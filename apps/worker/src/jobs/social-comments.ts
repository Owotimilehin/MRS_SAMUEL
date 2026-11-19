/**
 * Comments on Facebook and Instagram posts: background jobs (suite spec 03, section 6).
 *
 *   - fillCommentDetails: read the post a comment belongs to (text, picture,
 *     link), fill in comments we only know by ID, and mark a reply whose send
 *     was cut off as "not confirmed".
 *   - backfillComments: the first load after connecting (the last 30 days), and
 *     again after "Try again" on the Comments page. It only adds what is missing.
 *   - pollComments: Instagram comment webhooks need Meta's advanced access, so
 *     Instagram comments arrive here (within 5 minutes); for Facebook it is a
 *     safety net for a missed webhook (every 30 minutes).
 *
 * These jobs only READ from Meta, with one exception that changes nothing a
 * customer can see: they keep the Page subscribed to the `feed` and `mention`
 * webhook fields. They never post, hide, delete or send anything, and never
 * re-send a reply or a private message.
 *
 * Meta is always asked first, outside any transaction; the database is written
 * afterwards. A switched-off account, or one paused after an error, is skipped.
 */
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { inboxPhoneNumber, socialComment, socialCommentAccount, socialPostRef, type DbClient } from "@ms/db";
import {
  applyCommentChange,
  applyRemoteComment,
  classifyMetaError,
  ensurePageSubscribed,
  explainCommentError,
  fetchComment,
  fetchPost,
  listPostComments,
  listRecentPosts,
  metaConfigFromEnv,
  metaErrorCode,
  MetaApiError,
  networkOfAccount,
  oldestFirst,
  publishCommentUpdated,
  raiseCommentsConfigAlert,
  recordCommentsProblem,
  rerootPlaceholder,
  savePostDetails,
  type ChannelAccount,
  type MetaConfig,
  type MetaProblem,
  type RemotePost,
} from "@ms/domain";
import type { CommentKind } from "@ms/shared";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FILL_BATCH = 10;
const FILL_PAUSE_MIN = 15;
const SYNC_PAUSE_MIN = 60;
const MAX_POST_ATTEMPTS = 5;
const BACKFILL_DAYS = 30;
const POLL_DAYS = 14;
const POLL_EVERY_MS = { instagram: 5 * MINUTE, facebook: 30 * MINUTE };
/** A queued reply this old means the API process died mid-send. */
const STUCK_SEND_MS = 2 * MINUTE;

interface AccountState {
  account: ChannelAccount;
  backfillStartedAt: Date | null;
  backfilledAt: Date | null;
  lastPolledAt: Date | null;
  pausedUntil: Date | null;
}

/** Every switched-on Facebook Page and Instagram account, with where its syncing stands (a state row is made if missing). */
async function accountStates(db: DbClient): Promise<AccountState[]> {
  const lines = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      externalId: inboxPhoneNumber.externalId,
      pageId: inboxPhoneNumber.pageExternalId,
      isActive: inboxPhoneNumber.isActive,
    })
    .from(inboxPhoneNumber)
    .where(and(inArray(inboxPhoneNumber.kind, ["messenger", "instagram"]), eq(inboxPhoneNumber.isActive, true)))
    .orderBy(asc(inboxPhoneNumber.createdAt));
  const usable = lines.filter((l) => l.externalId && l.pageId);
  if (usable.length === 0) return [];
  await db
    .insert(socialCommentAccount)
    .values(usable.map((l) => ({ accountId: l.id })))
    .onConflictDoNothing();
  const states = await db
    .select()
    .from(socialCommentAccount)
    .where(inArray(socialCommentAccount.accountId, usable.map((l) => l.id)));
  return usable.map((l) => {
    const s = states.find((x) => x.accountId === l.id);
    return {
      account: { ...l, kind: l.kind as ChannelAccount["kind"] },
      backfillStartedAt: s?.backfillStartedAt ?? null,
      backfilledAt: s?.backfilledAt ?? null,
      lastPolledAt: s?.lastPolledAt ?? null,
      pausedUntil: s?.pausedUntil ?? null,
    };
  });
}

const isPaused = (s: AccountState, now: Date): boolean => !!s.pausedUntil && s.pausedUntil.getTime() > now.getTime();

async function pause(db: DbClient, accountId: string, minutes: number, now: Date): Promise<void> {
  await db
    .update(socialCommentAccount)
    .set({ pausedUntil: new Date(now.getTime() + minutes * MINUTE) })
    .where(eq(socialCommentAccount.accountId, accountId));
}

/**
 * The retry rules in one place (spec 03, section 6): busy or no answer → pause
 * the account and try later; a token or permission problem → tell the owner
 * once a day, pause an hour, show a banner; a refusal → note it, do not retry
 * that item; gone → the caller marks the item. Anything that is not a Meta
 * error is a bug and is thrown.
 */
