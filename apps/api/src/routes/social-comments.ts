/**
 * Comments on Facebook Page posts and Instagram posts (suite spec 03):
 * /v1/social/comments.
 *
 * Who sees what: a person with social.comments sees comments on the channel
 * accounts they may use (canUseNumber: the existing per-line access, with
 * inbox.view_all meaning every account). That is the same access table the
 * inbox uses, not a second rule. A thread on an account the viewer cannot use
 * answers 404, so its existence is not revealed.
 *
 * Every action that leaves the building (public reply, hide, show, delete,
 * like, private message) is made by a named person, shown on screen before it
 * is sent, and written to the audit log (foundation rule 7). Nothing here runs
 * unattended. A Meta refusal is answered in plain words, never as a 500.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { adminUser, inboxConversation, inboxPhoneNumber, socialComment, socialCommentAccount, socialPostRef, type DbClient } from "@ms/db";
import {
  CommentActionError,
  canSeeConversation,
  canUseNumber,
  classifyMetaError,
  deleteComment,
  hideComment,
  likeComment,
  loadViewer,
  metaConfigFromEnv,
  metaErrorCode,
  MetaApiError,
  privateReplyToComment,
  publishCommentUpdated,
  refreshThread,
  replyToComment,
  type InboxViewer,
  type SocialCommentRow,
} from "@ms/domain";
import {
  COMMENT_MAX,
  commentActionsFor,
  networkName,
  resolveCapabilities,
  type AdminRole,
  type CommentActions,
  type CommentKind,
  type CommentSendStatus,
  type CommentStatus,
  type PermissionOverrides,
  type SocialNetwork,
} from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";
import { need } from "./inbox.js";

export interface ThreadSummary {
  id: string;
  network: SocialNetwork;
  account_id: string;
  account_label: string;
  account_active: boolean;
  kind: CommentKind;
  author_name: string | null;
  author_username: string | null;
  preview: string | null;
  status: CommentStatus;
  hidden_source: "suite" | "outside" | null;
  work_state: "open" | "done";
  unread: number;
  assignee_id: string | null;
  assignee_name: string | null;
  last_activity_at: string;
  reply_count: number;
  post: {
    id: string;
    message: string | null;
    picture_url: string | null;
    permalink_url: string | null;
    posted_at: string | null;
    is_ad: boolean;
    /** False until the worker has read the post from Meta. */
    fetched: boolean;
    fetch_error: string | null;
  };
}

export interface CommentItem {
  id: string;
  external_id: string | null;
  is_root: boolean;
  from_business: boolean;
  author_name: string | null;
  author_username: string | null;
  sent_by_name: string | null;
  message: string | null;
  attachment_url: string | null;
  status: CommentStatus;
  hidden_source: "suite" | "outside" | null;
  edited: boolean;
  send_status: CommentSendStatus | null;
  error_message: string | null;
  liked_by_business: boolean;
  like_count: number | null;
  commented_at: string;
  private_reply: {
    status: CommentSendStatus;
    body: string;
    by_name: string | null;
    at: string;
    error: string | null;
    conversation_id: string | null;
  } | null;
  actions: CommentActions;
}

/** How long opening a thread waits for Meta before showing what is stored. Tests shorten it. */
export const commentTimings = { refreshBudgetMs: 5_000, refreshEveryMs: 60_000 };

const assignee = alias(adminUser, "assignee");
const sender = alias(adminUser, "sender");
const privateSender = alias(adminUser, "private_sender");

