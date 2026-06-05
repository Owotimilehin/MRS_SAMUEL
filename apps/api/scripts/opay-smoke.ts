/**
 * Live smoke test of the OPay Cashier integration against real credentials.
 * Run: pnpm --filter @ms/api exec tsx --env-file=../../.env scripts/opay-smoke.ts
 *
 * Exercises the real client code (not raw curl):
 *   1. createOpaySession  — creates a small real Cashier order, prints cashierUrl
 *   2. queryOpayOrder     — reads the order back to confirm the signing scheme
 *
 * This is the gate for go-live: if step 2 returns a valid `code: 00000`
 * response, the OPAY_SIGN_ALG / key wiring is correct. If it 401s, flip
 * OPAY_SIGN_ALG between `hmac-sha512` and `rsa-sha256` and re-run — the signer
 * is the only thing that changes.
 *
 * Uses a tiny amount (₦100) and does NOT complete payment — no money moves
 * unless you actually open the printed cashierUrl and pay.
 */
/* eslint-disable no-console -- manual smoke script, prints to stdout */
import { createOpaySession, queryOpayOrder } from "../src/payments/opay.js";

if (!process.env.OPAY_PUBLIC_KEY || !process.env.OPAY_MERCHANT_ID) {
  console.error("OPAY_PUBLIC_KEY / OPAY_MERCHANT_ID not set — aborting");
  process.exit(1);
}

function log(label: string, v: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const reference = `SMOKE-${Date.now()}`;

  // 1. Create a real Cashier session (₦100).
  const session = await createOpaySession({
    amountNgn: 100,
    email: "smoke@mrssamuel.com",
    reference,
    returnUrl: "https://mrssamuel.com/order/" + reference + "?paid=1",
    callbackUrl: "https://api.mrssamuel.com/v1/webhooks/opay",
    productName: "OPay smoke test",
  });
  log("createOpaySession()", session);

  // 2. Read it back — this is the signed (private-key) call that proves the
  //    signing scheme. Fresh orders report INITIAL/PENDING; that's success
  //    here — we only care that the call authenticates.
  const status = await queryOpayOrder(reference);
  log("queryOpayOrder()", status);

  console.log(
    `\nOpen this URL to pay manually and confirm the webhook fires:\n  ${session.authorization_url}\n`,
  );
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err);
  process.exit(1);
});
