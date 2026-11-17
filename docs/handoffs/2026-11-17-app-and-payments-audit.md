# App and payments audit: what is not working

Audit of the released code (master `9d08c06`) on 17 Nov 2026, by Olu with Claude. Read-only: nothing here was changed in production and no production data was read. Items marked **fixed on branch** are in `work/olu/unified-inbox`; everything else needs a decision from Tes.

## Payments

How it works today: checkout creates the order and a 30-minute stock hold, then sends the customer to OPay. The order is marked paid only after the server asks OPay for the status itself (the webhook body is never trusted). A worker re-checks unpaid orders every 2 minutes and cancels them at 60 minutes. OPay is the only live provider; the Payaza code is gone.

| # | Problem | What the customer or owner sees | Severity |
|---|---|---|---|
| P1 | **A payment that lands after the 60-minute cancel is never noticed** unless OPay's own callback arrives. The sweep only looks at unpaid-and-open orders. If the last re-check fails (OPay down), the order is cancelled anyway. "Complete payment" at minute 55 gives a fresh 30-minute OPay session but the order still dies at 60. (`apps/worker/src/jobs/payment-reconcile.ts:55`, `expire-unpaid-orders.ts:55-62`, `apps/api/src/routes/public-orders.ts:675,812`) | Customer paid, order shows cancelled, nobody is told | High |
| P2 | **Every shopper shares one limit of 30 requests a minute.** The storefront server calls the API without passing the shopper's address, so all shoppers count as one. Quotes, checkout and the 20-second order-tracking refresh all draw from it. (`apps/api/src/middleware/rate-limit.ts:44`, `docker-compose.yml:206`) | Checkout fails with "too many requests" when a few people have a tracking page open. Likely the main cause of "payments are flaky" | High |
| P3 | **A failed checkout is remembered and replayed.** Any response, including errors, is stored against the request key for 30 days. The order is saved and the cart emptied *before* OPay is contacted, so an OPay timeout returns an error but leaves an order, held stock and a "new order" alert. Retrying creates another order (JavaScript on) or replays the same error for the rest of the hour (JavaScript off). If the server restarts mid-request the spinner never ends. (`apps/api/src/middleware/idempotency.ts:61-77`, `public-orders.ts:359-610`, `apps/customer/src/routes/checkout.tsx:369,415`) | "An unexpected error occurred", duplicate unpaid orders, endless spinner | High |
| P4 | **A customer who just paid is told to pay.** The return page ignores that they came back from OPay. While OPay still says pending (bank transfer, USSD) it shows "Almost there, complete payment", and at 30 minutes "your hold expired" although the order is payable until 60. A return in a different browser asks for the phone number again. (`apps/customer/src/routes/order.$orderNumber.tsx`, `PaymentHoldBanner.tsx:27`) | Confusion and a risk of paying twice | Medium |
| P5 | **Cancelling a paid preorder that was not yet produced adds stock that never existed.** (`apps/api/src/routes/payments-admin.ts:282-300`, `sales.ts:1169`) | Stock count too high | Medium |
| P6 | **Stock is held for 30 minutes but payment is accepted for 60.** A payment in the second half-hour takes stock without checking it is still there. | Overselling | Medium |
| P7 | **"Accept as paid" does not check that OPay reported success**, and errors out if OPay cannot be reached. (`payments-admin.ts:207-227`) | An order can be booked as card-paid when it was not | Medium |
| P8 | Smaller: cancel-and-refund has no status guard (a webhook in between leaves stock wrong); a manual payment followed by an OPay success raises no double-payment alert; the webhook endpoint is open and unlimited (safe for money, abusable); "Re-check payment" shows nothing when OPay says not completed; a missing email is sent to OPay as a placeholder address. | | Low |

Leftovers that mislead: `PAYAZA_*` settings and comments in `docker-compose.yml:66-72,145-150`, `scripts/payaza-fee-fields-check.sql`, `apps/admin/e2e/payaza-checkout.spec.ts`.

