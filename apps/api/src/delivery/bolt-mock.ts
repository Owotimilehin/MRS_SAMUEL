import { v4 as uuid } from "uuid";
import type {
  DeliveryProvider,
  DeliveryQuote,
  DeliveryQuoteInput,
  DeliveryQuoteOptions,
  NormalizedWebhook,
  RequestDeliveryInput,
  RequestDeliveryResult,
} from "./provider.js";

/**
 * Mock Bolt implementation. Returns deterministic quotes and emits webhook
 * events on a schedule so we can exercise the full end-to-end flow without
 * real Bolt credentials.
 *
 * The schedule is driven by setTimeout against a configurable webhook URL —
 * normally http://localhost:3001/v1/webhooks/bolt — so the worker can pick
 * up status changes exactly as it would in prod.
 */

const BASE_FEE_NGN = 600;
const PER_KM_NGN = 100;
const EARTH_KM = 6371;

interface MockSchedule {
  externalRef: string;
  webhookUrl: string;
  customerName: string;
  pickup: { address: string };
  dropoff: { address: string };
}

const RIDERS = [
  { name: "Tunde Okafor", phone: "+2348012345671", vehicle: "Honda CG · LSR-489" },
  { name: "Bisi Adewale", phone: "+2348012345672", vehicle: "Bajaj Boxer · LSR-211" },
  { name: "Kola Eze", phone: "+2348012345673", vehicle: "Yamaha YBR · LSR-908" },
];

export class BoltMockProvider implements DeliveryProvider {
  readonly name = "bolt" as const;
  private readonly webhookUrl: string;
  private readonly fastMode: boolean;

  constructor(opts: { webhookUrl: string; fastMode?: boolean } = { webhookUrl: "http://127.0.0.1:3001/v1/webhooks/bolt" }) {
    this.webhookUrl = opts.webhookUrl;
    this.fastMode = opts.fastMode ?? true;
  }

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuote> {
    // Force a small async hop so callers can model real latency.
    await new Promise((r) => setTimeout(r, 25));
    const distKm =
      input.dropoffLat != null && input.dropoffLng != null
        ? haversineKm(input.pickupLat, input.pickupLng, input.dropoffLat, input.dropoffLng)
        : estimateKmFromAddress(input.dropoffAddress);
    const feeNgn = Math.round(BASE_FEE_NGN + PER_KM_NGN * distKm);
    const etaMinutes = Math.max(20, Math.round(15 + distKm * 4));
    return {
      providerQuoteId: `mock_q_${uuid().slice(0, 8)}`,
      feeNgn,
      etaMinutes,
      expiresInSeconds: 5 * 60,
    };
  }

  async quoteOptions(input: DeliveryQuoteInput): Promise<DeliveryQuoteOptions> {
    const base = await this.quote(input);
    const token = `mock_${uuid().slice(0, 8)}`;
    // Two synthetic couriers so the selector has something to choose between
    // in dev: a cheaper/slower standard and a pricier/faster express.
    return {
      quoteToken: token,
      expiresInSeconds: base.expiresInSeconds,
      validatedAddress: { addressCode: 0, formatted: input.dropoffAddress, lat: null, lng: null },
      options: [
        {
          id: `${token}::mock-standard::ND`,
          courierName: "Mock Standard",
          feeNgn: base.feeNgn,
          etaMinutes: base.etaMinutes,
          onDemand: true,
        },
        {
          id: `${token}::mock-express::SD`,
          courierName: "Mock Express",
          feeNgn: base.feeNgn + 700,
          etaMinutes: Math.max(15, Math.round(base.etaMinutes * 0.6)),
          onDemand: true,
        },
      ],
    };
  }

