/**
 * Provider-agnostic interface for on-demand last-mile delivery. Today only
 * Bolt is wired (mock + live). To add Glovo / Chowdeck Send / in-house
 * dispatch, implement this interface and update env-keyed selection in
 * `./index.ts`.
 */

export interface DeliveryQuoteInput {
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  dropoffLat?: number;
  dropoffLng?: number;
}

export interface DeliveryQuote {
  /** Provider's quote id; passed back into requestDelivery to lock the fee. */
  providerQuoteId: string;
  feeNgn: number;
  /** Best-effort ETA at the moment of quoting. */
  etaMinutes: number;
  /** TTL in seconds after which the quote may differ on requestDelivery. */
  expiresInSeconds: number;
  /** Free-text reason if the quote is degraded (e.g. surge). Optional. */
  notice?: string;
}

export interface RequestDeliveryInput {
  saleOrderId: string;
  orderNumber: string;
  providerQuoteId?: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  dropoffLat?: number;
  dropoffLng?: number;
  /** Customer-side contact passed to the rider. */
  customerName: string;
  customerPhone: string;
  /** Optional rider instructions. */
  notes?: string;
}

export interface RequestDeliveryResult {
  externalRef: string;
  /** Provider's hosted tracking URL (shown to the customer). */
  trackingUrl: string | null;
  initialEtaMinutes: number | null;
}

export interface NormalizedWebhook {
  externalRef: string;
  status:
    | "searching_rider"
    | "assigned"
    | "picked_up"
    | "in_transit"
    | "delivered"
    | "failed"
    | "cancelled";
  rider?: {
    name?: string;
    phone?: string;
    vehicle?: string;
  };
  etaMinutes?: number;
  actualFeeNgn?: number;
  failReason?: string;
  raw: unknown;
}

export interface DeliveryProvider {
  readonly name: "bolt" | "manual";
  quote(input: DeliveryQuoteInput): Promise<DeliveryQuote>;
  requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult>;
  cancelDelivery(externalRef: string): Promise<void>;
  /**
   * Verify a webhook's signature and return the normalised shape. Throws on
   * invalid signature. Returns null if the payload is recognised but should
   * be silently ignored (e.g. heartbeat events).
   */
  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null;
}
