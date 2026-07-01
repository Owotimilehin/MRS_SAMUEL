import { ShipbubbleLiveProvider } from "./shipbubble-live.js";
import { ShipbubbleMockProvider } from "./shipbubble-mock.js";
import { shipbubbleConfigFromEnv } from "./shipbubble-config.js";
import type { DeliveryProvider } from "./provider.js";

export type { DeliveryProvider, DeliveryQuote, NormalizedWebhook } from "./provider.js";

let cached: DeliveryProvider | null = null;

/**
 * Select the active delivery provider. Shipbubble is the only integration:
 *
 *   SHIPBUBBLE_PROVIDER=live + credentials present → real Shipbubble API
 *   anything else                                  → Shipbubble mock (dev/CI)
 *
 * Missing credentials degrade to the mock so checkouts never hard-fail in a
 * misconfigured environment — we log a warning instead.
 */
export function getDeliveryProvider(): DeliveryProvider {
  if (cached) return cached;

  const mode = (process.env["SHIPBUBBLE_PROVIDER"] ?? "mock").toLowerCase();
  const cfg = shipbubbleConfigFromEnv(process.env);
  if (mode === "live" && cfg) {
    cached = new ShipbubbleLiveProvider(cfg);
    return cached;
  }
  if (mode === "live") {
    // eslint-disable-next-line no-console
    console.warn(
      "[delivery] SHIPBUBBLE_PROVIDER=live but SHIPBUBBLE_API_KEY missing — falling back to mock",
    );
  }
  return mockProvider();
}

function mockProvider(): DeliveryProvider {
  const webhookUrl =
    process.env["DELIVERY_MOCK_WEBHOOK_URL"] ?? "http://127.0.0.1:3001/v1/webhooks/shipbubble";
  cached = new ShipbubbleMockProvider({ webhookUrl });
  return cached;
}

/** Test/reset hook — used by integration tests to clear the singleton. */
export function _resetDeliveryProviderForTesting(): void {
  cached = null;
}
