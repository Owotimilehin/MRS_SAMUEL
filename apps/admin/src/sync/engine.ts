import { local, type OutboxRow } from "../db/local.js";
import { refreshAccessToken } from "../lib/api.js";

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
  const send = (): Promise<Response> => {
    const init: RequestInit = {
      method: row.method,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "idempotency-key": row.id,
      },
    };
    if (row.payload !== null) init.body = JSON.stringify(row.payload);
    return fetch(row.endpoint, init);
  };

  let res = await send();

  // Session lapsed mid-shift. The access cookie lives 30 minutes; a till left
  // idle or backgrounded past that (Chrome throttles the proactive refresh timer
  // in background tabs) outlives it, so the request reaches the server with no
  // cookie and comes back 401 "missing session". Renew the session with the
  // long-lived refresh cookie — exactly what the app-level api() wrapper does —
  // then retry once. Re-sends are safe: the row id is the Idempotency-Key, so a
  // request that actually landed is deduped server-side.
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await send();
  }

  if (res.ok) {
    await local.outbox.update(row.id, {
      status: "acknowledged",
      acknowledged_at: Date.now(),
    });
    return;
  }

  // Still unauthorized after a refresh attempt → the session is genuinely gone
  // (refresh token expired/revoked, or offline mid-refresh). This is RECOVERABLE,
  // not a rejected sale: keep the row pending with backoff and a plain-language
  // note so it flushes automatically the moment the cashier signs back in. Never
  // dead-letter a real sale over an auth lapse — that is how sales silently
  // failed to lodge.
  if (res.status === 401) {
    const nextAttempts = row.attempt_count + 1;
    await local.outbox.update(row.id, {
      status: "pending",
      attempt_count: nextAttempts,
      next_attempt_at: Date.now() + backoffMs(nextAttempts),
      last_error: "Signed out — sign in again and this will send automatically.",
    });
    return;
  }

  // Business rule rejection — don't keep retrying.
  if ([400, 403, 404, 409, 422].includes(res.status)) {
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

/**
 * One-time heal for tills that double-counted sales before the pull-reconcile
 * fix landed. A sale rung up under the old code left BOTH its optimistic row
 * (client id) AND the server's authoritative row (server id) in the ledger, so
 * the deduction was applied twice. Those rows were already pulled, so a fresh
 * pull won't re-deliver them and `pullDeltas`' source-id reconcile can't reach
 * them. Collapse the duplicates here: for `sale` rows only — the only source
 * with an optimistic twin — keep ONE row per (source_id, product_id,
 * variant_id). The server writes exactly one ledger row per sold line, so any
 * second row with the same key is a stale optimistic copy. Non-sale sources
 * (production, transfers, adjustments) are never touched — two of those sharing
 * a key are genuinely distinct movements. Idempotent: a deduped ledger is a
 * no-op on the next run.
 */
export async function dedupeSaleLedger(): Promise<void> {
  const saleRows = await local.ledger.filter((r) => r.source_type === "sale").toArray();
  const seen = new Set<string>();
  const staleIds: string[] = [];
  for (const r of saleRows) {
    const key = `${r.source_id}|${r.product_id}|${r.variant_id ?? "null"}`;
    if (seen.has(key)) staleIds.push(r.id);
    else seen.add(key);
  }
  if (staleIds.length > 0) await local.ledger.bulkDelete(staleIds);
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
      imageUrl?: string | null;
    }>;
    variants: Array<{
      id: string;
      productId: string;
      sizeMl: number;
      sku: string;
      isActive: boolean;
      preorderOnly: boolean;
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
      variantId: string | null;
      delta: number;
      sourceType: string;
      sourceId: string;
      recordedAt: string;
    }>;
    // Authoritative current on-hand per flavour+size (server `SUM(delta)`).
    // Replaces the local snapshot wholesale each pull. Optional so an older
    // server that doesn't send it can't wipe the till's stock to zero.
    stock?: Array<{
      productId: string;
      variantId: string | null;
      qty: number;
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
    /** Server signals that today's opening count is already on file for this branch. */
    opened_today?: boolean;
    /**
     * The branch's currently-open shift, or null if none. Used to heal the
     * local currentShift mirror on every pull so a second device or a
     * reinstalled PWA knows the correct state without a manual action.
     */
    open_shift?: { id: string; opened_at: string | null } | null;
  };
  next_cursor: string;
}