  async requestDelivery(input: RequestDeliveryInput): Promise<RequestDeliveryResult> {
    const externalRef = `mock_d_${uuid().slice(0, 12)}`;
    const trackingUrl = `https://mock-bolt.local/track/${externalRef}`;
    const rider = RIDERS[Math.floor(Math.random() * RIDERS.length)]!;
    const schedule: MockSchedule = {
      externalRef,
      webhookUrl: this.webhookUrl,
      customerName: input.customerName,
      pickup: { address: input.pickupAddress },
      dropoff: { address: input.dropoffAddress },
    };
    // Kick off the timeline. In fast mode (default) the entire delivery
    // completes in ~80s, perfect for E2E testing. Set fastMode=false to
    // exercise the real-world 30-minute timeline in a staging env.
    void this.runTimeline(schedule, rider);
    return { externalRef, trackingUrl, initialEtaMinutes: 25 };
  }

  async cancelDelivery(externalRef: string): Promise<void> {
    // Emit a cancelled webhook so downstream sees the state flip.
    void this.emit(externalRef, {
      status: "cancelled",
      failReason: "Cancelled by merchant",
    });
  }

  parseWebhook(rawBody: string, _signature: string | null): NormalizedWebhook | null {
    // Mock doesn't sign — accept anything in the format we send.
    try {
      const parsed = JSON.parse(rawBody) as {
        external_ref?: string;
        status?: NormalizedWebhook["status"];
        rider?: NormalizedWebhook["rider"];
        eta_minutes?: number;
        actual_fee_ngn?: number;
        fail_reason?: string;
      };
      if (!parsed.external_ref || !parsed.status) return null;
      const result: NormalizedWebhook = {
        externalRef: parsed.external_ref,
        status: parsed.status,
        raw: parsed,
      };
      if (parsed.rider) result.rider = parsed.rider;
      if (parsed.eta_minutes !== undefined) result.etaMinutes = parsed.eta_minutes;
      if (parsed.actual_fee_ngn !== undefined) result.actualFeeNgn = parsed.actual_fee_ngn;
      if (parsed.fail_reason) result.failReason = parsed.fail_reason;
      return result;
    } catch {
      return null;
    }
  }

  // ───────── private ─────────

  private async runTimeline(
    s: MockSchedule,
    rider: { name: string; phone: string; vehicle: string },
  ): Promise<void> {
    const step = this.fastMode ? 1 : 60; // seconds-per-tick

    // searching_rider → assigned
    await sleep(5 * step * 1000);
    await this.emit(s.externalRef, { status: "assigned", rider, etaMinutes: 22 });

    // assigned → picked_up
    await sleep(15 * step * 1000);
    await this.emit(s.externalRef, { status: "picked_up", rider, etaMinutes: 15 });

    // picked_up → in_transit (some implementations skip this; we keep it)
    await sleep(5 * step * 1000);
    await this.emit(s.externalRef, { status: "in_transit", rider, etaMinutes: 10 });

    // in_transit → delivered
    await sleep(15 * step * 1000);
    await this.emit(s.externalRef, { status: "delivered", rider });
  }

  private async emit(
    externalRef: string,
    body: {
      status: NormalizedWebhook["status"];
      rider?: NormalizedWebhook["rider"];
      etaMinutes?: number;
      actualFeeNgn?: number;
      failReason?: string;
    },
  ): Promise<void> {
    const payload = {
      external_ref: externalRef,
      status: body.status,
      ...(body.rider ? { rider: body.rider } : {}),
      ...(body.etaMinutes !== undefined ? { eta_minutes: body.etaMinutes } : {}),
      ...(body.actualFeeNgn !== undefined ? { actual_fee_ngn: body.actualFeeNgn } : {}),
      ...(body.failReason ? { fail_reason: body.failReason } : {}),
    };
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bolt-signature": "mock",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Mock — if the webhook receiver is down, just log and drop.
      // eslint-disable-next-line no-console
      console.warn("[bolt-mock] webhook delivery failed", externalRef, body.status);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}
function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/**
 * Crude fallback when we have no coordinates: use a stable hash of the
 * dropoff address to pick something between 3 and 12 km. Deterministic so
 * the same address always gets the same fee in mock mode.
 */
function estimateKmFromAddress(addr: string): number {
  let hash = 0;
  for (let i = 0; i < addr.length; i++) hash = ((hash << 5) - hash + addr.charCodeAt(i)) | 0;
  const norm = (Math.abs(hash) % 1000) / 1000; // 0..1
  return 3 + norm * 9;
}
