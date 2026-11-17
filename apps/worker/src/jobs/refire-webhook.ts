/**
 * Re-fire the api's payment webhook for a single order, by order number, over
 * HTTP. The webhook owns the one tested money-reconcile path (verify +
 * applyPaymentConfirmation); the worker never imports @ms/api or re-implements
 * ledger logic — it only re-triggers the webhook so a completed payment whose
 * original callback was lost still reconciles. Shared by the reconcile sweep
 * and the auto-cancel job.
 */

export type PaymentProvider = "opay";

/**
 * OPay is the only provider. Legacy rows carrying null (or the retired
 * "payaza") resolve here too: the sweep's window is 48 hours, so nothing that
 * predates the OPay switch can still be in scope — and re-verifying a stale
 * order against OPay simply reports "not completed" rather than moving money.
 */
export function providerOf(_paymentProvider: string | null): PaymentProvider {
  return "opay";
}

/** The api gives OPay 8 seconds; past this the api itself is stuck, and one
 *  hung call must not hold the worker's single loop. */
const REFIRE_TIMEOUT_MS = 15_000;

/** POST the payment webhook. Returns true on a 2xx. The webhook accepts a
 *  minimal re-fire body and verifies the money server-to-server. */
export async function refireProviderWebhook(
  orderNumber: string,
  provider: PaymentProvider,
): Promise<boolean> {
  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";
  const body = { reference: orderNumber };
  const res = await fetch(`${base}/v1/webhooks/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFIRE_TIMEOUT_MS),
  });
  return res.ok;
}

/**
 * Re-verify one order with the provider. Resolves true only when the check
 * completed (whatever the provider said); false means the api answered but
 * could not get a status for THIS order; a throw means the api itself could
 * not be reached. Injectable so tests can drive it without real HTTP.
 */
export type RefireFn = (orderNumber: string, provider: PaymentProvider) => Promise<boolean>;

/**
 * When this worker process last put each order to the provider. Kept in memory
 * on purpose: it only decides who goes first, so losing it on a restart costs
 * nothing, and it needs no column.
 */
export type CheckLog = Map<string, number>;

export interface CheckRunOptions {
  /** Rotation memory; one per job. */
  log: CheckLog;
  /** Stop starting new checks once this much time has gone by. */
  budgetMs: number;
  /** Injectable clock for tests. */
  clock?: () => number;
  /** Called for a check that threw (the api could not be reached). */
  onUnreachable?: (order: { id: string; orderNumber: string }, err: unknown) => void;
}

/** After this many checks in a row THROW, the api is down: stop the run. An
 *  order whose check merely came back "could not tell" never counts, so a
 *  cluster of uncheckable orders cannot stop the others being checked. */
const MAX_UNREACHABLE_IN_A_ROW = 3;

/**
 * Put orders to the provider one by one, fairly and for a bounded time.
 *
 *   - Least recently checked first (never-checked orders ahead of everything,
 *     otherwise in the order given), so when a run cannot get through the
 *     whole list the next run carries on where this one stopped.
 *   - An order that cannot be checked is skipped; the run continues.
 *   - The run ends when the time budget is spent, or when the api is
 *     unreachable (see above).
 *
 * Returns the ids whose check completed.
 */
export async function checkInRotation(
  orders: ReadonlyArray<{ id: string; orderNumber: string; paymentProvider: string | null }>,
  refire: RefireFn,
  opts: CheckRunOptions,
): Promise<Set<string>> {
  const clock = opts.clock ?? Date.now;
  const { log } = opts;

  // Forget orders that are no longer candidates, so the log cannot grow.
  const live = new Set(orders.map((o) => o.id));
  for (const id of log.keys()) if (!live.has(id)) log.delete(id);

  // Array.prototype.sort is stable: ties keep the caller's order.
  const queue = [...orders].sort((a, b) => (log.get(a.id) ?? 0) - (log.get(b.id) ?? 0));

  const completed = new Set<string>();
  const started = clock();
  let unreachableInARow = 0;
  for (const o of queue) {
    if (clock() - started >= opts.budgetMs) break;
    log.set(o.id, clock());
    try {
      if ((await refire(o.orderNumber, providerOf(o.paymentProvider))) === true) {
        completed.add(o.id);
      }
      unreachableInARow = 0;
    } catch (err) {
      opts.onUnreachable?.(o, err);
      if (++unreachableInARow >= MAX_UNREACHABLE_IN_A_ROW) break;
    }
  }
  return completed;
}