async function handleMetaError(
  db: DbClient,
  log: Log,
  account: ChannelAccount,
  err: unknown,
  pauseMinutes: number,
  now: Date,
  what: string,
  /** A refusal about one post or comment is not worth a banner on the Comments page. */
  oneItem = false,
): Promise<MetaProblem> {
  if (!(err instanceof MetaApiError)) throw err;
  const problem = classifyMetaError(err);
  const code = metaErrorCode(err);
  if (problem === "temporary" || problem === "unknown") {
    await pause(db, account.id, pauseMinutes, now);
  } else if (problem === "config") {
    await raiseCommentsConfigAlert(db, account, { code, message: err.message });
    await pause(db, account.id, SYNC_PAUSE_MIN, now);
  } else if (problem === "refused" && !oneItem) {
    await recordCommentsProblem(db, account.id, { code, message: explainCommentError(err, networkOfAccount(account)) });
  }
  // The Page token is never part of a Meta error; only the code and message are logged.
  log.warn({ accountId: account.id, problem, code, message: err.message }, `comments: ${what} failed`);
  return problem;
}

// ── 6.1 Fill ─────────────────────────────────────────────────────────────────

async function fillPosts(db: DbClient, log: Log, cfg: MetaConfig, states: AccountState[], stopped: Set<string>, now: Date): Promise<number> {
  const accountIds = states.map((s) => s.account.id);
  const fresh = await db
    .select()
    .from(socialPostRef)
    .where(and(inArray(socialPostRef.accountId, accountIds), isNull(socialPostRef.fetchedAt), lt(socialPostRef.fetchAttempts, MAX_POST_ATTEMPTS)))
    .orderBy(asc(socialPostRef.createdAt))
    .limit(FILL_BATCH);
  // Meta's picture links expire: refresh the posts people are still working on, once a day.
  const stale = await db
    .select()
    .from(socialPostRef)
    .where(
      and(
        inArray(socialPostRef.accountId, accountIds),
        lt(socialPostRef.fetchedAt, new Date(now.getTime() - DAY)),
        lt(socialPostRef.fetchAttempts, MAX_POST_ATTEMPTS),
        sql`exists (select 1 from social_comment c where c.post_id = ${socialPostRef.id} and c.root_id is null and c.work_state = 'open')`,
      ),
    )
    .orderBy(asc(socialPostRef.fetchedAt))
    .limit(FILL_BATCH);

  let done = 0;
  for (const post of [...fresh, ...stale]) {
    const state = states.find((s) => s.account.id === post.accountId);
    if (!state || stopped.has(post.accountId)) continue;
    try {
      const remote = await fetchPost(cfg, state.account, post.externalId);
      await db.transaction(async (tx) => {
        await savePostDetails(tx, state.account, networkOfAccount(state.account), { ...remote, externalId: post.externalId });
        await tx.update(socialPostRef).set({ fetchAttempts: 0 }).where(eq(socialPostRef.id, post.id));
        const roots = await tx
          .select({ id: socialComment.id, rootId: socialComment.rootId, accountId: socialComment.accountId })
          .from(socialComment)
          .where(and(eq(socialComment.postId, post.id), isNull(socialComment.rootId), eq(socialComment.workState, "open")))
          .limit(50);
        for (const root of roots) await publishCommentUpdated(tx, root);
      });
      done++;
    } catch (err) {
      const problem = await handleMetaError(db, log, state.account, err, FILL_PAUSE_MIN, now, "reading a post", true);
      if (problem === "gone") {
        await db
          .update(socialPostRef)
          .set({ fetchError: "no longer available", fetchAttempts: MAX_POST_ATTEMPTS, fetchedAt: post.fetchedAt ?? null })
          .where(eq(socialPostRef.id, post.id));
      } else {
        await db
          .update(socialPostRef)
          .set({
            fetchAttempts: sql`${socialPostRef.fetchAttempts} + 1`,
            ...(problem === "refused" && err instanceof Error ? { fetchError: err.message.slice(0, 300) } : {}),
          })
          .where(eq(socialPostRef.id, post.id));
        if (problem !== "refused") stopped.add(post.accountId);
      }
    }
  }
  return done;
}