export async function pullDeltas(branchId: string): Promise<void> {
  if (!navigator.onLine) return;
  const meta = await local.meta.get("default");
  const since = meta?.last_pull_at ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const url = `/v1/sync/pull?branch_id=${branchId}&since=${encodeURIComponent(since)}`;
  let res = await fetch(url, { credentials: "include" });
  // Session lapsed mid-shift (see sendOne). Renew once and retry so stock keeps
  // syncing instead of silently freezing on a backgrounded till.
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await fetch(url, { credentials: "include" });
  }
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
      local.stock,
      local.transfers,
      local.sales,
      local.meta,
      local.currentShift,
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
          image_url: p.imageUrl ?? null,
        });
      }
      for (const v of body.data.variants) {
        await local.variants.put({
          id: v.id,
          product_id: v.productId,
          size_ml: v.sizeMl,
          sku: v.sku,
          is_active: v.isActive,
          preorder_only: v.preorderOnly ?? false,
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
      // Acknowledge optimistic sale rows. A local sale decrements stock
      // immediately with a CLIENT-generated row keyed to the order id as its
      // source_id; once the server has booked that sale its ledger row arrives
      // here (same source_id) AND the authoritative `stock` snapshot below
      // already reflects it. So we simply DROP every local row whose source is
      // in this batch — the snapshot is now the single source of truth and the
      // till's ledger keeps only sales the server hasn't acknowledged yet. We no
      // longer persist server ledger rows locally (that incremental replay was
      // what let a server-side wipe leave phantom stock behind).
      const incomingSourceIds = new Set(body.data.ledger.map((lg) => lg.sourceId));
      if (incomingSourceIds.size > 0) {
        await local.ledger.filter((row) => incomingSourceIds.has(row.source_id)).delete();
      }

      // Overwrite the authoritative on-hand snapshot wholesale. Guard on the
      // field being present so an older server (no `stock` key) can never wipe
      // the till to zero; an empty array IS a valid "branch holds nothing" truth.
      if (Array.isArray(body.data.stock)) {
        await local.stock.clear();
        if (body.data.stock.length > 0) {
          await local.stock.bulkPut(
            body.data.stock.map((s) => ({
              id: `${s.productId}::${s.variantId ?? ""}`,
              product_id: s.productId,
              variant_id: s.variantId ?? null,
              qty: s.qty,
              synced_at: body.next_cursor,
            })),
          );
        }
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

      const existingMeta = await local.meta.get("default");
      await local.meta.put({
        ...existingMeta,
        id: "default",
        last_pull_at: body.next_cursor,
        branch_id: branchId,
        opened_today: body.data.opened_today ?? false,
      });

      // Mirror server open_shift into currentShift so any device heals.
      // Only act when the server sent the field (undefined = old server that
      // doesn't know about shifts yet — leave local state untouched).
      if ("open_shift" in body.data) {
        const openShift = body.data.open_shift;
        const existingShift = await local.currentShift.get(branchId);
        if (openShift) {
          // Server has an open shift — record it. Preserve shiftLocalId if
          // the device already has one and the server id matches, otherwise
          // overwrite with the authoritative server id.
          const openedAtValue = openShift.opened_at ?? null;
          const openedAtPatch = openedAtValue != null ? { openedAt: openedAtValue } : {};
          await local.currentShift.put({
            ...(existingShift ?? { branchId }),
            branchId,
            shiftLocalId: openShift.id,
            ...openedAtPatch,
            status: "open",
          });
        } else {
          // Server says no open shift — mark closed (keep the row for history).
          await local.currentShift.put({
            ...(existingShift ?? { branchId }),
            branchId,
            status: "closed",
          });
        }
      }
    },
  );
}

/**
 * Manual recovery: force the till's stock back in line with the server. Clears
 * the local snapshot and resets the pull cursor, then pulls a fresh
 * authoritative snapshot. Un-synced optimistic sale rows are left untouched so
 * a pending sale isn't double-counted back in. Returns true if it refreshed
 * (online), false if offline.
 */
export async function resyncStock(branchId: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  await local.stock.clear();
  const meta = await local.meta.get("default");
  await local.meta.put({
    id: "default",
    last_pull_at: null,
    branch_id: meta?.branch_id ?? branchId,
  });
  await pullDeltas(branchId);
  return true;
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
  // heal any double-counted sale rows left by the pre-reconcile code, THEN start
  // the loop so the rescued rows flush on the very first tick.
  void Promise.allSettled([reclaimInFlight(), dedupeSaleLedger()]).finally(() => void tick());

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
