import { BoltMockProvider } from "./bolt-mock.js";
import { BoltLiveProvider } from "./bolt-live.js";
import { ShipbubbleLiveProvider } from "./shipbubble-live.js";
import { shipbubbleConfigFromEnv } from "./shipbubble-config.js";
import type { DeliveryProvider } from "./provider.js";

export type { DeliveryProvider, DeliveryQuote, NormalizedWebhook } from "./provider.js";

let cached: DeliveryProvider | null = null;

/**
 * Select the active delivery provider based on env.
 *
 *   DELIVERY_PROVIDER=shipbubble + SHIPBUBBLE_PROVIDER=live → real Shipbubble API
 *   DELIVERY_PROVIDER=bolt (default) + BOLT_PROVIDER=live    → real Bolt API
 *   anything else                                            → Bolt mock (safe dev default)
 *
 * Missing credentials degrade to the mock so checkouts never hard-fail in a
 * misconfigured environment — we log a warning instead.
 */
export function getDeliveryProvider(): DeliveryProvider {
  if (cached) return cached;

  const active = (process.env["DELIVERY_PROVIDER"] ?? "bolt").toLowerCase();

  if (active === "shipbubble") {
    const mode = (process.env["SHIPBUBBLE_PROVIDER"] ?? "mock").toLowerCase();
    const cfg = shipbubbleConfigFromEnv(process.env);
    if (mode === "live" && cfg) {
      cached = new ShipbubbleLiveProvider(cfg);
      return cached;
    }
    if (mode === "live") {
      // eslint-disable-next-line no-console
      console.warn(
        "[delivery] DELIVERY_PROVIDER=shipbubble + live but SHIPBUBBLE_API_KEY missing — falling back to mock",
      );
    }
    return mockProvider();
  }

  // Default: Bolt (legacy).
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
  return mockProvider();
}

function mockProvider(): DeliveryProvider {
  const webhookUrl =
    process.env["BOLT_MOCK_WEBHOOK_URL"] ?? "http://127.0.0.1:3001/v1/webhooks/bolt";
  cached = new BoltMockProvider({ webhookUrl });
  return cached;
}

/** Test/reset hook — used by integration tests to clear the singleton. */
export function _resetDeliveryProviderForTesting(): void {
  cached = null;
}
