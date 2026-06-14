import { local, type OutboxRow } from "../db/local.js";

/**
 * Offline-first sync engine.
 *
 * Outbound: drains the local outbox FIFO, depends_on aware. Each mutation
 * carries the row id as its Idempotency-Key so server-side replays are safe.
 *
 * Inbound: hits /v1/sync/pull with the last cursor and writes returned rows
 * into the local mirror tables.
 */

const POLL_MS = 30_000;
const TELEMETRY_MS = 5 * 60_000;
const APP_VERSION = (import.meta as { env?: { VITE_APP_VERSION?: string } }).env?.VITE_APP_VERSION ?? "dev";
const BACKOFFS_S = [1, 2, 4, 8, 16, 32, 60, 120, 300, 300] as const;

function getDeviceId(): string {
  let id = localStorage.getItem("ms-device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("ms-device-id", id);
  }
  return id;
}

async function reportTelemetry(): Promise<void> {
  if (!navigator.onLine) return;
  const queue = await local.outbox.where("status").anyOf("pending", "in_flight").count();
  const meta = await local.meta.get("default");
  try {
    await fetch("/v1/telemetry/sync", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        app_version: APP_VERSION,
        queue_depth: queue,
        last_sync_at: meta?.last_pull_at ?? null,
      }),
    });
  } catch {
    // Telemetry is best-effort.
  }
}

function backoffMs(attempts: number): number {
  const idx = Math.min(attempts, BACKOFFS_S.length - 1);
  const base = (BACKOFFS_S[idx] ?? BACKOFFS_S[BACKOFFS_S.length - 1] ?? 1) * 1000;
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(1000, base + jitter);
}

async function sendOne(row: OutboxRow): Promise<void> {
  const init: RequestInit = {
    method: row.method,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "idempotency-key": row.id,
    },
  };
  if (row.payload !== null) init.body = JSON.stringify(row.payload);
  const res = await fetch(row.endpoint, init);

  if (res.ok) {
    await local.outbox.update(row.id, {
      status: "acknowledged",
      acknowledged_at: Date.now(),
    });
    return;
  }

  // Business rule rejection — don't keep retrying.
  if ([400, 401, 403, 404, 409, 422].includes(res.status)) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    await local.outbox.update(row.id, {
      status: "dead",
      last_error: body.error?.message ?? `HTTP ${res.status}`,
    });
    return;
  }

  // Transient — bump attempt count, schedule next try.
  const nextAttempts = row.attempt_count + 1;
  await local.outbox.update(row.id, {
    attempt_count: nextAttempts,
    next_attempt_at: Date.now() + backoffMs(nextAttempts),
    last_error: `HTTP ${res.status}`,
    status: nextAttempts > 50 ? "dead" : "pending",
  });
}

/**
 * Reclaim outbox rows orphaned in `in_flight`.
 *
 * A row is only ever `in_flight` for the duration of a single in-process send.
 * If the till app is closed or the tab crashes mid-send — common on a bad
 * network where the request hangs and staff force-quit — the row is left
 * stranded: `flushOutbox` only picks up `pending`, so it would never retry, and
 * the queue UI even hides its Retry button. On a fresh session any `in_flight`
 * row is by definition orphaned, so reset it to `pending` and make it due now.
 * Re-sends are safe because each row carries its id as the Idempotency-Key.
 */
export async function reclaimInFlight(): Promise<void> {
  await local.outbox
    .where("status")
    .equals("in_flight")
    .modify((row) => {
      row.status = "pending";
      row.next_attempt_at = Date.now();
    });
}

