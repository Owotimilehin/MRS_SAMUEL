# Customer Order-Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the customer post-purchase experience into a hybrid order-tracking screen — live rider stepper when a rider is dispatched, honest scheduled/WhatsApp-coordinated states otherwise — plus a `/track` lookup and a payment-hold countdown with resume.

**Architecture:** A pure `deriveJourney(order)` function (the shared status-taxonomy seed) maps the order's fields to a track + ordered steps; the React screen only renders steps. The tracking API endpoint is extended with the fields the screen needs (items, milestone timestamps, reservation expiry, resume-payment config, support WhatsApp link). No DB migration — all timestamp columns already exist.

**Tech Stack:** Hono + Drizzle + Zod (API), TanStack Start/Router + React + Tailwind + framer-motion (customer app), Vitest (tests).

## Global Constraints

- API responses wrap payloads in `{ data: … }`; the customer client's `apiFetch` unwraps `data`. Match this exactly.
- Tracking endpoint stays phone-gated; any auth/phone failure returns the SAME `not_found` 404 (anti-enumeration). Never branch error messages on "order exists but phone wrong".
- `resume_payment` is built ONLY when `status === "confirmed"`, and only after the phone check passes.
- Money is integer naira everywhere (`*_ngn`); Payaza SDK config carries kobo (`amount = ngn * 100`) — already handled by `buildPayazaCheckoutConfig`.
- Customer app uses storefront tokens: `var(--brand)` (deep green), `var(--brand-orange)`, `var(--cream)`, `font-display`, `rounded-[1.5rem]`. Respect `prefers-reduced-motion` (no pulse/spin when set).
- Times shown to customers use `timeZone: "Africa/Lagos"`.
- New env var `SUPPORT_WHATSAPP` is OPTIONAL (`z.preprocess(emptyToUndef, z.string().optional())`); when unset the WhatsApp affordance is hidden, never errors.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.

---

### Task 1: `deriveJourney` status model (pure, the Phase 0 taxonomy seed)

**Files:**
- Create: `apps/customer/src/lib/order-journey.ts`
- Test: `apps/customer/src/lib/order-journey.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export type Track = "live" | "scheduled" | "coordinated";
  export type StepState = "done" | "current" | "upcoming";
  export interface JourneyStep { key: string; label: string; state: StepState; at?: string }
  export interface Journey {
    track: Track;
    steps: JourneyStep[];
    currentStep: JourneyStep;
    methodLabel: string;
    isPreorder: boolean;
    special: "none" | "payment_hold" | "reconcile" | "cancelled";
  }
  export interface TrackingOrderLike {
    status: string;
    payment_status: string;
    is_preorder: boolean;
    scheduled_delivery_at: string | null;
    delivery_state: string | null;
    paid_at: string | null;
    out_for_delivery_at: string | null;
    delivered_at: string | null;
    delivery: { status: string } | null;
  }
  export function deriveJourney(order: TrackingOrderLike): Journey;
  ```
- Track rules (first match wins): `cancelled` status → special `cancelled` (track `coordinated`). Outside Lagos (`delivery_state` set and not `"Lagos"`) → `coordinated`. `scheduled_delivery_at` present → `scheduled`. `delivery` object present → `live`. Else → `coordinated`.
- Special rules: `status === "confirmed"` → `payment_hold`; `status === "reconcile_needed"` → `reconcile`; `status === "cancelled"` → `cancelled`; else `none`.
- Step keys per track:
  - live: `placed, paid, preparing, on_the_way, delivered`
  - scheduled: `placed, paid, scheduled, out_for_delivery, delivered`
  - coordinated: `placed, paid, arranging, on_the_way, delivered`
- Step state: `placed` always `done`. `paid` `done` if `payment_status === "paid"` (use `paid_at`). The middle step (`preparing`/`scheduled`/`arranging`) is `current` once paid and not yet out-for-delivery. The `on_the_way`/`out_for_delivery` step is `done`/`current` based on `out_for_delivery_at` or `delivery.status` in `{picked_up,in_transit,out_for_delivery}`. `delivered` `done` when `status === "delivered"` (`delivered_at`). The first non-`done` step is `current`; all after it `upcoming`. If all milestones done, `currentStep` is `delivered`.
- `isPreorder` true relabels the `preparing`/`arranging` step label to `"In production 🥤"`.
- `methodLabel`: live → `"Live rider"`; scheduled → `"Scheduled delivery"`; coordinated outside Lagos → `"We'll arrange delivery to {state}"`; coordinated in-Lagos → `"We'll arrange your delivery"`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/customer/src/lib/order-journey.test.ts
import { describe, it, expect } from "vitest";
import { deriveJourney, type TrackingOrderLike } from "./order-journey";

const base: TrackingOrderLike = {
  status: "paid", payment_status: "paid", is_preorder: false,
  scheduled_delivery_at: null, delivery_state: "Lagos",
  paid_at: "2026-06-21T13:00:00Z", out_for_delivery_at: null,
  delivered_at: null, delivery: null,
};

