# Payment fixes (`work/olu/payment-fixes`): read before merging

For Tes and whoever reviews the branch. It fixes P1, P2 and P3/A1 from the 17 Nov audit. Two questions can only be answered by OPay, and five things change at deploy. No database migration is included.

## Check with OPay before merging

Two behaviours of OPay decide whether parts of this branch work as intended. We could not test either (no sandbox access from the build machine, and we did not guess). Run both against the sandbox (`OPAY_API_BASE=https://testapi.opaycheckout.com`) with the sandbox keys, in your own terminal so the keys never land in a chat or a log. Only the variable names appear below.

### Call 1: status of a reference OPay has never seen

Why it matters: when OPay cannot be reached at checkout, the order is now saved without an OPay session. The worker later asks OPay for that order's status. `parseOpayStatus` (`apps/api/src/payments/opay.ts`) treats every answer whose `code` is not `00000` as "the check failed".

```bash
BODY='{"reference":"SO-NEVER-SEEN-0001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$OPAY_SECRET_KEY" -hex | sed 's/^.* //')
curl -s -X POST "$OPAY_API_BASE/api/v3/cashier/status" \
  -H "content-type: application/json" \
  -H "MerchantId: $OPAY_MERCHANT_ID" \
  -H "authorization: Bearer $SIG" \
  -d "$BODY"
```

| OPay answers | What it means for us | Code change needed |
|---|---|---|
| `code: "00000"` with a status that is not `SUCCESS` (or empty `data`) | Read as "not paid". Such orders are cancelled at 60 minutes like any other. | None. |
| Any other `code` (for example an "order does not exist" code) | Read as "check failed". Each such order stays open for up to 6 hours instead of 1, is then cancelled unchecked, and the late-payment sweep keeps asking about it for 48 hours. Every attempt logs an error in the API and sends one event to Sentry. No money is at risk; it is noise and a delayed cancel. | In `parseOpayStatus`, treat that one exact code as a normal "not paid" answer (return a non-success status instead of throwing), with a unit test in `apps/api/test/unit/opay.test.ts`. About five lines. Do not widen it to other codes: an authentication failure must keep failing loudly. |

### Call 2: a second payment session for the same reference

Why it matters: "Complete payment" on the order page (which this branch makes work for the first time, see below) and the new "Try payment again" page both call `cashier/create` again with the same reference, our order number.

Run this twice with the same reference. Then run it a third time after opening the first `cashierUrl` in a browser and abandoning it.

```bash
curl -s -X POST "$OPAY_API_BASE/api/v1/international/cashier/create" \
  -H "content-type: application/json" \
  -H "MerchantId: $OPAY_MERCHANT_ID" \
  -H "authorization: Bearer $OPAY_PUBLIC_KEY" \
  -d '{"country":"NG","reference":"SO-DUP-TEST-0001","amount":{"total":250000,"currency":"NGN"},"returnUrl":"https://www.mrssamuel.com/order/SO-DUP-TEST-0001?paid=1","callbackUrl":"https://api.mrssamuel.com/v1/webhooks/opay","expireAt":30,"userInfo":{"userName":"Test","userEmail":"test@example.com","userMobile":"+2348000000000"},"product":{"name":"Mrs Samuel juice order","description":"Order SO-DUP-TEST-0001"}}'
```

| OPay answers the second call | What it means for us | Code change needed |
|---|---|---|
| `code: "00000"` and a `cashierUrl` (new or the same) | "Complete payment" works. | None. |
| A rejection (duplicate reference) | "Complete payment" and "Try payment again" can never open a payment page once a first session exists. The customer now sees "We couldn't open the payment page" instead of nothing, but still cannot pay. This also covers a first call that timed out on our side yet was registered by OPay. | The resume endpoint (`POST /v1/public/orders/:orderNumber/opay-session`) must send a fresh reference per attempt (for example the order number plus a counter), and the status check and webhook must map that reference back to the order and ask OPay about every reference used. This touches the money path and needs its own review. Until it is done, treat "Complete payment" as not working. |

## What changes at deploy

1. **`INTERNAL_RECONCILE_TOKEN` must be set, or the rate-limit fix does nothing.** With it set, the storefront tells the API each shopper's address and every shopper gets their own limit of 30 requests a minute. With it empty, all shoppers still share one limit, exactly as today. Setting it has a second effect: the delivery-reconcile endpoint (`/v1/webhooks/delivery-reconcile`) starts requiring the token. The worker already sends it, so nothing should break, but it is a change. Generate with `openssl rand -hex 32`.

2. **Set `HOST_BIND=127.0.0.1`.** The storefront takes the shopper's address from Cloudflare's `CF-Connecting-IP` header. Compose publishes the ports on every network interface by default. If port 3002 can be reached on the server's public IP, anyone can send that header themselves and get a fresh rate limit each time. Cloudflare Tunnel connects over localhost, so binding to 127.0.0.1 does not affect it.

3. **Old stored failures become retryable. Check the till queues first.** Until now every failed request was remembered for 30 days and replayed. After this deploy, a request that was stored as rejected with status **400, 401, 403, 404, 409, 422 or 429** runs for real the next time the same request is sent. Stored 5xx failures keep replaying and are never run again.
   - A till sale that is still **pending** because it first met an expired session (stored 401) will lodge by itself the next time that till syncs. That is the fix working. If staff already re-rang that sale by hand, it will exist twice.
   - A till row **parked** ("dead") on a 400, 403, 404, 409 or 422 will run if staff press **Retry**. If it was re-rung by hand, that is also a second sale.
   - Before deploying, open the queue screen on each till and **Drop** every row that was already re-rung.

4. **During an OPay outage, unpaid orders can stay open for up to 6 hours** instead of being cancelled at 60 minutes, because an order is no longer cancelled when its last payment check failed. Stock is still released at 30 minutes as before. After 6 hours the order is cancelled without a check and the late-payment sweep watches it for 48 hours.

5. **A few "Payment on a CANCELLED order" alerts may arrive together on first deploy.** The new sweep looks back 48 hours. Each alert is a real payment for an order that was cancelled as unpaid and needs a refund or a manual decision. Nothing is refunded or reinstated automatically.

## Smaller things worth knowing

- The table `idempotency_key` gains a third value in its `status` text column, `failed` (a failure kept on purpose and replayed). It is a text column with no constraint, so no migration. Rolling back to the old code is safe: it replays `failed` rows like any stored response.
- A request that was cut off mid-flight can be retried after 15 minutes. Before that the retry is told to wait. The till now treats "wait" as "try again later" instead of parking the sale.
- "Complete payment" on the order page had never worked: the API answered in a shape the storefront could not read. That is fixed here, which is why Call 2 above matters.
- Not covered by this branch: P4 to P8 and A3 to A6 from the audit.
