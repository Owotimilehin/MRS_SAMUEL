import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { deliveryOrder, saleOrder, outboxEvent } from "@ms/db";
import { setupTestDb, seedOwner, seedOnlineOrder } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("applyDeliveryStatus + reconcile endpoint (mock provider)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let app: import("hono").Hono;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(db);
    const { buildApp } = await import("../../src/test-app.js");
    app = buildApp();
  }, 120_000);

  afterAll(async () => { await container.stop(); });

  async function seedDelivery(status: string, externalRef: string) {
    const { saleId, branchId } = await seedOnlineOrder(db, {
      status: "paid", deliveryState: "Lagos", deliveryFeeNgn: 1500,
    });
    await db.insert(deliveryOrder).values({
      saleOrderId: saleId, pickupBranchId: branchId,
      pickupAddress: "Factory", dropoffAddress: "12 Allen Ave",
      quotedFeeNgn: 1500, externalRef, status: status as never,
    });
    return { saleId };
  }

  it("delivered snapshot moves order → delivered + emits exactly one delivery.completed", async () => {
    const ref = "ext_deliver_1";
    const { saleId } = await seedDelivery("in_transit", ref);
    const { applyDeliveryStatus } = await import("../../src/delivery/apply-status.js");
    const res = await db.transaction((tx) =>
      applyDeliveryStatus(tx, { externalRef: ref, status: "delivered", raw: {} }));
    expect(res.changed).toBe(true);

    const [ord] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(ord!.status).toBe("delivered");
    const [dl] = await db.select().from(deliveryOrder).where(eq(deliveryOrder.externalRef, ref));
    expect(dl!.status).toBe("delivered");
    const events = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "delivery.completed"));
    expect(events.filter((e) => (e.payload as { delivery_id?: string }).delivery_id === dl!.id)).toHaveLength(1);
  });

  it("re-applying the same delivered snapshot is idempotent (changed:false, no new outbox)", async () => {
    const ref = "ext_deliver_1"; // same row as above, now terminal
    const { applyDeliveryStatus } = await import("../../src/delivery/apply-status.js");
    const res = await db.transaction((tx) =>
      applyDeliveryStatus(tx, { externalRef: ref, status: "delivered", raw: {} }));
    expect(res.changed).toBe(false);
    const [dl] = await db.select().from(deliveryOrder).where(eq(deliveryOrder.externalRef, ref));
    const events = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "delivery.completed"));
    expect(events.filter((e) => (e.payload as { delivery_id?: string }).delivery_id === dl!.id)).toHaveLength(1);
  });

  it("failed snapshot marks delivery failed but leaves sale_order at paid + one delivery.failed", async () => {
    const ref = "ext_fail_1";
    const { saleId } = await seedDelivery("searching_rider", ref);
    const { applyDeliveryStatus } = await import("../../src/delivery/apply-status.js");
    await db.transaction((tx) =>
      applyDeliveryStatus(tx, { externalRef: ref, status: "failed", failReason: "no rider", raw: {} }));
    const [ord] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(ord!.status).toBe("paid");
    const [dl] = await db.select().from(deliveryOrder).where(eq(deliveryOrder.externalRef, ref));
    expect(dl!.status).toBe("failed");
    const events = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "delivery.failed"));
    expect(events.filter((e) => (e.payload as { delivery_id?: string }).delivery_id === dl!.id)).toHaveLength(1);
  });

  it("reconcile endpoint polls the mock provider and drives a stale ride to delivered", async () => {
    const ref = "ext_endpoint_1";
    const { saleId } = await seedDelivery("in_transit", ref);
    const res = await app.request("/v1/webhooks/delivery-reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ external_ref: ref }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true });
    const [ord] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    expect(ord!.status).toBe("delivered");
  });

  it("reconcile endpoint with missing external_ref returns 400", async () => {
    const res = await app.request("/v1/webhooks/delivery-reconcile", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(400);
  });
});
