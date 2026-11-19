/**
 * Posts to Facebook and Instagram (suite spec 09, section 5.8), mounted at /v1/social.
 *
 * Every route needs social.publish. Nothing here posts anything: a person approves a
 * post ("approve", "retry", "resolve"), each time after seeing exactly what will go out
 * (the content hash proves it), and the worker does the sending (foundation rules 7 and 9).
 * The two calls that do reach Meta from here change or remove a post that is already
 * public, on a person's click. Every write is audited. No token is ever read, logged,
 * stored or returned: Page tokens stay inside @ms/domain.
 */
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  adminUser,
  appSetting,
  inboxPhoneNumber,
  socialPost,
  socialPostTarget,
  SOCIAL_PUBLISHING_KEY,
  type DbClient,
  type DbExecutor,
  type SocialPostMedia,
  type SocialPublishingValue,
} from "@ms/db";
import {
  MetaApiError,
  classifyPublishError,
  fbDeleteObject,
  fbUpdatePostMessage,
  igDeleteMedia,
  igPublishingQuota,
  metaConfigFromEnv,
  postDraftShape,
  postFingerprint,
  reconcileTarget,
  recomputePostStatus,
  withPageTokenRetry,
  type MetaConfig,
  type SocialPostRow,
  type SocialTargetRow,
} from "@ms/domain";
import {
  SOCIAL_MEDIA_KEY_RE,
  effectiveCaption,
  networkForAccountKind,
  networkName,
  validatePostForNetwork,
  validateSchedule,
  type PostProblem,
  type SocialNetwork,
  type SocialPostKind,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { BusinessError } from "../lib/errors.js";
import { presignSocialPreview, presignSocialPut } from "../lib/r2.js";
import { env } from "../env.js";

const Uuid = z.string().uuid();

const NOT_CONNECTED = "Meta is not connected on this server.";
const ACCOUNT_OFF = "This account is switched off in Channels.";
const CHANGED = "This post changed while you were looking at it. Check it again.";
const SETTLED = "This has already been settled. Reload the page.";
const NOT_YOURS = "That upload isn't yours to use";
const PICK_ACCOUNT = "Pick a connected Facebook Page or Instagram account";
const MARKED_POSTED_NOTE = "Marked as posted by a person; not linked to statistics.";

/** A target in one of these states has reached Meta's "risky call", so the post is kept for the record. */
const GONE_OUT = ["publishing", "published", "unknown", "removed"];
/** Meta's "you may not do this" codes for taking a post down (5.8, Q2). */
const TAKE_DOWN_REFUSED = new Set(["10", "200", "299", "3"]);

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PostTargetJson {
  id: string;
  account_id: string | null;
  account_label: string;
  network: SocialNetwork;
  caption_override: string | null;
  status: string;
  external_id: string | null;
  external_kind: string | null;
  permalink: string | null;
  error_message: string | null;
  error_code: string | null;
  attempts: number;
  published_at: string | null;
  removed_at: string | null;
  removed_by: { id: string; name: string } | null;
  problems: PostProblem[];
}

export interface PostJson {
  id: string;
  kind: SocialPostKind;
  caption: string;
  link_url: string | null;
  /** preview_url is a 10-minute signed link, or null when file storage is not set up. */
  media: (SocialPostMedia & { preview_url: string | null })[];
  status: string;
  status_note: string | null;
  scheduled_at: string | null;
  created_by: { id: string; name: string } | null;
  approved_by: { id: string; name: string } | null;
  approved_at: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  targets: PostTargetJson[];
}

const MediaItem = z.object({
  key: z.string().regex(SOCIAL_MEDIA_KEY_RE),
  // Needed for a file that is new to the post; a file already on the post needs none.
  upload_token: z.string().min(16).max(128).optional(),
  mime: z.string().max(100),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
  duration_s: z.number().positive().max(3600).nullable(),
  alt_text: z.string().max(1000).nullable(),
});
const PostBody = z.object({
  kind: z.enum(["text", "link", "photo", "album", "video", "story"]),
  caption: z.string().max(5000),
  link_url: z.string().url().max(2000).nullable().optional(),
  media: z.array(MediaItem).max(10),
  targets: z
    .array(z.object({ account_id: z.string().uuid(), caption_override: z.string().max(5000).nullable().optional() }))
    .min(1)
    .max(4),
});
const PatchBody = PostBody.extend({ base_updated_at: z.string().datetime() });
const ApproveBody = z.object({
  when: z.enum(["now", "schedule"]),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  content_hash: z.string().min(16).max(128),
});
const HashBody = z.object({ content_hash: z.string().min(16).max(128) });
const ResolveBody = z.object({ outcome: z.enum(["posted", "not_posted"]), confirm: z.literal(true).optional() });
const EditPublishedBody = z.object({ message: z.string().trim().min(1).max(5000) });
const TakeDownBody = z.object({ manual: z.literal(true).optional() });
const UploadBody = z.object({
  filename: z.string().min(1).max(200),
  content_type: z.string().min(1).max(100),
  size_bytes: z.number().int().positive(),
});
const SettingsBody = z.object({ scheduled_enabled: z.boolean() }).strict();
const LagosDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── Upload tokens: a file can only be put on a post by whoever uploaded it ───

function uploadToken(userId: string, key: string): string {
  return crypto.createHmac("sha256", env.JWT_SIGNING_KEY).update(`social-upload:${userId}:${key}`).digest("base64url");
}

function verifyUploadToken(userId: string, key: string, token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(uploadToken(userId, key));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function schedulingEnabled(db: DbExecutor): Promise<boolean> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, SOCIAL_PUBLISHING_KEY));
  return (row?.value as Partial<SocialPublishingValue> | undefined)?.scheduled_enabled === true;
}

