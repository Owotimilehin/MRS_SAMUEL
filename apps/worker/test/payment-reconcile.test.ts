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
  outboxEvent,
  type DbClient,
} from "@ms/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../packages/db/migrations");

describe("payment reconcile sweep", () => {
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
    isPreorder?: boolean;
    paymentProvider?: "opay" | "payaza" | null;
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
        isPreorder: opts.isPreorder ?? false,
        paymentProvider: opts.paymentProvider ?? null,
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

  it("re-fires the webhook for every stuck-confirmed online order within the lookback window — including preorders and expired-reservation orders", async () => {
    // Eligible: online, confirmed, created 5min ago, reservation still live.
    await makeOrder({
      orderNumber: "SO-1",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
    });
    // Eligible (the expired-reservation gap): a real payment whose stock hold
    // already lapsed must still be recovered — the money was taken.
    await makeOrder({
      orderNumber: "SO-2",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: -600,
    });
    // Ineligible: too recent (< 90s old) — give the webhook a chance first.
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
    // Eligible (the preorder gap): preorders never hold a reservation, so the
    // old EXISTS gate excluded them entirely — they had NO auto-confirm path.
    await makeOrder({
      orderNumber: "SO-6",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: null,
      isPreorder: true,
    });
    // Ineligible: beyond the lookback window (older than 48h) — presumed
    // abandoned; the long tail falls to admin recheck, not an endless re-verify.
    await makeOrder({
      orderNumber: "SO-OLD",
      status: "confirmed",
      channel: "online",
      ageSeconds: 49 * 3600,
      reservationExpiresInSeconds: null,
    });

    const { sweepStuckPaymentOrders } = await import("../src/jobs/payment-reconcile.js");
    const count = await sweepStuckPaymentOrders(db);

    expect(count).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    const refs = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => {
      const [url, init] = call;
      expect(String(url)).toMatch(/\/v1\/webhooks\/opay$/);
      return JSON.parse((init as RequestInit).body as string).reference;
    });
    expect(refs.sort()).toEqual(["SO-1", "SO-2", "SO-6"]);
  });

  // OPay is the only provider now. Orders stamped "payaza" or left null are
  // legacy rows from before the switch; they must still route to the OPay
  // webhook rather than a route that no longer exists.
  it("re-fires the OPay webhook for every order, whatever provider is stamped", async () => {
    // An OPay-stamped stuck order must be re-verified against the OPay webhook.
    await makeOrder({
      orderNumber: "SO-OPAY",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
      paymentProvider: "opay",
    });
    // A legacy payaza-stamped order → still the OPay webhook.
    await makeOrder({
      orderNumber: "SO-PAYAZA",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
      paymentProvider: "payaza",
    });
    // A legacy null-provider order → likewise.
    await makeOrder({
      orderNumber: "SO-LEGACY",
      status: "confirmed",
      channel: "online",
      ageSeconds: 300,
      reservationExpiresInSeconds: 600,
      paymentProvider: null,
    });

    const { sweepStuckPaymentOrders } = await import("../src/jobs/payment-reconcile.js");
    const count = await sweepStuckPaymentOrders(db);
    expect(count).toBe(3);

    const byRef = new Map<string, { url: string; body: Record<string, unknown> }>();
    for (const call of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      const [url, init] = call;
      const body = JSON.parse((init as RequestInit).body as string);
      byRef.set(body.reference, { url: String(url), body });
    }
    expect(byRef.get("SO-OPAY")!.url).toMatch(/\/v1\/webhooks\/opay$/);
    expect(byRef.get("SO-OPAY")!.body).toEqual({ reference: "SO-OPAY" });
    expect(byRef.get("SO-PAYAZA")!.url).toMatch(/\/v1\/webhooks\/opay$/);
    expect(byRef.get("SO-PAYAZA")!.body).toEqual({ reference: "SO-PAYAZA" });
    expect(byRef.get("SO-LEGACY")!.url).toMatch(/\/v1\/webhooks\/opay$/);
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

    const { sweepStuckPaymentOrders } = await import("../src/jobs/payment-reconcile.js");
    const count = await sweepStuckPaymentOrders(db);

    // SO-7's POST throws and is swallowed; SO-8's POST succeeds. The loop
    // must not abort after SO-7's failure, so both get attempted and only
    // the successful one counts.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
  });

  // ---- P1: a payment that lands after the 60-minute auto-cancel ----
  describe("late-payment sweep (orders cancelled as payment_expired)", () => {
    const HOUR = 3600 * 1000;

    beforeEach(async () => {
      await db.delete(outboxEvent);
    });

    /** An online order as the expiry job leaves it (or as otherwise specified). */
    async function makeCancelled(opts: {
      orderNumber: string;
      cancelledHoursAgo: number;
      cancelReason?: string;
      status?: "cancelled" | "confirmed" | "paid";
      channel?: "online" | "walkup";
    }): Promise<string> {
      const cancelledAt = new Date(Date.now() - opts.cancelledHoursAgo * HOUR);
      const createdAt = new Date(cancelledAt.getTime() - HOUR);
      const status = opts.status ?? "cancelled";
      const [o] = await db
        .insert(saleOrder)
        .values({
          orderNumber: opts.orderNumber,
          branchId,
          channel: opts.channel ?? "online",
          status,
          subtotalNgn: 1000,
          totalNgn: 1000,
          paymentMethod: "card",
          paymentStatus: status === "paid" ? "paid" : "pending",
          cancelReason: status === "cancelled" ? (opts.cancelReason ?? "payment_expired") : null,
          cancelledAt: status === "cancelled" ? cancelledAt : null,
          createdAtLocal: createdAt,
          createdAt,
          idempotencyKey: randomUUID(),
        })
        .returning();
      return o!.id;
    }

    /** What the api's paid-after-cancel path writes when OPay reports SUCCESS. */
    async function recordAlert(saleOrderId: string, orderNumber: string): Promise<void> {
      await db.insert(outboxEvent).values({
        eventType: "sale.paid_after_cancel",
        payload: { sale_order_id: saleOrderId, order_number: orderNumber, total_ngn: 1000 },
      });
    }

    const firedRefs = (): string[] =>
      (fetch as ReturnType<typeof vi.fn>).mock.calls
        .map(([url, init]) => {
          expect(String(url)).toMatch(/\/v1\/webhooks\/opay$/);
          return JSON.parse((init as RequestInit).body as string).reference as string;
        })
        .sort();

    it("re-fires the webhook for orders expired in the last 48h, and only those", async () => {
      await makeCancelled({ orderNumber: "EX-RECENT", cancelledHoursAgo: 0.1 });
      await makeCancelled({ orderNumber: "EX-47H", cancelledHoursAgo: 47 });
      // Past the 48h window.
      await makeCancelled({ orderNumber: "EX-49H", cancelledHoursAgo: 49 });
      // Cancelled by staff, not by the expiry job: not ours to second-guess.
      await makeCancelled({ orderNumber: "EX-STAFF", cancelledHoursAgo: 1, cancelReason: "customer changed mind" });
      // Still open / already paid: the other sweep's business, or nobody's.
      await makeCancelled({ orderNumber: "EX-OPEN", cancelledHoursAgo: 1, status: "confirmed" });
      await makeCancelled({ orderNumber: "EX-PAID", cancelledHoursAgo: 1, status: "paid" });
      await makeCancelled({ orderNumber: "EX-WALKUP", cancelledHoursAgo: 1, channel: "walkup" });

      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");
      expect(await sweepExpiredOrdersForLatePayment(db)).toBe(2);
      expect(firedRefs()).toEqual(["EX-47H", "EX-RECENT"]);
    });

    it("an expired-then-paid order is detected once: after its alert exists it is not asked about again", async () => {
      const paidLateId = await makeCancelled({ orderNumber: "EX-PAIDLATE", cancelledHoursAgo: 2 });
      await makeCancelled({ orderNumber: "EX-NEVERPAID", cancelledHoursAgo: 2 });
      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");

      // The api's webhook, as far as the worker can see it: OPay reports SUCCESS
      // for EX-PAIDLATE, so the paid-after-cancel alert is written for it.
      const asked: string[] = [];
      const refire = async (orderNumber: string): Promise<boolean> => {
        asked.push(orderNumber);
        if (orderNumber === "EX-PAIDLATE") await recordAlert(paidLateId, orderNumber);
        return true;
      };

      expect(await sweepExpiredOrdersForLatePayment(db, new Date(), refire)).toBe(2);
      expect(asked.sort()).toEqual(["EX-NEVERPAID", "EX-PAIDLATE"]);

      // Next sweep: the alerted order is skipped; the unpaid one is still watched.
      asked.length = 0;
      expect(await sweepExpiredOrdersForLatePayment(db, new Date(), refire)).toBe(1);
      expect(asked).toEqual(["EX-NEVERPAID"]);

      const alerts = await db.select().from(outboxEvent);
      expect(alerts).toHaveLength(1);
      // The worker itself never touches the order: no reinstating, no refund.
      const orders = await db.select().from(saleOrder);
      expect(orders.every((o) => o.status === "cancelled")).toBe(true);
    });

    it("an alert for a different order does not hide this one", async () => {
      const other = await makeCancelled({ orderNumber: "EX-OTHER", cancelledHoursAgo: 3 });
      await recordAlert(other, "EX-OTHER");
      await makeCancelled({ orderNumber: "EX-MINE", cancelledHoursAgo: 3 });

      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");
      expect(await sweepExpiredOrdersForLatePayment(db)).toBe(1);
      expect(firedRefs()).toEqual(["EX-MINE"]);
    });

    it("stops only when the api itself is unreachable (3 checks in a row throw)", async () => {
      for (let i = 0; i < 6; i++) {
        await makeCancelled({ orderNumber: `EX-DOWN-${i}`, cancelledHoursAgo: 1 + i });
      }
      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");
      const down = vi.fn(async (): Promise<boolean> => {
        throw new Error("ECONNREFUSED");
      });
      expect(await sweepExpiredOrdersForLatePayment(db, new Date(), down, { log: new Map() })).toBe(0);
      expect(down).toHaveBeenCalledTimes(3);
    });

    it("a cluster of uncheckable orders is skipped, not allowed to starve the older ones", async () => {
      // The five NEWEST expiries cannot be checked (the api answers non-2xx for
      // them, e.g. OPay does not know the reference). Two older ones can.
      for (let i = 0; i < 5; i++) {
        await makeCancelled({ orderNumber: `EX-STUCK-${i}`, cancelledHoursAgo: 1 + i * 0.1 });
      }
      await makeCancelled({ orderNumber: "EX-OLDER-A", cancelledHoursAgo: 20 });
      await makeCancelled({ orderNumber: "EX-OLDER-B", cancelledHoursAgo: 40 });
      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");

      const asked: string[] = [];
      const refire = async (orderNumber: string): Promise<boolean> => {
        asked.push(orderNumber);
        return !orderNumber.startsWith("EX-STUCK");
      };
      expect(await sweepExpiredOrdersForLatePayment(db, new Date(), refire, { log: new Map() })).toBe(2);
      expect(asked).toHaveLength(7);
      expect(asked).toContain("EX-OLDER-A");
      expect(asked).toContain("EX-OLDER-B");
    });

    it("more expiries than one run can check are all reached, in rotation, before any is asked twice", async () => {
      const all: string[] = [];
      for (let i = 0; i < 7; i++) {
        const n = `EX-ROT-${i}`;
        all.push(n);
        await makeCancelled({ orderNumber: n, cancelledHoursAgo: 1 + i });
      }
      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");

      // Every check "takes" 8 seconds and a run may spend 24: three per run.
      let t = 1_000_000;
      const clock = () => t;
      const asked: string[] = [];
      const refire = async (orderNumber: string): Promise<boolean> => {
        asked.push(orderNumber);
        t += 8_000;
        return orderNumber !== "EX-ROT-0"; // the newest one can never be checked
      };
      const opts = { log: new Map<string, number>(), budgetMs: 24_000, clock };

      await sweepExpiredOrdersForLatePayment(db, new Date(), refire, opts);
      expect(asked).toEqual(["EX-ROT-0", "EX-ROT-1", "EX-ROT-2"]); // newest first
      await sweepExpiredOrdersForLatePayment(db, new Date(), refire, opts);
      await sweepExpiredOrdersForLatePayment(db, new Date(), refire, opts);

      // Nine checks over three runs: all seven reached once before the first
      // two come round again. The uncheckable newest did not hog the front.
      expect(asked.slice(0, 7).sort()).toEqual(all);
      expect(asked.slice(7)).toEqual(["EX-ROT-0", "EX-ROT-1"]);
    });

    it("has no cap on the window: 130 expired orders are all checked when time allows", async () => {
      const createdAt = new Date(Date.now() - 3 * HOUR);
      await db.insert(saleOrder).values(
        Array.from({ length: 130 }, (_, i) => ({
          orderNumber: `EX-MANY-${i}`,
          branchId,
          channel: "online" as const,
          status: "cancelled" as const,
          subtotalNgn: 1000,
          totalNgn: 1000,
          paymentMethod: "card" as const,
          paymentStatus: "pending" as const,
          cancelReason: "payment_expired",
          cancelledAt: new Date(Date.now() - 2 * HOUR - i * 1000),
          createdAtLocal: createdAt,
          createdAt,
          idempotencyKey: randomUUID(),
        })),
      );
      const { sweepExpiredOrdersForLatePayment } = await import("../src/jobs/payment-reconcile.js");
      const refire = vi.fn(async (): Promise<boolean> => true);
      expect(await sweepExpiredOrdersForLatePayment(db, new Date(), refire, { log: new Map() })).toBe(130);
      expect(refire).toHaveBeenCalledTimes(130);
    });
  });
});