async function fillComments(db: DbClient, log: Log, cfg: MetaConfig, states: AccountState[], stopped: Set<string>, now: Date): Promise<number> {
  const rows = await db
    .select({ comment: socialComment, postExternalId: socialPostRef.externalId })
    .from(socialComment)
    .innerJoin(socialPostRef, eq(socialPostRef.id, socialComment.postId))
    .where(
      and(
        eq(socialComment.needsFetch, true),
        inArray(socialComment.accountId, states.map((s) => s.account.id)),
        sql`${socialComment.status} <> 'deleted'`,
        sql`${socialComment.externalId} is not null`,
      ),
    )
    .orderBy(asc(socialComment.createdAt))
    .limit(FILL_BATCH);

  let done = 0;
  for (const { comment: row, postExternalId } of rows) {
    const state = states.find((s) => s.account.id === row.accountId);
    if (!state || stopped.has(row.accountId)) continue;
    const account = state.account;
    try {
      const remote = await fetchComment(cfg, account, row.externalId!, row.kind === "mention" ? "mention" : "comment");
      await db.transaction(async (tx) => {
        // Rule R11 (Facebook): the placeholder is itself a reply. Its parent becomes the thread.
        if (row.rootId === null && remote.parentExternalId && remote.parentExternalId !== postExternalId && account.kind === "messenger") {
          await rerootPlaceholder(tx, row, remote.parentExternalId);
        }
        await applyRemoteComment(tx, account, postExternalId, { ...remote, parentExternalId: row.parentExternalId }, {
          source: "poll",
          now,
          kind: row.kind as CommentKind,
        });
        // Whatever came back, this row has been looked up.
        await tx.update(socialComment).set({ needsFetch: false }).where(eq(socialComment.id, row.id));
      });
      done++;
    } catch (err) {
      const problem = await handleMetaError(db, log, account, err, FILL_PAUSE_MIN, now, "reading a comment", true);
      if (problem === "gone") {
        await db.transaction(async (tx) => {
          await applyCommentChange(tx, account, {
            type: "status",
            network: networkOfAccount(account),
            accountExternalId: account.externalId ?? "",
            externalId: row.externalId!,
            status: "deleted",
            at: now,
          });
        });
      } else if (problem === "refused") {
        await db.update(socialComment).set({ needsFetch: false }).where(eq(socialComment.id, row.id));
      } else {
        stopped.add(row.accountId);
      }
    }
  }
  return done;
}

/**
 * A reply or private message still "queued" after two minutes: the API process
 * died between saving it and hearing from Meta. It becomes "not confirmed" for
 * a person to check. The worker never sends it again.
 */
async function settleStuckSends(db: DbClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_SEND_MS);
  const replies = await db
    .update(socialComment)
    .set({ sendStatus: "unknown", errorMessage: "We never heard back, so we can't tell if it was posted." })
    .where(and(eq(socialComment.sendStatus, "queued"), lt(socialComment.createdAt, cutoff)))
    .returning({ id: socialComment.id, rootId: socialComment.rootId, accountId: socialComment.accountId });
  const privates = await db
    .update(socialComment)
    .set({ privateReplyStatus: "unknown", privateReplyError: "We never heard back, so we can't tell if it was sent." })
    .where(and(eq(socialComment.privateReplyStatus, "queued"), lt(socialComment.privateReplyAt, cutoff)))
    .returning({ id: socialComment.id, rootId: socialComment.rootId, accountId: socialComment.accountId });
  for (const row of [...replies, ...privates]) await publishCommentUpdated(db, row);
  return replies.length + privates.length;
}

export async function fillCommentDetails(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  let done = await settleStuckSends(db, now);
  const states = (await accountStates(db)).filter((s) => !isPaused(s, now));
  if (states.length === 0) return done;
  /** Accounts that hit a busy or permission error this run: nothing more is asked of them until the pause ends. */
  const stopped = new Set<string>();
  done += await fillPosts(db, log, cfg, states, stopped, now);
  done += await fillComments(db, log, cfg, states, stopped, now);
  return done;
}

// ── 6.2 First load, and 6.3 polling ──────────────────────────────────────────

/** Read one post's comments from Meta and store them, oldest first. Returns how many were new. */
async function syncPostComments(
  db: DbClient,
  cfg: MetaConfig,
  account: ChannelAccount,
  post: RemotePost,
  opts: { source: "backfill" | "poll"; maxPages: number; now: Date },
): Promise<number> {
  const comments = await listPostComments(cfg, account, post.externalId, { maxPages: opts.maxPages });
  const network = networkOfAccount(account);
  return db.transaction(async (tx) => {
    const postId = await savePostDetails(tx, account, network, post);
    let created = 0;
    for (const c of oldestFirst(comments)) {
      const r = await applyRemoteComment(tx, account, post.externalId, c, { source: opts.source, now: opts.now });
      if (r.created) created++;
    }
    // What Meta showed when we last read this post's comments: the next poll compares against it.
    await tx
      .update(socialPostRef)
      .set({ remoteCommentCount: post.commentCount, remoteUpdatedAt: post.updatedAt })
      .where(eq(socialPostRef.id, postId));
    return created;
  });
}

