# Admin-facing Delivery + WhatsApp Arrangement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move delivery from a customer-driven live-courier checkout to an admin-driven model: the customer just gets told "we'll contact you on WhatsApp," and the admin books the ride in-app from the order page using the details the customer provided, then relays the rider's number over WhatsApp.

**Architecture:** The existing customer live-quote flow and worker auto-dispatch are preserved but gated behind two off-by-default flags. New admin-only API endpoints (`options`/`book`/`cancel`) reuse the existing `ShipbubbleClient` to book a ride from the order detail page. The Shipbubble webhook parser bug (reads `data.order_id` instead of root `order_id`) is fixed so rider status/number flow back. Delivery is ₦0 at checkout; cost is settled with the customer over WhatsApp out-of-band.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM (Postgres), React + TanStack Router (customer SSR + admin SPA), Vitest, Shipbubble REST API.

## Global Constraints

- Quality gates: 0 lint errors, clean typecheck repo-wide, tests green. Run gates before every commit.
- Delivery provider is selected by env via `getDeliveryProvider()`; never instantiate a provider directly in a route. Tests use the mock provider.
- Money is integer NGN. Phone numbers are Nigerian; `wa.me` needs the international form (leading `0` → `234`).
- Both new flags default **off**: `LIVE_COURIER_QUOTES = false` (customer), `AUTO_DISPATCH_DELIVERY` unset/`"false"` (API). Off restores/keeps the new behavior; on restores the legacy behavior.
- New admin endpoints are owner/admin capability (`sales.view` to read options, `sales.manage` to book/cancel) and online-channel orders only.
- Do not delete the legacy live-quote UI or the worker `dispatchDeliveryFromEvent` — only gate them.
- Co-author commits: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Fix Shipbubble webhook parser (root-level fields + rider info)

**Files:**
- Modify: `packages/domain/src/shipbubble.ts` (`ShipbubbleWebhook` interface ~92-96, `parseShipbubbleWebhook` ~376-397)
- Modify: `apps/api/src/delivery/shipbubble-live.ts` (`parseWebhook` ~157-164)
- Test: `packages/domain/src/shipbubble.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseShipbubbleWebhook(rawBody: string): ShipbubbleWebhook | null` where `ShipbubbleWebhook` gains `rider?: { name?: string; phone?: string; vehicle?: string }`. Reads root-level `order_id`/`status` with `data.*` fallback.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/shipbubble.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseShipbubbleWebhook } from "./shipbubble.js";

