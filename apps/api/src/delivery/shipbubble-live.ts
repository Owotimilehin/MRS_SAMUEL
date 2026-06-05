import crypto from "node:crypto";
import {
  ShipbubbleClient,
  etaMinutesUntil,
  parseShipbubbleWebhook,
  type ShipbubbleAddress,
} from "@ms/domain";
import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteInput,
  NormalizedWebhook,
  RequestDeliveryInput,
  RequestDeliveryResult,
} from "./provider.js";
import { lagosPickupDate, type ShipbubbleConfig } from "./shipbubble-config.js";

/**
 * Live Shipbubble delivery provider. Wraps the shared `ShipbubbleClient` and
 * adapts the 4-step token flow onto the provider-agnostic interface.
 *
 * Notes on the impedance match:
 *  - `quote()` validates the dropoff with a placeholder contact (rates are
 *    geocode-based) and returns the cheapest courier. The providerQuoteId
 *    encodes `requestToken::courierId::serviceCode` so it *can* be reused, but
 *    `requestDelivery()` re-runs the flow with the real customer contact so the
 *    rider gets the right name/phone on the label.
 *  - The package profile (category/weight/dims) comes from env config; line
 *    items aren't threaded through the interface yet.
 */
export class ShipbubbleLiveProvider implements DeliveryProvider {
  readonly name = "shipbubble" as const;
  private readonly client: ShipbubbleClient;
  private readonly cfg: ShipbubbleConfig;

  constructor(cfg: ShipbubbleConfig) {
    this.cfg = cfg;
    this.client = new ShipbubbleClient({
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      webhookSecret: cfg.webhookSecret,
    });
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const receiver: ShipbubbleAddress = {
      name: "Prospective Customer",
      email: "quote@mrssamuel.ng",
      phone: "+2348000000000",
      address: input.dropoffAddress,
    };
    const { rates, chosen } = await this.client.quote({
      sender: this.cfg.sender,
      receiver,
      pkg: this.cfg.pkg,
      pickupDate: lagosPickupDate(),
    });
    const quote: DeliveryQuote = {
      providerQuoteId: `${rates.requestToken}::${chosen.courierId}::${chosen.serviceCode}`,
      feeNgn: chosen.totalNgn,
      etaMinutes: etaMinutesUntil(chosen.deliveryEtaTime),
      // Shipbubble request tokens live 7 days; cap our cache at 1 hour so a
      // tampered/stale quote can't be replayed long after the basket changed.
      expiresInSeconds: 60 * 60,
    };
    const notice = chosen.onDemand ? undefined : `${chosen.courierName} · scheduled pickup`;
    if (notice) quote.notice = notice;
    return quote;
  }

  async requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const receiver: ShipbubbleAddress = {
      name: input.customerName,
      email: synthEmail(input.customerPhone),
      phone: input.customerPhone,
      address: input.dropoffAddress,
    };
    const { label, chosen } = await this.client.dispatch({
      sender: this.cfg.sender,
      receiver,
      pkg: this.cfg.pkg,
      pickupDate: lagosPickupDate(),
    });
    return {
      externalRef: label.orderId,
      trackingUrl: label.trackingUrl,
      initialEtaMinutes: etaMinutesUntil(chosen.deliveryEtaTime),
    };
  }

  async cancelDelivery(externalRef: string): Promise<void> {
    await this.client.cancelLabel(externalRef);
  }

  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null {
    if (!this.verifySignature(rawBody, signature)) {
      throw new Error("invalid signature");
    }
    const parsed = parseShipbubbleWebhook(rawBody);
    if (!parsed) return null;
    return { externalRef: parsed.externalRef, status: parsed.status, raw: parsed.raw };
  }

  /** HMAC-SHA512 of the raw body keyed with the webhook secret (x-ship-signature). */
  private verifySignature(rawBody: string, signature: string | null): boolean {
    if (!this.cfg.webhookSecret || !signature) return false;
    const expected = crypto
      .createHmac("sha512", this.cfg.webhookSecret)
      .update(rawBody)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.trim());
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

/** Shipbubble requires an email; synthesize a stable one from the phone. */
function synthEmail(phone: string): string {
  const digits = phone.replace(/\D/g, "") || "customer";
  return `customer+${digits}@mrssamuel.ng`;
}
