/**
 * Broadcast jobs (suite spec 14, Phase B, section 6). Each runs under withJobLock in the
 * inbox loop, so only one worker runs each at a time.
 *
 *   - broadcast_start  (30 s): scheduled broadcasts whose time has come start; with the owner
 *                              switch off, every scheduled or sending broadcast stops instead.
 *   - broadcast_send   (5 s):  one tick per sending broadcast (claim, send, settle).
 *   - broadcast_sweep  (60 s): recipients stuck in `sending` become sent or unknown, never
 *                              waiting again; broadcasts with nobody left finish.
 *   - broadcast_health (5 min): quality and limit of the lines in use, read from Meta.
 *
 * The system only ever stops a broadcast; a person resumes it (R56). No token is logged.
 */
import type { DbClient } from "@ms/db";
import { metaConfigFromEnv, refreshBroadcastHealth, runSendingBroadcasts, startDueBroadcasts, sweepBroadcasts } from "@ms/domain";

interface Log {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export async function startBroadcasts(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const r = await startDueBroadcasts(db, opts.now ?? new Date());
  if (r.started || r.stopped) log.info(r, "broadcasts started or stopped");
  return r.started;
}

export async function sendBroadcasts(db: DbClient, _log: Log, opts: { now?: Date } = {}): Promise<number> {
  return runSendingBroadcasts(db, metaConfigFromEnv(), opts.now ?? new Date());
}

export async function sweepBroadcastRecipients(db: DbClient, log: Log, opts: { now?: Date } = {}): Promise<number> {
  const r = await sweepBroadcasts(db, opts.now ?? new Date());
  if (r.settled || r.finished) log.info(r, "broadcast sweep");
  return r.settled;
}

export async function checkBroadcastHealth(db: DbClient, log: Log): Promise<number> {
  const r = await refreshBroadcastHealth(db, metaConfigFromEnv());
  // Only Meta's code is logged, never a token or a request.
  if (r.errors.length) log.warn({ errors: r.errors }, "broadcast health: Meta did not answer for some lines");
  return r.lines;
}