describe("parseShipbubbleWebhook", () => {
  it("reads root-level order_id and status (current Shipbubble payload)", () => {
    const body = JSON.stringify({
      event: "shipment.status.changed",
      order_id: "SB-6BAD4363F17C",
      status: "in_transit",
      courier: { name: "Darum NG", rider_info: { name: "Sola A.", phone: "08031234567" } },
    });
    const out = parseShipbubbleWebhook(body);
    expect(out).not.toBeNull();
    expect(out!.externalRef).toBe("SB-6BAD4363F17C");
    expect(out!.status).toBe("in_transit");
    expect(out!.rider?.name).toBe("Sola A.");
    expect(out!.rider?.phone).toBe("08031234567");
  });

  it("maps shipment.cancelled to cancelled", () => {
    const body = JSON.stringify({ event: "shipment.cancelled", order_id: "SB-X", status: "cancelled" });
    expect(parseShipbubbleWebhook(body)!.status).toBe("cancelled");
  });

  it("still parses a legacy nested data.* payload via fallback", () => {
    const body = JSON.stringify({ event: "shipment.status.changed", data: { order_id: "SB-Y", status: "delivered" } });
    const out = parseShipbubbleWebhook(body);
    expect(out!.externalRef).toBe("SB-Y");
    expect(out!.status).toBe("delivered");
  });

  it("returns null for an unknown status", () => {
    const body = JSON.stringify({ event: "shipment.status.changed", order_id: "SB-Z", status: "banana" });
    expect(parseShipbubbleWebhook(body)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/domain && pnpm vitest run src/shipbubble.test.ts`
Expected: FAIL — root-level test gets `null` (parser reads `data.order_id`), rider assertions fail.

- [ ] **Step 3: Update the `ShipbubbleWebhook` interface**

In `packages/domain/src/shipbubble.ts`, replace the interface (~92-96):

```typescript
export interface ShipbubbleWebhook {
  externalRef: string;
  status: NormalizedDeliveryStatus;
  rider?: { name?: string; phone?: string; vehicle?: string };
  raw: unknown;
}
```

- [ ] **Step 4: Rewrite `parseShipbubbleWebhook` to read root-level fields + rider**

Replace the function body (~376-397) with:

```typescript
export function parseShipbubbleWebhook(rawBody: string): ShipbubbleWebhook | null {
  let payload: {
    event?: string;
    order_id?: string;
    status?: string;
    courier?: {
      name?: string;
      phone?: string;
      rider_info?: { name?: string; phone?: string; vehicle?: string } | null;
    };
    data?: { order_id?: string; status?: string };
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return null;
  }
  // Current Shipbubble payloads put order_id/status at the root; older/nested
  // shapes carried them under `data`. Prefer root, fall back to data.
  const orderId = payload.order_id ?? payload.data?.order_id;
  if (!orderId) return null;

  const rider = riderFrom(payload.courier);

  if (payload.event === "shipment.cancelled") {
    return { externalRef: orderId, status: "cancelled", ...(rider ? { rider } : {}), raw: payload };
  }
  const rawStatus = payload.status ?? payload.data?.status;
  if (!rawStatus) return null;
  const status = mapShipbubbleStatus(rawStatus);
  if (!status) return null;
  return { externalRef: orderId, status, ...(rider ? { rider } : {}), raw: payload };
}

function riderFrom(
  courier:
    | { name?: string; phone?: string; rider_info?: { name?: string; phone?: string; vehicle?: string } | null }
    | undefined,
): { name?: string; phone?: string; vehicle?: string } | undefined {
  if (!courier) return undefined;
  const info = courier.rider_info ?? undefined;
  const name = info?.name ?? undefined;
  const phone = info?.phone ?? undefined;
  const vehicle = info?.vehicle ?? undefined;
  if (!name && !phone && !vehicle) return undefined;
  return { ...(name ? { name } : {}), ...(phone ? { phone } : {}), ...(vehicle ? { vehicle } : {}) };
}
```

- [ ] **Step 5: Pass rider through in the live provider**

In `apps/api/src/delivery/shipbubble-live.ts`, replace `parseWebhook` (~157-164):

```typescript
  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null {
    if (!this.verifySignature(rawBody, signature)) {
      throw new Error("invalid signature");
    }
    const parsed = parseShipbubbleWebhook(rawBody);
    if (!parsed) return null;
    return {
      externalRef: parsed.externalRef,
      status: parsed.status,
      ...(parsed.rider ? { rider: parsed.rider } : {}),
      raw: parsed.raw,
    };
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/domain && pnpm vitest run src/shipbubble.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Rebuild domain + typecheck API**

Run: `cd packages/domain && pnpm build && cd ../../apps/api && pnpm typecheck`
Expected: no errors. (The `@ms/db`/domain rebuild rule applies — see `reference_migration_journal`/build memory.)

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/shipbubble.ts packages/domain/src/shipbubble.test.ts apps/api/src/delivery/shipbubble-live.ts
git commit -m "fix(shipbubble): parse root-level webhook order_id/status + rider info"
```

---

### Task 2: Gate auto-dispatch behind `AUTO_DISPATCH_DELIVERY`

**Files:**
- Create: `apps/api/src/lib/delivery-flags.ts`
- Modify: `apps/api/src/routes/webhooks-payaza.ts` (~150-161)
- Modify: `apps/api/src/routes/preorder-shared.ts` (~138-143)
- Test: `apps/api/test/integration/online-order.test.ts` (~409-413)

**Interfaces:**
- Consumes: nothing.
- Produces: `autoDispatchEnabled(): boolean` — true only when `process.env.AUTO_DISPATCH_DELIVERY === "true"`.

- [ ] **Step 1: Create the flag helper**

Create `apps/api/src/lib/delivery-flags.ts`:

```typescript
/**
 * Auto-dispatch was the legacy behavior: paying for an immediate in-Lagos order
 * emitted `delivery.request` and the worker booked a ride automatically. The
 * business now books rides manually from the admin order page, so this is OFF
 * by default. Flip AUTO_DISPATCH_DELIVERY=true to restore the old flow.
 */
export function autoDispatchEnabled(): boolean {
  return process.env["AUTO_DISPATCH_DELIVERY"] === "true";
}
```

- [ ] **Step 2: Update the failing integration expectation**

In `apps/api/test/integration/online-order.test.ts`, find the test "immediate Lagos order: emits BOTH sale.paid_online and delivery.request" (~409). Change its delivery.request expectation to assert it is NOT emitted while the flag is off:

```typescript
  it("immediate Lagos order: emits sale.paid_online but NOT delivery.request when auto-dispatch is off", async () => {
    // ...existing arrange/act that pays an immediate in-Lagos order, producing `mine`...
    expect(mine.some((e) => e.eventType === "sale.paid_online")).toBe(true);
    expect(mine.some((e) => e.eventType === "delivery.request")).toBe(false);
  });
```

(Keep the existing arrange/act lines for that test; only the title and the delivery.request assertion change from `true` to `false`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run test/integration/online-order.test.ts -t "immediate Lagos"`
Expected: FAIL — `delivery.request` is currently still emitted, so the `toBe(false)` assertion fails.

- [ ] **Step 4: Gate the payaza emission**

In `apps/api/src/routes/webhooks-payaza.ts`, add the import near the top with the other local imports:

```typescript
import { autoDispatchEnabled } from "../lib/delivery-flags.js";
```

Replace the bypass block (~147-161) so the flag short-circuits emission:

```typescript
      // Auto-dispatch is OFF by default — rides are booked manually from the
      // admin order page. When AUTO_DISPATCH_DELIVERY=true, fall back to the
      // legacy behavior: immediate, in-Lagos, in-stock orders request a ride now
      // (preorders / scheduled / outside-Lagos are always fulfilled out of band).
      const outsideLagos = isOutsideLagos(o.deliveryState);
      const bypass = o.isPreorder || o.scheduledDeliveryAt != null || outsideLagos;
      if (autoDispatchEnabled() && !bypass) {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.request",
          payload: {
            sale_order_id: o.id,
            order_number: o.orderNumber,
            branch_id: o.branchId,
          },
        });
      }
```

- [ ] **Step 5: Gate the preorder-fulfil emission**

In `apps/api/src/routes/preorder-shared.ts`, add the import:

```typescript
import { autoDispatchEnabled } from "./../lib/delivery-flags.js";
```

(Match the existing relative-import style in that file; it lives in `apps/api/src/routes/`, so the helper is `../lib/delivery-flags.js`.)

Replace the emission block (~138-143):

```typescript
    if (!toCounter && autoDispatchEnabled()) {
      await tx.insert(outboxEvent).values({
        eventType: "delivery.request",
        payload: { sale_order_id: id, order_number: o.orderNumber, branch_id: o.branchId },
      });
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run test/integration/online-order.test.ts`
Expected: PASS — the immediate-Lagos test now sees no `delivery.request`; the scheduled/outside-Lagos tests still pass.

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/delivery-flags.ts apps/api/src/routes/webhooks-payaza.ts apps/api/src/routes/preorder-shared.ts apps/api/test/integration/online-order.test.ts
git commit -m "feat(delivery): gate auto-dispatch behind AUTO_DISPATCH_DELIVERY (default off)"
```

---

### Task 3: Return customer name/phone on the sale-detail endpoint

**Files:**
- Modify: `apps/api/src/routes/sales.ts` (`r.get("/:id")` ~618-636)
- Test: `apps/api/test/integration/online-order.test.ts` (add one assertion to an existing order-detail fetch, or a focused new test)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /branches/:branchId/sales/:id` response `data` now includes `customerName: string | null` and `customerPhone: string | null` alongside the existing fields and `delivery`.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/online-order.test.ts`, add a test that places an online order with a known customer name/phone, fetches the order detail, and asserts the new fields. Use the suite's existing helpers for placing an order and the authenticated `request` client (mirror an existing detail-fetch test in the file):

```typescript
  it("sale detail returns customerName and customerPhone", async () => {
    // Arrange: place an online order for a customer named "Ada Test" / phone "08099887766"
    // using the suite's existing order-placement helper, capturing saleOrderId + branchId.
    const res = await authedGet(`/v1/branches/${branchId}/sales/${saleOrderId}`); // use the file's existing GET helper
    expect(res.status).toBe(200);
    expect(res.body.data.customerName).toBe("Ada Test");
    expect(res.body.data.customerPhone).toBe("08099887766");
  });
```

(Adapt `authedGet`/body access to the file's actual test client. If the file places orders via a helper that doesn't set a customer name, set name `"Ada Test"` and phone `"08099887766"` in that helper call.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run test/integration/online-order.test.ts -t "customerName"`
Expected: FAIL — `customerName`/`customerPhone` are `undefined`.

- [ ] **Step 3: Join the customer in the detail route**

In `apps/api/src/routes/sales.ts`, add `customer` to the schema import block (top, alongside `saleOrder` etc.):

```typescript
  customer,
```

Then update `r.get("/:id")` (~618-636) to load the customer and include the fields:

```typescript
  r.get("/:id", requireCapability("sales.view"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "sale not found", 404);
    const items = await db
      .select()
      .from(saleOrderItem)
      .where(eq(saleOrderItem.saleOrderId, id));
    // Customer contact for the order page (WhatsApp link + rider relay).
    let customerName: string | null = null;
    let customerPhone: string | null = null;
    if (o.customerId) {
      const [cust] = await db
        .select({ name: customer.name, phone: customer.phone })
        .from(customer)
        .where(eq(customer.id, o.customerId));
      customerName = cust?.name ?? null;
      customerPhone = cust?.phone ?? null;
    }
    // Latest delivery_order if any (single source of truth for rider info).
    const { deliveryOrder } = await import("@ms/db");
    const { desc: descFn } = await import("drizzle-orm");
    const [delivery] = await db
      .select()
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, id))
      .orderBy(descFn(deliveryOrder.requestedAt))
      .limit(1);
    return c.json({
      data: { ...o, items, customerName, customerPhone, delivery: delivery ?? null },
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run test/integration/online-order.test.ts -t "customerName"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/api && pnpm typecheck`

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/online-order.test.ts
git commit -m "feat(sales): include customerName/customerPhone in order detail"
```

---

### Task 4: Admin delivery endpoints — options / book / cancel

**Files:**
- Create: `apps/api/src/routes/delivery-admin.ts`
- Modify: the API app wiring where branch sub-routers mount (search for where `salesRoutes`/`/sales` is mounted under `/branches/:branchId`) to mount the new router at `/branches/:branchId/sales/:saleId/delivery`
- Test: `apps/api/test/integration/delivery-admin.test.ts` (create)

**Interfaces:**
- Consumes: `getDeliveryProvider()` (`apps/api/src/delivery/index.js`); `DeliveryProvider.quoteOptions`, `.requestDelivery`, `.cancelDelivery`.
- Produces three routes (capability-gated, online-channel only):
  - `GET  …/delivery/options` → `{ data: { quote_token, receiver_address_code, options: Array<{ id, courier_name, fee_ngn, eta_minutes }> } }`
  - `POST …/delivery/book` body `{ option_id: string, fee_ngn: number, receiver_address_code?: number }` → `{ data: <deliveryOrder row> }`; 409 if a non-cancelled delivery already exists.
  - `POST …/delivery/cancel` → `{ data: { status: "cancelled" } }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/delivery-admin.test.ts`. Use the suite's existing testcontainer + auth bootstrap (copy the `beforeAll`/`request` setup from `online-order.test.ts`). With the default **mock** provider:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
// import the shared test harness exactly as online-order.test.ts does
// (app builder, migrate/seed, authed request client, order-placement helper).

describe("admin delivery endpoints (mock provider)", () => {
  let branchId: string;
  let saleId: string;

  beforeAll(async () => {
    // boot app, seed, place an online in-Lagos order with a customer that has
    // name "Ada Test", phone "08099887766", address "12 Allen Ave, Ikeja".
    // capture branchId + saleId.
  });

  it("GET options returns at least one courier", async () => {
    const res = await authedGet(`/v1/branches/${branchId}/sales/${saleId}/delivery/options`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.options)).toBe(true);
    expect(res.body.data.options.length).toBeGreaterThan(0);
    expect(res.body.data.options[0]).toHaveProperty("id");
    expect(res.body.data.options[0]).toHaveProperty("fee_ngn");
  });

  it("POST book creates a delivery_order and is idempotent", async () => {
    const opt = (await authedGet(`/v1/branches/${branchId}/sales/${saleId}/delivery/options`)).body.data.options[0];
    const book = await authedPost(`/v1/branches/${branchId}/sales/${saleId}/delivery/book`, {
      option_id: opt.id, fee_ngn: opt.fee_ngn,
    });
    expect(book.status).toBe(200);
    expect(book.body.data.externalRef).toBeTruthy();

    const again = await authedPost(`/v1/branches/${branchId}/sales/${saleId}/delivery/book`, {
      option_id: opt.id, fee_ngn: opt.fee_ngn,
    });
    expect(again.status).toBe(409);
  });
});
```

(Replace `authedGet`/`authedPost`/order-placement with the file harness's real helpers, matching `online-order.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run test/integration/delivery-admin.test.ts`
Expected: FAIL — routes 404 (not mounted yet).

- [ ] **Step 3: Implement the router**

Create `apps/api/src/routes/delivery-admin.ts`:

```typescript
import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { saleOrder, deliveryOrder, branch, customer, type DbClient } from "@ms/db";
import { requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { getDeliveryProvider } from "../delivery/index.js";

/**
 * Admin-facing delivery actions for a single online order. Mounted under
 * /branches/:branchId/sales/:saleId/delivery. Rides are booked manually here
 * (auto-dispatch is off) using the address/phone/name the customer provided at
 * checkout. Delivery is ₦0 to the customer; the courier fee shown here is what
 * the admin quotes the customer over WhatsApp.
 */
export function deliveryAdminRoutes(db: DbClient) {
  const r = new Hono();

  // Resolve the order + its pickup branch + customer contact, or throw.
  async function load(saleId: string) {
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    if (o.channel === "walkup") {
      throw new BusinessError("conflict", "delivery is only for online orders", 409);
    }
    const [b] = await db.select().from(branch).where(eq(branch.id, o.branchId));
    if (!b || !b.address) {
      throw new BusinessError("conflict", "pickup branch has no address on file", 409);
    }
    let custName = "Customer";
    let custPhone = "";
    let custAddress = o.deliveryAddress ?? "";
    if (o.customerId) {
      const [cust] = await db.select().from(customer).where(eq(customer.id, o.customerId));
      if (cust) {
        custName = cust.name ?? custName;
        custPhone = cust.phone ?? "";
        custAddress = o.deliveryAddress ?? cust.defaultAddress ?? "";
      }
    }
    if (!custAddress || !custPhone) {
      throw new BusinessError("conflict", "order is missing a delivery address or phone", 409);
    }
    // Mirror the storefront's address completion so geocoding succeeds.
    const dropoff = normalizeDropoff(custAddress, o.deliveryState ?? undefined);
    return { o, b, custName, custPhone, dropoff };
  }

  // GET options — live courier rates for this route.
  r.get("/options", requireCapability("sales.view"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    const { b, dropoff } = await load(saleId);
    const provider = getDeliveryProvider();
    const q = await provider.quoteOptions({
      pickupAddress: b.address as string,
      pickupLat: b.lat != null ? Number(b.lat) : null,
      pickupLng: b.lng != null ? Number(b.lng) : null,
      dropoffAddress: dropoff,
    });
    return c.json({
      data: {
        quote_token: q.quoteToken,
        receiver_address_code: q.validatedAddress?.addressCode ?? null,
        options: q.options.map((o) => ({
          id: o.id,
          courier_name: o.courierName,
          fee_ngn: o.feeNgn,
          eta_minutes: o.etaMinutes,
        })),
      },
    });
  });

  // POST book — create the label, persist the delivery_order.
  r.post("/book", requireCapability("sales.manage"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    const body = (await c.req.json()) as {
      option_id?: string;
      fee_ngn?: number;
      receiver_address_code?: number;
    };
    if (!body.option_id) throw new BusinessError("validation_failed", "option_id required", 400);
    const feeNgn = Number.isFinite(body.fee_ngn) ? Math.round(body.fee_ngn as number) : 0;

    const { o, b, custName, custPhone, dropoff } = await load(saleId);

    // Idempotency: refuse if a live (non-cancelled) delivery already exists.
    const [existing] = await db
      .select({ id: deliveryOrder.id, status: deliveryOrder.status })
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, o.id))
      .orderBy(desc(deliveryOrder.requestedAt))
      .limit(1);
    if (existing && existing.status !== "cancelled") {
      throw new BusinessError("conflict", "a delivery already exists for this order", 409);
    }

    const provider = getDeliveryProvider();
    const result = await provider.requestDelivery({
      saleOrderId: o.id,
      orderNumber: o.orderNumber,
      providerQuoteId: body.option_id,
      pickupAddress: b.address as string,
      pickupLat: b.lat != null ? Number(b.lat) : 0,
      pickupLng: b.lng != null ? Number(b.lng) : 0,
      dropoffAddress: dropoff,
      customerName: custName,
      customerPhone: custPhone,
      ...(body.receiver_address_code != null
        ? { receiverAddressCode: body.receiver_address_code }
        : {}),
    });

    const [row] = await db
      .insert(deliveryOrder)
      .values({
        saleOrderId: o.id,
        provider: provider.name,
        externalRef: result.externalRef,
        pickupBranchId: b.id,
        pickupAddress: b.address as string,
        pickupLat: b.lat,
        pickupLng: b.lng,
        dropoffAddress: dropoff,
        quotedFeeNgn: feeNgn,
        etaMinutes: result.initialEtaMinutes,
        trackingUrl: result.trackingUrl,
        status: "searching_rider",
      })
      .returning();

    await db
      .update(saleOrder)
      .set({ deliveryProviderRef: result.externalRef, updatedAt: new Date() })
      .where(eq(saleOrder.id, o.id));

    return c.json({ data: row });
  });

  // POST cancel — cancel the latest live delivery.
  r.post("/cancel", requireCapability("sales.manage"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    const [row] = await db
      .select()
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, saleId))
      .orderBy(desc(deliveryOrder.requestedAt))
      .limit(1);
    if (!row || !row.externalRef) {
      throw new BusinessError("not_found", "no delivery to cancel", 404);
    }
    if (row.status === "cancelled") return c.json({ data: { status: "cancelled" } });
    const provider = getDeliveryProvider();
    await provider.cancelDelivery(row.externalRef);
    const now = new Date();
    await db
      .update(deliveryOrder)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(deliveryOrder.id, row.id));
    return c.json({ data: { status: "cancelled" } });
  });

  return r;
}

/**
 * Shipbubble's validator needs a complete address string (street, area, state,
 * country). Append the delivery state + "Nigeria" when missing — mirrors the
 * storefront's normalizeDropoff so admin bookings geocode as well as the
 * customer preview did.
 */
function normalizeDropoff(addr: string, state?: string): string {
  const a = addr.trim().replace(/,\s*$/, "");
  if (/nigeria/i.test(a)) return a;
  const st = state && state.trim() ? state.trim() : "Lagos";
  return new RegExp(st, "i").test(a) ? `${a}, Nigeria` : `${a}, ${st}, Nigeria`;
}
```

- [ ] **Step 4: Mount the router**

Find where the sales router mounts under branches (search the API app for `"/sales"` route mounting, e.g. `branchRouter.route("/:branchId/sales", salesRoutes(db))` or similar in `apps/api/src/app.ts`/`test-app.ts`). Mount the new router so `:saleId` is a path param. Add alongside it:

```typescript
import { deliveryAdminRoutes } from "./routes/delivery-admin.js";
// ...where other branch sub-routes mount (same db instance, same auth chain):
branchRouter.route("/:branchId/sales/:saleId/delivery", deliveryAdminRoutes(db));
```

Confirm the mount path makes `c.req.param("saleId")` and `c.req.param("branchId")` available (Hono nested params are inherited). If the existing sales mount swallows `/:saleId/...`, mount the delivery router on the same parent that mounts `/:branchId` so the longer path matches first.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run test/integration/delivery-admin.test.ts`
Expected: PASS — options returns couriers (mock), book creates a row + second book is 409.

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/api && pnpm typecheck`

```bash
git add apps/api/src/routes/delivery-admin.ts apps/api/src/app.ts apps/api/test/integration/delivery-admin.test.ts
git commit -m "feat(delivery): admin options/book/cancel endpoints for online orders"
```

(Adjust the staged app-wiring file to wherever the mount actually lives.)

---

### Task 5: Customer checkout — strip live courier behind `LIVE_COURIER_QUOTES`

**Files:**
- Create: `apps/customer/src/lib/flags.ts`
- Modify: `apps/customer/src/routes/checkout.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const LIVE_COURIER_QUOTES = false` controlling whether the checkout shows the legacy courier picker or the new WhatsApp notice.

This task has no automated test (the customer app has no component tests — see `reference_quality_gates`). Verification is typecheck + build + manual.

- [ ] **Step 1: Create the flag module**

Create `apps/customer/src/lib/flags.ts`:

```typescript
/**
 * When false (default), checkout collects delivery details but shows NO courier
 * options and NO delivery fee — the admin books the ride and contacts the
 * customer on WhatsApp. Flip to true to restore the legacy live-courier picker.
 */
export const LIVE_COURIER_QUOTES = false;
```

- [ ] **Step 2: Import the flag and short-circuit the quote effect**

In `apps/customer/src/routes/checkout.tsx`, add to the imports:

```typescript
import { LIVE_COURIER_QUOTES } from "@/lib/flags";
```

Change `wantQuote` (~69) so the live quote only runs when the flag is on:

```typescript
  const wantQuote =
    LIVE_COURIER_QUOTES && !outsideLagos && !scheduled && form.address.trim().length >= 5 && !!branchId;
```

- [ ] **Step 3: Force delivery fee to 0 when the flag is off**

Change `deliveryFee` (~98):

```typescript
  const deliveryFee =
    !LIVE_COURIER_QUOTES || outsideLagos || scheduled ? 0 : (selectedOption?.fee_ngn ?? 0);
```

- [ ] **Step 4: Replace the "Deliver now" toggle description + delivery section**

In the "When?" section, the "Deliver now" Toggle `desc` (~256) currently says "Live courier today". Change that branch so it no longer promises live courier when the flag is off:

```typescript
                  <Toggle active={form.when === "now"} disabled={hasPreorder} onClick={() => set("when", "now")} icon={<Truck className="h-4 w-4" />} title="Deliver now" desc={hasPreorder ? "Not available for preorder" : LIVE_COURIER_QUOTES && !outsideLagos ? "Live courier today" : "Arranged after checkout"} />
```

In the "Delivery cost" section (~285-320), wrap the courier-picker branches so they only render under the flag, and add the WhatsApp notice as the default. Replace the conditional chain body with:

```typescript
                <h2 className="font-display text-2xl text-[color:var(--brand)]">Delivery</h2>
                {outsideLagos ? (
                  <p className="mt-3 rounded-2xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/75">
                    <span className="font-semibold text-[color:var(--brand)]">Outside Lagos.</span> We'll arrange delivery to {form.state} and confirm logistics with you separately. No delivery fee is charged now.
                  </p>
                ) : scheduled ? (
                  <p className="mt-3 rounded-2xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/75">
                    <span className="font-semibold text-[color:var(--brand)]">Scheduled.</span> We'll deliver on {form.date}, {WINDOWS.find((w) => w.id === form.window)?.label}. No rider fee is charged now.
                  </p>
                ) : !LIVE_COURIER_QUOTES ? (
                  <p className="mt-3 rounded-2xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/75">
                    <span className="font-semibold text-[color:var(--brand)]">We'll contact you on WhatsApp</span> to arrange delivery and confirm the cost once your order is in. No delivery fee is charged now.
                  </p>
                ) : quoting ? (
                  <div className="mt-3 flex items-center gap-2 text-sm text-[color:var(--brand)]/60"><Loader2 className="h-4 w-4 animate-spin" /> Finding couriers…</div>
                ) : options.length > 0 ? (
                  <div className="mt-3 grid gap-2">
                    {options.map((o) => {
                      const active = o.id === selectedId;
                      return (
                        <button key={o.id} onClick={() => setSelectedId(o.id)} className={`flex items-center justify-between rounded-2xl px-4 py-3 text-left ring-2 transition ${active ? "ring-[color:var(--brand-orange)] bg-[color:var(--brand-orange)]/5" : "ring-black/5 hover:ring-black/15"}`}>
                          <div>
                            <div className="font-semibold text-[color:var(--brand)]">{o.courier_name}</div>
                            <div className="text-xs text-[color:var(--brand)]/60">{o.eta_minutes != null ? `~${o.eta_minutes} min` : "ETA on dispatch"}{o.on_demand ? " · on-demand" : ""}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[color:var(--brand)]">{formatNaira(o.fee_ngn)}</span>
                            {active && <Check className="h-4 w-4 text-[color:var(--brand-orange)]" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-3 rounded-2xl bg-[color:var(--cream)]/60 p-4 text-sm text-[color:var(--brand)]/75">
                    {form.address.trim().length >= 5 ? (quoteNotice ?? "No delivery fee is charged now.") : "Enter your address to see delivery options."}
                  </p>
                )}
```

- [ ] **Step 5: Keep the order summary "Delivery" row honest**

Change the summary Row (~340) so it shows ₦0 when the flag is off:

```typescript
                <Row label="Delivery" value={!LIVE_COURIER_QUOTES || outsideLagos || scheduled ? "₦0" : selectedOption ? formatNaira(deliveryFee) : "—"} />
```

The `submit()` body already omits `delivery_quote_id` unless `selectedOption` is set; with the flag off `selectedOption` is always null, so `delivery_fee_ngn: deliveryFee` sends `0`. No change needed there.

- [ ] **Step 6: Typecheck + build**

Run: `cd apps/customer && pnpm typecheck && pnpm build`
Expected: no errors. (`requestQuote` import stays — still used when the flag is on. The unused-var lint must stay clean; `options`/`quoting`/`selectedId` are all still referenced in the flag-on branches.)

- [ ] **Step 7: Manual check**

Run the customer app locally (`reference_local_run`), add an item, go to checkout, enter a Lagos address. Confirm: no "Finding couriers…", the WhatsApp notice shows, Delivery row reads ₦0, total = subtotal, and Place order works.

- [ ] **Step 8: Commit**

```bash
git add apps/customer/src/lib/flags.ts apps/customer/src/routes/checkout.tsx
git commit -m "feat(checkout): hide live courier behind LIVE_COURIER_QUOTES, show WhatsApp notice"
```

---

### Task 6: Admin order page — delivery workstation

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx`

**Interfaces:**
- Consumes: `GET/POST /branches/:branchId/sales/:saleId/delivery/{options,book,cancel}` (Task 4); `customerName`/`customerPhone`/`delivery` from the detail endpoint (Task 3); `ConfirmModal` (`../../components/ConfirmModal.js`); `api` (`../../lib/api.js`).
- Produces: a reworked Delivery card with options→book flow, rider info, a WhatsApp-customer button, and cancel.

No automated test (admin has no component tests). Verify with typecheck + build + manual.

- [ ] **Step 1: Extend the `Sale` type + capture the owning branch id**

In `order-detail.tsx`, extend the `Sale` interface (~21-47):

```typescript
  customerName?: string | null;
  customerPhone?: string | null;
  delivery?: {
    provider: "bolt" | "manual" | "shipbubble";
    status: string;
    externalRef?: string | null;
    riderName: string | null;
    riderPhone: string | null;
    riderVehicle: string | null;
    etaMinutes: number | null;
    trackingUrl: string | null;
    quotedFeeNgn?: number | null;
    actualFeeNgn?: number | null;
  } | null;
```

Add state for the owning branch id (needed to call the delivery endpoints). In the fetch effect (~120-138) where `owningBranch` is found, also store its id:

```typescript
  const [branchId, setBranchId] = useState<string>("");
```

and in the effect after `setBranchName(owningBranch?.name ?? "")`:

```typescript
        setBranchId(owningBranch?.id ?? "");
```

- [ ] **Step 2: Add delivery booking state + handlers**

Inside `OrderDetailPage`, add:

```typescript
  interface CourierOption { id: string; courier_name: string; fee_ngn: number; eta_minutes: number | null }
  const [options, setOptions] = useState<CourierOption[] | null>(null);
  const [receiverCode, setReceiverCode] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [picked, setPicked] = useState<CourierOption | null>(null);
  const [booking, setBooking] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  async function reloadOrder(): Promise<void> {
    const res = await api<{ data: Sale }>(`/branches/${branchId}/sales/${saleId}`);
    setData(res.data);
  }

  async function getOptions(): Promise<void> {
    setLoadingOptions(true);
    setDeliveryError(null);
    try {
      const res = await api<{ data: { receiver_address_code: number | null; options: CourierOption[] } }>(
        `/branches/${branchId}/sales/${saleId}/delivery/options`,
      );
      setOptions(res.data.options);
      setReceiverCode(res.data.receiver_address_code);
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOptions(false);
    }
  }

  async function confirmBook(): Promise<void> {
    if (!picked) return;
    setBooking(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${saleId}/delivery/book`, {
        method: "POST",
        body: JSON.stringify({
          option_id: picked.id,
          fee_ngn: picked.fee_ngn,
          ...(receiverCode != null ? { receiver_address_code: receiverCode } : {}),
        }),
      });
      setPicked(null);
      setOptions(null);
      await reloadOrder();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setBooking(false);
    }
  }

  async function cancelRide(): Promise<void> {
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/sales/${saleId}/delivery/cancel`, { method: "POST", body: "{}" });
      await reloadOrder();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    }
  }

  function waLink(phone: string): string {
    const digits = phone.replace(/\D/g, "").replace(/^0/, "234");
    const d = data?.delivery;
    const msg = encodeURIComponent(
      `Hi${data?.customerName ? " " + data.customerName : ""}, your Mrs. Samuel order ${data?.orderNumber} is on the way.` +
        (d?.riderName ? ` Rider: ${d.riderName}.` : "") +
        (d?.riderPhone ? ` Number: ${d.riderPhone}.` : "") +
        (d?.trackingUrl ? ` Track: ${d.trackingUrl}` : ""),
    );
    return `https://wa.me/${digits}?text=${msg}`;
  }
```

Add `ConfirmModal` to the imports:

```typescript
import { ConfirmModal } from "../../components/ConfirmModal.js";
```

- [ ] **Step 3: Replace the Delivery aside card**

Replace the Delivery `<section>` inside the `<aside>` (~315-340) with the workstation. Show booking UI when there's no live delivery, rider info + WhatsApp + cancel when there is:

```typescript
            {data.deliveryAddress && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Delivery</h3>
                <div style={{ fontSize: 14 }}>{data.deliveryAddress}</div>
                {data.customerPhone && (
                  <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                    {data.customerName ?? "Customer"} · {data.customerPhone}
                  </div>
                )}

                {deliveryError && (
                  <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{deliveryError}</p>
                )}

                {/* Booked delivery */}
                {data.delivery && data.delivery.status !== "cancelled" ? (
                  <div style={{ marginTop: 10, fontSize: 13 }}>
                    <div style={{ color: "var(--ink-soft)" }}>
                      {data.delivery.provider} · {data.delivery.status}
                      {data.delivery.quotedFeeNgn != null && <> · {ngn(data.delivery.quotedFeeNgn)}</>}
                    </div>
                    {data.delivery.riderName && <div style={{ marginTop: 4 }}>Rider: {data.delivery.riderName}</div>}
                    {data.delivery.riderPhone && <div>Rider phone: {data.delivery.riderPhone}</div>}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                      {data.customerPhone && (
                        <a className="btn btn--primary btn--sm" href={waLink(data.customerPhone)} target="_blank" rel="noopener noreferrer">
                          WhatsApp customer
                        </a>
                      )}
                      {data.delivery.trackingUrl && (
                        <a className="btn btn--subtle btn--sm" href={data.delivery.trackingUrl} target="_blank" rel="noopener noreferrer">
                          Track →
                        </a>
                      )}
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void cancelRide()}>
                        Cancel ride
                      </button>
                    </div>
                  </div>
                ) : !data.customerPhone ? (
                  <p style={{ fontSize: 13, color: "var(--warning)", marginTop: 10 }}>
                    No customer phone on this order — arrange delivery manually.
                  </p>
                ) : options ? (
                  /* Options fetched — pick a courier */
                  <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                    {options.length === 0 && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>No couriers available for this route right now.</p>}
                    {options.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setPicked(o)}
                        className="btn btn--subtle btn--sm"
                        style={{ justifyContent: "space-between", textAlign: "left" }}
                      >
                        <span>{o.courier_name}{o.eta_minutes != null ? ` · ~${o.eta_minutes}m` : ""}</span>
                        <strong>{ngn(o.fee_ngn)}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    style={{ marginTop: 10 }}
                    disabled={loadingOptions || !branchId}
                    onClick={() => void getOptions()}
                  >
                    {loadingOptions ? "Getting options…" : "Get delivery options"}
                  </button>
                )}
              </section>
            )}
```

- [ ] **Step 4: Add the confirm modal**

Just before the closing `</Shell>` (after the main grid), render the booking confirm:

```typescript
      {picked && (
        <ConfirmModal
          title="Book this ride?"
          confirmLabel="Book ride"
          busyLabel="Booking…"
          busy={booking}
          onCancel={() => setPicked(null)}
          onConfirm={() => void confirmBook()}
        >
          <p style={{ fontSize: 14 }}>
            Book <strong>{picked.courier_name}</strong> for <strong>{ngn(picked.fee_ngn)}</strong>. This debits the
            Shipbubble wallet. Tell the customer this amount on WhatsApp.
          </p>
        </ConfirmModal>
      )}
```

- [ ] **Step 5: Remove the stale "Bolt not dispatched" banner**

Delete the warning block (~212-234) that reads "Manual fulfilment — Bolt not dispatched … Arrange delivery manually". The Delivery card now owns that responsibility. Keep the `statusPill(data.status)` line.

- [ ] **Step 6: Typecheck + build**

Run: `cd apps/admin && pnpm typecheck && pnpm build`
Expected: no errors. (Confirm `ngn`, `api`, `ConfirmModal` imports resolve; remove the now-unused warning JSX without leaving dangling vars.)

- [ ] **Step 7: Manual check**

Run admin locally (`reference_local_run`), open an online order detail. Confirm: customer name/phone show; "Get delivery options" lists couriers (mock or sandbox); picking one opens the confirm modal with the fee; booking shows rider/status + a "WhatsApp customer" button whose `wa.me` link is correctly formatted (`0…`→`234…`) and pre-filled; "Cancel ride" works.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/routes/owner/order-detail.tsx
git commit -m "feat(admin): delivery workstation on order page (options/book/rider/WhatsApp)"
```

---

## Self-Review

**Spec coverage:**
- Customer ₦0 + WhatsApp notice, legacy hidden behind flag → Task 5. ✓
- Stop auto-dispatch (gated, not deleted) → Task 2. ✓
- Admin options/book/cancel endpoints → Task 4. ✓
- customerPhone/Name on detail → Task 3. ✓
- Admin order-page workstation + wa.me button → Task 6. ✓
- Webhook parser fix (root-level + rider) → Task 1. ✓
- Worker `dispatchDeliveryFromEvent` untouched → confirmed (only the emission is gated). ✓
- Phase 2 automated WhatsApp → not built (documented in spec). ✓
- No migration needed → confirmed; reuses existing `delivery_order` columns. ✓

**Placeholder scan:** Test harness helper names in Tasks 3/4 (`authedGet`/`authedPost`/order-placement) are deliberately deferred to "match `online-order.test.ts`" because that file's exact client is its own; the surrounding assertions and routes are concrete. The Task 4 mount file is flagged as "wherever the mount lives" — the implementer must grep for the sales mount. These are the only non-literal spots and each names exactly what to copy.

**Type consistency:** `option_id`/`fee_ngn`/`receiver_address_code` match between Task 4 (endpoint), Task 6 (`confirmBook`). `delivery.provider` union includes `"shipbubble"` in both the API (`deliveryProvider` enum) and the admin `Sale` type (Task 6 Step 1). `ShipbubbleWebhook.rider` (Task 1) matches `NormalizedWebhook.rider` consumed by the existing webhook handler. `autoDispatchEnabled()` name consistent across Task 2 files.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-20-admin-facing-delivery.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
