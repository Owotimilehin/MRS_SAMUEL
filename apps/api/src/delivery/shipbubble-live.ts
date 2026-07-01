import crypto from "node:crypto";
import {
  ShipbubbleClient,
  etaMinutesUntil,
  mapShipbubbleStatus,
  parseShipbubbleWebhook,
  type ShipbubbleAddress,
} from "@ms/domain";
import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteInput,
  DeliveryQuoteOptions,
  NormalizedWebhook,
  RequestDeliveryInput,
  RequestDeliveryResult,
} from "./provider.js";

/** Parse `requestToken::courierId::serviceCode` back into its parts. */
function parseOptionId(id: string): { courierId: string; serviceCode: string } | null {
  const parts = id.split("::");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { courierId: parts[1], serviceCode: parts[2] };
}
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

  async quoteOptions(input: DeliveryQuoteInput): Promise<DeliveryQuoteOptions> {
    const receiver: ShipbubbleAddress = {
      name: "Prospective Customer",
      email: "quote@mrssamuel.ng",
      phone: "+2348000000000",
      address: input.dropoffAddress,
    };
    const { rates, receiver: validated } = await this.client.quote({
      sender: this.cfg.sender,
      receiver,
      pkg: this.cfg.pkg,
      pickupDate: lagosPickupDate(),
    });
    return {
      quoteToken: rates.requestToken,
      // Shipbubble request tokens live 7 days; cap our cache at 1 hour so a
      // tampered/stale quote can't be replayed long after the basket changed.
      expiresInSeconds: 60 * 60,
      validatedAddress: {
        addressCode: validated.addressCode,
        formatted: validated.formattedAddress,
        lat: validated.latitude,
        lng: validated.longitude,
      },
      options: rates.couriers.map((c) => ({
        id: `${rates.requestToken}::${c.courierId}::${c.serviceCode}`,
        courierName: c.courierName,
        feeNgn: c.totalNgn,
        etaMinutes: etaMinutesUntil(c.deliveryEtaTime),
        onDemand: c.onDemand,
      })),
    };
  }

  async requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const receiver: ShipbubbleAddress = {
      name: input.customerName,
      email: synthEmail(input.customerPhone),
      phone: input.customerPhone,
      address: input.dropoffAddress,
    };
    // Honor the courier the customer picked (encoded in providerQuoteId) when
    // it's still on the fresh rate set; falls back to cheapest otherwise.
    const pref = input.providerQuoteId ? parseOptionId(input.providerQuoteId) : null;
    const prefArgs = pref
      ? { preferCourierId: pref.courierId, preferServiceCode: pref.serviceCode }
      : {};
    // When we captured a validated address_code at quote time, dispatch by it
    // so the rider routes to exactly the quoted+confirmed address — no
    // re-geocoding of the raw string. Otherwise fall back to validating the
    // raw address with the real customer contact.
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
            receiver,
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

  async cancelDelivery(externalRef: string): Promise<void> {
    await this.client.cancelLabel(externalRef);
  }

  async getStatus(externalRef: string): Promise<NormalizedWebhook | null> {
    const snap = await this.client.getShipmentStatus(externalRef);
    if (!snap) return null;
    const status = mapShipbubbleStatus(snap.status);
    if (!status) return null;
    return {
      externalRef,
      status,
      ...(snap.rider ? { rider: snap.rider } : {}),
      raw: snap.raw,
    };
  }

  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null {
    if (!this.verifySignature(rawBody, signature)) {
      throw new Error("invalid signature");
    }
    const parsed = parseShipbubbleWebhook(rawBody);
    if (!parsed) return null;
    return {
      externalRef: parsed.externalRef,
      status: parsed.status,
      ...(parsed.rider ? { rider: parsed.rider } : {}),
      raw: parsed.raw,
    };
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
