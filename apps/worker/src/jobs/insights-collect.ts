/**
 * Statistics from Meta (suite spec 11, section 6): the worker's side of the collector.
 *
 * Every 10 minutes the loop asks "is a collection due?". A full collection runs once a
 * day after 10:00 Lagos time (after midnight US Pacific and midnight UTC, so "yesterday"
 * is complete for every source), or when someone pressed "Refresh figures". Otherwise,
 * at most once an hour, only Instagram stories under 24 hours old are measured.
 *
 * Read-only at Meta. This job does not run under withJobLock: that helper keeps a
 * transaction open for the whole job, and a collection talks to Meta for a minute or
 * more. It takes a marker in the stored state instead (claimInsightsRun), one statement.
 */
import type { DbClient } from "@ms/db";
import {
  claimInsightsRun,
  metaConfigFromEnv,
  patchInsightsState,
  readInsightsState,
  releaseInsightsRun,
  runInsightsCollection,
  type InsightsState,
  type MetaConfig,
} from "@ms/domain";
import { lagosDayOf, lagosHourOf } from "@ms/shared";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** The hour of the Lagos day from which the daily collection may run. */
export const INSIGHTS_DAILY_HOUR = 10;
const STORIES_EVERY_MS = 60 * 60_000;

/** When the last stories-only pass ran. It does not need to survive a restart. */
let lastStoriesAt = 0;

/** Tests start each case with no memory of an earlier stories pass. */
export function resetInsightsCollectMemory(): void {
  lastStoriesAt = 0;
}

/** Why a full collection is due now, or null. Pure: the decision the job makes. */
export function insightsRunDue(
  state: Pick<InsightsState, "last_daily_run_day" | "last_run_at" | "refresh_requested_at">,
  now: Date,
): { daily: boolean; refresh: boolean } | null {
  const asked = state.refresh_requested_at ? Date.parse(state.refresh_requested_at) : NaN;
  const ran = state.last_run_at ? Date.parse(state.last_run_at) : NaN;
  const refresh = !Number.isNaN(asked) && (Number.isNaN(ran) || asked > ran);
  const daily = lagosHourOf(now) >= INSIGHTS_DAILY_HOUR && state.last_daily_run_day !== lagosDayOf(now);
  return daily || refresh ? { daily, refresh } : null;
}

/** What the job touches besides the clock. The defaults are the real ones; tests pass their own. */
export interface InsightsCollectDeps {
  cfg: MetaConfig | null;
  readState: (db: DbClient) => Promise<Pick<InsightsState, "last_daily_run_day" | "last_run_at" | "refresh_requested_at">>;
  patchState: typeof patchInsightsState;
  claim: (db: DbClient, now: Date) => Promise<boolean>;
  release: (db: DbClient) => Promise<void>;
  run: typeof runInsightsCollection;
}

export type InsightsCollectOutcome = "no_meta" | "full" | "stories" | "idle" | "busy";

export async function collectInsightsIfDue(
  db: DbClient,
  log: Log,
  now: Date = new Date(),
  overrides: Partial<InsightsCollectDeps> = {},
): Promise<InsightsCollectOutcome> {
  const deps: InsightsCollectDeps = {
    cfg: metaConfigFromEnv(),
    readState: readInsightsState,
    patchState: patchInsightsState,
    claim: claimInsightsRun,
    release: releaseInsightsRun,
    run: runInsightsCollection,
    ...overrides,
  };
  const cfg = deps.cfg;
  if (!cfg) return "no_meta";

  const due = insightsRunDue(await deps.readState(db), now);
  const storiesDue = now.getTime() - lastStoriesAt >= STORIES_EVERY_MS;
  if (!due && !storiesDue) return "idle";

  // Another worker is collecting: leave it to finish.
  if (!(await deps.claim(db, now))) return "busy";
  try {
    if (due) {
      const result = await deps.run(db, cfg, log, { now });
      await deps.patchState(db, {
        last_run_at: now.toISOString(),
        ...(due.daily ? { last_daily_run_day: lagosDayOf(now) } : {}),
        refresh_requested_at: null,
      });
      lastStoriesAt = now.getTime(); // a full collection measures the stories too
      log.info({ ...result, daily: due.daily, refresh: due.refresh }, "insights collected");
      return "full";
    }
    lastStoriesAt = now.getTime();
    const result = await deps.run(db, cfg, log, { now, storiesOnly: true });
    if (result.written > 0 || result.problems > 0) log.info(result, "insights: stories measured");
    return "stories";
  } finally {
    await deps.release(db);
  }
}