function likeTerm(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** SQL: the comment's account is one the viewer may use. Mirrors canUseNumber(). */
function accountScope(v: InboxViewer, column: AnyPgColumn = socialComment.accountId): SQL {
  if (v.numberIds === "all") return sql`true`;
  return v.numberIds.length > 0 ? inArray(column, v.numberIds) : sql`false`;
}

const threadColumns = {
  id: socialComment.id,
  network: socialComment.network,
  account_id: socialComment.accountId,
  account_label: inboxPhoneNumber.label,
  account_active: inboxPhoneNumber.isActive,
  kind: socialComment.kind,
  author_name: socialComment.authorName,
  author_username: socialComment.authorUsername,
  preview: socialComment.lastPreview,
  status: socialComment.status,
  hidden_source: socialComment.hiddenSource,
  work_state: socialComment.workState,
  unread: socialComment.unreadCount,
  assignee_id: socialComment.assigneeId,
  assignee_name: sql<string | null>`coalesce(${assignee.name}, ${assignee.email})`,
  last_activity_at: socialComment.lastActivityAt,
  reply_count: sql<number>`(select count(*)::int from social_comment r where r.root_id = ${socialComment.id} and r.status <> 'deleted')`,
  post_id: socialPostRef.id,
  post_message: socialPostRef.message,
  post_picture_url: socialPostRef.pictureUrl,
  post_permalink_url: socialPostRef.permalinkUrl,
  post_posted_at: socialPostRef.postedAt,
  post_is_ad: socialPostRef.isAd,
  post_fetched_at: socialPostRef.fetchedAt,
  post_fetch_error: socialPostRef.fetchError,
};

function threadQuery(db: DbClient) {
  return db
    .select(threadColumns)
    .from(socialComment)
    .innerJoin(socialPostRef, eq(socialPostRef.id, socialComment.postId))
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, socialComment.accountId))
    .leftJoin(assignee, eq(assignee.id, socialComment.assigneeId));
}

type ThreadRow = Awaited<ReturnType<ReturnType<typeof threadQuery>["limit"]>>[number];

function toSummary(r: ThreadRow): ThreadSummary {
  return {
    id: r.id,
    network: r.network as SocialNetwork,
    account_id: r.account_id,
    account_label: r.account_label,
    account_active: r.account_active,
    kind: r.kind as CommentKind,
    author_name: r.author_name,
    author_username: r.author_username,
    preview: r.preview,
    status: r.status as CommentStatus,
    hidden_source: r.hidden_source as ThreadSummary["hidden_source"],
    work_state: r.work_state as ThreadSummary["work_state"],
    unread: r.unread,
    assignee_id: r.assignee_id,
    assignee_name: r.assignee_name,
    last_activity_at: r.last_activity_at.toISOString(),
    reply_count: r.reply_count,
    post: {
      id: r.post_id,
      message: r.post_message,
      picture_url: r.post_picture_url,
      permalink_url: r.post_permalink_url,
      posted_at: r.post_posted_at ? r.post_posted_at.toISOString() : null,
      is_ad: r.post_is_ad,
      fetched: r.post_fetched_at !== null,
      fetch_error: r.post_fetch_error,
    },
  };
}

