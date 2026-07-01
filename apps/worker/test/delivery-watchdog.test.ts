import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDbClient, branch, saleOrder, deliveryOrder, type DbClient } from "@ms/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("delivery watchdog reconcile pass", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let branchId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    const [b] = await db.insert(branch).values({ name: "Ajao", code: "AJAO" }).returning();
    branchId = b!.id;
  }, 120_000);

  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) }),
    );
    await db.delete(deliveryOrder);
    await db.delete(saleOrder);
  });

  async function makeDelivery(opts: {
    externalRef: string | null;
    status: "searching_rider" | "assigned" | "picked_up" | "in_transit";
    updatedMinutesAgo: number;
  }): Promise<void> {
    const [o] = await db.insert(saleOrder).values({
      orderNumber: `SO-${randomUUID().slice(0, 6)}`,
      branchId, channel: "online", status: "out_for_delivery",
      subtotalNgn: 1000, totalNgn: 1000, paymentMethod: "transfer", paymentStatus: "paid",
      createdAtLocal: new Date(), idempotencyKey: randomUUID(),
    }).returning();
    const ts = new Date(Date.now() - opts.updatedMinutesAgo * 60_000);
    await db.insert(deliveryOrder).values({
      saleOrderId: o!.id, pickupBranchId: branchId,
      pickupAddress: "Factory", dropoffAddress: "12 Allen Ave",
      quotedFeeNgn: 1500, externalRef: opts.externalRef, status: opts.status,
      requestedAt: ts, updatedAt: ts,
    });
  }

  it("POSTs external_ref to the reconcile endpoint for stale active deliveries only", async () => {
    await makeDelivery({ externalRef: "ext_stale", status: "in_transit", updatedMinutesAgo: 45 });   // eligible
    await makeDelivery({ externalRef: "ext_fresh", status: "in_transit", updatedMinutesAgo: 1 });     // too fresh
    await makeDelivery({ externalRef: "ext_search", status: "searching_rider", updatedMinutesAgo: 45 }); // not an ACTIVE status (handled by retry/escalate passes)
    await makeDelivery({ externalRef: null, status: "assigned", updatedMinutesAgo: 45 });             // no ref → skip

    const { runDeliveryWatchdog } = await import("../src/jobs/delivery-watchdog.js");
    await runDeliveryWatchdog(db);

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toMatch(/\/v1\/webhooks\/delivery-reconcile$/);
    expect(JSON.parse((init as RequestInit).body as string).external_ref).toBe("ext_stale");
  });

  it("a failed reconcile POST is swallowed and does not abort the pass", async () => {
    await makeDelivery({ externalRef: "ext_a", status: "in_transit", updatedMinutesAgo: 45 });
    await makeDelivery({ externalRef: "ext_b", status: "picked_up", updatedMinutesAgo: 45 });
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, changed: true }) }),
    );
    const { runDeliveryWatchdog } = await import("../src/jobs/delivery-watchdog.js");
    await runDeliveryWatchdog(db);
    expect(fetch).toHaveBeenCalledTimes(2); // both attempted; the throw did not abort the loop
  });
});
