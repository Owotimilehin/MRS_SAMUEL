/**
 * Live smoke test of the Payaza collection integration against test/live keys.
 * Run: pnpm --filter @ms/api exec tsx --env-file=../../.env scripts/payaza-smoke.ts
 *
 * Payaza checkout is a frontend JS SDK, so the only server-side API is the
 * transaction-query (verify) endpoint. This exercises the real client code
 * (verifyPayazaTransaction) against Payaza's live API: a 200/400 business
 * response (not 401/403) confirms the endpoint path + base64 public-key auth.
 *
 * No money moves — it only reads a throwaway reference.
 */
/* eslint-disable no-console -- manual smoke script, prints to stdout */
import { verifyPayazaTransaction } from "../src/payments/payaza.js";

if (!process.env.PAYAZA_PUBLIC_KEY) {
  console.error("PAYAZA_PUBLIC_KEY not set — nothing to smoke-test (mock mode).");
  process.exit(1);
}

/**
 * NOTE: Payaza checkout is a FRONTEND JS SDK (checkout-v2.payaza.africa), not a
 * server-side initiate call — so the only server-side API to smoke is the
 * transaction-query (verify) endpoint. We query a throwaway reference: a 200
 * (even with success:false / "not found") proves the endpoint path + base64
 * public-key auth are correct. A 401/403 means the auth header is wrong.
 */
async function main(): Promise<void> {
  const reference = `SMOKE-${Date.now()}`;
  console.log("API base:", process.env.PAYAZA_API_BASE || "https://api.payaza.africa/live (default)");
  console.log("Reference:", reference, "\n");

  console.log("verifyPayazaTransaction (transaction-query) …");
  const status = await verifyPayazaTransaction(reference);
  console.log("   result:", JSON.stringify(status), "\n");
  console.log("✅ Verify endpoint reachable + auth accepted (no 401/403).");
}

main().catch((err) => {
  console.error("❌ Smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
