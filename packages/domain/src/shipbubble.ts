/**
 * Shipbubble client — Nigerian multi-courier aggregator (GIG, Kwik, Fez, DHL…).
 * Shared between the API (quote + webhook parse) and the worker (dispatch) so
 * the 4-step token flow lives in exactly one place.
 *
 * Flow:
 *   1. POST /shipping/address/validate  → address_code  (sender + receiver)
 *   2. POST /shipping/fetch_rates       → request_token + couriers[]
 *   3. POST /shipping/labels            → order_id + tracking_url (debits wallet)
 *   4. POST /shipping/labels/cancel/:id → cancel (only before processing date)
 *
 * Webhooks are signed HMAC-SHA512 over the raw body with the secret key, sent
 * in the `x-ship-signature` header.
 *
 * Docs: https://docs.shipbubble.com   Base: https://api.shipbubble.com/v1
 */

export interface ShipbubbleAddress {
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface ValidatedAddress {
  addressCode: number;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
}

export interface PackageItem {
  name: string;
  description: string;
  /** KG, as a string per the API. */
  unit_weight: string;
  /** Declared value in NGN, as a string. */
  unit_amount: string;
  quantity: string;
}

export interface PackageDimension {
  length: number;
  width: number;
  height: number;
}

export interface PackageProfile {
  categoryId: number;
  items: PackageItem[];
  dimension: PackageDimension;
}

export interface CourierRate {
  courierId: string;
  serviceCode: string;
  courierName: string;
  /** Total fee incl. VAT, NGN. */
  totalNgn: number;
  currency: string;
  serviceType: string;
  onDemand: boolean;
  pickupEtaTime: string | null;
  deliveryEtaTime: string | null;
}

export interface RatesResult {
  requestToken: string;
  couriers: CourierRate[];
  cheapest: CourierRate | null;
  fastest: CourierRate | null;
}

export interface CreatedLabel {
  orderId: string;
  trackingUrl: string | null;
  status: string;
  shippingFeeNgn: number | null;
  courierName: string | null;
}

/** Shipbubble shipment status → our normalized delivery_status enum. */
export type NormalizedDeliveryStatus =
  | "searching_rider"
  | "assigned"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled";

export interface ShipbubbleWebhook {
  externalRef: string;
  status: NormalizedDeliveryStatus;
  rider?: { name?: string; phone?: string; vehicle?: string };
  raw: unknown;
}

export class ShipbubbleError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ShipbubbleError";
  }
}

export class ShipbubbleClient {
  private readonly apiBase: string;
  private readonly apiKey: string;
  /** Memoized sender address_code(s) — the pickup branch rarely changes. */
  private readonly senderCache = new Map<string, number>();

