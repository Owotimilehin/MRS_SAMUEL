import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { checkoutAttemptLog, outboxEvent } from "@ms/db";
import type { Hono } from "hono";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { makeTestApp, authOwner } from "./helpers.js";

describe("checkout attempt log endpoints", () => {
  let app: Hono;
  let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    const t = await makeTestApp();
    app = t.app;
    db = t.db;
    container = t.container;
  }, 90_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  afterEach(async () => {
    await db.delete(checkoutAttemptLog);
    await db.delete(outboxEvent);
  });

  async function post(body: unknown) {
    return app.request("/v1/public/telemetry/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("POST /v1/public/telemetry/checkout", () => {
    it("persists a row for a valid press", async () => {
      const res = await post({
        attempt_id: "att-1",
        stage: "pressed",
        customer: { name: "Ada Okeke", phone: "08000000000", address: "1 Main St" },
        items: [{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }],
        total_ngn: 5000,
      });
      expect(res.status).toBe(204);
      const rows = await db
        .select()
        .from(checkoutAttemptLog)
        .where(eq(checkoutAttemptLog.attemptId, "att-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stage).toBe("pressed");
      expect(rows[0]!.status).toBe("info");
      expect(rows[0]!.customerName).toBe("Ada Okeke");
      expect(rows[0]!.totalNgn).toBe(5000);
    });

    it("enqueues a checkout.failed outbox event on a failure stage", async () => {
      await post({ attempt_id: "att-2", stage: "payment_failed", error_message: "popup blocked" });
      const events = await db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventType, "checkout.failed"));
      expect(events).toHaveLength(1);
      expect((events[0]!.payload as Record<string, unknown>).attempt_id).toBe("att-2");
      expect((events[0]!.payload as Record<string, unknown>).error_message).toBe("popup blocked");
    });

    it("does NOT enqueue Telegram for a success stage", async () => {
      await post({ attempt_id: "att-3", stage: "payment_paid" });
      const events = await db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventType, "checkout.failed"));
      expect(events).toHaveLength(0);
    });

    it("returns 204 and writes nothing for a malformed payload", async () => {
      const res = await post({ stage: "nope" });
      expect(res.status).toBe(204);
      const rows = await db.select().from(checkoutAttemptLog);
      expect(rows).toHaveLength(0);
    });
  });

  describe("GET /v1/reports/checkout-log", () => {
    it("requires auth", async () => {
      const res = await app.request("/v1/reports/checkout-log");
      expect([401, 403]).toContain(res.status);
    });

    it("groups stage rows by attempt, newest attempt first", async () => {
      // a1 has two stages; a2 is created later so should sort first.
      await post({ attempt_id: "a1", stage: "pressed", customer: { name: "First" } });
      await post({ attempt_id: "a1", stage: "order_created", order_number: "SO-1" });
      await post({ attempt_id: "a2", stage: "pressed", customer: { name: "Second" } });

      const { cookie } = await authOwner(app);
      const res = await app.request("/v1/reports/checkout-log", { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        attempts: Array<{ attempt_id: string; customer: { name: string | null }; stages: Array<{ stage: string }> }>;
      };
      expect(body.attempts[0]!.attempt_id).toBe("a2"); // newest first
      const a1 = body.attempts.find((a) => a.attempt_id === "a1")!;
      expect(a1.stages.map((s) => s.stage)).toEqual(["pressed", "order_created"]);
      expect(a1.customer.name).toBe("First");
    });
  });
});
