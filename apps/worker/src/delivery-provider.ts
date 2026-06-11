import { randomUUID } from "node:crypto";
import {
  ShipbubbleClient,
  etaMinutesUntil,
  lagosPickupDate,
  shipbubbleConfigFromEnv,
} from "@ms/domain";

/**
 * Local mirror of the API's delivery provider interface. The worker only needs
 * the outbound call surface (requestDelivery) — the API owns the webhook parse
 * side. The Shipbubble flow itself is shared via @ms/domain's ShipbubbleClient.
 */

interface RequestDeliveryInput {
  saleOrderId: string;
  orderNumber: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  customerName: string;
  customerPhone: string;
  /** The courier the customer chose, encoded requestToken::courierId::serviceCode. */
  providerQuoteId?: string;
  /** Validated dropoff address_code captured at quote time. */
  receiverAddressCode?: number;
}

/** Parse `requestToken::courierId::serviceCode` back into its parts. */
function parseOptionId(id: string): { courierId: string; serviceCode: string } | null {
  const parts = id.split("::");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { courierId: parts[1], serviceCode: parts[2] };
}
interface RequestDeliveryResult {
  externalRef: string;
  trackingUrl: string | null;
  initialEtaMinutes: number | null;
}

export interface DeliveryProvider {
  readonly name: "bolt" | "manual" | "shipbubble";
  requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult>;
}

/**
 * Live Shipbubble dispatch. Validates sender (env) + receiver (the customer),
 * fetches rates, and creates a label with the cheapest courier — all via the
 * shared client. Status updates flow back through Shipbubble webhooks.
 */
class ShipbubbleWorker implements DeliveryProvider {
  readonly name = "shipbubble" as const;
  private readonly client: ShipbubbleClient;
  private readonly cfg: NonNullable<ReturnType<typeof shipbubbleConfigFromEnv>>;

  constructor(cfg: NonNullable<ReturnType<typeof shipbubbleConfigFromEnv>>) {
    this.cfg = cfg;
    this.client = new ShipbubbleClient({
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      webhookSecret: cfg.webhookSecret,
    });
  }

  async requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const digits = input.customerPhone.replace(/\D/g, "") || "customer";
    const pref = input.providerQuoteId ? parseOptionId(input.providerQuoteId) : null;
    const prefArgs = pref
      ? { preferCourierId: pref.courierId, preferServiceCode: pref.serviceCode }
      : {};
    // Route by the address_code captured at quote time when we have it, so the
    // rider goes to exactly the quoted+confirmed address (no re-geocoding).
    const { label, chosen } =
      input.receiverAddressCode != null
        ? await this.client.dispatchByReceiverCode({
            sender: this.cfg.sender,
            receiverAddressCode: input.receiverAddressCode,
            pkg: this.cfg.pkg,
            pickupDate: lagosPickupDate(),
            ...prefArgs,
          })
        : await this.client.dispatch({
            sender: this.cfg.sender,
            receiver: {
              name: input.customerName,
              email: `customer+${digits}@mrssamuel.ng`,
              phone: input.customerPhone,
              address: input.dropoffAddress,
            },
            pkg: this.cfg.pkg,
            pickupDate: lagosPickupDate(),
            ...prefArgs,
          });
    return {
      externalRef: label.orderId,
      trackingUrl: label.trackingUrl,
      initialEtaMinutes: etaMinutesUntil(chosen.deliveryEtaTime),
    };
  }
}

const RIDERS = [
  { name: "Tunde Okafor", phone: "+2348012345671", vehicle: "Honda CG · LSR-489" },
  { name: "Bisi Adewale", phone: "+2348012345672", vehicle: "Bajaj Boxer · LSR-211" },
  { name: "Kola Eze", phone: "+2348012345673", vehicle: "Yamaha YBR · LSR-908" },
];

class BoltMockWorker implements DeliveryProvider {
  readonly name = "bolt" as const;
  constructor(private readonly webhookUrl: string) {}

  async requestDelivery(_input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const externalRef = `mock_d_${randomUUID().slice(0, 12)}`;
    const trackingUrl = `https://mock-bolt.local/track/${externalRef}`;
    const rider = RIDERS[Math.floor(Math.random() * RIDERS.length)]!;
    // Start the timeline asynchronously so this call returns fast.
    void this.runTimeline(externalRef, rider);
    return { externalRef, trackingUrl, initialEtaMinutes: 25 };
  }

  private async runTimeline(
    externalRef: string,
    rider: { name: string; phone: string; vehicle: string },
  ): Promise<void> {
    await sleep(5_000);
    await this.emit(externalRef, { status: "assigned", rider, eta_minutes: 22 });

    await sleep(15_000);
    await this.emit(externalRef, { status: "picked_up", rider, eta_minutes: 15 });

    await sleep(5_000);
    await this.emit(externalRef, { status: "in_transit", rider, eta_minutes: 10 });

    await sleep(15_000);
    await this.emit(externalRef, { status: "delivered", rider });
  }

  private async emit(
    externalRef: string,
    body: {
      status: string;
      rider?: { name: string; phone: string; vehicle: string };
      eta_minutes?: number;
    },
  ): Promise<void> {
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bolt-signature": "mock",
        },
        body: JSON.stringify({ external_ref: externalRef, ...body }),
      });
    } catch (err) {
      console.warn(
        "[worker:bolt-mock] webhook delivery failed",
        externalRef,
        body.status,
        err,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let cached: DeliveryProvider | null = null;

export function getWorkerDeliveryProvider(): DeliveryProvider {
  if (cached) return cached;

  const active = (process.env["DELIVERY_PROVIDER"] ?? "bolt").toLowerCase();
  if (active === "shipbubble") {
    const mode = (process.env["SHIPBUBBLE_PROVIDER"] ?? "mock").toLowerCase();
    const cfg = shipbubbleConfigFromEnv(process.env);
    if (mode === "live" && cfg) {
      cached = new ShipbubbleWorker(cfg);
      return cached;
    }
    if (mode === "live") {
      console.warn(
        "[worker] DELIVERY_PROVIDER=shipbubble + live but SHIPBUBBLE_API_KEY missing — using mock",
      );
    }
  }

  const webhookUrl =
    process.env["BOLT_MOCK_WEBHOOK_URL"] ?? "http://127.0.0.1:3001/v1/webhooks/bolt";
  cached = new BoltMockWorker(webhookUrl);
  return cached;
}