/** The first load on connect, and after POST /sync. One account per run. */
export async function backfillComments(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  const states = await accountStates(db);
  const due = states.find(
    (s) =>
      !s.backfilledAt &&
      !isPaused(s, now) &&
      (!s.backfillStartedAt || now.getTime() - s.backfillStartedAt.getTime() > 30 * MINUTE),
  );
  if (!due) return 0;
  const { account } = due;
  const mine = eq(socialCommentAccount.accountId, account.id);
  await db.update(socialCommentAccount).set({ backfillStartedAt: now }).where(mine);

  let created = 0;
  try {
    try {
      await ensurePageSubscribed(cfg, account);
    } catch (err) {
      // A plain refusal to subscribe does not stop the load: polling still brings comments in.
      const problem = await handleMetaError(db, log, account, err, SYNC_PAUSE_MIN, now, "subscribing the Page to comments");
      if (problem !== "refused" && problem !== "gone") return 0;
    }
    const posts = await listRecentPosts(cfg, account, { since: new Date(now.getTime() - BACKFILL_DAYS * DAY), limit: 50 });
    for (const post of posts) {
      try {
        created += await syncPostComments(db, cfg, account, post, { source: "backfill", maxPages: 3, now });
      } catch (err) {
        const problem = classifyMetaError(err);
        // One post that Meta will not show (deleted meanwhile, comments off) does not stop the rest.
        if (!(err instanceof MetaApiError) || (problem !== "gone" && problem !== "refused")) throw err;
        log.warn({ accountId: account.id, post: post.externalId, code: metaErrorCode(err) }, "comments: first load skipped a post");
      }
    }
  } catch (err) {
    // Left unfinished (backfilled_at stays empty), so it resumes; storing again is harmless.
    await handleMetaError(db, log, account, err, SYNC_PAUSE_MIN, now, "the first load");
    return created;
  }
  await db
    .update(socialCommentAccount)
    .set({ backfilledAt: now, lastPolledAt: now, lastError: null, lastErrorCode: null, lastErrorAt: null })
    .where(mine);
  log.info({ accountId: account.id, created }, "comments: first load finished");
  return created;
}

/** Look for comments no webhook told us about. Only posts whose comment count (Instagram) or last change (Facebook) moved are read. */
export async function pollComments(
  db: DbClient,
  log: Log,
  cfg: MetaConfig | null = metaConfigFromEnv(),
  now: Date = new Date(),
): Promise<number> {
  if (!cfg) return 0;
  let created = 0;
  for (const s of await accountStates(db)) {
    const { account } = s;
    const network = networkOfAccount(account);
    if (!s.backfilledAt || isPaused(s, now)) continue;
    if (s.lastPolledAt && now.getTime() - s.lastPolledAt.getTime() < POLL_EVERY_MS[network]) continue;
    try {
      // Keeps `feed` and `mention` on the Page's subscription if anything dropped them (Facebook only; one read).
      try {
        await ensurePageSubscribed(cfg, account);
      } catch (err) {
        const problem = await handleMetaError(db, log, account, err, SYNC_PAUSE_MIN, now, "subscribing the Page to comments");
        if (problem !== "refused" && problem !== "gone") continue;
      }
      const posts = await listRecentPosts(cfg, account, { since: new Date(now.getTime() - POLL_DAYS * DAY), limit: 25 });
      const known = posts.length
        ? await db
            .select({ externalId: socialPostRef.externalId, count: socialPostRef.remoteCommentCount, updatedAt: socialPostRef.remoteUpdatedAt })
            .from(socialPostRef)
            .where(and(eq(socialPostRef.network, network), inArray(socialPostRef.externalId, posts.map((p) => p.externalId))))
        : [];
      for (const post of posts) {
        const before = known.find((k) => k.externalId === post.externalId);
        const changed =
          !before ||
          (network === "instagram"
            ? post.commentCount !== before.count
            : (post.updatedAt?.getTime() ?? null) !== (before.updatedAt?.getTime() ?? null));
        if (!changed) continue;
        try {
          created += await syncPostComments(db, cfg, account, post, { source: "poll", maxPages: 1, now });
        } catch (err) {
          const problem = classifyMetaError(err);
          if (!(err instanceof MetaApiError) || (problem !== "gone" && problem !== "refused")) throw err;
          log.warn({ accountId: account.id, post: post.externalId, code: metaErrorCode(err) }, "comments: poll skipped a post");
        }
      }
      await db
        .update(socialCommentAccount)
        .set({ lastPolledAt: now, lastError: null, lastErrorCode: null, lastErrorAt: null })
        .where(eq(socialCommentAccount.accountId, account.id));
    } catch (err) {
      await handleMetaError(db, log, account, err, SYNC_PAUSE_MIN, now, "polling");
    }
  }
  return created;
}
