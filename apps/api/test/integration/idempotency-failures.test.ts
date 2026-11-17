import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { idempotencyKey, type DbClient } from "@ms/db";
import { setupTestDb } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * What the idempotency middleware remembers, and what it must let through.
 *
 * Runs the REAL middleware + error handler against Postgres, around a handler
 * the test scripts per key: how many times it ran is the thing under test.
 */
describe("idempotency middleware: failures, abandoned claims, concurrency", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let app: Hono;

  /** Per-key script: the statuses the handler answers with, in order (the last
   *  one repeats), how many times it has run, and an optional gate it waits on. */
  const plans = new Map<string, { statuses: number[]; runs: number; gate?: Promise<void> }>();

  function plan(statuses: number[], gate?: Promise<void>): string {
    const key = uuid();
    plans.set(key, { statuses, runs: 0, ...(gate ? { gate } : {}) });
    return key;
  }
  const runs = (key: string): number => plans.get(key)!.runs;

  function send(key: string, body: unknown = { n: 1 }): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/op", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }),
    );
  }

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
    const { createHash } = await import("node:crypto");
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
    const { BusinessError } = await import("../../src/lib/errors.js");

    app = new Hono();
    app.onError(onError);
    app.use("/v1/*", idempotencyMiddleware(db));
    app.post("/v1/op", async (c) => {
      const p = plans.get(c.req.header("idempotency-key")!)!;
      const run = ++p.runs;
      if (p.gate) await p.gate;
      else await new Promise((r) => setTimeout(r, 40)); // long enough to overlap
      const status = p.statuses[Math.min(run, p.statuses.length) - 1]!;
      if (status === 500) throw new Error("boom"); // an unhandled crash
      if (status >= 400) throw new BusinessError("conflict", `scripted ${status}`, status);
      return c.json({ data: { run, echo: await c.req.json() } }, status as 200 | 201);
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

  // 401/403: session lapsed. 429/5xx: transient. 400/404/409/422: a rule was
  // not met at the time. None of them is a completed operation.
  it.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503])(
    "does not store a %i: the retry executes and its success is what gets replayed",
    async (failure) => {
      const key = plan([failure, 200]);
      const r1 = await send(key);
      expect(r1.status).toBe(failure);
      // The key is released, not left pointing at the failure.
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

  it("lets a retry change the body after a failure (nothing was completed under the key)", async () => {
    const key = plan([409, 200]);
    expect((await send(key, { qty: 5 })).status).toBe(409);
    const r2 = await send(key, { qty: 2 });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: { echo: unknown } }).data.echo).toEqual({ qty: 2 });
  });

  it("still rejects a different body under a key that already succeeded", async () => {
    const key = plan([200]);
    expect((await send(key, { qty: 5 })).status).toBe(200);
    const r2 = await send(key, { qty: 2 });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_reused",
    );
    expect(runs(key)).toBe(1);
  });

  it("executes exactly once under concurrent requests with the same key", async () => {
    const key = plan([201]);
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(key)));
    const statuses = responses.map((r) => r.status).sort();
    expect(runs(key)).toBe(1);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // Everyone else was told the first attempt is still running.
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "idempotency_in_flight",
      );
    }
    // Once it has finished, a retry gets the stored result.
    expect((await send(key)).status).toBe(201);
    expect(runs(key)).toBe(1);
  });

  it("a fresh in-progress claim blocks a duplicate", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(1) });
    const r = await send(key);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_in_flight",
    );
    expect(runs(key)).toBe(0);
  });

  it("a stale in-progress claim (request cut off mid-flight) does not block the retry forever", async () => {
    const key = plan([200]);
    await seedRow(key, { firstSeenAt: minutesAgo(6) });
    const r = await send(key);
    expect(r.status).toBe(200);
    expect(runs(key)).toBe(1);
    expect((await row(key))?.status).toBe("done");
    // ...and the result is now stored like any other.
    expect((await send(key)).status).toBe(200);
    expect(runs(key)).toBe(1);
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
    // Its claim ages past the window (as if the request had been running for 10 min).
    await db
      .update(idempotencyKey)
      .set({ firstSeenAt: minutesAgo(10) })
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

  it("a failure stored by the old middleware no longer replays: the retry executes, once", async () => {
    const key = plan([201]);
    await seedRow(key, {
      status: "done",
      responseStatus: 401,
      responseBody: { error: { code: "unauthorized", message: "missing session" } },
      firstSeenAt: minutesAgo(60 * 24),
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => send(key)));
    expect(runs(key)).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await send(key)).status).toBe(201);
    expect(runs(key)).toBe(1);
  });
});
