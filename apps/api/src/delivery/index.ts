import { BoltMockProvider } from "./bolt-mock.js";
import { BoltLiveProvider } from "./bolt-live.js";
import type { DeliveryProvider } from "./provider.js";

export type { DeliveryProvider, DeliveryQuote, NormalizedWebhook } from "./provider.js";

let cached: DeliveryProvider | null = null;

/**
 * Select the active delivery provider based on env.
 *
 *   BOLT_PROVIDER=live  → real Bolt API (requires BOLT_API_KEY + BOLT_WEBHOOK_SECRET)
 *   anything else       → mock (safe default for dev / mock-mode prod tests)
 *
 * If `live` is set but credentials are missing we log a warning and fall
 * through to mock so checkouts don't fail in misconfigured environments.
 */
export function getDeliveryProvider(): DeliveryProvider {
  if (cached) return cached;

  const mode = (process.env["BOLT_PROVIDER"] ?? "mock").toLowerCase();
  const apiKey = process.env["BOLT_API_KEY"];
  const webhookSecret = process.env["BOLT_WEBHOOK_SECRET"];
  const apiBase = process.env["BOLT_API_BASE"] ?? "https://api.bolt.eu";

  if (mode === "live" && apiKey && webhookSecret) {
    cached = new BoltLiveProvider({ apiBase, apiKey, webhookSecret });
    return cached;
  }
  if (mode === "live") {
    // eslint-disable-next-line no-console
    console.warn(
      "[delivery] BOLT_PROVIDER=live but BOLT_API_KEY / BOLT_WEBHOOK_SECRET missing — falling back to mock",
    );
  }

  const webhookUrl =
    process.env["BOLT_MOCK_WEBHOOK_URL"] ?? "http://127.0.0.1:3001/v1/webhooks/bolt";
  cached = new BoltMockProvider({ webhookUrl });
  return cached;
}

/** Test/reset hook — used by integration tests to clear the singleton. */
export function _resetDeliveryProviderForTesting(): void {
  cached = null;
}
