/**
 * Sending approved posts to Facebook and Instagram (suite spec 09, section 6).
 *
 * publishDuePosts: promotes scheduled posts whose time has come (only while the owner's
 * switch is on, foundation correction C6), then moves a few pending targets forward.
 * reconcileUnknownTargets: looks at Meta to settle targets we could not be sure about.
 *
 * Nothing here decides to post: a target is only ever "pending" because a signed-in
 * person approved it (rule 1). The never-twice rule lives in advanceTarget (@ms/domain).
 */
import { and, asc, eq, lt, lte } from "drizzle-orm";
import { appSetting, socialPost, socialPostTarget, SOCIAL_PUBLISHING_KEY, type DbClient, type SocialPublishingValue } from "@ms/db";
import {
  MAX_RECONCILE_CHECKS,
  POST_CHANGED_NOTE,
  UNKNOWN_TEXT,
  advanceTarget,
  metaConfigFromEnv,
  postFingerprint,
  reconcileTarget,
  recomputePostStatus,
  type MetaConfig,
  type SignUrl,
} from "@ms/domain";
import { socialUrlSignerFromEnv } from "./social-media-url.js";

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

/** Tests pass these in; the worker reads them from its settings and the clock. */
export interface SocialPublishDeps {
  now?: Date;
  cfg?: MetaConfig | null;
  signUrl?: SignUrl | null;
}

export const LATE_LIMIT_MS = 60 * 60_000;
export const STUCK_AFTER_MS = 5 * 60_000;
export const SWITCHED_OFF_NOTE = "Scheduling was switched off when this post fell due.";
export const NOT_RUNNING_NOTE = "The suite was not running at the scheduled time.";
const TARGETS_PER_RUN = 5;

async function schedulingEnabled(db: DbClient): Promise<boolean> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, SOCIAL_PUBLISHING_KEY));
  return (row?.value as Partial<SocialPublishingValue> | undefined)?.scheduled_enabled === true;
}

/** Returns how many targets were published in this run. */
export async function publishDuePosts(db: DbClient, log: Logger, deps: SocialPublishDeps = {}): Promise<number> {
  const cfg = deps.cfg !== undefined ? deps.cfg : metaConfigFromEnv();
  if (!cfg) return 0;
  const now = deps.now ?? new Date();

  // 1. Promote due posts (rules 6 and 7). One conditional UPDATE per row, so a cancel or an edit wins cleanly.
  const due = await db
    .select({ id: socialPost.id, scheduledAt: socialPost.scheduledAt })
    .from(socialPost)
    .where(and(eq(socialPost.status, "scheduled"), lte(socialPost.scheduledAt, now)))
    .orderBy(asc(socialPost.scheduledAt))
    .limit(50);
  if (due.length > 0) {
    const enabled = await schedulingEnabled(db);
    for (const d of due) {
      const late = now.getTime() - (d.scheduledAt?.getTime() ?? 0) > LATE_LIMIT_MS;
      const next = !enabled
        ? { status: "missed", statusNote: SWITCHED_OFF_NOTE }
        : late
          ? { status: "missed", statusNote: NOT_RUNNING_NOTE }
          : { status: "publishing", statusNote: null };
      const [post] = await db
        .update(socialPost)
        .set({ ...next, updatedAt: now })
        .where(and(eq(socialPost.id, d.id), eq(socialPost.status, "scheduled")))
        .returning();
      if (!post || post.status !== "publishing") continue;

      // 2. The backstop: what goes out is exactly what a person approved (rule 2).
      const targets = await db.select().from(socialPostTarget).where(eq(socialPostTarget.postId, post.id));
      if (!post.approvedHash || postFingerprint(post, targets) !== post.approvedHash) {
        await db
          .update(socialPost)
          .set({ status: "failed", statusNote: POST_CHANGED_NOTE, updatedAt: now })
          .where(and(eq(socialPost.id, post.id), eq(socialPost.status, "publishing")));
        log.error({ postId: post.id }, "social post changed after approval; not sent");
      }
    }
  }

  // 3. Pick targets that are due, oldest first.
  const picks = await db
    .select({ id: socialPostTarget.id })
    .from(socialPostTarget)
    .innerJoin(socialPost, eq(socialPost.id, socialPostTarget.postId))
    .where(and(eq(socialPostTarget.status, "pending"), lte(socialPostTarget.nextAttemptAt, now), eq(socialPost.status, "publishing")))
    .orderBy(asc(socialPostTarget.nextAttemptAt), asc(socialPostTarget.id))
    .limit(TARGETS_PER_RUN);
  if (picks.length === 0) return 0;

  // 4. One target's trouble never stops the others (rule 8).
  const signUrl = deps.signUrl !== undefined ? deps.signUrl : socialUrlSignerFromEnv();
  let published = 0;
  for (const p of picks) {
    try {
      const result = await advanceTarget(db, cfg, p.id, signUrl, now);
      if (result === "published") published += 1;
      if (result === "failed" || result === "unknown") log.warn({ targetId: p.id, result }, "social post target did not publish");
    } catch (err) {
      log.error({ err, targetId: p.id }, "social post target failed unexpectedly");
    }
  }
  return published;
}

/** Returns how many unknown targets were settled (published, or proved not published) in this run. */
export async function reconcileUnknownTargets(db: DbClient, log: Logger, deps: SocialPublishDeps = {}): Promise<number> {
  const cfg = deps.cfg !== undefined ? deps.cfg : metaConfigFromEnv();
  if (!cfg) return 0;
  const now = deps.now ?? new Date();

  // A crash between the claim and the result leaves "publishing": after 5 minutes that is "unknown", never "pending".
  const stuck = await db
    .update(socialPostTarget)
    .set({ status: "unknown", errorMessage: UNKNOWN_TEXT, updatedAt: now })
    .where(and(eq(socialPostTarget.status, "publishing"), lt(socialPostTarget.lockedAt, new Date(now.getTime() - STUCK_AFTER_MS))))
    .returning({ postId: socialPostTarget.postId });
  for (const postId of new Set(stuck.map((s) => s.postId))) await recomputePostStatus(db, postId, now);

  const picks = await db
    .select({ id: socialPostTarget.id })
    .from(socialPostTarget)
    .where(and(eq(socialPostTarget.status, "unknown"), lt(socialPostTarget.reconcileChecks, MAX_RECONCILE_CHECKS)))
    .orderBy(asc(socialPostTarget.updatedAt), asc(socialPostTarget.id))
    .limit(10);
  let settled = 0;
  for (const p of picks) {
    try {
      if ((await reconcileTarget(db, cfg, p.id, now)) !== "unknown") settled += 1;
    } catch (err) {
      log.error({ err, targetId: p.id }, "social post reconcile failed unexpectedly");
    }
  }
  return settled;
}
