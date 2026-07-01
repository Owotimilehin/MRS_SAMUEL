# Checkout Attempt Log — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Author:** Claude + owner

## Problem

When a customer presses "Place order", the flow can fail at several points and we
currently have **no visibility**: the form may be rejected, the order API may
error, or (the bug we just fixed) the Payaza popup may fail to open. We could not
reproduce the popup failure live. The owner wants a durable, reviewable record of
**every** press — the delivery details entered, what error (if any) occurred, and
the response — so future checkout/payment problems can be diagnosed from real data
instead of guesswork.

## Goal

Record every "Place order" press and its full lifecycle, viewable by the owner in
the admin app, with a Telegram alert the moment a press fails. Personal data is
auto-pruned after 30 days. This is a **diagnostic/audit** feature; it must never
affect the customer's ability to order.

## Non-goals

- No card/payment data is logged (Payaza handles payment; that data never reaches us).
- No change to the order/payment money path.
- No analytics dashboard / charts — just a reviewable log.

## Concepts

A single press = one **attempt**, identified by `attempt_id` (the existing
per-press idempotency key, reused). As the flow unfolds we **append** stage rows
that share the same `attempt_id`, so the admin view shows a timeline per press.

### Stages

| stage | when | status |
|---|---|---|
| `pressed` | button tapped; form snapshot taken | `info` |
| `validation_failed` | a required field is missing/invalid | `error` |
| `order_created` | order API returned an order number | `ok` |
| `order_failed` | order API threw (stock conflict / network / server) | `error` |
| `payment_paid` | Payaza reported success | `ok` |
| `payment_closed` | customer dismissed the popup without paying | `abandoned` |
| `payment_failed` | popup failed to open / SDK blocked / Payaza rejected | `error` |

Failure stages (`validation_failed`, `order_failed`, `payment_failed`) trigger a
Telegram alert. `pressed` / `order_created` / `payment_paid` / `payment_closed`
are silent.

## Data model

New table `checkout_attempt_log` (migration `0061_checkout_attempt_log`):

