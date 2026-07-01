/**
 * Provider-agnostic interface for on-demand last-mile delivery. Today only
 * Shipbubble is wired (mock + live). To add Glovo / Chowdeck Send / in-house
 * dispatch, implement this interface and update env-keyed selection in
 * `./index.ts`.
 */

export interface DeliveryQuoteInput {
  pickupAddress: string;
  /**
   * Pickup coordinates are optional: a branch may have only an address on file.
   * Providers that geocode from address text (Shipbubble validates the address
   * and uses an env-configured sender) ignore these; the mock falls back to an
   * address-based distance estimate when they're null.
   */
  pickupLat: number | null;
  pickupLng: number | null;
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

/** A single courier option the customer can choose at checkout. */
export interface DeliveryOption {
  /**
   * Opaque id passed back into the order + requestDelivery to identify the
   * chosen courier. For Shipbubble this encodes
   * `requestToken::courierId::serviceCode`.
   */
  id: string;
  courierName: string;
  feeNgn: number;
  etaMinutes: number;
  /** True for instant on-demand dispatch; false for scheduled pickup. */
  onDemand: boolean;
}

/** The courier-validated dropoff. Its address_code is reused at dispatch so the
 *  rider routes to exactly the address that was quoted + confirmed. */
export interface ValidatedDropoff {
  addressCode: number;
  formatted: string;
  lat: number | null;
  lng: number | null;
}

export interface DeliveryQuoteOptions {
  /** Groups this set of options for server-side storage / validation. */
  quoteToken: string;
  options: DeliveryOption[];
  /** TTL in seconds after which the options may no longer be valid. */
  expiresInSeconds: number;
  /** The validated dropoff (present when the provider validates addresses). */
  validatedAddress?: ValidatedDropoff;
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
  /** Validated dropoff address_code captured at quote time — when present the
   *  provider routes to exactly this address (no re-geocoding). */
  receiverAddressCode?: number;
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
  readonly name: "manual" | "shipbubble";
  quote(input: DeliveryQuoteInput): Promise<DeliveryQuote>;
  /** Return every courier option for the route so the customer can choose. */
  quoteOptions(input: DeliveryQuoteInput): Promise<DeliveryQuoteOptions>;
  requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult>;
  cancelDelivery(externalRef: string): Promise<void>;
  /**
   * Verify a webhook's signature and return the normalised shape. Throws on
   * invalid signature. Returns null if the payload is recognised but should
   * be silently ignored (e.g. heartbeat events).
   */
  parseWebhook(rawBody: string, signature: string | null): NormalizedWebhook | null;
  /**
   * Poll the provider for the current status of a dispatched delivery, used by
   * the worker to reconcile when a webhook never arrived. Returns a
   * NormalizedWebhook-shaped snapshot, or null when the provider cannot report
   * status (manual) or the ref is unknown.
   */
  getStatus(externalRef: string): Promise<NormalizedWebhook | null>;
}
