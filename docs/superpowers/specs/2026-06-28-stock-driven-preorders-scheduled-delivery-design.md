# Stock-driven preorders + scheduled delivery — design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)

## Summary

Replace the current *silent* out-of-stock → preorder behaviour (and the "we'll
WhatsApp you" gracious modal, and the `preorder_only` variant flag) with an
**explicit, live-stock-driven** model:

- The storefront shows the **real per-size juice count** and labels each cart
  line **In stock** or **Preorder** up front.
- Out-of-stock items become preorders with a **real, computed delivery date and
  window** derived from business rules (size + day-of-week + time-of-day).
- The homepage shows a **dynamic banner** announcing which sizes are ready for
  delivery vs. on preorder, based on live stock.
- Checkout **prompts the customer clearly**: per-item status, the exact delivery
  date/window, a notice that **delivery cost will be confirmed separately**, and
  captures an **alternate phone number** for when the delivery number isn't on
  WhatsApp.

## Business rules (authoritative)

### Delivery hours
- **Mon–Sat:** 8am – 8pm
- **Sun:** 1pm – 8pm
- All times **Africa/Lagos (UTC+1, no DST)**.

### Delivery windows (redefined to fit the hours)
| Window    | Mon–Sat   | Sun       | Anchor instant |
|-----------|-----------|-----------|----------------|
| Morning   | 8am–12pm  | —         | 09:00          |
| Afternoon | 12pm–4pm  | 1pm–4pm   | 14:00          |
| Evening   | 4pm–8pm   | 4pm–8pm   | 18:00          |

Sunday offers **Afternoon + Evening only** (1–8pm). "Evening" everywhere = the
4–8pm slot.

### Per-line delivery target
Each cart line is **In stock** or **Preorder** (see "Availability model"). Its
target date/window:

- **In stock** → **today**, customer **picks** from today's *remaining* windows.
  If no window remains today (e.g. ordered after 8pm) → **next day**, customer
  picks from that day's windows.
- **650ml preorder** → **today's Evening** if Evening is still ahead today; else
  **next day's Evening**. Window is **fixed** (Evening), not picked.
- **330ml preorder** → **next day**, customer **picks** the window.
- **Sunday override:** any order **placed on Sunday** containing an
  **out-of-stock** line → that line is delivered **Monday** (650 = Monday
  Evening fixed; 330 = Monday, customer picks). In-stock Sunday orders still
  deliver **the same Sunday (1–8pm)**.

"Next day" = next calendar day (every day Mon–Sun is a delivery day). The Sunday
override is what pushes Sunday OOS to Monday rather than a literal Sunday-night
delivery.

### Order-level resolution ("one order, one date")
A cart may mix in-stock and preorder lines. The whole order ships together:
- **Order delivery date = the latest line's target date.**
- **Order window:** if any line on that final date is window-fixed (a 650
  preorder → Evening), the order uses **Evening**. Otherwise the customer
  **picks** from the windows available on that date.
- Consequence the user accepted: in-stock items in a mixed cart wait for the
  preorder date so the customer gets a single delivery.

### Worked examples (assume now = Lagos time)
| Now | Cart | Result |
|---|---|---|
| Wed 10:00 | 650 in stock | Wed, pick Afternoon/Evening (Morning passed) |
| Wed 21:00 | 650 in stock | Thu, pick any window |
| Wed 10:00 | 650 OOS | Wed Evening (fixed) |
| Wed 19:30 | 650 OOS | Thu Evening (fixed) |
| Wed 10:00 | 330 OOS | Thu, pick window |
| Sun 14:00 | 650 OOS | Mon Evening (Sunday override) |
| Sun 14:00 | 330 OOS | Mon, pick window |
| Sun 14:00 | 650 in stock | Sun, pick Afternoon/Evening |
| Wed 10:00 | 650 in stock + 330 OOS | Thu (latest), pick window |

## Availability model

### Per-size availability
Stock is an append-only ledger (`stock_ledger`) with `variant_id` recorded and
indexed (`idx_ledger_loc_product_variant`). Current `availableAtBranch` sums per
**product** (flavour). We add a per-**variant** function.

### Resolved decision — which branch decides
The customer chose "count across all branches," but an online order is placed
against the **online-default branch**, where stock is reserved/deducted. Showing
an all-branches count while the order's in-stock/preorder outcome is decided by a
single branch would contradict itself. **Resolution (confirm at review):**

> Everything that drives the customer's order — the displayed per-size count, the
> In-stock/Preorder badge, and the actual order decision — uses the
> **online-default branch's** stock. This guarantees the number shown matches
> what the customer can actually get, and matches where the order is fulfilled.

New domain function:
```ts
// packages/domain/src/availability.ts
export async function availableVariantAtBranch(
  db, { branchId, variantId },
): Promise<number>  // SUM(ledger.delta WHERE branch+variant) - active reservations
```
(If reservations remain product-grained, document the small over-/under-count
and prefer variant-grained reservation subtraction where feasible.)

### In-stock vs preorder
For each line, `available = availableVariantAtBranch(onlineDefaultBranch, variantId)`.
- `qty <= available` → **In stock** (reserve as today).
- `qty > available` → **whole line is Preorder** (no reservation; deduct at
  fulfilment, exactly like today's preorder path).

## Delivery-schedule module (shared, pure)

`packages/shared/src/delivery-schedule.ts` — no DB, no I/O, fully unit-testable.
Used by the **API (authoritative)** to compute and store the order's
`scheduled_delivery_at`, and by the **customer app (preview)** to show the date
live before payment.

```ts
export type DeliveryWindow = "morning" | "afternoon" | "evening";
export interface LineKind { sizeMl: number; inStock: boolean; }

// Windows + anchors, day-of-week availability (Sun excludes morning).
export function availableWindows(date: Date): DeliveryWindow[];

// Per-line target: { date: 'YYYY-MM-DD', window?: DeliveryWindow, pick: boolean }
export function lineTarget(now: Date, line: LineKind): LineTarget;

// Order resolution: latest date; evening-fixed dominates; else pickable.
export function orderSchedule(now: Date, lines: LineKind[]): {
  date: string;
  fixedWindow?: DeliveryWindow;     // present when a 650 preorder forces evening
  selectableWindows: DeliveryWindow[]; // [] when fixedWindow set
};

// Convert a chosen date+window to the stored instant (existing scheduledIso).
export function scheduledIso(date: string, window: DeliveryWindow): string;
```

The existing `apps/customer/src/lib/schedule.ts` is folded into / replaced by this
shared module so there is a single source of truth.

## API changes (`apps/api`)

- `public-catalog.ts`: expose **per-variant available count** (not just the
  per-flavour pool) so the storefront can render per-size counts and badges.
- `public-orders.ts` `CreateOnlineOrder`:
  - add `customer.alt_phone` (optional).
  - **Server is authoritative for the schedule.** Recompute in-stock/preorder per
    line from `availableVariantAtBranch(onlineDefault, …)` and compute
    `scheduled_delivery_at` via `orderSchedule(...)`. A client-supplied window is
    validated against `availableWindows(date)`; the date itself is server-derived,
    not trusted from the client.
  - keep `delivery_fee_ngn` = 0; the response/notifications carry a
    "delivery cost to be confirmed" flag for messaging.
  - store `alt_phone` (new column on `customer` or `sale_order` — see Data model).
- Telegram (`sale.preorder_fulfilled` / order-created events): include the
  computed delivery date/window and the alternate phone.

## Data model changes (`packages/db`)

- **New migration** (next number after current head): add `alt_phone text` to
  `customer` (or `sale_order` if it's order-specific — decide in plan; leaning
  `sale_order` since "delivery number" is per-order).
- No new tables. `scheduled_delivery_at` already exists on `sale_order`.
- Drop reliance on `product_variant.preorder_only` (column **retained** for
  safety, but no longer read by any code path — verified by grep in the plan).

## Customer app changes (`apps/customer`)

- **CartDrawer** + **ProductDetail**: show exact per-size count ("7 left") and an
  **In stock** / **Preorder** badge per line; when a quantity pushes a line over
  stock, flip the whole line to Preorder with an inline note.
- **Checkout**: explicit per-item status + the computed **delivery date/window**;
  a window **picker** when selectable; a clear **"delivery cost will be confirmed
  and sent to you separately"** notice; an **alternate phone** field.
- **Homepage**: dynamic banner from live stock — e.g. *"650ml ready for delivery
  today · 330ml on preorder (arrives next delivery day)"* — reflecting current
  online-default stock per size.
- **Remove** `GraciousContactModal` and its checkout wiring.
- Order tracking page already shows `scheduled_delivery_at`; ensure the new
  window/date and alt phone surface there.

## Removal checklist

- [ ] Delete `GraciousContactModal.tsx` + imports/usage at checkout.
- [ ] Remove the storefront `is_preorder` "we'll WhatsApp you" branch that gated
      on it; replace with the explicit per-line preorder labelling.
- [ ] Stop reading `product_variant.preorder_only` anywhere (catalog, public
      orders). Keep the DB column; treat availability as the only driver.
- [ ] Confirm the **till** keeps its current behaviour (preorder_only was already
      ignored at the till — see `docs/runbooks/preorder-rules.md`); this change
      must not alter POS selling.

## Non-goals (YAGNI)

- No delivery-fee calculation / live courier quotes (stays ₦0 + "confirmed
  separately"; `LIVE_COURIER_QUOTES` stays off).
- No change to the admin rider-booking flow (admin still books via the existing
  panel after the order lands).
- No change to walk-up/till selling.
- No customer-selectable future-date scheduling beyond the rule-derived date.

## Testing strategy

- **Unit (pure, fast):** `delivery-schedule.test.ts` covering every row of the
  worked-examples table + boundaries (exactly 8pm, exactly 1pm Sunday, midnight,
  evening-edge for 650, mixed-cart resolution). No DB.
- **Domain:** `availableVariantAtBranch` against seeded ledger rows (per-size).
- **API integration (Testcontainers):** online order create computes the right
  `scheduled_delivery_at`; per-line in-stock vs preorder by online-default stock;
  alt_phone persisted; client-supplied invalid window rejected.
- **Customer:** mapper/preview tests that the storefront preview matches the
  server schedule for representative cases.
- Keep the existing preorder integration tests green (fulfilment path unchanged).

## Phasing

- **Phase 1 — Counts & labels.** `availableVariantAtBranch`; catalog exposes
  per-variant counts; cart + product-detail show count + In-stock/Preorder badge;
  whole-line-preorder when qty > stock. Shippable on its own.
- **Phase 2 — Delivery engine & checkout.** `delivery-schedule.ts` (+ tests);
  server-authoritative `scheduled_delivery_at`; window picker; explicit checkout
  prompting; alt-phone field + migration; "cost confirmed separately" notice;
  off-hours always-open; surface date/alt-phone on tracking + Telegram.
- **Phase 3 — Homepage banner & removal.** Dynamic live-stock banner; delete
  gracious modal; retire `preorder_only` reads.

## Open risks / to confirm at review

1. **Branch reconciliation** (above) — counts + badge + decision all use the
   online-default branch. Confirm this overrides the earlier "all branches" answer.
2. **Reservation granularity** — reservations may be product-grained; per-size
   availability subtraction may need a variant-grained tweak to be exact.
3. **Mixed-cart "ship on latest date"** can delay in-stock items; accepted by the
   user but worth a clear checkout message.
