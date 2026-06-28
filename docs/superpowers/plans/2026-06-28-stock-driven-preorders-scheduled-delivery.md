# Stock-driven Preorders + Scheduled Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace silent out-of-stock→preorder behaviour with an explicit, live-stock-driven model: per-size counts + In-stock/Preorder labels on the storefront, and out-of-stock items get a real computed delivery date/window.

**Architecture:** A pure, shared delivery-schedule module (`@ms/shared`) computes the order's delivery date/window from size + day + time. The API is authoritative for stock decisions (using the **online-default branch**) and the stored `scheduled_delivery_at`; the customer app mirrors the same module for a live preview. Stock is read per-variant from the append-only `stock_ledger`.

**Tech Stack:** TypeScript, Hono (API), Drizzle/Postgres, TanStack Start (customer SSR), Vitest, Testcontainers.

## Global Constraints

- All delivery times are **Africa/Lagos (UTC+1, no DST)** — use a fixed `+01:00` offset, no tz library.
- Delivery hours: **Mon–Sat 8am–8pm; Sun 1pm–8pm.**
- Windows: **Morning 8–12 (anchor 09:00), Afternoon 12–4 (anchor 14:00), Evening 4–8 (anchor 18:00).** Sunday excludes Morning.
- A window is **available only if it has not yet started** (`lagosHour < window.startHour`).
- Stock decisions (count shown, In-stock/Preorder badge, order line decision) use the **online-default branch** only.
- A line is **In stock** when `qty <= available`, else the **whole line is Preorder** (no reservation; deduct at fulfilment).
- "One order, one date": order delivery date = **latest** line target; an evening-fixed line (650 preorder) forces the order window to Evening.
- Delivery fee stays **₦0**; checkout shows *"delivery cost will be confirmed and sent to you separately"*.
- `LIVE_COURIER_QUOTES` stays off; admin rider-booking flow unchanged; walk-up/till selling unchanged.
- Next migration number is **0059**.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/domain/src/availability.ts` | `availableVariantAtBranch` (per-size) | 1 |
| `apps/api/src/routes/public-catalog.ts` | expose per-variant available count | 2 |
| `apps/customer/src/lib/api/{types,mappers}.ts` | per-size `availableBySize` on Product | 3 |
| `apps/customer/src/lib/cart.tsx` | stock-driven preorder (qty>stock) | 3 |
| `apps/customer/src/components/{CartDrawer,ProductDetail}.tsx` | show count + badge | 3 |
| `packages/shared/src/delivery-schedule.ts` | pure date/window engine | 4 |
| `packages/db/migrations/0059_alt_phone.sql` + schema | `alt_phone` on sale_order | 5 |
| `apps/api/src/routes/public-orders.ts` | authoritative schedule + alt_phone | 6 |
| `apps/customer/src/routes/checkout.tsx` | window picker + prompting + alt phone | 7 |
| `apps/api/src/routes/public-orders.ts` (tracking) + worker notif | surface date/alt phone | 8 |
| `apps/customer/src/components/Hero.tsx` (or new `StockBanner.tsx`) | dynamic banner | 9 |
| removal: `GraciousContactModal.tsx`, `preorder_only` reads | cleanup | 10 |

---

# PHASE 1 — Counts & labels

### Task 1: Per-variant availability in the domain

**Files:**
- Modify: `packages/domain/src/availability.ts`
- Test: `packages/domain/src/availability.test.ts` (create if absent)

**Interfaces:**
- Produces: `availableVariantAtBranch(db, { branchId, variantId }): Promise<number>` — `SUM(ledger.delta for branch+variant) - SUM(active reservations for branch+variant)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/src/availability.test.ts
import { describe, it, expect } from "vitest";
import { availableVariantAtBranch } from "./availability.js";
// Use the api test helper pattern: a Testcontainers pg + seeded ledger rows.
// If domain has no test DB harness, place this test under apps/api/test/integration
// (see Task 2 note) — keep ONE harness. Prefer api integration if domain lacks pg.
```

> Note: `packages/domain` has no Postgres test harness today (only `shipbubble.test.ts`, pure). To avoid building one, **test this function via an api integration test** in Task 2's file, and keep this step as a type/compile check only. Implement the function here.

- [ ] **Step 2: Implement `availableVariantAtBranch`**

```ts
// append to packages/domain/src/availability.ts
export async function availableVariantAtBranch(
  db: DbExecutor,
  opts: { branchId: string; variantId: string },
): Promise<number> {
  const [bal] = await db
    .select({ sum: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int` })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.locationType, "branch"),
        eq(stockLedger.locationId, opts.branchId),
        eq(stockLedger.variantId, opts.variantId),
      ),
    );
  const [resv] = await db
    .select({ sum: sql<number>`COALESCE(SUM(${stockReservation.quantity}), 0)::int` })
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.branchId, opts.branchId),
        eq(stockReservation.variantId, opts.variantId),
        gt(stockReservation.expiresAt, new Date()),
      ),
    );
  return Number(bal?.sum ?? 0) - Number(resv?.sum ?? 0);
}
```

- [ ] **Step 3: Build & typecheck**

Run: `cd packages/domain && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/availability.ts
git commit -m "feat(domain): availableVariantAtBranch for per-size stock"
```

---

### Task 2: Catalog exposes per-variant available count

**Files:**
- Modify: `apps/api/src/routes/public-catalog.ts` (variant shape + `toOut`)
- Test: `apps/api/test/integration/public-catalog-stock.test.ts` (create)

**Interfaces:**
- Consumes: `availableVariantAtBranch` (Task 1).
- Produces: each catalog variant gains `available: number` (online-default branch). `preorder_only` is still returned but no longer drives behaviour.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/public-catalog-stock.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "./helpers.js";
import { availableVariantAtBranch } from "@ms/domain";
// Seed: one product, two variants (330 & 650), branch = online default,
// ledger gives 650 a balance of 5 and 330 a balance of 0.
// Assert GET /v1/public/catalog returns variants[650].available === 5
// and variants[330].available === 0.
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/public-catalog-stock.test.ts`
Expected: FAIL (no `available` on variant).

- [ ] **Step 3: Add per-variant available to catalog output**

In `public-catalog.ts`: extend `CatalogProductOut["variants"][number]` with `available: number`. In `variantsByProduct`, after building the variant list, for the resolved `branchId` compute `availableVariantAtBranch(db, { branchId, variantId: v.variant_id })` for each variant and attach. When `branchId` is null, `available = 0`.

```ts
// inside the variant mapping, when branchId present:
available: branchId ? await availableVariantAtBranch(db, { branchId, variantId: v.variant_id }) : 0,
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/public-catalog-stock.test.ts`
Expected: PASS (2 assertions).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/api && npx tsc -b
git add apps/api/src/routes/public-catalog.ts apps/api/test/integration/public-catalog-stock.test.ts
git commit -m "feat(api): expose per-variant available count in public catalog"
```

---

### Task 3: Storefront per-size count + stock-driven preorder badge

**Files:**
- Modify: `apps/customer/src/lib/api/types.ts`, `apps/customer/src/lib/api/mappers.ts`
- Modify: `apps/customer/src/lib/cart.tsx`
- Modify: `apps/customer/src/components/CartDrawer.tsx`, `apps/customer/src/components/ProductDetail.tsx`
- Test: `apps/customer/src/lib/api/mappers.test.ts`, `apps/customer/src/lib/cart.test.ts` (create)

**Interfaces:**
- Consumes: catalog variant `available` (Task 2).
- Produces: `Product.availableBySize: Record<Size, number>`; `isPreorderLine(product, size, qty): boolean` (qty exceeds available); cart items recompute `preorder` from stock + qty, not `preorder_only`.

- [ ] **Step 1: Write failing mapper test**

```ts
// mappers.test.ts — add
it("maps per-size available counts", () => {
  const p = mapProduct(fixtureWithVariants({ "650ml": { available: 5 }, "330ml": { available: 0 } }));
  expect(p.availableBySize["650ml"]).toBe(5);
  expect(p.availableBySize["330ml"]).toBe(0);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/customer && npx vitest run src/lib/api/mappers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `availableBySize` to types + mapper**

In `types.ts` add `available: number` to the API variant type. In `mappers.ts` build `availableBySize: Record<Size, number>` alongside the existing `variantIds`/`preorderBySize`. Add `Product.availableBySize`.

- [ ] **Step 4: Replace stock-driven preorder logic in cart**

In `cart.tsx` replace `isPreorderSize` (preorder_only) usage with a stock-driven helper:

```ts
/** A line is a preorder when the wanted qty exceeds the online-default
 *  branch's available stock for that size. Whole line flips (spec). */
export const isPreorderLine = (product: Product, size: Size, qty: number): boolean =>
  qty > (product.availableBySize[size] ?? 0);
```

Update `add`/`setQty` to set `item.preorder = isPreorderLine(product, size, item.qty)`; update `quickAddSize` to prefer the largest size with `availableBySize[s] > 0` (fallback unchanged). Keep `hasPreorder` derived from items.

- [ ] **Step 5: Write failing cart test**

```ts
// cart.test.ts
it("flips a line to preorder when qty exceeds stock", () => {
  const p = makeProduct({ availableBySize: { "650ml": 3, "330ml": 0 } });
  expect(isPreorderLine(p, "650ml", 3)).toBe(false);
  expect(isPreorderLine(p, "650ml", 4)).toBe(true);
  expect(isPreorderLine(p, "330ml", 1)).toBe(true);
});
```

- [ ] **Step 6: Run customer tests**

Run: `cd apps/customer && npx vitest run src/lib/api/mappers.test.ts src/lib/cart.test.ts`
Expected: PASS.

- [ ] **Step 7: Show count + badge in UI**

In `ProductDetail.tsx`: next to the size picker show `availableBySize[size]` (e.g. "7 in stock" or "Made to order — preorder"). In `CartDrawer.tsx`: per line show "{available} left" and a **Preorder** badge when `item.preorder`. Use existing Tailwind/`ui` primitives; match surrounding styles.

- [ ] **Step 8: Typecheck + build + commit**

```bash
cd apps/customer && npx tsc -b && npx vite build
git add apps/customer/src/lib apps/customer/src/components
git commit -m "feat(customer): per-size stock count + stock-driven preorder badge"
```

---

# PHASE 2 — Delivery engine & checkout

### Task 4: Pure delivery-schedule module (shared)

**Files:**
- Create: `packages/shared/src/delivery-schedule.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./delivery-schedule.js";`)
- Test: `packages/shared/src/delivery-schedule.test.ts`

**Interfaces:**
- Produces:
  - `type DeliveryWindow = "morning" | "afternoon" | "evening"`
  - `interface LineKind { sizeMl: number; inStock: boolean }`
  - `availableWindows(dow: number): DeliveryWindow[]`
  - `lineTarget(now: Date, line: LineKind): { date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[] }`
  - `orderSchedule(now: Date, lines: LineKind[]): { date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[] }`
  - `scheduledIso(date: string, window: DeliveryWindow): string`
  - `WINDOWS` (with anchors)

- [ ] **Step 1: Write the failing test (worked-examples table)**

```ts
// packages/shared/src/delivery-schedule.test.ts
import { describe, it, expect } from "vitest";
import { orderSchedule } from "./delivery-schedule.js";

// Helper: Lagos wall-clock -> Date. Lagos = UTC+1.
const at = (iso: string) => new Date(`${iso}+01:00`);

describe("orderSchedule", () => {
  it("in-stock 650 at Wed 10:00 -> today, pick afternoon+evening", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-01");
    expect(r.selectableWindows).toEqual(["afternoon", "evening"]);
    expect(r.fixedWindow).toBeUndefined();
  });
  it("in-stock 650 at Wed 21:00 -> next day, all windows", () => {
    const r = orderSchedule(at("2026-07-01T21:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("650 OOS at Wed 10:00 -> today evening (fixed)", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 650, inStock: false }]);
    expect(r).toMatchObject({ date: "2026-07-01", fixedWindow: "evening", selectableWindows: [] });
  });
  it("650 OOS at Wed 19:30 -> next day evening (fixed)", () => {
    const r = orderSchedule(at("2026-07-01T19:30:00"), [{ sizeMl: 650, inStock: false }]);
    expect(r).toMatchObject({ date: "2026-07-02", fixedWindow: "evening" });
  });
  it("330 OOS at Wed 10:00 -> next day, pick windows", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [{ sizeMl: 330, inStock: false }]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("Sunday 14:00 650 OOS -> Monday evening (override)", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 650, inStock: false }]); // 2026-07-05 is Sunday
    expect(r).toMatchObject({ date: "2026-07-06", fixedWindow: "evening" });
  });
  it("Sunday 14:00 330 OOS -> Monday, pick", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 330, inStock: false }]);
    expect(r.date).toBe("2026-07-06");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
  it("Sunday 14:00 650 in stock -> Sunday evening (afternoon already started)", () => {
    const r = orderSchedule(at("2026-07-05T14:00:00"), [{ sizeMl: 650, inStock: true }]);
    expect(r.date).toBe("2026-07-05");
    expect(r.selectableWindows).toEqual(["evening"]);
  });
  it("mixed in-stock 650 + 330 OOS at Wed 10:00 -> latest date (Thu), pick", () => {
    const r = orderSchedule(at("2026-07-01T10:00:00"), [
      { sizeMl: 650, inStock: true },
      { sizeMl: 330, inStock: false },
    ]);
    expect(r.date).toBe("2026-07-02");
    expect(r.selectableWindows).toEqual(["morning", "afternoon", "evening"]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd packages/shared && npx vitest run src/delivery-schedule.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the module**

```ts
// packages/shared/src/delivery-schedule.ts
export type DeliveryWindow = "morning" | "afternoon" | "evening";
export interface LineKind { sizeMl: number; inStock: boolean }

const LAGOS_OFFSET_MS = 3_600_000; // UTC+1, no DST
export const WINDOWS: Record<DeliveryWindow, { startHour: number; anchorHour: number }> = {
  morning: { startHour: 8, anchorHour: 9 },
  afternoon: { startHour: 12, anchorHour: 14 },
  evening: { startHour: 16, anchorHour: 18 },
};
const ORDER: DeliveryWindow[] = ["morning", "afternoon", "evening"];

interface LagosParts { dateStr: string; dow: number; hour: number }
function lagos(now: Date): LagosParts {
  const l = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const y = l.getUTCFullYear();
  const m = String(l.getUTCMonth() + 1).padStart(2, "0");
  const d = String(l.getUTCDate()).padStart(2, "0");
  return { dateStr: `${y}-${m}-${d}`, dow: l.getUTCDay(), hour: l.getUTCHours() };
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00+01:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return lagos(d).dateStr;
}
function dowOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00+01:00`).getUTCDay();
}

/** Windows offered on a given day-of-week (Sunday = 0 excludes morning). */
export function availableWindows(dow: number): DeliveryWindow[] {
  return dow === 0 ? ["afternoon", "evening"] : [...ORDER];
}
function remainingToday(p: LagosParts): DeliveryWindow[] {
  return availableWindows(p.dow).filter((w) => p.hour < WINDOWS[w].startHour);
}

export function lineTarget(now: Date, line: LineKind): {
  date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[];
} {
  const p = lagos(now);
  const isLarge = line.sizeMl >= 500;
  if (line.inStock) {
    const rem = remainingToday(p);
    if (rem.length) return { date: p.dateStr, selectableWindows: rem };
    const nd = addDays(p.dateStr, 1);
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  // preorder
  if (p.dow === 0) { // Sunday override: OOS -> Monday
    const nd = addDays(p.dateStr, 1);
    if (isLarge) return { date: nd, fixedWindow: "evening", selectableWindows: [] };
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  if (isLarge) {
    const eveningAhead = p.hour < WINDOWS.evening.startHour;
    const date = eveningAhead ? p.dateStr : addDays(p.dateStr, 1);
    return { date, fixedWindow: "evening", selectableWindows: [] };
  }
  const nd = addDays(p.dateStr, 1); // 330
  return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
}

export function orderSchedule(now: Date, lines: LineKind[]): {
  date: string; fixedWindow?: DeliveryWindow; selectableWindows: DeliveryWindow[];
} {
  if (lines.length === 0) {
    const p = lagos(now);
    const rem = remainingToday(p);
    if (rem.length) return { date: p.dateStr, selectableWindows: rem };
    const nd = addDays(p.dateStr, 1);
    return { date: nd, selectableWindows: availableWindows(dowOf(nd)) };
  }
  const targets = lines.map((l) => lineTarget(now, l));
  const finalDate = targets.map((t) => t.date).sort().at(-1)!;
  const onFinal = targets.filter((t) => t.date === finalDate);
  if (onFinal.some((t) => t.fixedWindow === "evening")) {
    return { date: finalDate, fixedWindow: "evening", selectableWindows: [] };
  }
  const todayStr = lagos(now).dateStr;
  const windows = finalDate === todayStr ? remainingToday(lagos(now)) : availableWindows(dowOf(finalDate));
  return { date: finalDate, selectableWindows: windows };
}

export function scheduledIso(date: string, window: DeliveryWindow): string {
  const hh = String(WINDOWS[window].anchorHour).padStart(2, "0");
  return `${date}T${hh}:00:00+01:00`;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd packages/shared && npx vitest run src/delivery-schedule.test.ts`
Expected: PASS (9 cases).

- [ ] **Step 5: Export + build + commit**

```bash
# add export to packages/shared/src/index.ts
cd packages/shared && npx tsc -b
git add packages/shared/src/delivery-schedule.ts packages/shared/src/delivery-schedule.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): pure delivery-schedule engine (windows, date rules)"
```

---

### Task 5: `alt_phone` migration + schema

**Files:**
- Create: `packages/db/migrations/0059_alt_phone.sql`
- Modify: `packages/db/src/schema/sale-order.ts`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry — match existing format)

**Interfaces:**
- Produces: `saleOrder.altPhone` (`alt_phone text` nullable).

- [ ] **Step 1: Add column to schema**

In `sale-order.ts`, after `refundOwedNgn`:
```ts
  // Secondary contact for delivery when the primary phone isn't reachable on WhatsApp.
  altPhone: text("alt_phone"),
```

- [ ] **Step 2: Write the migration SQL**

```sql
-- packages/db/migrations/0059_alt_phone.sql
ALTER TABLE "sale_order" ADD COLUMN "alt_phone" text;
```

- [ ] **Step 3: Append journal entry**

Add a new entry to `meta/_journal.json` with `idx` after 0058, a `when` timestamp **strictly greater** than 0058's (lesson from `project_shift_lifecycle_deploy_incident`: a too-low `when` is silently skipped). Tag `0059_alt_phone`.

- [ ] **Step 4: Build db + verify migration applies (in an api integration run)**

Run: `cd packages/db && npx tsc -b` then `cd apps/api && TZ=UTC npx vitest run test/integration/preorders.test.ts`
Expected: container migrates cleanly through 0059; tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/sale-order.ts packages/db/migrations/0059_alt_phone.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): add sale_order.alt_phone (0059)"
```

---

### Task 6: Authoritative schedule + alt_phone in online order create

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts`
- Test: `apps/api/test/integration/online-order-schedule.test.ts` (create)

**Interfaces:**
- Consumes: `availableVariantAtBranch` (1), `orderSchedule`/`scheduledIso` (4), `saleOrder.altPhone` (5).
- Produces: create response keeps `is_preorder`; order persists server-computed `scheduledDeliveryAt` + `altPhone`.

- [ ] **Step 1: Write the failing integration test**

```ts
// online-order-schedule.test.ts
// Seed online-default branch with 650 stock=5, 330 stock=0.
// (a) Order 4x650 in-stock placed at a fixed Lagos instant -> is_preorder=false,
//     scheduled_delivery_at on the expected date/window per orderSchedule.
// (b) Order 1x330 -> is_preorder=true, scheduled_delivery_at = next day.
// (c) alt_phone in payload is persisted on sale_order.
// Pin "now": inject via a header or a test-only clock; if none exists, assert the
// DATE math indirectly by seeding and reading scheduled_delivery_at is non-null
// and matches scheduledIso(orderSchedule(now,...)) computed in-test from Date.now().
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/online-order-schedule.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `public-orders.ts`**

- Add `alt_phone: z.string().optional()` under `customer` in `CreateOnlineOrder`.
- Replace the `preorderOnly || available < qty` per-line logic: compute per line `available = availableVariantAtBranch(tx, { branchId: body.branch_id, variantId })`; `inStock = qty <= available`; line is preorder when `!inStock`. **Stop reading `v.preorderOnly`.**
- Build `lines: LineKind[]` (`{ sizeMl, inStock }`) and call `orderSchedule(new Date(), lineKinds)`. If the client sent a window, validate it ∈ `selectableWindows` (or equals `fixedWindow`); otherwise use `fixedWindow ?? selectableWindows[0]`. Compute `scheduledDeliveryAt = new Date(scheduledIso(result.date, chosenWindow))`.
- Persist `scheduledDeliveryAt` and `altPhone: body.customer.alt_phone ?? null` on the order insert.
- Keep `deliveryFeeNgn: 0`.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/online-order-schedule.test.ts test/integration/online-order.test.ts`
Expected: PASS (existing online-order test still green).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/api && npx tsc -b
git add apps/api/src/routes/public-orders.ts apps/api/test/integration/online-order-schedule.test.ts
git commit -m "feat(api): server-authoritative delivery schedule + alt_phone on online orders"
```

---

### Task 7: Checkout — window picker, prompting, alt phone

**Files:**
- Modify: `apps/customer/src/routes/checkout.tsx`
- Modify/replace: `apps/customer/src/lib/schedule.ts` → re-export from `@ms/shared` (delete local window defs)
- Test: `apps/customer/src/lib/schedule.test.ts` (update to import shared)

**Interfaces:**
- Consumes: `orderSchedule`, `scheduledIso`, `DeliveryWindow` from `@ms/shared`; cart `items` with `preorder`.

- [ ] **Step 1: Point the customer schedule lib at the shared module**

Replace the contents of `apps/customer/src/lib/schedule.ts` with re-exports from `@ms/shared` (`orderSchedule`, `scheduledIso`, `WINDOWS`, `DeliveryWindow`, `availableWindows`). Update `schedule.test.ts` imports; keep any still-valid cases.

- [ ] **Step 2: Run the customer schedule test**

Run: `cd apps/customer && npx vitest run src/lib/schedule.test.ts`
Expected: PASS.

- [ ] **Step 3: Build cart `LineKind[]` and compute the schedule in checkout**

In `checkout.tsx` derive `lineKinds = items.map(i => ({ sizeMl: sizeToMl(i.size), inStock: !i.preorder }))` and `const sched = orderSchedule(new Date(), lineKinds)`.

- [ ] **Step 4: Render explicit prompting + picker + alt phone**

- Per item: show "In stock — {n} left" or "Preorder — made to order".
- Delivery section: show `sched.date` (formatted, Lagos). If `sched.fixedWindow` show it read-only ("Evening · 4–8pm"); else render a window `<select>`/radio over `sched.selectableWindows`.
- Add an **alternate phone** input → send as `customer.alt_phone`.
- Show the notice: *"Delivery cost will be confirmed and sent to you separately."*
- Send `scheduled_delivery_at = scheduledIso(sched.date, chosenWindow)` and `delivery_fee_ngn: 0` in the create payload.
- Off-hours: do **not** block — the schedule already rolls forward.

- [ ] **Step 5: Typecheck + build + commit**

```bash
cd apps/customer && npx tsc -b && npx vite build
git add apps/customer/src/routes/checkout.tsx apps/customer/src/lib/schedule.ts apps/customer/src/lib/schedule.test.ts
git commit -m "feat(customer): scheduled-delivery checkout (window picker, prompting, alt phone)"
```

---

### Task 8: Surface schedule + alt phone on tracking & notifications

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (tracking GET — include `scheduled_delivery_at`, `alt_phone` if not already)
- Modify: `apps/customer/src/components/OrderSummaryCard.tsx` / `OrderTimeline.tsx` (show delivery date/window)
- Modify: `apps/api/src/routes/preorder-shared.ts` notif payload + worker formatter (`apps/worker/src/outbox.ts`) to include scheduled date

**Interfaces:**
- Consumes: stored `scheduledDeliveryAt`, `altPhone`.

- [ ] **Step 1: Tracking payload includes schedule**

Ensure the tracking response returns `scheduled_delivery_at` (and `alt_phone` for admin/owner detail only — NOT public tracking). Add a customer test in `apps/customer` mappers if a mapper changes.

- [ ] **Step 2: Customer shows the promised date/window**

In the order summary/timeline, format `scheduled_delivery_at` to "Tue 7 Jul · Evening (4–8pm)".

- [ ] **Step 3: Notifications include the date**

Add `scheduled_delivery_at` to the `sale.preorder_fulfilled` and order-created payloads; format in the worker's Telegram message.

- [ ] **Step 4: Run affected tests + build**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/online-order.test.ts && cd ../customer && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/customer/src apps/worker/src
git commit -m "feat: surface scheduled delivery date/window on tracking + notifications"
```

---

# PHASE 3 — Homepage banner & removal

### Task 9: Dynamic live-stock homepage banner

**Files:**
- Create: `apps/customer/src/components/StockBanner.tsx`
- Modify: `apps/customer/src/routes/index.tsx` (render banner)
- Test: `apps/customer/src/components/StockBanner.test.tsx` (create)

**Interfaces:**
- Consumes: catalog `availableBySize` aggregated across products (per size: any product in stock?).

- [ ] **Step 1: Write failing component test**

```tsx
// StockBanner.test.tsx — render with stock summary props and assert copy.
it("announces 650 ready and 330 preorder", () => {
  render(<StockBanner summary={{ "650ml": "in_stock", "330ml": "preorder" }} />);
  expect(screen.getByText(/650ml.*delivery/i)).toBeInTheDocument();
  expect(screen.getByText(/330ml.*preorder/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, verify fail; then implement**

Compute a per-size summary from catalog data (size is `in_stock` if any product has `availableBySize[size] > 0`, else `preorder`). Render a dismissible top banner with copy derived from the summary. Render in `index.tsx` above the hero.

- [ ] **Step 3: Run test + build**

Run: `cd apps/customer && npx vitest run src/components/StockBanner.test.tsx && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/components/StockBanner.tsx apps/customer/src/components/StockBanner.test.tsx apps/customer/src/routes/index.tsx
git commit -m "feat(customer): dynamic live-stock homepage banner"
```

---

### Task 10: Remove gracious modal + retire preorder_only

**Files:**
- Delete: `apps/customer/src/components/GraciousContactModal.tsx`
- Modify: any importer (checkout, product detail) to drop usage
- Modify: `apps/api/src/routes/public-catalog.ts` + `public-orders.ts` — stop reading `product_variant.preorder_only`
- Modify: `apps/customer/src/lib/cart.tsx` — remove `isPreorderSize`/`preorderBySize` (now `isPreorderLine` only)

**Interfaces:** none new — pure removal. The DB column `preorder_only` is **kept** (no migration) but unread.

- [ ] **Step 1: Grep for all references**

Run: `grep -rn "GraciousContactModal\|preorder_only\|preorderOnly\|isPreorderSize\|preorderBySize" apps packages`
Expected: a known set of hits, each addressed below.

- [ ] **Step 2: Remove the modal + its wiring**

Delete the component; remove imports/usages and any `is_preorder` "we'll WhatsApp you" branch in `checkout.tsx` (replaced by Task 7 prompting).

- [ ] **Step 3: Stop reading preorder_only in API**

In `public-catalog.ts`/`public-orders.ts` remove reads of `preorderOnly` from the variant; behaviour is now availability-driven (Tasks 2 & 6). Keep returning the field in catalog only if a consumer still needs it — otherwise drop it from the output type too.

- [ ] **Step 4: Remove dead cart helpers**

Delete `isPreorderSize` and `preorderBySize`; confirm no remaining importers (grep again).

- [ ] **Step 5: Full typecheck + tests + builds**

Run:
```bash
cd apps/api && npx tsc -b && TZ=UTC npx vitest run
cd ../customer && npx tsc -b && npx vitest run && npx vite build
cd ../../packages/shared && npx vitest run
```
Expected: all green; grep from Step 1 returns no behavioural references (only the retained DB column definition).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove gracious modal + retire preorder_only reads (stock-driven)"
```

---

## Self-review notes

- **Spec coverage:** per-size counts (T1–T3), cart/detail placement (T3), whole-line preorder (T3), delivery engine + all rules incl. Sunday override (T4), real stored dates (T6), window picker + explicit prompting + alt phone + cost notice + off-hours (T7), tracking/notifications (T8), homepage banner (T9), removal of modal + preorder_only (T10), online-default-branch decisioning (T2/T6). All mapped.
- **Branch decisioning:** counts (T2) and order decision (T6) both use the online-default branch — consistent.
- **Reservation granularity:** `stock_reservation` has `variant_id` (verified) → `availableVariantAtBranch` subtracts variant-grained reservations exactly.
- **Migration safety:** T5 calls out the journal `when`-timestamp lesson.
- **Risk:** "now" injection for deterministic API schedule tests — T6 Step 1 gives a fallback (compute expected in-test from the same `Date`).