What is solid: money decisions come only from the signed status query; an order cannot be marked paid twice or have stock deducted twice; naira/kobo conversion is correct; prices and fees are computed on the server.

### Recommended order

1. P2 (one small change, probably the biggest visible win).
2. P3 (stop storing error responses; when OPay cannot be reached, still give the customer their order number and a "complete payment" page).
3. P1 (keep re-checking cancelled orders for 24 to 48 hours; do not cancel when the re-check itself failed).
4. P4, then P5 to P8.

### Numbers needed from production (Tes)

- P1 size: `SELECT order_number, created_at FROM sale_order WHERE channel='online' AND status='cancelled' AND cancel_reason='payment_expired' ORDER BY created_at DESC;` compared with successful transactions in the OPay dashboard.
- P2/P3 size: `SELECT response_status, count(*) FROM idempotency_key WHERE endpoint='/v1/public/orders' GROUP BY 1;` and API logs for `too many requests`, `opay create failed`, `opay create rejected`.
- Whether OPay rejects a second checkout session for the same order number (decides whether "Complete payment" works at all).

## The rest of the app

| # | Problem | What staff see | Status |
|---|---|---|---|
| A1 | **A failed request poisons its retry** (same cause as P3, app-wide). An action taken just after the session lapses is stored as "unauthorized" and replayed after signing back in. A till sale queued offline that first meets an expired session never lodges. A request cut off by a deploy stays "in progress" for good. The table is never cleaned. (`idempotency.ts:61-77`, `apps/admin/src/lib/api.ts:305-312`, `apps/admin/src/sync/engine.ts:82-113`) | Actions fail until retried from scratch; a lost offline sale | **Open. High.** |
| A2 | **Database rule errors showed as "an unexpected error occurred."** The database library wraps errors and six places looked in the wrong spot: deleting a staff member who has history, reopening a shift close, correcting a packaging purchase, settling a transfer variance, two shift opens at once, two stock adjustments at once. | A server error instead of a clear message; the staff member could not be removed | **Fixed on branch** (`apps/api/src/lib/errors.ts`, six routes) |
| A3 | **Worker: one slow outside call stalls every job**, because no outgoing call has a time limit. Alerts retry every 5 seconds and are dropped after about a minute. A name or note containing `_` or `*` breaks the Telegram message, so that alert, and the alert about the failure, are lost. (`apps/worker/src/notifiers/telegram.ts:17-23`, `outbox.ts:519-523,635-649`) | Missing owner alerts and customer emails; delayed expiry and reconcile | Open. Medium. |
| A4 | **Deploy does not wait for tests.** A push to master deploys even when CI is red, and CI on master is very likely red (below). (`.github/workflows/deploy.yml`) | Broken code can reach customers | Open. Medium. |
| A5 | **`/v1/echo` is live and needs no login.** A leftover test endpoint that can write rows into the database. (`apps/api/src/test-app.ts`) | None yet; it is an open door | Open. Low/Medium. |
| A6 | Smaller: two bottle materials of the same size can link a new flavour to the wrong one ("not enough bottles"); a delivery-quote failure is hidden and checkout proceeds at ₦0 delivery; the storefront ships 28 MB of PNG images; browser tests are not in CI. | | Open. Low. |

### Tests on master (run locally against Postgres 16)

| Package | Passed | Failed |
|---|---|---|
| apps/api | 469 | 7, plus 2 suites that crash in setup |
| apps/worker, admin, customer, db, domain, shared | all | 0 |

Of the API failures, one was a real bug (A2, now fixed). The others are stale tests: hard-coded June 2026 dates, a hard-coded count of 53 migrations (there are now 70), test data that no longer matches a rule added on 14 June, and one test that depends on random ordering.

## Not checked

- Real CI status on GitHub, production settings, production logs and data.
- Paths that need Redis, and the browser tests.
- The DigitalOcean account (the guard blocked reading it).
