/**
 * Live smoke test of the Payaza collection integration against test/live keys.
 * Run: pnpm --filter @ms/api exec tsx --env-file=../../.env scripts/payaza-smoke.ts
 *
 * Exercises the real client code (not raw curl):
 *   1. createPayazaSession     — creates a small real checkout, prints the URL
 *   2. verifyPayazaTransaction — reads it back to confirm auth + parsing
 *
 * This is the gate for go-live AND the place where the API open items get
 * pinned: if step 1 returns a checkout URL and step 2 returns a recognised
 * status without a 401, the PAYAZA_AUTH_SCHEME / key wiring is correct. If
 * either 401s, flip PAYAZA_AUTH_SCHEME between `payaza-base64` and `bearer`
 * and re-run — the auth header is the only thing that changes. If the endpoint
 * path or response envelope differs from what payaza.ts assumes, fix it there.
 *
 * Uses a tiny amount (₦100) and does NOT complete payment — no money moves
 * unless you actually open the printed checkout URL and pay.
 */
/* eslint-disable no-console -- manual smoke script, prints to stdout */
import { createPayazaSession, verifyPayazaTransaction } from "../src/payments/payaza.js";

if (!process.env.PAYAZA_SECRET_KEY) {
  console.error("PAYAZA_SECRET_KEY not set — nothing to smoke-test (mock mode).");
  process.exit(1);
}

async function main(): Promise<void> {
  const reference = `SMOKE-${Date.now()}`;
  console.log("Auth scheme:", process.env.PAYAZA_AUTH_SCHEME ?? "payaza-base64 (default)");
  console.log("API base:", process.env.PAYAZA_API_BASE ?? "https://api.payaza.africa/live (default)");
  console.log("Reference:", reference, "\n");

  console.log("1) createPayazaSession …");
  const session = await createPayazaSession({
    amountNgn: 100,
    email: "smoke@mrssamuel.ng",
    reference,
    returnUrl: "https://mrssamuel.com/order/SMOKE?paid=1",
    callbackUrl: "https://api.mrssamuel.com/v1/webhooks/payaza",
    productName: "Payaza smoke test",
  });
  console.log("   checkout URL:", session.authorization_url, "\n");

  console.log("2) verifyPayazaTransaction …");
  const status = await verifyPayazaTransaction(reference);
  console.log("   status:", JSON.stringify(status), "\n");

  console.log("✅ Smoke completed without an auth error. Confirm the status value");
  console.log("   above matches a Payaza success spelling in isPayazaSuccess().");
}

main().catch((err) => {
  console.error("❌ Smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