export async function flushOutbox(): Promise<void> {
  if (!navigator.onLine) return;
  const now = Date.now();

  const pending = await local.outbox
    .where("status")
    .equals("pending")
    .and((r) => r.next_attempt_at <= now)
    .sortBy("created_at_local");

  for (const row of pending) {
    // Dependency-aware: a Pay depends on its Confirm; skip until the dep
    // is acknowledged.
    if (row.depends_on) {
      const dep = await local.outbox.get(row.depends_on);
      if (!dep || dep.status !== "acknowledged") continue;
    }
    await local.outbox.update(row.id, { status: "in_flight" });
    try {
      await sendOne({ ...row, status: "in_flight" });
    } catch (err) {
      const nextAttempts = row.attempt_count + 1;
      await local.outbox.update(row.id, {
        status: "pending",
        attempt_count: nextAttempts,
        next_attempt_at: Date.now() + backoffMs(nextAttempts),
        last_error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

interface PullResponse {
  data: {
    products: Array<{
      id: string;
      name: string;
      slug: string;
      category: string;
      ingredients: string[];
      isActive: boolean;
    }>;
    variants: Array<{
      id: string;
      productId: string;
      sizeMl: number;
      sku: string;
      isActive: boolean;
    }>;
    prices: Array<{
      id: string;
      productId: string;
      variantId: string | null;
      priceNgn: number;
      validFrom: string;
      validTo: string | null;
    }>;
    ledger: Array<{
      id: string;
      locationType: string;
      locationId: string;
      productId: string;
      delta: number;
      sourceType: string;
      sourceId: string;
      recordedAt: string;
    }>;
    transfers: Array<{
      id: string;
      transferNumber: string;
      status: string;
      updatedAt: string;
    }>;
    sales: Array<{
      id: string;
      orderNumber: string;
      branchId: string;
      channel: string;
      status: string;
      totalNgn: number;
      paymentMethod: string;
      createdAtLocal: string;
      idempotencyKey: string;
    }>;
  };
  next_cursor: string;
}

export async function pullDeltas(branchId: string): Promise<void> {
  if (!navigator.onLine) return;
  const meta = await local.meta.get("default");
  const since = meta?.last_pull_at ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const url = `/v1/sync/pull?branch_id=${branchId}&since=${encodeURIComponent(since)}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return;
  const body = (await res.json()) as PullResponse;

  // Map variant id -> size so price rows can carry their can size locally.
  const sizeByVariant = new Map<string, number>(
    body.data.variants.map((v) => [v.id, v.sizeMl]),
  );

  await local.transaction(
    "rw",
    [
      local.products,
      local.variants,
      local.prices,
      local.ledger,
      local.transfers,
      local.sales,
      local.meta,
    ],
    async () => {
      for (const p of body.data.products) {
        await local.products.put({
          id: p.id,
          name: p.name,
          slug: p.slug,
          category: p.category,
          ingredients: p.ingredients,
          is_active: p.isActive,
        });
      }
      for (const v of body.data.variants) {
        await local.variants.put({
          id: v.id,
          product_id: v.productId,
          size_ml: v.sizeMl,
          sku: v.sku,
          is_active: v.isActive,
        });
      }
      for (const pr of body.data.prices) {
        await local.prices.put({
          id: pr.id,
          product_id: pr.productId,
          variant_id: pr.variantId,
          size_ml: pr.variantId ? sizeByVariant.get(pr.variantId) ?? null : null,
          price_ngn: pr.priceNgn,
          valid_from: pr.validFrom,
          valid_to: pr.validTo,
        });
      }
      for (const lg of body.data.ledger) {
        await local.ledger.put({
          id: lg.id,
          location_type: lg.locationType,
          location_id: lg.locationId,
          product_id: lg.productId,
          delta: lg.delta,
          source_type: lg.sourceType,
          source_id: lg.sourceId,
          recorded_at: lg.recordedAt,
        });
      }
      for (const t of body.data.transfers) {
        await local.transfers.put({
          id: t.id,
          transfer_number: t.transferNumber,
          status: t.status,
          updated_at: t.updatedAt,
        });
      }
      for (const s of body.data.sales) {
        await local.sales.put({
          id: s.id,
          order_number: s.orderNumber,
          branch_id: s.branchId,
          channel: s.channel,
          status: s.status,
          total_ngn: s.totalNgn,
          payment_method: s.paymentMethod,
          created_at_local: s.createdAtLocal,
          idempotency_key: s.idempotencyKey,
        });
      }
      // Reconcile the full-set tables. products / variants / prices are sent as
      // the COMPLETE active set on every pull (server filters deletedAt IS NULL /
      // validTo IS NULL — see sync.ts), so anything the server no longer returns
      // has been retired (a removed size or flavour, or a closed price). Drop it
      // locally so it stops appearing on an already-synced till. Guard on a
      // non-empty catalog so a malformed/partial response can never wipe the till.
      if (body.data.products.length > 0) {
        const liveProducts = new Set(body.data.products.map((p) => p.id));
        await local.products.filter((p) => !liveProducts.has(p.id)).delete();
      }
      // Variants and prices get their own guards: during a price transition the
      // server can return products but a momentarily-empty active variant/price
      // set, which would otherwise wipe local prices/variants on a partial active set.
      if (body.data.variants.length > 0) {
        const liveVariants = new Set(body.data.variants.map((v) => v.id));
        await local.variants.filter((v) => !liveVariants.has(v.id)).delete();
      }
      if (body.data.prices.length > 0) {
        const livePrices = new Set(body.data.prices.map((pr) => pr.id));
        await local.prices.filter((pr) => !livePrices.has(pr.id)).delete();
      }

      await local.meta.put({
        id: "default",
        last_pull_at: body.next_cursor,
        branch_id: branchId,
      });
    },
  );
}

let stopLoop: (() => void) | null = null;

export function startSyncLoop(branchId: string): () => void {
  if (stopLoop) stopLoop();

  let active = true;
  const tick = async (): Promise<void> => {
    if (!active) return;
    try {
      await flushOutbox();
      await pullDeltas(branchId);
    } catch (err) {
      console.error("sync tick failed", err);
    }
    setTimeout(tick, POLL_MS);
  };

  const onOnline = (): void => {
    void flushOutbox();
  };
  window.addEventListener("online", onOnline);

  // Fresh session: rescue any sale stranded mid-send by a previous crash/close,
  // THEN start the loop so the rescued rows flush on the very first tick.
  void reclaimInFlight().finally(() => void tick());

  // Fire-and-forget telemetry tick.
  void reportTelemetry();
  const telemetryHandle = setInterval(() => void reportTelemetry(), TELEMETRY_MS);

  stopLoop = () => {
    active = false;
    clearInterval(telemetryHandle);
    window.removeEventListener("online", onOnline);
    stopLoop = null;
  };
  return stopLoop;
}