describe("deriveJourney", () => {
  it("live track when a rider exists, in Lagos, immediate", () => {
    const j = deriveJourney({ ...base, delivery: { status: "searching_rider" } });
    expect(j.track).toBe("live");
    expect(j.steps.map((s) => s.key)).toEqual(["placed","paid","preparing","on_the_way","delivered"]);
    expect(j.currentStep.key).toBe("preparing");
    expect(j.methodLabel).toBe("Live rider");
  });

  it("scheduled track when scheduled_delivery_at set", () => {
    const j = deriveJourney({ ...base, scheduled_delivery_at: "2026-06-22T11:00:00Z" });
    expect(j.track).toBe("scheduled");
    expect(j.steps.map((s) => s.key)).toContain("scheduled");
  });

  it("coordinated track when outside Lagos, overriding schedule", () => {
    const j = deriveJourney({ ...base, delivery_state: "Oyo", scheduled_delivery_at: "2026-06-22T11:00:00Z" });
    expect(j.track).toBe("coordinated");
    expect(j.methodLabel).toBe("We'll arrange delivery to Oyo");
  });

  it("payment_hold special when confirmed/unpaid", () => {
    const j = deriveJourney({ ...base, status: "confirmed", payment_status: "pending", paid_at: null });
    expect(j.special).toBe("payment_hold");
    expect(j.steps.find((s) => s.key === "paid")?.state).toBe("current");
  });

  it("reconcile special is calm, not cancelled", () => {
    expect(deriveJourney({ ...base, status: "reconcile_needed" }).special).toBe("reconcile");
  });

  it("cancelled special + track coordinated", () => {
    const j = deriveJourney({ ...base, status: "cancelled" });
    expect(j.special).toBe("cancelled");
  });

  it("out_for_delivery marks the OTW step current and preparing done", () => {
    const j = deriveJourney({ ...base, delivery: { status: "in_transit" }, out_for_delivery_at: "2026-06-21T13:20:00Z" });
    expect(j.steps.find((s) => s.key === "preparing")?.state).toBe("done");
    expect(j.currentStep.key).toBe("on_the_way");
  });

  it("delivered marks all done", () => {
    const j = deriveJourney({ ...base, status: "delivered", delivery: { status: "delivered" }, out_for_delivery_at: "x", delivered_at: "2026-06-21T13:40:00Z" });
    expect(j.steps.every((s) => s.state === "done")).toBe(true);
    expect(j.currentStep.key).toBe("delivered");
  });

  it("preorder relabels the prep step", () => {
    const j = deriveJourney({ ...base, is_preorder: true, delivery: { status: "searching_rider" } });
    expect(j.steps.find((s) => s.key === "preparing")?.label).toBe("In production 🥤");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/customer && npx vitest run src/lib/order-journey.test.ts`
Expected: FAIL — `Cannot find module './order-journey'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/customer/src/lib/order-journey.ts
export type Track = "live" | "scheduled" | "coordinated";
export type StepState = "done" | "current" | "upcoming";
export interface JourneyStep { key: string; label: string; state: StepState; at?: string }
export interface Journey {
  track: Track;
  steps: JourneyStep[];
  currentStep: JourneyStep;
  methodLabel: string;
  isPreorder: boolean;
  special: "none" | "payment_hold" | "reconcile" | "cancelled";
}
export interface TrackingOrderLike {
  status: string;
  payment_status: string;
  is_preorder: boolean;
  scheduled_delivery_at: string | null;
  delivery_state: string | null;
  paid_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  delivery: { status: string } | null;
}

const OTW_STATUSES = new Set(["picked_up", "in_transit", "out_for_delivery"]);

function pickTrack(o: TrackingOrderLike): Track {
  if (o.delivery_state && o.delivery_state !== "Lagos") return "coordinated";
  if (o.scheduled_delivery_at) return "scheduled";
  if (o.delivery) return "live";
  return "coordinated";
}

function midStep(track: Track): { key: string; label: string } {
  if (track === "scheduled") return { key: "scheduled", label: "Scheduled" };
  if (track === "live") return { key: "preparing", label: "Preparing" };
  return { key: "arranging", label: "Arranging + WhatsApp" };
}

function otwStep(track: Track): { key: string; label: string } {
  if (track === "scheduled") return { key: "out_for_delivery", label: "Out for delivery" };
  return { key: "on_the_way", label: "On the way" };
}

export function deriveJourney(o: TrackingOrderLike): Journey {
  const track = pickTrack(o);
  const special: Journey["special"] =
    o.status === "confirmed" ? "payment_hold"
    : o.status === "reconcile_needed" ? "reconcile"
    : o.status === "cancelled" ? "cancelled"
    : "none";

  const paidDone = o.payment_status === "paid";
  const otwDone = !!o.out_for_delivery_at || OTW_STATUSES.has(o.delivery?.status ?? "");
  const deliveredDone = o.status === "delivered";

  const mid = midStep(track);
  const otw = otwStep(track);
  const midLabel = o.is_preorder && mid.key !== "scheduled" ? "In production 🥤" : mid.label;

  const raw: Array<{ key: string; label: string; done: boolean; at?: string }> = [
    { key: "placed", label: "Placed", done: true, at: undefined },
    { key: "paid", label: "Paid", done: paidDone, at: o.paid_at ?? undefined },
    { key: mid.key, label: midLabel, done: otwDone || deliveredDone },
    { key: otw.key, label: otw.label, done: deliveredDone, at: o.out_for_delivery_at ?? undefined },
    { key: "delivered", label: "Delivered", done: deliveredDone, at: o.delivered_at ?? undefined },
  ];

  let currentAssigned = false;
  const steps: JourneyStep[] = raw.map((s) => {
    let state: StepState;
    if (s.done) state = "done";
    else if (!currentAssigned) { state = "current"; currentAssigned = true; }
    else state = "upcoming";
    return s.at ? { key: s.key, label: s.label, state, at: s.at } : { key: s.key, label: s.label, state };
  });
  const currentStep = steps.find((s) => s.state === "current") ?? steps[steps.length - 1]!;

  const methodLabel =
    track === "live" ? "Live rider"
    : track === "scheduled" ? "Scheduled delivery"
    : o.delivery_state && o.delivery_state !== "Lagos"
      ? `We'll arrange delivery to ${o.delivery_state}`
      : "We'll arrange your delivery";

  return { track, steps, currentStep, methodLabel, isPreorder: o.is_preorder, special };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/customer && npx vitest run src/lib/order-journey.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/lib/order-journey.ts apps/customer/src/lib/order-journey.test.ts
git commit -m "feat(customer): deriveJourney order-status model (Phase 0 taxonomy)"
```

---

### Task 2: `useCountdown` hook

**Files:**
- Create: `apps/customer/src/hooks/useCountdown.ts`
- Test: `apps/customer/src/hooks/useCountdown.test.ts`

**Interfaces:**
- Produces: `export function useCountdown(targetIso: string | null): { mmss: string; expired: boolean; totalMs: number }` — recomputes every 1s; `expired` true once now ≥ target or target null/invalid; `mmss` is `M:SS` (e.g. `29:41`), `0:00` when expired.

- [ ] **Step 1: Write the failing test**

```ts
// apps/customer/src/hooks/useCountdown.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountdown } from "./useCountdown";

afterEach(() => vi.useRealTimers());

describe("useCountdown", () => {
  it("counts down toward the target", () => {
    vi.useFakeTimers();
    const target = new Date(Date.now() + 65_000).toISOString();
    const { result } = renderHook(() => useCountdown(target));
    expect(result.current.expired).toBe(false);
    expect(result.current.mmss).toBe("1:05");
    act(() => { vi.advanceTimersByTime(66_000); });
    expect(result.current.expired).toBe(true);
    expect(result.current.mmss).toBe("0:00");
  });

  it("is immediately expired for null target", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current.expired).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/customer && npx vitest run src/hooks/useCountdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/customer/src/hooks/useCountdown.ts
import { useEffect, useState } from "react";

function compute(targetIso: string | null): { mmss: string; expired: boolean; totalMs: number } {
  if (!targetIso) return { mmss: "0:00", expired: true, totalMs: 0 };
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) return { mmss: "0:00", expired: true, totalMs: 0 };
  const ms = t - Date.now();
  if (ms <= 0) return { mmss: "0:00", expired: true, totalMs: 0 };
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return { mmss: `${m}:${String(s).padStart(2, "0")}`, expired: false, totalMs: ms };
}

export function useCountdown(targetIso: string | null): { mmss: string; expired: boolean; totalMs: number } {
  const [state, setState] = useState(() => compute(targetIso));
  useEffect(() => {
    setState(compute(targetIso));
    const id = setInterval(() => setState(compute(targetIso)), 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/customer && npx vitest run src/hooks/useCountdown.test.ts`
Expected: PASS. If `@testing-library/react` is missing, install it as a dev dep: `cd apps/customer && pnpm add -D @testing-library/react` (the app already runs jsdom via vitest per repo config).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/hooks/useCountdown.ts apps/customer/src/hooks/useCountdown.test.ts
git commit -m "feat(customer): useCountdown hook for payment-hold timer"
```

---

### Task 3: Extend the tracking API endpoint

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (the `r.get("/:orderNumber")` handler, ~lines 538-596)
- Modify: `apps/api/src/env.ts` (add `SUPPORT_WHATSAPP`)
- Test: `apps/api/test/integration/online-order.test.ts` (add cases)

**Interfaces:**
- Consumes: `buildPayazaCheckoutConfig({ amountNgn, email, reference, customerName?, customerPhone? })` from `../payments/payaza.js`; existing `saleOrder`, `saleOrderItem`, `product`, `productVariant`, `payment`, `stockReservation`, `deliveryOrder`, `customer` schemas.
- Produces: the tracking `data` object gains: `items[]`, `is_preorder`, `fulfilled_at`, `paid_at`, `out_for_delivery_at`, `delivered_at`, `reservation_expires_at`, `resume_payment` (or null), `support_whatsapp` (or null).

- [ ] **Step 1: Add the env var**

In `apps/api/src/env.ts`, add to the schema (next to `TURNSTILE_SECRET`):

```ts
  SUPPORT_WHATSAPP: z.preprocess(emptyToUndef, z.string().optional()),
```

- [ ] **Step 2: Write the failing test**

Add to `apps/api/test/integration/online-order.test.ts` (follow the file's existing harness for seeding a branch/variant/price and placing an order). Add:

```ts
it("tracking returns items, milestone timestamps and resume_payment while unpaid", async () => {
  // place an order via POST /v1/public/orders (existing helper in this file)
  const placed = await placeTestOrder(); // returns { order_number, phone }
  const res = await app.request(
    `/v1/public/orders/${placed.order_number}?phone=${encodeURIComponent(placed.phone)}`,
  );
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(Array.isArray(data.items)).toBe(true);
  expect(data.items[0]).toHaveProperty("name");
  expect(data.items[0]).toHaveProperty("size_ml");
  expect(data).toHaveProperty("is_preorder");
  expect(data).toHaveProperty("reservation_expires_at");
  expect(data.resume_payment).not.toBeNull(); // unpaid → resume config present
  expect(data.resume_payment.payaza).toHaveProperty("reference");
});

it("tracking with a wrong phone is an indistinguishable 404", async () => {
  const placed = await placeTestOrder();
  const res = await app.request(`/v1/public/orders/${placed.order_number}?phone=08000000000`);
  expect(res.status).toBe(404);
});
```

If a `placeTestOrder` helper doesn't already exist in the file, write it inline using the same seeding the other tests in the file use (branch + variant + price), POSTing to `/v1/public/orders` with an `idempotency-key` header and reading `data.order_number`; the customer phone you pass in the body is the one you query with.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/online-order.test.ts -t "resume_payment"`
Expected: FAIL — `data.items` undefined / `resume_payment` undefined.

- [ ] **Step 4: Implement the endpoint additions**

In `public-orders.ts`, import `payment`, `productVariant`, `product`, `stockReservation` (some already imported), `buildPayazaCheckoutConfig`, `env`, and add aggregation. Replace the tracking handler's response build so that after loading `o` and `cust` (and the existing `delivery` lookup) it also gathers:

```ts
// line items
const itemRows = await db
  .select({
    name: product.name,
    sizeMl: productVariant.sizeMl,
    quantity: saleOrderItem.quantity,
    unitPriceNgn: saleOrderItem.unitPriceNgn,
    lineTotalNgn: saleOrderItem.lineTotalNgn,
  })
  .from(saleOrderItem)
  .leftJoin(product, eq(product.id, saleOrderItem.productId))
  .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
  .where(eq(saleOrderItem.saleOrderId, o.id));
const items = itemRows.map((r) => ({
  name: r.name ?? "Item",
  size_ml: r.sizeMl ?? null,
  quantity: r.quantity,
  unit_price_ngn: r.unitPriceNgn,
  line_total_ngn: r.lineTotalNgn,
}));

// latest paid payment timestamp
const [pay] = await db
  .select({ paidAt: payment.paidAt })
  .from(payment)
  .where(eq(payment.saleOrderId, o.id))
  .orderBy(descFn(payment.paidAt))
  .limit(1);

// earliest live reservation expiry (only meaningful while unpaid + non-preorder)
let reservationExpiresAt: string | null = null;
if (o.status === "confirmed" && !o.isPreorder) {
  const [resv] = await db
    .select({ expiresAt: stockReservation.expiresAt })
    .from(stockReservation)
    .where(eq(stockReservation.saleOrderId, o.id))
    .orderBy(stockReservation.expiresAt)
    .limit(1);
  reservationExpiresAt = resv?.expiresAt ? resv.expiresAt.toISOString() : null;
}

// resume-payment config only for unpaid orders (phone already verified above)
let resumePayment: { reference: string; payaza: ReturnType<typeof buildPayazaCheckoutConfig> } | null = null;
if (o.status === "confirmed") {
  const payaza = buildPayazaCheckoutConfig({
    amountNgn: o.totalNgn,
    email: cust.email ?? "no-email@example.com",
    reference: o.orderNumber,
    customerName: cust.name ?? undefined,
    customerPhone: cust.phone ?? undefined,
  });
  resumePayment = { reference: payaza.reference, payaza };
}

// support WhatsApp deep link
const waNumber = env.SUPPORT_WHATSAPP;
const supportWhatsapp = waNumber
  ? {
      number: waNumber,
      url: `https://wa.me/${waNumber.replace(/[^\d]/g, "")}?text=${encodeURIComponent(
        `Hi Mrs. Samuel, I'm checking on my order ${o.orderNumber}.`,
      )}`,
    }
  : null;
```

Then extend the returned `data` object with:

```ts
        items,
        is_preorder: o.isPreorder,
        fulfilled_at: o.fulfilledAt ? o.fulfilledAt.toISOString() : null,
        paid_at: pay?.paidAt ? pay.paidAt.toISOString() : null,
        out_for_delivery_at: o.outForDeliveryAt ? o.outForDeliveryAt.toISOString() : null,
        delivered_at: delivery?.deliveredAt ? delivery.deliveredAt.toISOString() : null,
        reservation_expires_at: reservationExpiresAt,
        resume_payment: resumePayment,
        support_whatsapp: supportWhatsapp,
```

Note: add `deliveredAt: deliveryOrder.deliveredAt` to the existing `delivery` select projection. `descFn` is the already-imported `desc` from drizzle-orm (the handler imports it dynamically as `descFn`; reuse that, or add `desc` to the top import — match the file's current style).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/online-order.test.ts`
Expected: PASS (new cases + existing ones). If the suite hits a testcontainer beforeAll timeout, re-run the single file alone (known-flaky per repo notes).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/public-orders.ts apps/api/src/env.ts apps/api/test/integration/online-order.test.ts
git commit -m "feat(api): enrich order tracking (items, timestamps, hold expiry, resume payment, WhatsApp)"
```

---

### Task 4: Mirror the new fields into the customer API type

**Files:**
- Modify: `apps/customer/src/lib/api/types.ts:135-155` (the `ApiOrderTracking` interface)

**Interfaces:**
- Consumes: the JSON shape Task 3 produces.
- Produces: an `ApiOrderTracking` that satisfies `TrackingOrderLike` from Task 1 (so `deriveJourney(order)` type-checks directly).

- [ ] **Step 1: Extend the interface**

Replace `ApiOrderTracking` with:

```ts
export interface ApiOrderItem {
  name: string;
  size_ml: number | null;
  quantity: number;
  unit_price_ngn: number;
  line_total_ngn: number;
}

export interface ApiOrderTracking {
  order_number: string;
  status: string;
  payment_status: string;
  total_ngn: number;
  subtotal_ngn: number;
  delivery_fee_ngn: number;
  channel: string;
  created_at: string;
  scheduled_delivery_at: string | null;
  delivery_state: string | null;
  is_preorder: boolean;
  fulfilled_at: string | null;
  paid_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  reservation_expires_at: string | null;
  resume_payment: { reference: string; payaza: PayazaCheckoutConfig } | null;
  support_whatsapp: { number: string; url: string } | null;
  items: ApiOrderItem[];
  delivery: {
    status: string;
    rider_name: string | null;
    rider_phone: string | null;
    rider_vehicle: string | null;
    tracking_url: string | null;
    eta_minutes: number | null;
    provider: string;
  } | null;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/customer && npx tsc --noEmit`
Expected: PASS (the existing `order.$orderNumber.tsx` still compiles against the superset; it's rewritten in Task 6).

- [ ] **Step 3: Commit**

```bash
git add apps/customer/src/lib/api/types.ts
git commit -m "feat(customer): extend ApiOrderTracking with new tracking fields"
```

---

### Task 5: Presentational components (timeline, rider card, hold banner, summary)

**Files:**
- Create: `apps/customer/src/components/OrderTimeline.tsx`
- Create: `apps/customer/src/components/RiderCard.tsx`
- Create: `apps/customer/src/components/PaymentHoldBanner.tsx`
- Create: `apps/customer/src/components/OrderSummaryCard.tsx`

**Interfaces:**
- Consumes: `Journey`, `JourneyStep` from `../lib/order-journey`; `useCountdown` from `../hooks/useCountdown`; `formatNaira` from `../lib/cart`; `ApiOrderItem`, `ApiOrderTracking` from `../lib/api/types`; `launchPayazaCheckout` from `../lib/payaza`.
- Produces:
  - `OrderTimeline({ steps }: { steps: JourneyStep[] })`
  - `RiderCard({ delivery }: { delivery: NonNullable<ApiOrderTracking["delivery"]> })`
  - `PaymentHoldBanner({ order, onResumed }: { order: ApiOrderTracking; onResumed: () => void })`
  - `OrderSummaryCard({ items, subtotalNgn, deliveryFeeNgn, totalNgn }: { items: ApiOrderItem[]; subtotalNgn: number; deliveryFeeNgn: number; totalNgn: number })`

- [ ] **Step 1: OrderTimeline**

```tsx
// apps/customer/src/components/OrderTimeline.tsx
import { Check } from "lucide-react";
import type { JourneyStep } from "@/lib/order-journey";

function ts(at?: string): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit" });
}

export function OrderTimeline({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="relative space-y-5">
      {steps.map((s, i) => {
        const done = s.state === "done";
        const current = s.state === "current";
        return (
          <li key={s.key} className="flex items-start gap-3" aria-current={current ? "step" : undefined}>
            <span className="relative flex flex-col items-center">
              <span className={`grid h-8 w-8 place-items-center rounded-full ring-2 transition ${
                done ? "bg-[color:var(--brand)] text-white ring-transparent"
                : current ? "bg-[color:var(--brand-orange)] text-white ring-[color:var(--brand-orange)]/30 motion-safe:animate-pulse"
                : "bg-white text-[color:var(--brand)]/30 ring-black/10"}`}>
                {done ? <Check className="h-4 w-4" /> : <span className="text-xs font-bold">{i + 1}</span>}
              </span>
              {i < steps.length - 1 && <span className={`mt-1 h-6 w-0.5 ${done ? "bg-[color:var(--brand)]" : "bg-black/10"}`} />}
            </span>
            <span className="pt-1.5">
              <span className={`block text-sm font-semibold ${current ? "text-[color:var(--brand-orange)]" : "text-[color:var(--brand)]"}`}>{s.label}</span>
              {s.at && <span className="block text-xs text-[color:var(--brand)]/50">{ts(s.at)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: RiderCard**

```tsx
// apps/customer/src/components/RiderCard.tsx
import { Phone, MapPin } from "lucide-react";
import type { ApiOrderTracking } from "@/lib/api/types";

export function RiderCard({ delivery }: { delivery: NonNullable<ApiOrderTracking["delivery"]> }) {
  return (
    <div className="rounded-2xl bg-[color:var(--cream)]/60 p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55">Your rider</div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-[color:var(--brand)]">{delivery.rider_name ?? "Assigning a rider…"}</div>
          <div className="text-xs text-[color:var(--brand)]/60">
            {delivery.rider_vehicle ?? "—"}{delivery.eta_minutes != null ? ` · ~${delivery.eta_minutes} min` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          {delivery.rider_phone && (
            <a href={`tel:${delivery.rider_phone}`} className="grid h-10 w-10 place-items-center rounded-full bg-white ring-1 ring-black/10" aria-label="Call rider"><Phone className="h-4 w-4 text-[color:var(--brand)]" /></a>
          )}
          {delivery.tracking_url && (
            <a href={delivery.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[color:var(--brand)] text-white px-4 text-sm font-semibold"><MapPin className="h-4 w-4" /> Live</a>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: OrderSummaryCard**

```tsx
// apps/customer/src/components/OrderSummaryCard.tsx
import { formatNaira } from "@/lib/cart";
import type { ApiOrderItem } from "@/lib/api/types";

export function OrderSummaryCard({ items, subtotalNgn, deliveryFeeNgn, totalNgn }: {
  items: ApiOrderItem[]; subtotalNgn: number; deliveryFeeNgn: number; totalNgn: number;
}) {
  return (
    <div className="rounded-2xl bg-white ring-1 ring-black/5 p-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55">Your order</div>
      <ul className="mt-3 space-y-2">
        {items.map((it, i) => (
          <li key={i} className="flex justify-between text-sm text-[color:var(--brand)]/80">
            <span>{it.quantity}× {it.name}{it.size_ml ? ` ${it.size_ml}ml` : ""}</span>
            <span className="tabular-nums">{formatNaira(it.line_total_ngn)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-1.5 border-t border-black/5 pt-3 text-sm">
        <div className="flex justify-between text-[color:var(--brand)]/70"><span>Subtotal</span><span>{formatNaira(subtotalNgn)}</span></div>
        <div className="flex justify-between text-[color:var(--brand)]/70"><span>Delivery</span><span>{deliveryFeeNgn === 0 ? "₦0" : formatNaira(deliveryFeeNgn)}</span></div>
        <div className="flex justify-between font-display text-xl pt-2 border-t border-black/5 text-[color:var(--brand)]"><span>Total</span><span>{formatNaira(totalNgn)}</span></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: PaymentHoldBanner**

```tsx
// apps/customer/src/components/PaymentHoldBanner.tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clock, Loader2 } from "lucide-react";
import { formatNaira } from "@/lib/cart";
import { launchPayazaCheckout } from "@/lib/payaza";
import { useCountdown } from "@/hooks/useCountdown";
import type { ApiOrderTracking } from "@/lib/api/types";

export function PaymentHoldBanner({ order, onResumed }: { order: ApiOrderTracking; onResumed: () => void }) {
  const { mmss, expired } = useCountdown(order.reservation_expires_at);
  const [busy, setBusy] = useState(false);

  // Preorders carry no reservation; the hold concept ("bottles held") doesn't
  // apply, but they still need to pay — so show a resume button without a timer.
  const hasTimer = !order.is_preorder && !!order.reservation_expires_at;

  if (hasTimer && expired) {
    return (
      <div className="rounded-2xl bg-[color:var(--cream)]/80 p-5 ring-1 ring-black/5">
        <div className="font-semibold text-[color:var(--brand)]">Your hold expired</div>
        <p className="mt-1 text-sm text-[color:var(--brand)]/70">The bottles were released back to stock. You can start a fresh order any time.</p>
        <Link to="/juices" className="mt-3 inline-block rounded-full bg-[color:var(--brand)] text-white px-5 py-2.5 text-sm font-semibold">Reorder</Link>
      </div>
    );
  }

  async function resume() {
    if (!order.resume_payment) return;
    setBusy(true);
    await launchPayazaCheckout(order.resume_payment.payaza, {
      onPaid: () => onResumed(),
      onClose: () => setBusy(false),
    });
  }

  return (
    <div className="rounded-2xl bg-[color:var(--brand-orange)]/10 p-5 ring-1 ring-[color:var(--brand-orange)]/20">
      <div className="flex items-center gap-2 text-[color:var(--brand-orange)] font-semibold"><Clock className="h-4 w-4" /> {hasTimer ? "We're holding your bottles" : "Finish your payment"}</div>
      {hasTimer && <div className="mt-1 text-sm text-[color:var(--brand)]/70">Reserved for <span className="font-bold tabular-nums">{mmss}</span> — complete payment to lock it in.</div>}
      <button onClick={() => void resume()} disabled={busy || !order.resume_payment} className="mt-3 w-full rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-3 text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
        {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Opening payment…</> : <>Complete payment — {formatNaira(order.total_ngn)}</>}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/customer && npx tsc --noEmit`
Expected: PASS.

```bash
git add apps/customer/src/components/OrderTimeline.tsx apps/customer/src/components/RiderCard.tsx apps/customer/src/components/OrderSummaryCard.tsx apps/customer/src/components/PaymentHoldBanner.tsx
git commit -m "feat(customer): order-tracking presentational components"
```

---

### Task 6: Rewrite the tracking page to assemble everything

**Files:**
- Modify: `apps/customer/src/routes/order.$orderNumber.tsx` (full rewrite)

**Interfaces:**
- Consumes: `trackOrder` server fn, `deriveJourney`, the four components, `useCountdown` (indirectly), `ApiOrderTracking`.
- Produces: the rendered tracking screen. Polls every 20s while `status` is not terminal (`delivered`/`cancelled`); stops when the tab is hidden (Page Visibility); has an `aria-live="polite"` headline region.

- [ ] **Step 1: Rewrite the route component**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { Loader2, AlertCircle } from "lucide-react";
import { SiteShell } from "@/components/SiteShell";
import { trackOrder } from "@/lib/api/server-fns";
import { ApiError } from "@/lib/api/client";
import type { ApiOrderTracking } from "@/lib/api/types";
import { deriveJourney } from "@/lib/order-journey";
import { OrderTimeline } from "@/components/OrderTimeline";
import { RiderCard } from "@/components/RiderCard";
import { OrderSummaryCard } from "@/components/OrderSummaryCard";
import { PaymentHoldBanner } from "@/components/PaymentHoldBanner";

export const Route = createFileRoute("/order/$orderNumber")({
  head: () => ({ meta: [{ title: "Your order — Mrs. Samuel Fruit Juice" }] }),
  component: OrderPage,
});

function storedPhone(orderNumber: string): string | null {
  try {
    const raw = localStorage.getItem(`ms_track_${orderNumber}`);
    return raw ? (JSON.parse(raw).phone ?? null) : null;
  } catch { return null; }
}

const TERMINAL = new Set(["delivered", "cancelled"]);

function OrderPage() {
  const { orderNumber } = useParams({ from: "/order/$orderNumber" });
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [order, setOrder] = useState<ApiOrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { setPhone(storedPhone(orderNumber)); }, [orderNumber]);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const o = await trackOrder({ data: { orderNumber, phone: p } });
      setOrder(o); setError(null);
      if (!TERMINAL.has(o.status) && document.visibilityState === "visible") {
        timerRef.current = setTimeout(() => void load(p), 20000);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't find an order with that number and phone.");
    } finally { setLoading(false); }
  }, [orderNumber]);

  useEffect(() => {
    if (!phone) return;
    void load(phone);
    const onVis = () => { if (document.visibilityState === "visible" && order && !TERMINAL.has(order.status)) void load(phone); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(timerRef.current); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, load]);

  const journey = order ? deriveJourney(order) : null;

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-2xl mx-auto pt-32 sm:pt-36 pb-24">
        <div className="inline-flex items-center gap-2 rounded-full bg-[color:var(--cream)]/80 px-4 py-1.5 text-xs font-mono">
          <span className="text-[color:var(--brand)]/60">Order</span><span className="font-bold text-[color:var(--brand)]">{orderNumber}</span>
        </div>

        {!phone && (
          <div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6">
            <p className="text-sm text-[color:var(--brand)]/75">Enter the phone number on the order to view its status.</p>
            <div className="mt-3 flex gap-2">
              <input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="0800 000 0000" className="flex-1 rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none" />
              <button onClick={() => setPhone(phoneInput.replace(/[\s-]/g, ""))} className="rounded-xl bg-[color:var(--brand)] text-white px-5 text-sm font-semibold">View</button>
            </div>
          </div>
        )}

        {phone && loading && !order && <div className="mt-10 flex items-center gap-2 text-[color:var(--brand)]/60"><Loader2 className="h-5 w-5 animate-spin" /> Loading…</div>}
        {phone && error && !order && <div className="mt-8 rounded-2xl bg-white ring-1 ring-black/5 p-6 text-[color:var(--brand)]/80"><AlertCircle className="inline h-4 w-4 mr-1" /> {error}</div>}

        {order && journey && (
          <div className="mt-6 space-y-5">
            <div aria-live="polite">
              <h1 className="font-display text-4xl text-[color:var(--brand)]">
                {journey.special === "cancelled" ? "Order cancelled"
                  : journey.special === "reconcile" ? "Confirming your payment"
                  : journey.special === "payment_hold" ? "Almost there"
                  : journey.currentStep.label === "Delivered" ? "Delivered 🎉"
                  : journey.currentStep.label}
              </h1>
              <p className="mt-1 text-sm text-[color:var(--brand)]/70">{journey.methodLabel}</p>
            </div>

            {journey.special === "payment_hold" && <PaymentHoldBanner order={order} onResumed={() => phone && void load(phone)} />}
            {journey.special === "reconcile" && (
              <div className="rounded-2xl bg-[color:var(--cream)]/70 p-5 ring-1 ring-black/5 text-sm text-[color:var(--brand)]/80">We've received your payment and we're just confirming the details. We'll message you shortly — no action needed.</div>
            )}

            {journey.special === "none" && (
              <div className="rounded-2xl bg-white ring-1 ring-black/5 p-6"><OrderTimeline steps={journey.steps} /></div>
            )}

            {journey.track === "live" && order.delivery && journey.special === "none" && <RiderCard delivery={order.delivery} />}

            <OrderSummaryCard items={order.items} subtotalNgn={order.subtotal_ngn} deliveryFeeNgn={order.delivery_fee_ngn} totalNgn={order.total_ngn} />

            {order.support_whatsapp && (
              <a href={order.support_whatsapp.url} target="_blank" rel="noreferrer" className="block w-full rounded-full bg-[#25D366] text-white px-6 py-3 text-center text-sm font-bold">💬 Need help? WhatsApp us</a>
            )}
            <div className="flex flex-wrap gap-3">
              <Link to="/juices" className="rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Order more</Link>
              <Link to="/" className="rounded-full bg-white ring-1 ring-black/10 text-[color:var(--brand)] px-6 py-3 text-sm font-semibold">Back home</Link>
            </div>
          </div>
        )}
      </div>
    </SiteShell>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/customer && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Build the customer app**

Run: `cd apps/customer && pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/routes/order.\$orderNumber.tsx
git commit -m "feat(customer): rebuild order-tracking page (hybrid timeline + hold + rider)"
```

---

### Task 7: `/track` lookup page + nav/footer link

**Files:**
- Create: `apps/customer/src/routes/track.tsx`
- Modify: `apps/customer/src/components/Nav.tsx` (add a "Track order" link)

**Interfaces:**
- Consumes: TanStack Router `useNavigate`.
- Produces: route `/track` with order# + phone fields that navigate to `/order/$orderNumber` and seed the phone into `localStorage` so the tracking page picks it up.

- [ ] **Step 1: Create the lookup route**

```tsx
// apps/customer/src/routes/track.tsx
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SiteShell } from "@/components/SiteShell";

export const Route = createFileRoute("/track")({
  head: () => ({ meta: [{ title: "Track your order — Mrs. Samuel Fruit Juice" }] }),
  component: TrackPage,
});

function TrackPage() {
  const navigate = useNavigate();
  const [orderNumber, setOrderNumber] = useState("");
  const [phone, setPhone] = useState("");

  function go() {
    const num = orderNumber.trim();
    const ph = phone.replace(/[\s-]/g, "");
    if (!num || !ph) return;
    try { localStorage.setItem(`ms_track_${num}`, JSON.stringify({ phone: ph })); } catch { /* ignore */ }
    void navigate({ to: "/order/$orderNumber", params: { orderNumber: num } });
  }

  return (
    <SiteShell>
      <div className="px-5 max-w-md mx-auto pt-36 pb-24">
        <h1 className="font-display text-4xl text-[color:var(--brand)]">Track your order</h1>
        <p className="mt-2 text-sm text-[color:var(--brand)]/70">Enter your order number and the phone number you used at checkout.</p>
        <div className="mt-6 space-y-3">
          <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="Order number (e.g. 1042)" className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" className="w-full rounded-xl bg-[color:var(--cream)]/60 px-4 py-3 text-sm ring-1 ring-black/5 focus:ring-2 focus:ring-[color:var(--brand-orange)] focus:outline-none" />
          <button onClick={go} disabled={!orderNumber.trim() || !phone.trim()} className="w-full rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-bold disabled:opacity-50">Track order</button>
        </div>
      </div>
    </SiteShell>
  );
}
```

- [ ] **Step 2: Add the Nav link**

In `apps/customer/src/components/Nav.tsx`, add a link to `/track` labelled "Track order" in the same style as the existing nav links (match the file's existing `<Link>` pattern; place it among the primary nav items). If the file references a dead Account/Search icon (per the storefront audit), replace that icon's target with `/track`.

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/customer && npx tsc --noEmit && pnpm build`
Expected: PASS — the route tree regenerates to include `/track`.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/routes/track.tsx apps/customer/src/components/Nav.tsx
git commit -m "feat(customer): /track order-lookup page + nav link"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Customer unit tests**

Run: `cd apps/customer && npx vitest run`
Expected: PASS incl. `order-journey` (9) and `useCountdown` (2).

- [ ] **Step 2: API tracking integration**

Run: `cd apps/api && npx vitest run test/integration/online-order.test.ts`
Expected: PASS (re-run alone if a testcontainer beforeAll timeout shows — known-flaky).

- [ ] **Step 3: Typecheck + lint both apps**

Run: `cd apps/customer && npx tsc --noEmit && cd ../api && npx tsc --noEmit`
Expected: PASS. Then `pnpm -w lint` (or the repo's configured lint) — expect 0 new errors (repo has ~6 pre-existing lint errors noted; don't introduce more).

- [ ] **Step 4: Manual smoke (documented, optional in CI)**

Boot the stack locally (see `reference_local_run`), place an online order, confirm: held-payment countdown shows while unpaid; after mock pay the timeline advances; `/track` lookup loads the order on a fresh browser with no localStorage.

- [ ] **Step 5: Final commit (if any lint/type fixups were needed)**

```bash
git add -A
git commit -m "chore(customer): tracking phase verification fixups"
```

---

## Self-Review

**Spec coverage:**
- C1 (timeline / what's next) → Tasks 1, 5 (OrderTimeline), 6.
- C2 (lookup entry) → Task 7.
- C3 (hold countdown + resume) → Tasks 2, 3 (reservation_expires_at + resume_payment), 5 (PaymentHoldBanner), 6.
- C4 (honest method copy) → Task 1 (methodLabel), 6.
- X1 (taxonomy) → Task 1 (deriveJourney).
- API additions → Task 3. Type mirror → Task 4. `SUPPORT_WHATSAPP` env → Task 3 Step 1.
- States table (loading/hold/expired/reconcile/cancelled/not-found/network) → Tasks 5–6.
- Testing (deriveJourney table, useCountdown, API fields, phone-404) → Tasks 1, 2, 3, 8.

**Placeholder scan:** none — every code step carries full code; the only narrative steps are the Nav edit (Task 7 Step 2, follows existing pattern) and verification (Task 8).

**Type consistency:** `ApiOrderTracking` (Task 4) is a structural superset of `TrackingOrderLike` (Task 1), so `deriveJourney(order)` accepts it directly. `resume_payment.payaza` is `PayazaCheckoutConfig`, matching `launchPayazaCheckout`'s param (Task 5). Component prop names (`steps`, `delivery`, `order`, `items/subtotalNgn/deliveryFeeNgn/totalNgn`) are consistent between Task 5 definitions and Task 6 call sites.

**Out of scope (confirmed not in this plan):** C5 (structured address), C6 (basket preorder badge) — deferred to a checkout-polish pass per the spec.
```