  constructor(opts: { apiBase?: string; apiKey: string; webhookSecret?: string }) {
    this.apiBase = (opts.apiBase ?? "https://api.shipbubble.com/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    // webhookSecret is verified API-side (needs node:crypto); accepted here for
    // a uniform constructor but unused in this environment-agnostic client.
    void opts.webhookSecret;
  }

  /** Validate/geocode an address and obtain its reusable address_code. */
  async validateAddress(a: ShipbubbleAddress): Promise<ValidatedAddress> {
    const data = await this.call<{
      address_code: number;
      formatted_address?: string;
      latitude?: number;
      longitude?: number;
    }>("POST", "/shipping/address/validate", a);
    return {
      addressCode: data.address_code,
      formattedAddress: data.formatted_address ?? a.address,
      latitude: typeof data.latitude === "number" ? data.latitude : null,
      longitude: typeof data.longitude === "number" ? data.longitude : null,
    };
  }

  /** Fetch courier rates between two validated addresses for a package. */
  async fetchRates(input: {
    senderAddressCode: number;
    receiverAddressCode: number;
    pickupDate: string; // yyyy-mm-dd
    pkg: PackageProfile;
  }): Promise<RatesResult> {
    const data = await this.call<{
      request_token: string;
      couriers?: unknown[];
      cheapest_courier?: unknown;
      fastest_courier?: unknown;
    }>("POST", "/shipping/fetch_rates", {
      sender_address_code: input.senderAddressCode,
      reciever_address_code: input.receiverAddressCode, // [sic] — Shipbubble's spelling
      pickup_date: input.pickupDate,
      category_id: input.pkg.categoryId,
      package_items: input.pkg.items,
      package_dimension: input.pkg.dimension,
    });
    const couriers = (data.couriers ?? []).map(normalizeCourier).filter((c): c is CourierRate => c !== null);
    return {
      requestToken: data.request_token,
      couriers,
      cheapest: data.cheapest_courier ? normalizeCourier(data.cheapest_courier) : couriers[0] ?? null,
      fastest: data.fastest_courier ? normalizeCourier(data.fastest_courier) : null,
    };
  }

  /** Create the shipment label (debits the Shipbubble wallet). */
  async createLabel(input: {
    requestToken: string;
    serviceCode: string;
    courierId: string;
  }): Promise<CreatedLabel> {
    const data = await this.call<{
      order_id: string;
      tracking_url?: string;
      status?: string;
      courier?: { name?: string };
      payment?: { shipping_fee?: number };
    }>("POST", "/shipping/labels", {
      request_token: input.requestToken,
      service_code: input.serviceCode,
      courier_id: input.courierId,
    });
    return {
      orderId: data.order_id,
      trackingUrl: typeof data.tracking_url === "string" ? data.tracking_url : null,
      status: data.status ?? "pending",
      shippingFeeNgn:
        typeof data.payment?.shipping_fee === "number" ? Math.round(data.payment.shipping_fee) : null,
      courierName: data.courier?.name ?? null,
    };
  }

  /** Cancel a scheduled shipment (only valid before the processing date). */
  async cancelLabel(orderId: string): Promise<void> {
    await this.call("POST", `/shipping/labels/cancel/${encodeURIComponent(orderId)}`, {});
  }

  // ───────── high-level orchestration ─────────

  /**
   * Resolve the sender's address_code, memoized — the pickup branch is static,
   * so re-validating it on every quote wastes calls and risks rate-limit
   * failures. Cache key is the address string (bounded to the few branches).
   */
  async resolveSenderCode(sender: ShipbubbleAddress): Promise<number> {
    const cached = this.senderCache.get(sender.address);
    if (cached !== undefined) return cached;
    const v = await this.validateAddress(sender);
    this.senderCache.set(sender.address, v.addressCode);
    return v.addressCode;
  }

  /** validate receiver → fetch rates → return cheapest courier + token + the
   *  validated receiver (its reusable address_code is what guarantees dispatch
   *  routes to the exact address that was quoted). */
  async quote(input: {
    sender: ShipbubbleAddress;
    receiver: ShipbubbleAddress;
    pkg: PackageProfile;
    pickupDate: string;
  }): Promise<{ rates: RatesResult; chosen: CourierRate; receiver: ValidatedAddress }> {
    const [senderCode, receiverV] = await Promise.all([
      this.resolveSenderCode(input.sender),
      this.validateAddress(input.receiver),
    ]);
    const rates = await this.fetchRates({
      senderAddressCode: senderCode,
      receiverAddressCode: receiverV.addressCode,
      pickupDate: input.pickupDate,
      pkg: input.pkg,
    });
    const chosen = rates.cheapest;
    if (!chosen) throw new ShipbubbleError("no couriers returned for route", 200, "");
    return { rates, chosen, receiver: receiverV };
  }

  /**
   * Dispatch using a receiver address_code captured at quote time — skips
   * re-validating the raw address string, so the courier routes to exactly the
   * geocoded point the customer was quoted and confirmed. Honors the chosen
   * courier; falls back to cheapest if it's no longer offered.
   */
  async dispatchByReceiverCode(input: {
    sender: ShipbubbleAddress;
    receiverAddressCode: number;
    pkg: PackageProfile;
    pickupDate: string;
    preferCourierId?: string;
    preferServiceCode?: string;
  }): Promise<{ label: CreatedLabel; chosen: CourierRate }> {
    const senderCode = await this.resolveSenderCode(input.sender);
    const rates = await this.fetchRates({
      senderAddressCode: senderCode,
      receiverAddressCode: input.receiverAddressCode,
      pickupDate: input.pickupDate,
      pkg: input.pkg,
    });
    const preferred =
      input.preferCourierId != null
        ? rates.couriers.find(
            (c) =>
              c.courierId === input.preferCourierId &&
              c.serviceCode === input.preferServiceCode,
          )
        : undefined;
    const chosen = preferred ?? rates.cheapest;
    if (!chosen) throw new ShipbubbleError("no couriers returned for route", 200, "");
    const label = await this.createLabel({
      requestToken: rates.requestToken,
      serviceCode: chosen.serviceCode,
      courierId: chosen.courierId,
    });
    return { label, chosen };
  }

  /**
   * Full dispatch: validate → rates → create label. Picks the courier the
   * customer chose (preferCourierId/preferServiceCode) when it's still
   * available on the fresh rate set; otherwise falls back to the cheapest.
   */
  async dispatch(input: {
    sender: ShipbubbleAddress;
    receiver: ShipbubbleAddress;
    pkg: PackageProfile;
    pickupDate: string;
    preferCourierId?: string;
    preferServiceCode?: string;
  }): Promise<{ label: CreatedLabel; chosen: CourierRate }> {
    const { rates, chosen: cheapest } = await this.quote(input);
    const preferred =
      input.preferCourierId != null
        ? rates.couriers.find(
            (c) =>
              c.courierId === input.preferCourierId &&
              c.serviceCode === input.preferServiceCode,
          )
        : undefined;
    const chosen = preferred ?? cheapest;
    const label = await this.createLabel({
      requestToken: rates.requestToken,
      serviceCode: chosen.serviceCode,
      courierId: chosen.courierId,
    });
    return { label, chosen };
  }

  /** Poll a shipment's current status for reconcile-on-silent-webhook.
   *  Returns null if the order is unknown or the request fails.
   *  // VERIFY path against live Shipbubble docs before enabling live polling */
  async getShipmentStatus(orderId: string): Promise<{ status: string; rider?: { name?: string; phone?: string }; raw: unknown } | null> {
    try {
      const data = await this.call<{ status?: string; courier?: { rider_name?: string; rider_phone?: string } }>(
        "GET",
        `/shipping/status/${encodeURIComponent(orderId)}`,
        {},
      );
      if (!data?.status) return null;
      const riderName = data.courier?.rider_name;
      const riderPhone = data.courier?.rider_phone;
      const rider: { name?: string; phone?: string } | undefined =
        riderName || riderPhone
          ? {
              ...(riderName ? { name: riderName } : {}),
              ...(riderPhone ? { phone: riderPhone } : {}),
            }
          : undefined;
      return { status: data.status, ...(rider ? { rider } : {}), raw: data };
    } catch {
      return null; // treat any fetch/parse error as "no update available"
    }
  }

  // ───────── private ─────────

  private async call<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (method === "POST") init.body = JSON.stringify(body);
    const res = await fetch(`${this.apiBase}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      throw new ShipbubbleError(`shipbubble ${path} → ${res.status}`, res.status, text);
    }
    let json: { status?: string; message?: string; data?: T };
    try {
      json = JSON.parse(text) as { status?: string; message?: string; data?: T };
    } catch {
      throw new ShipbubbleError(`shipbubble ${path}: non-JSON response`, res.status, text);
    }
    if (json.status && json.status !== "success") {
      throw new ShipbubbleError(`shipbubble ${path}: ${json.message ?? "request failed"}`, res.status, text);
    }
    return json.data as T;
  }
}

/** Map a Shipbubble shipment status string to our normalized enum. */
export function mapShipbubbleStatus(status: string): NormalizedDeliveryStatus | null {
  switch (status.toLowerCase()) {
    case "pending":
      return "searching_rider";
    case "confirmed":
    case "acknowledged":
      return "assigned";
    case "picked_up":
    case "pickup":
      return "picked_up";
    case "in_transit":
    case "intransit":
      return "in_transit";
    case "completed":
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "failed":
    case "returned":
      return "failed";
    default:
      return null;
  }
}

/**
 * Parse a Shipbubble webhook body into our normalized shape. Handles the
 * documented event envelopes:
 *   shipment.label.created · shipment.status.changed · shipment.cancelled
 * Current Shipbubble payloads put order_id/status at the root; older/nested
 * shapes carried them under `data`. Prefer root, fall back to data.
 */
export function parseShipbubbleWebhook(rawBody: string): ShipbubbleWebhook | null {
  let payload: {
    event?: string;
    order_id?: string;
    status?: string;
    courier?: {
      name?: string;
      phone?: string;
      rider_info?: { name?: string; phone?: string; vehicle?: string } | null;
    };
    data?: { order_id?: string; status?: string };
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return null;
  }
  // Current Shipbubble payloads put order_id/status at the root; older/nested
  // shapes carried them under `data`. Prefer root, fall back to data.
  const orderId = payload.order_id ?? payload.data?.order_id;
  if (!orderId) return null;

  const rider = riderFrom(payload.courier);

  if (payload.event === "shipment.cancelled") {
    return { externalRef: orderId, status: "cancelled", ...(rider ? { rider } : {}), raw: payload };
  }
  const rawStatus = payload.status ?? payload.data?.status;
  if (!rawStatus) return null;
  const status = mapShipbubbleStatus(rawStatus);
  if (!status) return null;
  return { externalRef: orderId, status, ...(rider ? { rider } : {}), raw: payload };
}

function riderFrom(
  courier:
    | { name?: string; phone?: string; rider_info?: { name?: string; phone?: string; vehicle?: string } | null }
    | undefined,
): { name?: string; phone?: string; vehicle?: string } | undefined {
  if (!courier) return undefined;
  const info = courier.rider_info ?? undefined;
  const name = info?.name ?? undefined;
  const phone = info?.phone ?? undefined;
  const vehicle = info?.vehicle ?? undefined;
  if (!name && !phone && !vehicle) return undefined;
  return { ...(name ? { name } : {}), ...(phone ? { phone } : {}), ...(vehicle ? { vehicle } : {}) };
}

interface RawCourier {
  courier_id?: string;
  service_code?: string;
  courier_name?: string;
  total?: number | string;
  currency?: string;
  service_type?: string;
  on_demand?: boolean;
  pickup_eta_time?: string;
  delivery_eta_time?: string;
}

function normalizeCourier(raw: unknown): CourierRate | null {
  const c = raw as RawCourier;
  if (!c || !c.courier_id || !c.service_code) return null;
  return {
    courierId: String(c.courier_id),
    serviceCode: String(c.service_code),
    courierName: c.courier_name ?? "Courier",
    totalNgn: Math.round(Number(c.total ?? 0)),
    currency: c.currency ?? "NGN",
    serviceType: c.service_type ?? "pickup",
    onDemand: Boolean(c.on_demand),
    pickupEtaTime: c.pickup_eta_time ?? null,
    deliveryEtaTime: c.delivery_eta_time ?? null,
  };
}

export interface ShipbubbleConfig {
  apiBase: string;
  apiKey: string;
  webhookSecret: string;
  sender: ShipbubbleAddress;
  pkg: PackageProfile;
}

/**
 * Build Shipbubble config from a plain env bag. Returns null when no API key is
 * set so callers can fall back to the mock provider. Pure — env is passed in.
 */
export function shipbubbleConfigFromEnv(env: Record<string, string | undefined>): ShipbubbleConfig | null {
  const apiKey = env["SHIPBUBBLE_API_KEY"];
  if (!apiKey) return null;
  return {
    apiBase: env["SHIPBUBBLE_API_BASE"] ?? "https://api.shipbubble.com/v1",
    apiKey,
    webhookSecret: env["SHIPBUBBLE_WEBHOOK_SECRET"] ?? "",
    sender: {
      name: env["SHIPBUBBLE_SENDER_NAME"] ?? "Mrs Samuel Fruit Juice",
      email: env["SHIPBUBBLE_SENDER_EMAIL"] ?? "orders@mrssamuel.ng",
      phone: env["SHIPBUBBLE_SENDER_PHONE"] ?? "+2348000000000",
      address: env["SHIPBUBBLE_SENDER_ADDRESS"] ?? "Ajao Estate, Lagos, Nigeria",
    },
    pkg: {
      categoryId: Number(env["SHIPBUBBLE_CATEGORY_ID"] ?? 2178251), // Groceries
      items: [
        {
          name: "Fruit juice order",
          description: "Mrs Samuel fruit juice",
          unit_weight: env["SHIPBUBBLE_PKG_WEIGHT_KG"] ?? "8",
          unit_amount: env["SHIPBUBBLE_PKG_VALUE_NGN"] ?? "6000",
          quantity: "1",
        },
      ],
      dimension: {
        length: Number(env["SHIPBUBBLE_PKG_LENGTH_CM"] ?? 40),
        width: Number(env["SHIPBUBBLE_PKG_WIDTH_CM"] ?? 30),
        height: Number(env["SHIPBUBBLE_PKG_HEIGHT_CM"] ?? 25),
      },
    },
  };
}

/** Today in Lagos (GMT+1) as yyyy-mm-dd — the earliest valid pickup_date. */
export function lagosPickupDate(now: Date = new Date()): string {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000); // shift to GMT+1
  return lagos.toISOString().slice(0, 10);
}

/** Minutes from now until an ISO-ish "yyyy-mm-dd HH:mm:ss" timestamp, floored at 20. */
export function etaMinutesUntil(ts: string | null): number {
  if (!ts) return 60;
  const t = Date.parse(ts.replace(" ", "T"));
  if (Number.isNaN(t)) return 60;
  return Math.max(20, Math.round((t - Date.now()) / 60000));
}
