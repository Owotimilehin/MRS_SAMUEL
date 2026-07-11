import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDbClient,
  branch,
  product,
  saleOrder,
  stockReservation,
  type DbClient,
} from "@ms/db";
import { expireUnpaidOrders } from "../src/jobs/expire-unpaid-orders.js";

/** No-op re-verify: the default hits the api over HTTP, unavailable in unit
 *  tests. Existing cases assert cancellation behaviour, not reconciliation. */
const noRefire = async () => {};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("expireUnpaidOrders", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());

    const [b] = await db
      .insert(branch)
      .values({ name: "Test Branch", code: "TEST" })
      .returning();
    branchId = b!.id;

    const [p] = await db
      .insert(product)
      .values({ name: "Zobo", slug: "zobo", category: "regular" })
      .returning();
    productId = p!.id;
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    await db.delete(stockReservation);
    await db.delete(saleOrder);
  });

  /** Insert a sale_order and optionally a stock_reservation tied to it. */
  async function makeOrder(opts: {
    channel: "online" | "walkup";
    status: "draft" | "confirmed" | "paid" | "cancelled";
    paymentStatus?: "pending" | "paid" | "failed" | "refunded";
    createdAt: Date;
    withReservation?: boolean;
  }): Promise<string> {
    const [o] = await db
      .insert(saleOrder)
      .values({
        orderNumber: `SO-${randomUUID()}`,
        branchId,
        channel: opts.channel,
        status: opts.status,
        paymentStatus: opts.paymentStatus ?? "pending",
        subtotalNgn: 1000,
        totalNgn: 1000,
        paymentMethod: "card",
        createdAtLocal: opts.createdAt,
        createdAt: opts.createdAt,
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (!o) throw new Error("insert returned no row");

    if (opts.withReservation) {
      await db.insert(stockReservation).values({
        saleOrderId: o.id,
        branchId,
        productId,
        quantity: 2,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
    }
    return o.id;
  }

  it("cancels unpaid confirmed online orders older than 60m, leaves paid + recent alone", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 61 * 60_000);
    const recent = new Date(now.getTime() - 5 * 60_000);

    // Eligible: online, confirmed, pending, older than 60m.
    const oldUnpaidId = await makeOrder({
      channel: "online",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: old,
      withReservation: true,
    });

    // Ineligible: recent (only 5m old) — still within the window.
    await makeOrder({
      channel: "online",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: recent,
    });

    // Ineligible: paid order — must NEVER be touched.
    await makeOrder({
      channel: "online",
      status: "paid",
      paymentStatus: "paid",
      createdAt: old,
    });

    // Ineligible: walkup channel.
    await makeOrder({
      channel: "walkup",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: old,
    });

    const n = await expireUnpaidOrders(db, now, noRefire);
    expect(n).toBe(1);

    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, oldUnpaidId));
    expect(row!.status).toBe("cancelled");
    expect(row!.cancelReason).toBe("payment_expired");
    expect(row!.cancelledAt).not.toBeNull();

    // Reservation for the cancelled order must be gone.
    const reservations = await db
      .select()
      .from(stockReservation)
      .where(eq(stockReservation.saleOrderId, oldUnpaidId));
    expect(reservations).toHaveLength(0);
  });

  it("is idempotent — re-running does not double-cancel", async () => {
    const old = new Date(Date.now() - 90 * 60_000);
    await makeOrder({
      channel: "online",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: old,
    });

    const first = await expireUnpaidOrders(db, new Date(), noRefire);
    expect(first).toBe(1);

    // Second run: already cancelled, so status != 'confirmed' → not matched again.
    const second = await expireUnpaidOrders(db, new Date(), noRefire);
    expect(second).toBe(0);
  });

  it("never touches a paid online order", async () => {
    const old = new Date(Date.now() - 120 * 60_000);
    const paidId = await makeOrder({
      channel: "online",
      status: "paid",
      paymentStatus: "paid",
      createdAt: old,
    });

    const n = await expireUnpaidOrders(db, new Date(), noRefire);
    expect(n).toBe(0);

    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, paidId));
    expect(row!.status).toBe("paid");
  });

  it("does NOT cancel an order the re-verify reconciles to paid (lost-webhook rescue)", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 61 * 60_000);

    // Two stale unpaid orders. The re-verify stub will "confirm" only the first
    // (simulating an OPay transfer that settled but whose webhook was lost),
    // flipping it to paid exactly as the real webhook would.
    const rescuedId = await makeOrder({
      channel: "online",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: old,
      withReservation: true,
    });
    const abandonedId = await makeOrder({
      channel: "online",
      status: "confirmed",
      paymentStatus: "pending",
      createdAt: old,
    });

    const [rescued] = await db.select().from(saleOrder).where(eq(saleOrder.id, rescuedId));
    const refire = async (orderNumber: string) => {
      if (orderNumber === rescued!.orderNumber) {
        await db
          .update(saleOrder)
          .set({ status: "paid", paymentStatus: "paid" })
          .where(eq(saleOrder.id, rescuedId));
      }
    };

    const n = await expireUnpaidOrders(db, now, refire);
    expect(n).toBe(1); // only the abandoned one is cancelled

    const [rescuedRow] = await db.select().from(saleOrder).where(eq(saleOrder.id, rescuedId));
    expect(rescuedRow!.status).toBe("paid"); // reconciled, NOT cancelled

    const [abandonedRow] = await db.select().from(saleOrder).where(eq(saleOrder.id, abandonedId));
    expect(abandonedRow!.status).toBe("cancelled");

    // The rescued order keeps its reservation (it's a real paid order now);
    // only the cancelled order's reservation is released.
    const resv = await db
      .select()
      .from(stockReservation)
      .where(eq(stockReservation.saleOrderId, rescuedId));
    expect(resv).toHaveLength(1);
  });
});
