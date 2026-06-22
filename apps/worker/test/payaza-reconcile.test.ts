import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createDbClient,
  branch,
  product,
  saleOrder,
  stockReservation,
  type DbClient,
} from "@ms/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("payaza reconcile sweep", () => {
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
      .values({ name: "Ajao", code: "AJAO" })
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    // Each test seeds its own orders — clear prior rows so eligibility
    // assertions aren't polluted by a previous test's data.
    await db.delete(stockReservation);
    await db.delete(saleOrder);
  });

  /** Insert a sale_order row with the given status/channel/age, and optionally
   *  a live (non-expired) stock_reservation tied to it. */
  async function makeOrder(opts: {
    orderNumber: string;
    status: "draft" | "confirmed" | "paid" | "cancelled";
    channel: "online" | "walkup";
    ageSeconds: number;
    reservationExpiresInSeconds: number | null; // null = no reservation row
  }): Promise<string> {
    const createdAt = new Date(Date.now() - opts.ageSeconds * 1000);
    const [o] = await db
      .insert(saleOrder)
      .values({
        orderNumber: opts.orderNumber,
        branchId,
        channel: opts.channel,
        status: opts.status,
        subtotalNgn: 1000,
        totalNgn: 1000,
        paymentMethod: "card",
        paymentStatus: "pending",
        createdAtLocal: createdAt,
        createdAt,
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (!o) throw new Error("insert returned no row");

    if (opts.reservationExpiresInSeconds !== null) {
      await db.insert(stockReservation).values({
        saleOrderId: o.id,
        branchId,
        productId,
        quantity: 1,
        expiresAt: new Date(Date.now() + opts.reservationExpiresInSeconds * 1000),
      });
    }
    return o.id;
  }

  it("re-fires the webhook only for stuck-confirmed online orders with a live reservation", async () => {
    // Eligible: online, confirmed, created 5min ago, reservation expires in 10min.
    await makeOrder({
      orderNumber: "SO-1",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    // Ineligible: reservation already expired.
    await makeOrder({
      orderNumber: "SO-2",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: -600,
    });
    // Ineligible: too recent (< 90s old).
    await makeOrder({
      orderNumber: "SO-3",
      status: "confirmed",
      channel: "online",
      ageSeconds: 10,
      reservationExpiresInSeconds: 600,
    });
    // Ineligible: not online channel.
    await makeOrder({
      orderNumber: "SO-4",
      status: "confirmed",
      channel: "walkup",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    // Ineligible: not confirmed status.
    await makeOrder({
      orderNumber: "SO-5",
      status: "paid",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    // Ineligible: confirmed+online+old enough but no reservation at all.
    await makeOrder({
      orderNumber: "SO-6",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: null,
    });

    const { sweepStuckPayazaOrders } = await import("../src/jobs/payaza-reconcile.js");
    const count = await sweepStuckPayazaOrders(db);

    expect(count).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/webhooks\/payaza$/);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.transaction_reference).toBe("SO-1");
  });

  it("a failed POST is logged and does not abort the sweep (best-effort)", async () => {
    await makeOrder({
      orderNumber: "SO-7",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    await makeOrder({
      orderNumber: "SO-8",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ ok: true, status: 200 }),
    );

    const { sweepStuckPayazaOrders } = await import("../src/jobs/payaza-reconcile.js");
    const count = await sweepStuckPayazaOrders(db);

    // SO-7's POST throws and is swallowed; SO-8's POST succeeds. The loop
    // must not abort after SO-7's failure, so both get attempted and only
    // the successful one counts.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
  });
});