interface AccountRow {
  id: string;
  kind: string;
  label: string;
  externalId: string | null;
  pageId: string | null;
  isActive: boolean;
}

async function accountsById(db: DbExecutor, ids: string[]): Promise<Map<string, AccountRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      externalId: inboxPhoneNumber.externalId,
      pageId: inboxPhoneNumber.pageExternalId,
      isActive: inboxPhoneNumber.isActive,
    })
    .from(inboxPhoneNumber)
    .where(inArray(inboxPhoneNumber.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** What stops this target going out: the composer's rules, plus an account that is gone or switched off. */
function targetProblems(post: SocialPostRow, target: SocialTargetRow, account: AccountRow | undefined): PostProblem[] {
  const out = validatePostForNetwork(postDraftShape(post), target.network as SocialNetwork, effectiveCaption(post.caption, target.captionOverride));
  if (!account || !account.isActive || networkForAccountKind(account.kind) !== target.network) {
    out.unshift({ code: "account_off", message: ACCOUNT_OFF, blocking: true });
  }
  return out;
}

async function postsToJson(db: DbExecutor, posts: SocialPostRow[]): Promise<PostJson[]> {
  if (posts.length === 0) return [];
  const targets = await db
    .select()
    .from(socialPostTarget)
    .where(
      inArray(
        socialPostTarget.postId,
        posts.map((p) => p.id),
      ),
    )
    .orderBy(asc(socialPostTarget.network), asc(socialPostTarget.createdAt), asc(socialPostTarget.id));
  const accounts = await accountsById(db, [...new Set(targets.flatMap((t) => (t.accountId ? [t.accountId] : [])))]);
  const userIds = [
    ...new Set(
      [...posts.flatMap((p) => [p.createdBy, p.approvedBy]), ...targets.map((t) => t.removedBy)].filter((x): x is string => !!x),
    ),
  ];
  const users = userIds.length
    ? await db.select({ id: adminUser.id, name: adminUser.name, email: adminUser.email }).from(adminUser).where(inArray(adminUser.id, userIds))
    : [];
  const person = (id: string | null): { id: string; name: string } | null => {
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u ? { id, name: u.name?.trim() || u.email.split("@")[0] || "Staff" } : { id, name: "Staff" };
  };

  const out: PostJson[] = [];
  for (const post of posts) {
    const mine = targets.filter((t) => t.postId === post.id);
    const media: PostJson["media"] = [];
    for (const m of post.media) media.push({ ...m, preview_url: await presignSocialPreview(m.key) });
    out.push({
      id: post.id,
      kind: post.kind as SocialPostKind,
      caption: post.caption,
      link_url: post.linkUrl,
      media,
      status: post.status,
      status_note: post.statusNote,
      scheduled_at: post.scheduledAt?.toISOString() ?? null,
      created_by: person(post.createdBy),
      approved_by: person(post.approvedBy),
      approved_at: post.approvedAt?.toISOString() ?? null,
      content_hash: postFingerprint(post, mine),
      created_at: post.createdAt.toISOString(),
      updated_at: post.updatedAt.toISOString(),
      targets: mine.map((t) => {
        const account = t.accountId ? accounts.get(t.accountId) : undefined;
        return {
          id: t.id,
          account_id: t.accountId,
          account_label: account?.label ?? "Removed account",
          network: t.network as SocialNetwork,
          caption_override: t.captionOverride,
          status: t.status,
          external_id: t.externalId,
          external_kind: t.externalKind,
          permalink: t.permalink,
          error_message: t.errorMessage,
          error_code: t.errorCode,
          attempts: t.attempts,
          published_at: t.publishedAt?.toISOString() ?? null,
          removed_at: t.removedAt?.toISOString() ?? null,
          removed_by: person(t.removedBy),
          // Only a target that has not gone out can still have something to fix.
          problems: t.status === "pending" || t.status === "failed" ? targetProblems(post, t, account) : [],
        };
      }),
    });
  }
  return out;
}

function postIdOf(c: Context): string {
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  return id.data;
}

async function onePost(db: DbExecutor, id: string): Promise<PostJson> {
  const [post] = await db.select().from(socialPost).where(eq(socialPost.id, id));
  if (!post) throw new BusinessError("not_found", "not found", 404);
  return (await postsToJson(db, [post]))[0]!;
}

async function loadTarget(db: DbExecutor, c: Context): Promise<{ post: SocialPostRow; target: SocialTargetRow; account: AccountRow | undefined }> {
  const postId = postIdOf(c);
  const tid = Uuid.safeParse(c.req.param("tid"));
  if (!tid.success) throw new BusinessError("not_found", "not found", 404);
  const [target] = await db
    .select()
    .from(socialPostTarget)
    .where(and(eq(socialPostTarget.id, tid.data), eq(socialPostTarget.postId, postId)));
  if (!target) throw new BusinessError("not_found", "not found", 404);
  const [post] = await db.select().from(socialPost).where(eq(socialPost.id, postId));
  if (!post) throw new BusinessError("not_found", "not found", 404);
  const account = target.accountId ? (await accountsById(db, [target.accountId])).get(target.accountId) : undefined;
  return { post, target, account };
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
  return cfg;
}

/** The accounts a post may go to: active, a Page or an Instagram account, each named once. */
async function pickAccounts(db: DbExecutor, wanted: { account_id: string }[]): Promise<Map<string, AccountRow>> {
  const ids = wanted.map((t) => t.account_id);
  if (new Set(ids).size !== ids.length) throw new BusinessError("validation_failed", PICK_ACCOUNT, 400);
  const found = await accountsById(db, ids);
  for (const id of ids) {
    const a = found.get(id);
    if (!a || !a.isActive || !networkForAccountKind(a.kind)) throw new BusinessError("validation_failed", PICK_ACCOUNT, 400);
  }
  return found;
}

function storedMedia(items: z.infer<typeof MediaItem>[]): SocialPostMedia[] {
  return items.map((m) => ({
    key: m.key,
    mime: m.mime,
    bytes: m.bytes,
    width: m.width,
    height: m.height,
    duration_s: m.duration_s,
    alt_text: m.alt_text?.trim() ? m.alt_text.trim() : null,
  }));
}

/** A target back at the very start: nothing prepared, nothing counted, no error. */
function freshTarget(now: Date) {
  return {
    status: "pending",
    step: "start",
    attempts: 0,
    reconcileChecks: 0,
    nextAttemptAt: now,
    waitStartedAt: null,
    lockedAt: null,
    containerId: null,
    childIds: [] as string[],
    errorCode: null,
    errorSubcode: null,
    errorMessage: null,
    updatedAt: now,
  };
}

const auditTargets = (post: { caption: string }, targets: { network: string; accountId: string | null; captionOverride: string | null }[]) =>
  targets.map((t) => ({ network: t.network, account_id: t.accountId, caption: effectiveCaption(post.caption, t.captionOverride) }));

// ── Routes ───────────────────────────────────────────────────────────────────

export function socialPostRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("social.publish"));

  r.get("/accounts", async (c) => {
    const rows = await db
      .select({
        id: inboxPhoneNumber.id,
        kind: inboxPhoneNumber.kind,
        label: inboxPhoneNumber.label,
        externalId: inboxPhoneNumber.externalId,
        pageId: inboxPhoneNumber.pageExternalId,
      })
      .from(inboxPhoneNumber)
      .where(and(eq(inboxPhoneNumber.isActive, true), inArray(inboxPhoneNumber.kind, ["messenger", "instagram"])))
      .orderBy(asc(inboxPhoneNumber.kind), asc(inboxPhoneNumber.label));
    const cfg = metaConfigFromEnv();
    const data = await Promise.all(
      rows.map(async (a) => {
        let quota: { used: number; total: number } | null = null;
        const igId = a.externalId;
        const pageId = a.pageId;
        if (a.kind === "instagram" && cfg && igId && pageId) {
          // The figure is a help, never a reason for the page to fail.
          quota = await withPageTokenRetry(cfg, pageId, (t) => igPublishingQuota(cfg, t, igId)).catch(() => null);
        }
        return { id: a.id, label: a.label, network: networkForAccountKind(a.kind)!, quota };
      }),
    );
    return c.json({ data, scheduling_enabled: await schedulingEnabled(db) });
  });

  r.post("/uploads", async (c) => {
    const body = UploadBody.parse(await c.req.json().catch(() => ({})));
    const res = await presignSocialPut({ filename: body.filename, contentType: body.content_type, sizeBytes: body.size_bytes });
    return c.json({ data: { ...res, upload_token: uploadToken(c.get("auth").userId, res.object_key) } }, 201);
  });

  r.get("/posts", async (c) => {
    const group = z.enum(["draft", "scheduled", "posted", "problems", "all"]).catch("all").parse(c.req.query("status") ?? "all");
    const from = LagosDay.safeParse(c.req.query("from"));
    const to = LagosDay.safeParse(c.req.query("to"));
    const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query("limit") ?? "30", 10) || 30));
    const [cursorAt, cursorId] = (c.req.query("cursor") ?? "").split("_");

    // Whole milliseconds, so a cursor (an ISO time) compares exactly.
    const sortAt = sql`date_trunc('milliseconds', coalesce(${socialPost.scheduledAt}, ${socialPost.createdAt}))`;
    const statuses: Record<typeof group, string[] | null> = {
      draft: ["draft"],
      scheduled: ["scheduled", "publishing"],
      posted: ["published", "partly_published"],
      problems: ["failed", "needs_check", "missed"],
      all: null,
    };
    const conds = [];
    if (statuses[group]) conds.push(inArray(socialPost.status, statuses[group]!));
    // Lagos is UTC+1 all year.
    if (from.success) conds.push(sql`${sortAt} >= ${`${from.data}T00:00:00+01:00`}::timestamptz`);
    if (to.success) conds.push(sql`${sortAt} < ${`${to.data}T00:00:00+01:00`}::timestamptz + interval '1 day'`);
    if (cursorAt && cursorId && !Number.isNaN(Date.parse(cursorAt)) && Uuid.safeParse(cursorId).success) {
      conds.push(sql`(${sortAt}, ${socialPost.id}) < (${cursorAt}::timestamptz, ${cursorId}::uuid)`);
    }
    const rows = await db
      .select()
      .from(socialPost)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${sortAt} desc`, desc(socialPost.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? `${(last.scheduledAt ?? last.createdAt).toISOString()}_${last.id}` : null;
    return c.json({ data: await postsToJson(db, page), next_cursor: next });
  });

  r.get("/posts/:id", async (c) => c.json({ data: await onePost(db, postIdOf(c)) }));

  r.post("/posts", async (c) => {
    const body = PostBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    for (const m of body.media) {
      if (!verifyUploadToken(auth.userId, m.key, m.upload_token)) throw new BusinessError("validation_failed", NOT_YOURS, 400);
    }
    const accounts = await pickAccounts(db, body.targets);
    const now = new Date();
    const id = await db.transaction(async (tx) => {
      const [post] = await tx
        .insert(socialPost)
        .values({
          kind: body.kind,
          caption: body.caption,
          linkUrl: body.kind === "link" ? (body.link_url ?? null) : null,
          media: storedMedia(body.media),
          status: "draft",
          createdBy: auth.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: socialPost.id });
      await tx.insert(socialPostTarget).values(
        body.targets.map((t) => ({
          postId: post!.id,
          accountId: t.account_id,
          network: networkForAccountKind(accounts.get(t.account_id)!.kind)!,
          captionOverride: t.caption_override ?? null,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return post!.id;
    });
    const data = await onePost(db, id);
    await writeAudit(db, c, {
      action: "social.post_create",
      entityType: "social_post",
      entityId: id,
      after: { kind: data.kind, caption: data.caption, targets: data.targets.map((t) => ({ network: t.network, account_id: t.account_id })) },
      notify: false,
    });
    return c.json({ data }, 201);
  });

  r.patch("/posts/:id", async (c) => {
    const id = postIdOf(c);
    const body = PatchBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const accounts = await pickAccounts(db, body.targets);
    const now = new Date();

    const before = await db.transaction(async (tx) => {
      const [post] = await tx.select().from(socialPost).where(eq(socialPost.id, id)).for("update");
      if (!post) throw new BusinessError("not_found", "not found", 404);
      const existing = await tx.select().from(socialPostTarget).where(eq(socialPostTarget.postId, id));
      const editable = ["draft", "scheduled", "missed", "failed"].includes(post.status) && !existing.some((t) => GONE_OUT.includes(t.status));
      if (!editable) throw new BusinessError("conflict", "This post has already gone out. Edit it on the post's page.", 409);
      // Rule 14: two people editing.
      if (post.updatedAt.getTime() !== Date.parse(body.base_updated_at)) {
        throw new BusinessError("conflict", "Someone else changed this post. Reload to see their version.", 409, { reason: "stale" });
      }
      const already = new Set(post.media.map((m) => m.key));
      for (const m of body.media) {
        if (!already.has(m.key) && !verifyUploadToken(auth.userId, m.key, m.upload_token)) {
          throw new BusinessError("validation_failed", NOT_YOURS, 400);
        }
      }

      // Rule 3: any edit needs a fresh approval, so the post goes back to a draft.
      await tx
        .update(socialPost)
        .set({
          kind: body.kind,
          caption: body.caption,
          linkUrl: body.kind === "link" ? (body.link_url ?? null) : null,
          media: storedMedia(body.media),
          status: "draft",
          scheduledAt: null,
          statusNote: null,
          approvedBy: null,
          approvedAt: null,
          approvedHash: null,
          updatedAt: now,
        })
        .where(eq(socialPost.id, id));

      const wanted = new Set(body.targets.map((t) => t.account_id));
      const drop = existing.filter((t) => !t.accountId || !wanted.has(t.accountId)).map((t) => t.id);
      if (drop.length) await tx.delete(socialPostTarget).where(inArray(socialPostTarget.id, drop));
      for (const t of body.targets) {
        const kept = existing.find((e) => e.accountId === t.account_id);
        if (kept) {
          await tx
            .update(socialPostTarget)
            .set({ ...freshTarget(now), captionOverride: t.caption_override ?? null })
            .where(eq(socialPostTarget.id, kept.id));
        } else {
          await tx.insert(socialPostTarget).values({
            postId: id,
            accountId: t.account_id,
            network: networkForAccountKind(accounts.get(t.account_id)!.kind)!,
            captionOverride: t.caption_override ?? null,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      return { status: post.status, caption: post.caption, targets: auditTargets(post, existing) };
    });

    const data = await onePost(db, id);
    await writeAudit(db, c, {
      action: "social.post_update",
      entityType: "social_post",
      entityId: id,
      before,
      after: {
        status: data.status,
        caption: data.caption,
        targets: data.targets.map((t) => ({ network: t.network, account_id: t.account_id, caption: effectiveCaption(data.caption, t.caption_override) })),
      },
      notify: false,
    });
    return c.json({ data });
  });

  r.delete("/posts/:id", async (c) => {
    const id = postIdOf(c);
    const before = await db.transaction(async (tx) => {
      const [post] = await tx.select().from(socialPost).where(eq(socialPost.id, id)).for("update");
      if (!post) throw new BusinessError("not_found", "not found", 404);
      const targets = await tx.select().from(socialPostTarget).where(eq(socialPostTarget.postId, id));
      // Rule 15: a post that has gone out, or is going out now, is never deleted.
      if (!["draft", "scheduled", "missed", "failed"].includes(post.status) || targets.some((t) => GONE_OUT.includes(t.status))) {
        throw new BusinessError("conflict", "This post has gone out, so it is kept for the record.", 409);
      }
      await tx.delete(socialPost).where(eq(socialPost.id, id));
      return { status: post.status, kind: post.kind, caption: post.caption, targets: auditTargets(post, targets) };
    });
    await writeAudit(db, c, { action: "social.post_delete", entityType: "social_post", entityId: id, before, notify: true });
    return c.json({ ok: true });
  });

  r.post("/posts/:id/approve", async (c) => {
    const id = postIdOf(c);
    const body = ApproveBody.parse(await c.req.json().catch(() => ({})));
    const auth = c.get("auth");
    const now = new Date();

    const audit = await db.transaction(async (tx) => {
      const [post] = await tx.select().from(socialPost).where(eq(socialPost.id, id)).for("update");
      if (!post) throw new BusinessError("not_found", "not found", 404);
      const targets = await tx.select().from(socialPostTarget).where(eq(socialPostTarget.postId, id));
      const nothingOut = !targets.some((t) => GONE_OUT.includes(t.status));
      if (!["draft", "missed", "failed"].includes(post.status) || !nothingOut || targets.length === 0) {
        throw new BusinessError("conflict", "This post is not waiting to be approved", 409);
      }

      const accounts = await accountsById(tx, targets.flatMap((t) => (t.accountId ? [t.accountId] : [])));
      const problems = targets.flatMap((t) =>
        targetProblems(post, t, t.accountId ? accounts.get(t.accountId) : undefined)
          .filter((p) => p.blocking)
          .map((p) => ({ ...p, target_id: t.id, network: t.network })),
      );
      if (problems.length > 0) throw new BusinessError("validation_failed", problems[0]!.message, 422, { problems });

      let scheduledAt: Date | null = null;
      if (body.when === "schedule") {
        // Foundation correction C6: scheduled publishing sits behind the owner switch, off by default.
        if (!(await schedulingEnabled(tx))) {
          throw new BusinessError("conflict", "Scheduling is switched off. Ask the owner to turn it on in Posts settings.", 409, {
            reason: "scheduling_off",
          });
        }
        if (!body.scheduled_at) throw new BusinessError("validation_failed", "Pick a day and time.", 400);
        scheduledAt = new Date(body.scheduled_at);
        const when = validateSchedule(scheduledAt, now);
        if (when.length > 0) throw new BusinessError("validation_failed", when[0]!.message, 422, { problems: when });
      } else if (!metaConfigFromEnv()) {
        throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
      }

      // Rule 2: the person confirmed the post this hash describes, and nothing else.
      if (postFingerprint(post, targets) !== body.content_hash) {
        throw new BusinessError("conflict", CHANGED, 409, { reason: "changed" });
      }
      // The time is part of what was approved: the worker checks this hash again before it sends.
      const hash = postFingerprint({ ...post, scheduledAt }, targets);

      // Rule 17: a second click finds no row.
      const moved = await tx
        .update(socialPost)
        .set({
          status: scheduledAt ? "scheduled" : "publishing",
          scheduledAt,
          statusNote: null,
          approvedBy: auth.userId,
          approvedAt: now,
          approvedHash: hash,
          updatedAt: now,
        })
        .where(and(eq(socialPost.id, id), inArray(socialPost.status, ["draft", "missed", "failed"])))
        .returning({ id: socialPost.id });
      if (moved.length === 0) throw new BusinessError("conflict", "This post is not waiting to be approved", 409);
      await tx
        .update(socialPostTarget)
        .set(freshTarget(now))
        .where(and(eq(socialPostTarget.postId, id), notInArray(socialPostTarget.status, ["published", "removed"])));
      return { hash, when: body.when, scheduled_at: scheduledAt?.toISOString() ?? null, targets: auditTargets(post, targets) };
    });

    await writeAudit(db, c, { action: "social.post_approve", entityType: "social_post", entityId: id, after: audit, notify: true });
    return c.json({ data: await onePost(db, id) });
  });

  r.post("/posts/:id/cancel", async (c) => {
    const id = postIdOf(c);
    const now = new Date();
    const rows = await db
      .update(socialPost)
      .set({ status: "draft", scheduledAt: null, approvedBy: null, approvedAt: null, approvedHash: null, updatedAt: now })
      .where(and(eq(socialPost.id, id), eq(socialPost.status, "scheduled")))
      .returning({ id: socialPost.id });
    if (rows.length === 0) {
      const [exists] = await db.select({ id: socialPost.id }).from(socialPost).where(eq(socialPost.id, id));
      if (!exists) throw new BusinessError("not_found", "not found", 404);
      throw new BusinessError("conflict", "Too late: this post has already started going out.", 409);
    }
    await writeAudit(db, c, { action: "social.post_cancel", entityType: "social_post", entityId: id, after: { status: "draft" }, notify: false });
    return c.json({ data: await onePost(db, id) });
  });

  r.post("/posts/:id/targets/:tid/retry", async (c) => {
    const body = HashBody.parse(await c.req.json().catch(() => ({})));
    const { target } = await loadTarget(db, c);
    if (!metaConfigFromEnv()) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
    const now = new Date();
    await db.transaction(async (tx) => {
      const [post] = await tx.select().from(socialPost).where(eq(socialPost.id, target.postId)).for("update");
      if (!post) throw new BusinessError("not_found", "not found", 404);
      const targets = await tx.select().from(socialPostTarget).where(eq(socialPostTarget.postId, post.id));
      const mine = targets.find((t) => t.id === target.id);
      const live = ["publishing", "failed", "partly_published", "needs_check"].includes(post.status);
      if (!mine || mine.status !== "failed" || !live) {
        throw new BusinessError("conflict", "Only a post that did not go out can be tried again.", 409);
      }
      // The content is unchanged since a person approved it.
      if (!post.approvedHash || body.content_hash !== post.approvedHash || postFingerprint(post, targets) !== post.approvedHash) {
        throw new BusinessError("conflict", CHANGED, 409, { reason: "changed" });
      }
      const moved = await tx
        .update(socialPostTarget)
        .set(freshTarget(now))
        .where(and(eq(socialPostTarget.id, target.id), eq(socialPostTarget.status, "failed")))
        .returning({ id: socialPostTarget.id });
      if (moved.length === 0) throw new BusinessError("conflict", SETTLED, 409);
      await tx.update(socialPost).set({ status: "publishing", statusNote: null, updatedAt: now }).where(eq(socialPost.id, post.id));
    });
    await writeAudit(db, c, {
      action: "social.post_retry",
      entityType: "social_post",
      entityId: target.postId,
      after: { target_id: target.id, network: target.network, account_id: target.accountId },
      notify: false,
    });
    return c.json({ data: await onePost(db, target.postId) });
  });

  r.post("/posts/:id/targets/:tid/check", async (c) => {
    const { target } = await loadTarget(db, c);
    if (target.status !== "unknown") throw new BusinessError("conflict", SETTLED, 409);
    await reconcileTarget(db, needConfig(), target.id);
    return c.json({ data: await onePost(db, target.postId) });
  });

  r.post("/posts/:id/targets/:tid/resolve", async (c) => {
    const body = ResolveBody.parse(await c.req.json().catch(() => ({})));
    const { target } = await loadTarget(db, c);
    if (target.status !== "unknown") throw new BusinessError("conflict", SETTLED, 409);
    const now = new Date();
    if (body.outcome === "not_posted") {
      // This is the one way a person can cause a second attempt: it needs the explicit confirm.
      if (body.confirm !== true) {
        throw new BusinessError("validation_failed", "Confirm that you have looked and the post is not there.", 400);
      }
      if (!metaConfigFromEnv()) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
    }
    await db.transaction(async (tx) => {
      const set =
        body.outcome === "posted"
          ? { status: "published", step: "done", externalId: null, externalKind: null, publishedAt: now, errorCode: null, errorSubcode: null, errorMessage: null, updatedAt: now }
          : freshTarget(now);
      const moved = await tx
        .update(socialPostTarget)
        .set(set)
        .where(and(eq(socialPostTarget.id, target.id), eq(socialPostTarget.status, "unknown")))
        .returning({ id: socialPostTarget.id });
      if (moved.length === 0) throw new BusinessError("conflict", SETTLED, 409);
      if (body.outcome === "posted") {
        await tx.update(socialPost).set({ statusNote: MARKED_POSTED_NOTE, updatedAt: now }).where(eq(socialPost.id, target.postId));
      }
      await recomputePostStatus(tx, target.postId, now);
    });
    await writeAudit(db, c, {
      action: "social.post_resolve",
      entityType: "social_post",
      entityId: target.postId,
      before: { target_id: target.id, status: "unknown" },
      after: { target_id: target.id, network: target.network, account_id: target.accountId, outcome: body.outcome },
      notify: true,
    });
    return c.json({ data: await onePost(db, target.postId) });
  });

  r.patch("/posts/:id/targets/:tid/published", async (c) => {
    const body = EditPublishedBody.parse(await c.req.json().catch(() => ({})));
    const { post, target, account } = await loadTarget(db, c);
    if (target.network !== "facebook") {
      throw new BusinessError("conflict", "Instagram does not let apps change a caption. Take the post down and post it again.", 409);
    }
    const externalId = target.externalId;
    if (target.status !== "published" || target.externalKind !== "post" || !externalId) {
      throw new BusinessError("conflict", "Only a post that is out on Facebook, and linked to the suite, can have its text changed here.", 409);
    }
    const pageId = account?.externalId;
    if (!account || !account.isActive || !pageId) throw new BusinessError("conflict", ACCOUNT_OFF, 409);
    const cfg = needConfig();
    const beforeText = effectiveCaption(post.caption, target.captionOverride);
    const audit = (result: string, err?: MetaApiError) =>
      writeAudit(db, c, {
        action: "social.published_edit",
        entityType: "social_post",
        entityId: post.id,
        before: { target_id: target.id, text: beforeText },
        after: { target_id: target.id, text: body.message, result, meta_code: err?.code ?? null, meta_message: err?.message ?? null },
        notify: true,
      });

    try {
      await withPageTokenRetry(cfg, pageId, (t) => fbUpdatePostMessage(cfg, t, externalId, body.message));
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      const cls = classifyPublishError(err, err.subcode, "facebook");
      if (err.delivery === "unknown") {
        await audit("unknown", err);
        throw new BusinessError("service_unavailable", "We could not tell whether Facebook saved this. Open the post on Facebook to check.", 504, {
          reason: "unknown",
        });
      }
      await audit("refused", err);
      if (cls.kind === "configuration") {
        await alertOnce(db, "social.publish_config_error", {
          account: account.id,
          account_id: account.id,
          network: "facebook",
          label: account.label,
          code: err.code,
          message: err.message,
        });
      }
      throw new BusinessError("service_unavailable", cls.staffMessage, 502, { reason: "meta_refused", meta_code: err.code });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(socialPostTarget).set({ captionOverride: body.message, updatedAt: now }).where(eq(socialPostTarget.id, target.id));
      // The text a person just sent to Facebook is now part of what was approved, so a later
      // "Try again" on the other network still matches (see "Built differently" in the spec).
      const [fresh] = await tx.select().from(socialPost).where(eq(socialPost.id, post.id)).for("update");
      const targets = await tx.select().from(socialPostTarget).where(eq(socialPostTarget.postId, post.id));
      if (fresh) {
        await tx
          .update(socialPost)
          .set({ ...(fresh.approvedHash ? { approvedHash: postFingerprint(fresh, targets) } : {}), updatedAt: now })
          .where(eq(socialPost.id, post.id));
      }
    });
    await audit("saved");
    return c.json({ data: await onePost(db, post.id) });
  });

  r.delete("/posts/:id/targets/:tid/published", async (c) => {
    const body = TakeDownBody.parse(await c.req.json().catch(() => ({})));
    const { post, target, account } = await loadTarget(db, c);
    const network = target.network as SocialNetwork;
    const name = networkName(network);
    if (target.status !== "published") throw new BusinessError("conflict", "This post is not out, so there is nothing to take down.", 409);
    const manual = body.manual === true;

    if (!manual) {
      const externalId = target.externalId;
      const pageId = network === "facebook" ? account?.externalId : account?.pageId;
      if (!externalId || !account || !pageId) {
        throw new BusinessError(
          "conflict",
          `The suite cannot take this down because it is not linked to the post. Remove it ${network === "facebook" ? "on the Page itself" : "in the Instagram app"}, then press 'I removed it myself'.`,
          409,
          { reason: "manual_needed" },
        );
      }
      const cfg = needConfig();
      try {
        await withPageTokenRetry(cfg, pageId, (t) => (network === "facebook" ? fbDeleteObject(cfg, t, externalId) : igDeleteMedia(cfg, t, externalId)));
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        if (err.delivery === "unknown") {
          throw new BusinessError("service_unavailable", `We could not tell whether ${name} took this down. Look at the post, then try again.`, 504, {
            reason: "unknown",
          });
        }
        if (err.code && TAKE_DOWN_REFUSED.has(err.code)) {
          throw new BusinessError(
            "conflict",
            network === "facebook"
              ? "Facebook did not let the suite take this down. Delete it on the Page itself, then press 'I removed it myself'."
              : "Instagram did not let the suite take this down. Delete it in the Instagram app, then press 'I removed it myself'.",
            409,
            { reason: "manual_needed", meta_code: err.code },
          );
        }
        const cls = classifyPublishError(err, err.subcode, network);
        if (err.code === "190") {
          await alertOnce(db, "social.publish_config_error", {
            account: account.id,
            account_id: account.id,
            network,
            label: account.label,
            code: err.code,
            message: err.message,
          });
        }
        throw new BusinessError("service_unavailable", cls.staffMessage, 502, { reason: "meta_refused", meta_code: err.code });
      }
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(socialPostTarget)
        .set({ status: "removed", removedAt: now, removedBy: c.get("auth").userId, updatedAt: now })
        .where(and(eq(socialPostTarget.id, target.id), eq(socialPostTarget.status, "published")))
        .returning({ id: socialPostTarget.id });
      if (moved.length === 0) throw new BusinessError("conflict", SETTLED, 409);
      await recomputePostStatus(tx, post.id, now);
    });
    await writeAudit(db, c, {
      action: "social.published_delete",
      entityType: "social_post",
      entityId: post.id,
      before: { target_id: target.id, status: "published", external_id: target.externalId },
      after: { target_id: target.id, network, account_id: target.accountId, status: "removed", manual },
      notify: true,
    });
    return c.json({ data: await onePost(db, post.id) });
  });

  r.get("/settings", async (c) => c.json({ data: { scheduled_enabled: await schedulingEnabled(db) } }));

  r.put("/settings", async (c) => {
    const auth = c.get("auth");
    // Foundation correction C6: only the owner turns unattended publishing on or off.
    if (auth.role !== "owner") throw new BusinessError("forbidden", "Only the owner can change this", 403);
    const body = SettingsBody.parse(await c.req.json().catch(() => ({})));
    const before = { scheduled_enabled: await schedulingEnabled(db) };
    const value: SocialPublishingValue = { scheduled_enabled: body.scheduled_enabled };
    const now = new Date();
    await db
      .insert(appSetting)
      .values({ key: SOCIAL_PUBLISHING_KEY, value, updatedBy: auth.userId, updatedAt: now })
      .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedBy: auth.userId, updatedAt: now } });
    await writeAudit(db, c, {
      action: "social.settings_update",
      entityType: "app_settings",
      entityId: SOCIAL_PUBLISHING_KEY,
      before,
      after: value,
      notify: true,
    });
    return c.json({ data: value });
  });

  return r;
}
