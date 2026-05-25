import crypto from "node:crypto";
import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteInput,
  NormalizedWebhook,
  RequestDeliveryInput,
  RequestDeliveryResult,
} from "./provider.js";

/**
 * Real Bolt Send (on-demand parcel) integration. The exact endpoint paths and
 * payload shapes are stubbed against Bolt's current docs; final wiring waits
 * on real credentials and a sandbox account. When BOLT_API_KEY is unset, this
 * provider throws on every call — the selector in ./index.ts should pick the
 * mock implementation in that case.
 */
export class BoltLiveProvider implements DeliveryProvider {
  readonly name = "bolt" as const;
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;

  constructor(opts: { apiBase: string; apiKey: string; webhookSecret: string }) {
    this.apiBase = opts.apiBase.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.webhookSecret = opts.webhookSecret;
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    const res = await this.call("POST", "/v2/orders/quote", {
      pickup: {
        address: input.pickupAddress,
        latitude: input.pickupLat,
        longitude: input.pickupLng,
      },
      dropoff: {
        address: input.dropoffAddress,
        latitude: input.dropoffLat,
        longitude: input.dropoffLng,
      },
    });
    return {
      providerQuoteId: String(res.quote_id),
      feeNgn: Math.round(Number(res.price)),
      etaMinutes: Math.round(Number(res.eta_minutes ?? 25)),
      expiresInSeconds: Number(res.expires_in_seconds ?? 300),
    };
  }

  async requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const res = await this.call("POST", "/v2/orders", {
      quote_id: input.providerQuoteId,
      external_id: input.saleOrderId,
      order_reference: input.orderNumber,
      pickup: {
        address: input.pickupAddress,
        latitude: input.pickupLat,
        longitude: input.pickupLng,
      },
      dropoff: {
        address: input.dropoffAddress,
        latitude: input.dropoffLat,
        longitude: input.dropoffLng,
        contact_name: input.customerName,
        contact_phone: input.customerPhone,
      },
      ...(input.notes ? { notes: input.notes } : {}),
    });
    return {
      externalRef: String(res.order_id),
      trackingUrl: typeof res.tracking_url === "string" ? res.tracking_url : null,
      initialEtaMinutes: res.eta_minutes != null ? Math.round(Number(res.eta_minutes)) : null,
    };
  }

  async cancelDelivery(externalRef: string): Promise<void> {
    await this.call("POST", `/v2/orders/${encodeURIComponent(externalRef)}/cancel`, {});
  }

  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null {
    if (!signature) throw new Error("missing signature");
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");
    if (!safeEq(expected, signature.replace(/^sha256=/, ""))) {
      throw new Error("invalid signature");
    }
    const payload = JSON.parse(rawBody) as {
      order_id?: string;
      event?: string;
      data?: Record<string, unknown>;
    };
    if (!payload.order_id || !payload.event) return null;

    const map: Record<string, NormalizedWebhook["status"]> = {
      "order.searching": "searching_rider",
      "order.assigned": "assigned",
      "order.collected": "picked_up",
      "order.in_transit": "in_transit",
      "order.delivered": "delivered",
      "order.cancelled": "cancelled",
      "order.failed": "failed",
    };
    const status = map[payload.event];
    if (!status) return null;

    const d = payload.data ?? {};
    const result: NormalizedWebhook = {
      externalRef: payload.order_id,
      status,
      raw: payload,
    };
    if (d["rider"] && typeof d["rider"] === "object") {
      const r = d["rider"] as Record<string, unknown>;
      const rider: NonNullable<NormalizedWebhook["rider"]> = {};
      if (typeof r["name"] === "string") rider.name = r["name"];
      if (typeof r["phone"] === "string") rider.phone = r["phone"];
      if (typeof r["vehicle"] === "string") rider.vehicle = r["vehicle"];
      if (Object.keys(rider).length > 0) result.rider = rider;
    }
    if (typeof d["eta_minutes"] === "number") result.etaMinutes = d["eta_minutes"];
    if (typeof d["actual_fee_ngn"] === "number") result.actualFeeNgn = d["actual_fee_ngn"];
    if (typeof d["fail_reason"] === "string") result.failReason = d["fail_reason"];
    return result;
  }

  // ───────── private ─────────

  private async call(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (method === "POST") init.body = JSON.stringify(body);
    const res = await fetch(`${this.apiBase}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`bolt ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
