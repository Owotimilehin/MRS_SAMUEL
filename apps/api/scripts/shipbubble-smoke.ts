/**
 * Live smoke test of the ShipbubbleLiveProvider against the sandbox key.
 * Run: pnpm --filter @ms/api exec tsx --env-file=../../.env scripts/shipbubble-smoke.ts
 *
 * Exercises the real provider code (not raw curl): quote → requestDelivery →
 * cancelDelivery, plus a webhook parse round-trip with a signed payload.
 */
import crypto from "node:crypto";
import { ShipbubbleLiveProvider } from "../src/delivery/shipbubble-live.js";
import { shipbubbleConfigFromEnv } from "@ms/domain";

const cfg = shipbubbleConfigFromEnv(process.env);
if (!cfg) {
  console.error("SHIPBUBBLE_API_KEY not set — aborting");
  process.exit(1);
}
// Force a webhook secret so the parse round-trip can be tested even if unset.
cfg.webhookSecret = cfg.webhookSecret || "smoke-test-secret";
const provider = new ShipbubbleLiveProvider(cfg);

function log(label: string, v: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  // 1. quote
  const quote = await provider.quote({
    pickupAddress: cfg!.sender.address,
    pickupLat: 6.5496,
    pickupLng: 3.3277,
    dropoffAddress: "15 Babatunde Jose St, Victoria Island, Lagos, Nigeria",
  });
  log("quote()", quote);

  // 2. requestDelivery (creates a real sandbox label)
  const requested = await provider.requestDelivery({
    saleOrderId: "smoke-" + Date.now(),
    orderNumber: "SMOKE-001",
    providerQuoteId: quote.providerQuoteId,
    pickupAddress: cfg!.sender.address,
    pickupLat: 6.5496,
    pickupLng: 3.3277,
    dropoffAddress: "15 Babatunde Jose St, Victoria Island, Lagos, Nigeria",
    customerName: "Lebron James",
    customerPhone: "+2348057575855",
  });
  log("requestDelivery()", requested);

  // 3. webhook parse round-trip (sign a status.changed payload like Shipbubble would)
  const body = JSON.stringify({
    event: "shipment.status.changed",
    data: { order_id: requested.externalRef, status: "picked_up" },
  });
  const sig = crypto.createHmac("sha512", cfg!.webhookSecret).update(body).digest("hex");
  const parsed = provider.parseWebhook(body, sig);
  log("parseWebhook(signed picked_up)", parsed);

  // 4. cancel (best-effort cleanup; may fail if already processing)
  try {
    await provider.cancelDelivery(requested.externalRef);
    log("cancelDelivery()", { cancelled: requested.externalRef });
  } catch (err) {
    log("cancelDelivery() — non-fatal", { error: err instanceof Error ? err.message : String(err) });
  }

  console.log("\n✅ Shipbubble provider smoke test passed");
}

main().catch((err) => {
  console.error("\n❌ smoke test failed:", err instanceof Error ? err.message : err);
  if (err && typeof err === "object" && "body" in err) console.error("body:", (err as { body: string }).body);
  process.exit(1);
});
