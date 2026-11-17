import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, sql } from "drizzle-orm";
import { saleOrder, outboxEvent, idempotencyKey, type DbClient } from "@ms/db";
import { makeTestApp, seedCatalog, addBranchStock } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * P3: checkout saves the order (and empties the cart, holds stock, alerts the
 * owner) BEFORE it contacts OPay. An OPay failure used to surface as an error,
 * leaving that order behind while the customer's retry created a second one.
 */
describe("checkout when OPay cannot open a payment page", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let branchId: string;
  let productId: string;
  let phoneSeq = 0;

  beforeAll(async () => {
    const t = await makeTestApp();
    ({ app, db, container } = t);
    ({ branchId, productId } = await seedCatalog(db));
    await addBranchStock(db, { branchId, productId, qty: 50 });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Make OPay's cashier/create misbehave; nothing else is called over HTTP. */
  function opayCreate(behaviour: "timeout" | "rejected" | "ok"): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (!String(url).includes("/cashier/create")) throw new Error(`unexpected fetch ${String(url)}`);
        if (behaviour === "timeout") throw new DOMException("The operation timed out", "TimeoutError");
        const body =
          behaviour === "rejected"
            ? { code: "02001", message: "request params not valid" }
            : { code: "00000", data: { cashierUrl: "https://cashier.example.test/resumed", orderNo: "r1" } };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  }

  /** A distinct customer per test, so orders are told apart by phone. */
  function newCheckout() {
    const phone = `+23480255${String(60000 + ++phoneSeq)}`;
    const body = {
      branch_id: branchId,
      delivery_fee_ngn: 0,
      customer: { name: "Checkout Tester", phone, address: "1 Test Close" },
      items: [{ product_id: productId, quantity: 1 }],
    };
    return { phone, body, key: uuid() };
  }

  type Placed = {
    data: { id: string; order_number: string; payment: { redirect_url: string | null } };
  };

  function place(key: string, body: unknown): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/public/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      }),
    );
  }

  const ordersForKey = (key: string) =>
    db.select().from(saleOrder).where(eq(saleOrder.idempotencyKey, key));

  async function newOrderAlerts(orderId: string): Promise<number> {
    const rows = await db
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(
        sql`${outboxEvent.eventType} = 'sale.online_placed' and ${outboxEvent.payload}->>'sale_order_id' = ${orderId}`,
      );
    return rows.length;
  }

  it.each(["timeout", "rejected"] as const)(
    "OPay %s: returns the created order (no payment URL) instead of an error",
    async (failure) => {
      const { key, body } = newCheckout();
      opayCreate(failure);

      const res = await place(key, body);
      expect(res.status).toBe(201);
      const placed = (await res.json()) as Placed;
      expect(placed.data.order_number).toBeTruthy();
      expect(placed.data.payment.redirect_url).toBeNull();

      const orders = await ordersForKey(key);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.id).toBe(placed.data.id);
      expect(orders[0]!.status).toBe("confirmed"); // unpaid, awaiting payment
    },
  );

  it("a retry with the same key returns that same order, never a second one", async () => {
    const { key, body, phone } = newCheckout();
    opayCreate("timeout");
    const first = (await (await place(key, body)).json()) as Placed;

    // OPay is back; the customer (or the no-JS form, which reuses its key for an
    // hour) submits again.
    opayCreate("ok");
    const again = await place(key, body);
    expect(again.status).toBe(201);
    const second = (await again.json()) as Placed;
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.order_number).toBe(first.data.order_number);

    expect(await ordersForKey(key)).toHaveLength(1);
    expect(await newOrderAlerts(first.data.id)).toBe(1);
    const mine = await db
      .select({ id: saleOrder.id })
      .from(saleOrder)
      .where(sql`${saleOrder.customerId} in (select id from customer where phone = ${phone})`);
    expect(mine).toHaveLength(1);
  });

  it("the customer can then complete payment from the order page", async () => {
    const { key, body, phone } = newCheckout();
    opayCreate("timeout");
    const placed = (await (await place(key, body)).json()) as Placed;

    opayCreate("ok");
    const res = await app.request(
      `/v1/public/orders/${placed.data.order_number}/opay-session?phone=${encodeURIComponent(phone)}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    // In the `data` envelope: the storefront's API client returns only `data`.
    expect(await res.json()).toEqual({
      data: { redirect_url: "https://cashier.example.test/resumed" },
    });
  });

  it("an order saved by a request that never finished is returned to the retry, not duplicated", async () => {
    const { key, body } = newCheckout();
    opayCreate("ok");
    const first = (await (await place(key, body)).json()) as Placed;
    // As if the server had died after saving the order but before recording the
    // result: the key is free again (a stale claim is taken over the same way).
    await db.delete(idempotencyKey).where(eq(idempotencyKey.key, key));

    const again = await place(key, body);
    expect(again.status).toBe(201);
    const second = (await again.json()) as Placed;
    expect(second.data.id).toBe(first.data.id);
    // No payment URL: the order page mints a fresh session.
    expect(second.data.payment.redirect_url).toBeNull();
    expect(await ordersForKey(key)).toHaveLength(1);
    expect(await newOrderAlerts(first.data.id)).toBe(1);
  });

  it("does not hand an existing order to a different customer who presents its key", async () => {
    const { key, body } = newCheckout();
    opayCreate("ok");
    await place(key, body);
    await db.delete(idempotencyKey).where(eq(idempotencyKey.key, key));

    const stranger = { ...body, customer: { ...body.customer, phone: "+2348025599999" } };
    const res = await place(key, stranger);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_reused",
    );
    expect(await ordersForKey(key)).toHaveLength(1);
  });
});