```ts
export const checkoutAttemptLog = pgTable("checkout_attempt_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: text("attempt_id").notNull(),          // groups stages of one press
  stage: text("stage").notNull(),                   // see Stages table
  status: text("status").notNull(),                 // info | ok | error | abandoned
  orderNumber: text("order_number"),                // set from order_created onward
  // Delivery details snapshot (whatever was filled at press time)
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  customerEmail: text("customer_email"),
  deliveryAddress: text("delivery_address"),
  deliveryState: text("delivery_state"),
  deliveryWindow: text("delivery_window"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  itemsJson: jsonb("items_json"),                   // [{variant_id,name,size,qty}]
  totalNgn: integer("total_ngn"),
  errorMessage: text("error_message"),
  responseJson: jsonb("response_json"),             // order id, payaza response type, etc.
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),                    // server-stamped
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Index on `(attempt_id)` and `(created_at)` for grouping + newest-first listing + prune.

**Migration journal note:** when adding `0061` to `packages/db/migrations/meta/_journal.json`,
the `when` timestamp MUST be strictly greater than the latest existing entry's
`when`, or Drizzle silently skips the migration (prior production incident). Verify
after generating.

## Components

### 1. Public beacon endpoint — `POST /v1/checkout-log`

Unauthenticated (checkout is public). Accepts a JSON body:

```ts
{
  attempt_id: string,            // client UUID (the idempotency key)
  stage: Stage,
  status?: Status,               // derived from stage if omitted
  order_number?: string,
  customer?: { name?, phone?, email?, address?, state? },
  delivery_window?: string,
  scheduled_for?: string,        // ISO
  items?: Array<{ variant_id, name, size, qty }>,
  total_ngn?: number,
  error_message?: string,
  response?: Record<string, unknown>,
}
```

Behaviour:
- **Strict zod validation.** Unknown/oversized input rejected. Caps: each string
  ≤ 500 chars, `error_message` ≤ 1000, `items` ≤ 50, `response` serialized ≤ 4 KB,
  `stage` must be one of the enum.
- **Per-IP rate limit** (in-memory token bucket, e.g. 60 writes / 5 min / IP) to
  bound abuse of an unauthenticated PII-writing endpoint. Over-limit → 429, no row.
- Server stamps `ip_address` (from `x-forwarded-for` / connection) and `user_agent`.
- Inserts one row. Derives `status` from `stage` if not supplied.
- On a failure stage, inserts an `outboxEvent` with `eventType: "checkout.failed"`
  and a payload (attempt_id, stage, customer name/phone, error_message, order_number)
  so the worker sends Telegram.
- Always returns `204` quickly. Internal errors are logged but still return `204`
  (logging must never surface to the customer).

### 2. Telegram alert (worker)

- Add `"checkout.failed"` to the worker's event humanizer → a concise message:
  who (name/phone), which stage, the error, order number if any, Lagos time + link.
- Reuses the existing `outboxEvent` → worker → Telegram pipeline (same as
  `sale.online_placed`). No new transport.

### 3. Client wiring — `apps/customer/src/routes/checkout.tsx`

- New helper `logCheckout(stage, extra?)`:
  - Builds the payload from current `form` + cart snapshot + `idemRef.current`.
  - Sends via `fetch(url, { method: "POST", keepalive: true, ... })` so it survives
    the post-payment redirect. Wrapped in try/catch; **all failures swallowed.**
  - Pure payload-builder split out (`buildCheckoutLogPayload`) for unit testing.
- Call sites (hooks already exist from the recent refactor):
  - `submit()` start (after `idemRef` set) → `pressed`
  - missing-fields branch → `validation_failed` (+ message listing fields)
  - after `placeOrderFn` resolves → `order_created` (order_number, total)
  - `submit()` catch → `order_failed` (+ api error code/message)
  - `proceedToPayment` `onPaid` → `payment_paid`
  - `onClose` → `payment_closed`
  - `onError` → `payment_failed` (+ message)

### 4. Owner admin page — `/owner/checkout-log`

- Auth'd `GET /v1/checkout-log?limit&before` (owner-only, same gating as other
  owner-only reports). Returns attempts **grouped by `attempt_id`**, newest first,
  each with its ordered stage rows. Cursor pagination on `created_at`.
- Page renders each attempt as a card: customer name/phone, address, items + total,
  and a vertical stage timeline (icon per status) with timestamps and any error
  message. Newest at top; "load more" pagination.
- Add a Nav entry under the owner section.

### 5. Worker prune job

- Daily job: `DELETE FROM checkout_attempt_log WHERE created_at < now() - interval '30 days'`.
- Registered alongside existing worker jobs (`runJob` isolation).

## Data flow

```
press → logCheckout("pressed")            ─┐
  ├ invalid → logCheckout("validation_failed") → POST /v1/checkout-log → row + Telegram
  └ valid → placeOrder API
        ├ ok  → logCheckout("order_created")   → row
        │        Payaza popup
        │          ├ paid   → logCheckout("payment_paid")   → row
        │          ├ closed → logCheckout("payment_closed") → row
        │          └ error  → logCheckout("payment_failed") → row + Telegram
        └ err → logCheckout("order_failed")    → row + Telegram
```

## Error handling

- Client: logging is fire-and-forget; a network/endpoint failure never blocks or
  breaks ordering (try/catch, ignore).
- Server: validation/rate-limit failures return 4xx with no row; unexpected errors
  are logged server-side but the endpoint still returns 204.
- Telegram: enqueue only; if the worker/Telegram is down, the row is still saved
  (Telegram is best-effort, the log is the source of truth).

## Privacy

- Stores customers' own delivery PII (name/phone/email/address) server-side,
  auto-pruned at 30 days by the worker.
- No card/payment data is ever captured.
- Read access is owner-only.

## Testing

- **API endpoint:** writes a row for a valid payload; derives status from stage;
  rejects malformed/oversized payloads; enforces per-IP rate limit (429);
  enqueues `checkout.failed` outbox only on failure stages; stamps IP/UA.
- **API read:** owner-only (401/403 for others); groups rows by attempt_id newest
  first; cursor pagination boundary.
- **Worker prune:** deletes rows older than 30 days, keeps newer (boundary test).
- **Worker humanizer:** `checkout.failed` renders expected message fields.
- **Client:** `buildCheckoutLogPayload` produces the right shape per stage
  (node test; customer app has no DOM tests).

## Migration / deploy notes

- Migration `0061_checkout_attempt_log` (+ verified `_journal.json` timestamp).
- New owner Nav link → PWA hard-refresh to appear.
- Auto-deploys on push to master.

## Open questions

None outstanding. (Stages, retention=30d, view=admin+Telegram-on-failure all
confirmed with the owner.)
