import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, sql } from "drizzle-orm";
import { idempotencyKey, outboxEvent, type DbClient } from "@ms/db";
import { setupTestDb } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * What the idempotency middleware remembers, and what it must let through.
 *
 * Runs the REAL middleware + error handler against Postgres, around a handler
 * the test scripts per key: how many times it ran (and how many rows it
 * committed) is the thing under test.
 */
describe("idempotency middleware: failures, abandoned claims, concurrency", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let app: Hono;

  /** One scripted answer. `rejects` throws the way validation, auth and
   *  business rules do; `returns` hands back the status without throwing;
   *  `crashes` throws a plain Error (an unhandled 500). `commits` first writes a
   *  real row, like a handler that saves its work and then fails afterwards. */
  type Step = {
    status: number;
    how?: "rejects" | "returns" | "crashes";
    commits?: boolean;
  };
  const plans = new Map<string, { steps: Step[]; runs: number; gate?: Promise<void> }>();

  function plan(steps: Array<Step | number>, gate?: Promise<void>): string {
    const key = uuid();
    plans.set(key, {
      steps: steps.map((s) => (typeof s === "number" ? { status: s } : s)),
      runs: 0,
      ...(gate ? { gate } : {}),
    });
    return key;
  }
  const runs = (key: string): number => plans.get(key)!.runs;

  /** Rows the scripted handler committed under this key. */
  async function committed(key: string): Promise<number> {
    const rows = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        sql`${outboxEvent.eventType} = 'test.idempotency_commit' and ${outboxEvent.payload}->>'key' = ${key}`,
      );
    return rows.length;
  }

  function send(key: string, body: unknown = { n: 1 }): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/op", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }),
    );
  }

  const errorCode = async (r: Response): Promise<string> =>
    ((await r.json()) as { error: { code: string } }).error.code;

  async function row(key: string) {
    const [r] = await db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key));
    return r;
  }

  const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

  /** A row as an earlier request would have left it. */
  async function seedRow(
    key: string,
    over: Partial<typeof idempotencyKey.$inferInsert>,
    body: unknown = { n: 1 },
  ): Promise<void> {
    await db.insert(idempotencyKey).values({
      key,
      endpoint: "/v1/op",
      requestHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      status: "in_progress",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      ...over,
    });
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    const { idempotencyMiddleware } = await import("../../src/middleware/idempotency.js");
    const { onError } = await import("../../src/middleware/error.js");
    const { BusinessError, SystemError } = await import("../../src/lib/errors.js");

    app = new Hono();
    app.onError(onError);
    app.use("/v1/*", idempotencyMiddleware(db));
    app.post("/v1/op", async (c) => {
      const key = c.req.header("idempotency-key")!;
      const p = plans.get(key)!;
      const run = ++p.runs;
      if (p.gate) await p.gate;
      else await new Promise((r) => setTimeout(r, 40)); // long enough to overlap
      const step = p.steps[Math.min(run, p.steps.length) - 1]!;
      if (step.commits) {
        await db
          .insert(outboxEvent)
          .values({ eventType: "test.idempotency_commit", payload: { key, run } });
      }
      const { status } = step;
      if (status >= 200 && status < 300) {
        return c.json({ data: { run, echo: await c.req.json() } }, status as 200 | 201);
      }
      const how = step.how ?? (status >= 500 ? "crashes" : "rejects");
      if (how === "returns") {
        return c.json({ error: { code: "conflict", message: "returned" } }, status as 409);
      }
      if (how === "crashes" && status === 500) throw new Error("boom");
      if (status >= 500) throw new SystemError("service_unavailable", `scripted ${status}`, status);
      throw new BusinessError("conflict", `scripted ${status}`, status);
    });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it("replays a successful response without running the handler again", async () => {
    const key = plan([201]);
    const r1 = await send(key);
    const r2 = await send(key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual(await r1.json());
    expect(runs(key)).toBe(1);
    expect((await row(key))?.status).toBe("done");
  });

  // ---- rejections: the handler cannot have done its work ----

  // 401/403: no session or permission. 429: rate limited. 400/404/409/422:
  // validation or a business rule. All thrown before anything is saved.
  it.each([400, 401, 403, 404, 409, 422, 429])(
    "a thrown %i rejection is not stored: the retry executes and its success is what gets replayed",
    async (rejection) => {
      const key = plan([rejection, 200]);
      const r1 = await send(key);
      expect(r1.status).toBe(rejection);
      // The key is released, not left pointing at the rejection.
      expect(await row(key)).toBeUndefined();

      const r2 = await send(key);
      expect(r2.status).toBe(200);
      expect(runs(key)).toBe(2);

      // From here on it is a completed operation: replayed, never re-run.
      const r3 = await send(key);
      expect(r3.status).toBe(200);
      expect(await r3.json()).toEqual(await r2.json());
      expect(runs(key)).toBe(2);
    },
  );

  it("a till row parked on a business rule (409) goes through when staff press Retry later", async () => {
    // Same key, same body, sent again after the cause was fixed.
    const key = plan([409, 409, 201]);
    expect((await send(key)).status).toBe(409);
    expect((await send(key)).status).toBe(409); // still not fixed: re-checked, not replayed
    expect((await send(key)).status).toBe(201);
    expect(runs(key)).toBe(3);
    expect((await send(key)).status).toBe(201);
    expect(runs(key)).toBe(3);
  });

  it("lets a retry change the body after a rejection (nothing was completed under the key)", async () => {
    const key = plan([409, 200]);
    expect((await send(key, { qty: 5 })).status).toBe(409);
    const r2 = await send(key, { qty: 2 });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: { echo: unknown } }).data.echo).toEqual({ qty: 2 });
  });

  // ---- failures whose outcome is unknown: never run again ----

  it.each([
    ["crashes with an unhandled error (500)", { status: 500, commits: true }],
    ["throws a 503 from follow-up work", { status: 503, commits: true }],
    ["throws a 502", { status: 502, commits: true }],
    ["RETURNS a 409 itself instead of throwing", { status: 409, how: "returns", commits: true }],
  ] as Array<[string, Step]>)(
    "a handler that commits and then %s is not run again by a retry",
    async (_label, failure) => {
      const key = plan([failure, 201]);
      const r1 = await send(key);
      expect(r1.status).toBe(failure.status);
      expect(await committed(key)).toBe(1);

      // The client's automatic retry (same key): gets the same failure back.
      const r2 = await send(key);
      expect(r2.status).toBe(failure.status);
      expect(await r2.json()).toEqual(await r1.json());
      const r3 = await send(key);
      expect(r3.status).toBe(failure.status);

      // The work was applied exactly once.
      expect(runs(key)).toBe(1);
      expect(await committed(key)).toBe(1);
    },
  );

  it("a 5xx is stored even when nothing was committed (we cannot tell the difference)", async () => {
    const key = plan([503, 200]);
    expect((await send(key)).status).toBe(503);
    expect((await send(key)).status).toBe(503);
    expect(runs(key)).toBe(1);
    expect((await row(key))?.responseStatus).toBe(503);
  });

  // ---- payload ----

  it("still rejects a different body under a key that already succeeded", async () => {
    const key = plan([200]);
    expect((await send(key, { qty: 5 })).status).toBe(200);
    const r2 = await send(key, { qty: 2 });
    expect(r2.status).toBe(409);
    expect(await errorCode(r2)).toBe("idempotency_key_reused");
    expect(runs(key)).toBe(1);
  });

  // ---- concurrency ----

  it("executes exactly once under concurrent requests with the same key", async () => {
    const key = plan([201]);
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(key)));
    const statuses = responses.map((r) => r.status).sort();
    expect(runs(key)).toBe(1);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // Everyone else was told the first attempt is still running.
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(await errorCode(r)).toBe("idempotency_in_flight");
    }
    // Once it has finished, a retry gets the stored result.
    expect((await send(key)).status).toBe(201);
    expect(runs(key)).toBe(1);
  });

  // ---- abandoned claims ----

  it("an in-progress claim younger than 15 minutes blocks a duplicate", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(14) });
    const r = await send(key);
    expect(r.status).toBe(409);
    expect(await errorCode(r)).toBe("idempotency_in_flight");
    expect(runs(key)).toBe(0);
  });

  it("a stale in-progress claim (request cut off mid-flight) does not block the retry forever", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(16) });
    const r = await send(key);
    expect(r.status).toBe(200);
    expect(runs(key)).toBe(1);
    expect((await row(key))?.status).toBe("done");
    // ...and the result is now stored like any other.
    expect((await send(key)).status).toBe(200);
    expect(runs(key)).toBe(1);
  });

  it("a stale claim is not inherited by a different payload", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(60) }, { qty: 5 });
    const r = await send(key, { qty: 2 });
    expect(r.status).toBe(409);
    expect(await errorCode(r)).toBe("idempotency_key_reused");
    expect(runs(key)).toBe(0);
    // The original payload can still take it over.
    expect((await send(key, { qty: 5 })).status).toBe(200);
  });

  it("only one of several concurrent retries takes over a stale claim", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(30) });
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(key)));
    expect(runs(key)).toBe(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("a request whose claim was taken over cannot overwrite its successor's result", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const key = plan([200], gate);

    // First request claims the key and hangs inside the handler.
    const first = send(key);
    while (runs(key) < 1) await new Promise((r) => setTimeout(r, 5));
    // Its claim ages past the window (as if it had been running for 20 min).
    await db
      .update(idempotencyKey)
      .set({ firstSeenAt: minutesAgo(20) })
      .where(eq(idempotencyKey.key, key));

    // A retry takes over and completes.
    delete plans.get(key)!.gate;
    const second = await send(key);
    expect(second.status).toBe(200);
    const stored = (await row(key))?.responseBody;

    // The first request now finishes: it must leave the stored result alone.
    open();
    await first;
    const after = await row(key);
    expect(after?.status).toBe("done");
    expect(after?.responseBody).toEqual(stored);
  });

  // ---- rows stored by the old middleware (it stored every response) ----

  const storedByOldCode = (status: number) => ({
    status: "done",
    responseStatus: status,
    responseBody: { error: { code: "x", message: `stored ${status}` } },
    firstSeenAt: minutesAgo(60 * 24),
  });

  it.each([400, 401, 403, 404, 409, 422, 429])(
    "an old stored %i rejection no longer replays: the retry executes, once",
    async (status) => {
      const key = plan([201]);
      await seedRow(key, storedByOldCode(status));
      const responses = await Promise.all(Array.from({ length: 6 }, () => send(key)));
      expect(runs(key)).toBe(1);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
      expect((await send(key)).status).toBe(201);
      expect(runs(key)).toBe(1);
    },
  );

  it.each([500, 502, 503])(
    "an old stored %i is still replayed, never re-run (its outcome is unknown)",
    async (status) => {
      const key = plan([201]);
      await seedRow(key, storedByOldCode(status));
      const r = await send(key);
      expect(r.status).toBe(status);
      expect(runs(key)).toBe(0);
    },
  );

  it("an old stored rejection is not inherited by a different payload", async () => {
    const key = plan([201]);
    await seedRow(key, storedByOldCode(401), { qty: 5 });
    const r = await send(key, { qty: 2 });
    expect(r.status).toBe(409);
    expect(await errorCode(r)).toBe("idempotency_key_reused");
    expect(runs(key)).toBe(0);
  });
});