export function socialCommentRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", async (c, next) => {
    const auth = c.get("auth");
    if (!auth.capabilities.includes("social.comments")) {
      throw new BusinessError("forbidden", "missing capability: social.comments", 403);
    }
    c.set("inboxViewer", await loadViewer(db, auth.userId, auth.capabilities));
    await next();
  });

  const viewerOf = (c: Context): InboxViewer => c.get("inboxViewer");
  const notFound = () => new BusinessError("not_found", "comment not found", 404);

  /** A comment (root or reply) on an account the viewer may use; 404 otherwise. */
  async function visibleComment(c: Context, id: string): Promise<SocialCommentRow> {
    if (!z.string().uuid().safeParse(id).success) throw notFound();
    const [row] = await db.select().from(socialComment).where(eq(socialComment.id, id));
    if (!row || !canUseNumber(viewerOf(c), row.accountId)) throw notFound();
    return row;
  }

  async function visibleThread(c: Context, id: string): Promise<SocialCommentRow> {
    const row = await visibleComment(c, id);
    if (row.rootId !== null) throw notFound();
    return row;
  }

  async function summaryOf(id: string): Promise<ThreadSummary> {
    const [row] = await threadQuery(db).where(eq(socialComment.id, id)).limit(1);
    if (!row) throw notFound();
    return toSummary(row);
  }

  /** The comments of a thread as the screen shows them: root first, replies oldest first, at most 300. */
  async function itemsOf(c: Context, where: SQL): Promise<CommentItem[]> {
    const v = viewerOf(c);
    const rows = await db
      .select({
        comment: socialComment,
        sent_by_name: sql<string | null>`coalesce(${sender.name}, ${sender.email})`,
        private_by_name: sql<string | null>`coalesce(${privateSender.name}, ${privateSender.email})`,
        account_active: inboxPhoneNumber.isActive,
      })
      .from(socialComment)
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, socialComment.accountId))
      .leftJoin(sender, eq(sender.id, socialComment.sentByUserId))
      .leftJoin(privateSender, eq(privateSender.id, socialComment.privateReplyByUserId))
      .where(where)
      .orderBy(sql`(${socialComment.rootId} is not null)`, asc(socialComment.commentedAt), asc(socialComment.createdAt))
      .limit(300);

    // A chat is linked only for someone who may open it in the Inbox.
    const convIds = [...new Set(rows.map((x) => x.comment.conversationId).filter((x): x is string => !!x))];
    const visible = new Set<string>();
    if (convIds.length > 0 && v.capabilities.includes("inbox.view")) {
      const convs = await db.select().from(inboxConversation).where(inArray(inboxConversation.id, convIds));
      for (const conv of convs) if (canSeeConversation(v, conv)) visible.add(conv.id);
    }
    const now = new Date();
    return rows.map(({ comment: m, sent_by_name, private_by_name, account_active }) => {
      const network = m.network as SocialNetwork;
      const privateStatus = m.privateReplyStatus as CommentSendStatus | null;
      return {
        id: m.id,
        external_id: m.externalId,
        is_root: m.rootId === null,
        from_business: m.fromBusiness,
        author_name: m.authorName,
        author_username: m.authorUsername,
        sent_by_name: m.sentByUserId ? sent_by_name : null,
        message: m.message,
        attachment_url: m.attachmentUrl,
        status: m.status as CommentStatus,
        hidden_source: m.hiddenSource as CommentItem["hidden_source"],
        edited: m.editedAt !== null,
        send_status: m.sendStatus as CommentSendStatus | null,
        error_message: m.errorMessage,
        liked_by_business: m.likedByBusiness,
        like_count: m.likeCount,
        commented_at: m.commentedAt.toISOString(),
        private_reply: privateStatus
          ? {
              status: privateStatus,
              body: m.privateReplyBody ?? "",
              by_name: private_by_name,
              at: (m.privateReplyAt ?? m.commentedAt).toISOString(),
              error: m.privateReplyError,
              conversation_id: m.conversationId && visible.has(m.conversationId) ? m.conversationId : null,
            }
          : null,
        actions: commentActionsFor(
          {
            kind: m.kind as CommentKind,
            status: m.status as CommentStatus,
            fromBusiness: m.fromBusiness,
            externalId: m.externalId,
            likedByBusiness: m.likedByBusiness,
            commentedAt: m.commentedAt,
            privateReplyStatus: privateStatus,
          },
          network,
          v.capabilities,
          now,
          { accountActive: account_active },
        ),
      };
    });
  }

  async function itemOf(c: Context, id: string): Promise<CommentItem> {
    const [item] = await itemsOf(c, eq(socialComment.id, id));
    if (!item) throw notFound();
    return item;
  }

  const audit = (c: Context, action: string, entityId: string, after?: unknown, before?: unknown) =>
    writeAudit(db, c, { action, entityType: "social_comment", entityId, before, after, notify: false });

  /** A refusal our own rules made (no call to Meta, or nothing changed). */
  function actionError(err: CommentActionError): BusinessError {
    if (err.code === "not_found") return notFound();
    if (err.code === "not_configured") return new BusinessError("service_unavailable", err.message, 503);
    return new BusinessError("conflict", err.message, 409, { reason: err.code });
  }

  /** A Meta failure on hide, show, delete or like, in plain words (spec 03, 5.7). */
  function metaFailure(err: MetaApiError, network: SocialNetwork): BusinessError {
    const name = networkName(network);
    const details = { meta_code: metaErrorCode(err) };
    switch (classifyMetaError(err)) {
      case "config":
        return new BusinessError(
          "service_unavailable",
          "The suite has lost its permission for this account. Ask the owner to check Channels. Nothing was changed.",
          502,
          details,
        );
      case "temporary":
        return new BusinessError(
          "service_unavailable",
          `${name} is busy or is limiting how often we can ask. Nothing was changed. Try again in a few minutes.`,
          503,
          details,
        );
      case "gone":
        return new BusinessError("conflict", `This comment no longer exists on ${name}.`, 409, details);
      case "unknown":
        return new BusinessError(
          "service_unavailable",
          `No answer from ${name}, so we can't tell if it worked. Open the comment again in a minute to see.`,
          504,
          details,
        );
      default: {
        const code = metaErrorCode(err);
        return new BusinessError("conflict", `${name} refused this: ${err.message}${code ? ` (code ${code})` : ""}.`, 409, details);
      }
    }
  }

  function mapped(err: unknown, network: SocialNetwork): unknown {
    if (err instanceof CommentActionError) return actionError(err);
    if (err instanceof MetaApiError) return metaFailure(err, network);
    return err;
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  r.get("/accounts", async (c) => {
    const rows = await db
      .select({
        id: inboxPhoneNumber.id,
        label: inboxPhoneNumber.label,
        kind: inboxPhoneNumber.kind,
        is_active: inboxPhoneNumber.isActive,
        backfilled_at: socialCommentAccount.backfilledAt,
        last_error: socialCommentAccount.lastError,
      })
      .from(inboxPhoneNumber)
      .leftJoin(socialCommentAccount, eq(socialCommentAccount.accountId, inboxPhoneNumber.id))
      .where(and(inArray(inboxPhoneNumber.kind, ["messenger", "instagram"]), accountScope(viewerOf(c), inboxPhoneNumber.id)))
      .orderBy(asc(inboxPhoneNumber.label));
    return c.json({
      data: rows.map((a) => ({
        id: a.id,
        label: a.label,
        network: (a.kind === "instagram" ? "instagram" : "facebook") as SocialNetwork,
        is_active: a.is_active,
        comments_ready: a.backfilled_at !== null,
        backfilled_at: a.backfilled_at ? a.backfilled_at.toISOString() : null,
        last_error: a.last_error,
      })),
    });
  });

  /** The number on the menu: comment threads still waiting, the same ones "Needs a reply" lists. */
  r.get("/unread", async (c) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(socialComment)
      .where(
        and(
          isNull(socialComment.rootId),
          eq(socialComment.workState, "open"),
          eq(socialComment.kind, "comment"),
          sql`${socialComment.unreadCount} > 0`,
          accountScope(viewerOf(c)),
        ),
      );
    return c.json({ data: { threads: row?.n ?? 0 } });
  });

  r.get("/threads", async (c) => {
    const v = viewerOf(c);
    const q = z
      .object({
        state: z.enum(["open", "done", "all"]).default("open"),
        view: z.enum(["all", "mine", "unassigned"]).default("all"),
        network: z.enum(["facebook", "instagram"]).optional(),
        account: z.string().uuid().optional(),
        kind: z.enum(["comment", "mention", "live", "all"]).default("comment"),
        hidden: z.enum(["0", "1"]).optional(),
        q: z.string().trim().max(100).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(c.req.query());
    const conds: SQL[] = [isNull(socialComment.rootId), accountScope(v)];
    if (q.state !== "all") conds.push(eq(socialComment.workState, q.state));
    if (q.view === "mine") conds.push(eq(socialComment.assigneeId, v.userId));
    if (q.view === "unassigned") conds.push(isNull(socialComment.assigneeId));
    if (q.network) conds.push(eq(socialComment.network, q.network));
    if (q.account) conds.push(eq(socialComment.accountId, q.account));
    if (q.kind !== "all") conds.push(eq(socialComment.kind, q.kind));
    if (q.hidden === "1") conds.push(eq(socialComment.status, "hidden"));
    if (q.q) {
      const term = likeTerm(q.q.replace(/^@/, ""));
      conds.push(
        sql`exists (select 1 from social_comment m where (m.id = ${socialComment.id} or m.root_id = ${socialComment.id})
          and (m.author_name ilike ${term} or m.author_username ilike ${term} or m.message ilike ${term}))`,
      );
    }
    if (q.before) conds.push(lt(socialComment.lastActivityAt, new Date(q.before)));
    const rows = await threadQuery(db)
      .where(and(...conds))
      .orderBy(desc(socialComment.lastActivityAt), desc(socialComment.id))
      .limit(q.limit + 1);
    const has_more = rows.length > q.limit;
    const data = rows.slice(0, q.limit).map(toSummary);
    return c.json({ data, has_more, next_before: has_more && data.length ? data[data.length - 1]!.last_activity_at : null });
  });

  r.get("/threads/:id", async (c) => {
    const root = await visibleThread(c, c.req.param("id"));
    // Rule R13: bring the thread up to date with Meta, but never keep the person waiting for it.
    let refresh_error: string | null = null;
    const cfg = metaConfigFromEnv();
    const stale = !root.refreshedAt || Date.now() - root.refreshedAt.getTime() > commentTimings.refreshEveryMs;
    if (cfg && stale) {
      const work = refreshThread(db, cfg, root.id).then(
        () => null,
        (err: unknown) => {
          if (!(err instanceof MetaApiError)) logger.warn({ err, threadId: root.id }, "comment thread refresh failed");
          return err instanceof MetaApiError ? `Could not check ${networkName(root.network as SocialNetwork)} for changes just now.` : "Could not check for changes just now.";
        },
      );
      const timeout = new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("Still checking for changes."), commentTimings.refreshBudgetMs);
        void work.finally(() => clearTimeout(t));
      });
      refresh_error = await Promise.race([work, timeout]);
    }
    const thread = await summaryOf(root.id);
    const comments = await itemsOf(c, sql`(${socialComment.id} = ${root.id} or ${socialComment.rootId} = ${root.id})`);
    return c.json({ data: { thread: { ...thread, refresh_error }, comments } });
  });

  r.post("/threads/:id/read", async (c) => {
    const root = await visibleThread(c, c.req.param("id"));
    if (root.unreadCount > 0) {
      await db.transaction(async (tx) => {
        await tx.update(socialComment).set({ unreadCount: 0 }).where(eq(socialComment.id, root.id));
        await publishCommentUpdated(tx, root);
      });
    }
    return c.json({ ok: true });
  });

  r.patch("/threads/:id", async (c) => {
    const root = await visibleThread(c, c.req.param("id"));
    const body = z
      .object({ assignee_id: z.string().uuid().nullable().optional(), work_state: z.enum(["open", "done"]).optional() })
      .strict()
      .parse(await c.req.json());
    const auth = c.get("auth");
    if (body.assignee_id) {
      const [u] = await db
        .select({ role: adminUser.role, overrides: adminUser.permissionOverrides, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
        .from(adminUser)
        .where(eq(adminUser.id, body.assignee_id));
      const ok =
        u && u.isActive && !u.deletedAt && resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides).includes("social.comments");
      if (!ok) throw new BusinessError("validation_failed", "That person can't work on comments", 400);
    }
    const now = new Date();
    const set: Partial<typeof socialComment.$inferInsert> = {};
    if (body.assignee_id !== undefined) set.assigneeId = body.assignee_id;
    if (body.work_state === "done") Object.assign(set, { workState: "done", doneByUserId: auth.userId, doneAt: now, unreadCount: 0 });
    if (body.work_state === "open") Object.assign(set, { workState: "open", doneByUserId: null, doneAt: null });
    if (Object.keys(set).length > 0) {
      await db.transaction(async (tx) => {
        await tx.update(socialComment).set(set).where(eq(socialComment.id, root.id));
        await publishCommentUpdated(tx, root);
      });
      if (body.assignee_id !== undefined && body.assignee_id !== root.assigneeId) {
        await audit(c, "social.comment_assign", root.id, { assignee_id: body.assignee_id }, { assignee_id: root.assigneeId });
      }
      if (body.work_state !== undefined && body.work_state !== root.workState) {
        await audit(c, "social.comment_state", root.id, { work_state: body.work_state }, { work_state: root.workState });
      }
    }
    return c.json({ data: await summaryOf(root.id) });
  });

  // ── Actions ────────────────────────────────────────────────────────────────

  const text = z.string().trim().min(1).max(COMMENT_MAX);

  async function postExternalId(postId: string): Promise<string | null> {
    const [p] = await db.select({ externalId: socialPostRef.externalId }).from(socialPostRef).where(eq(socialPostRef.id, postId));
    return p?.externalId ?? null;
  }

  r.post("/comments/:id/reply", async (c) => {
    const target = await visibleComment(c, c.req.param("id"));
    const { message } = z.object({ message: text }).strict().parse(await c.req.json());
    const network = target.network as SocialNetwork;
    let row: SocialCommentRow;
    try {
      row = await replyToComment(db, metaConfigFromEnv(), { commentId: target.id, userId: c.get("auth").userId, message });
    } catch (err) {
      throw mapped(err, network);
    }
    await audit(c, "social.comment_reply", row.id, {
      network,
      post_external_id: await postExternalId(target.postId),
      to_comment: target.externalId,
      message,
      result: row.sendStatus,
      meta_code: row.errorCode,
    });
    // 502: Meta did not take it, or did not answer. The row says which; nothing sends it again.
    return c.json({ data: await itemOf(c, row.id) }, row.sendStatus === "sent" ? 201 : 502);
  });

  async function moderate(
    c: Context,
    action: string,
    run: (target: SocialCommentRow) => Promise<SocialCommentRow>,
    before?: (target: SocialCommentRow) => unknown,
  ) {
    const target = await visibleComment(c, c.req.param("id")!);
    const network = target.network as SocialNetwork;
    let row: SocialCommentRow;
    try {
      row = await run(target);
    } catch (err) {
      throw mapped(err, network);
    }
    await audit(c, action, row.id, { network, comment: row.externalId, status: row.status, liked: row.likedByBusiness }, before?.(target));
    return c.json({ data: await itemOf(c, row.id) });
  }

  const userOf = (c: Context): string => c.get("auth").userId;

  r.post("/comments/:id/hide", (c) =>
    moderate(c, "social.comment_hide", (t) => hideComment(db, metaConfigFromEnv(), { commentId: t.id, userId: userOf(c), hidden: true })),
  );
  r.post("/comments/:id/unhide", (c) =>
    moderate(c, "social.comment_unhide", (t) => hideComment(db, metaConfigFromEnv(), { commentId: t.id, userId: userOf(c), hidden: false })),
  );
  r.delete("/comments/:id", (c) =>
    moderate(
      c,
      "social.comment_delete",
      (t) => deleteComment(db, metaConfigFromEnv(), { commentId: t.id, userId: userOf(c) }),
      (t) => ({ message: t.message, author_name: t.authorName ?? t.authorUsername }),
    ),
  );
  r.post("/comments/:id/like", (c) =>
    moderate(c, "social.comment_like", (t) => likeComment(db, metaConfigFromEnv(), { commentId: t.id, userId: userOf(c), liked: true })),
  );
  r.delete("/comments/:id/like", (c) =>
    moderate(c, "social.comment_unlike", (t) => likeComment(db, metaConfigFromEnv(), { commentId: t.id, userId: userOf(c), liked: false })),
  );

  r.post("/comments/:id/private-reply", async (c) => {
    need(c, "inbox.reply");
    const target = await visibleComment(c, c.req.param("id"));
    const body = z.object({ text }).strict().parse(await c.req.json());
    const network = target.network as SocialNetwork;
    let row: SocialCommentRow;
    try {
      row = await privateReplyToComment(db, metaConfigFromEnv(), { commentId: target.id, userId: userOf(c), text: body.text });
    } catch (err) {
      throw mapped(err, network);
    }
    await audit(c, "social.comment_private_reply", row.id, {
      network,
      comment: row.externalId,
      text: body.text,
      result: row.privateReplyStatus,
      conversation_id: row.conversationId,
      meta_code: row.privateReplyErrorCode,
    });
    return c.json({ data: await itemOf(c, row.id) }, row.privateReplyStatus === "sent" ? 201 : 502);
  });

  /** Ask the worker to load the last 30 days again. It only adds what is missing. */
  r.post("/sync", async (c) => {
    need(c, "channels.manage");
    const { account_id } = z.object({ account_id: z.string().uuid() }).strict().parse(await c.req.json());
    const [account] = await db
      .select({ id: inboxPhoneNumber.id, kind: inboxPhoneNumber.kind })
      .from(inboxPhoneNumber)
      .where(eq(inboxPhoneNumber.id, account_id));
    if (!account || !["messenger", "instagram"].includes(account.kind) || !canUseNumber(viewerOf(c), account.id)) {
      throw new BusinessError("not_found", "account not found", 404);
    }
    const cleared = { backfilledAt: null, backfillStartedAt: null, pausedUntil: null, lastError: null, lastErrorCode: null, lastErrorAt: null };
    await db
      .insert(socialCommentAccount)
      .values({ accountId: account.id })
      .onConflictDoUpdate({ target: socialCommentAccount.accountId, set: cleared });
    await writeAudit(db, c, { action: "social.comment_resync", entityType: "social_comment", entityId: account.id, notify: false });
    return c.json({ ok: true }, 202);
  });

  return r;
}
