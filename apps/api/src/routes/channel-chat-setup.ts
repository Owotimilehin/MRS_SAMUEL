/**
 * Chat set-up for Messenger and Instagram (suite spec 04, section 5.4): the draft,
 * what is live at Meta, publishing, history. Mounted at
 * /v1/channels/:accountId/chat-setup, before the /v1/channels router.
 *
 * Every route needs channels.manage. Nothing is pushed to Meta except by
 * POST /publish, which needs `confirm: true` and writes an audit row (foundation
 * rule 7). No token is ever read, logged, stored or returned here (R15): the Page
 * token stays inside @ms/domain.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { adminUser, channelChatSetup, inboxPhoneNumber, type DbClient } from "@ms/db";
import {
  ChatSetupError,
  MetaApiError,
  describeChatSetupMetaError,
  liveMatches,
  metaConfigFromEnv,
  nextPublishAllowedAt,
  profileToConfig,
  publishChatSetup,
  readMessengerProfile,
  repairStuckPublish,
  type ChannelAccount,
  type ChatSetupRow,
  type LiveProfile,
  type MetaConfig,
} from "@ms/domain";
import {
  CHAT_SETUP_LIMITS,
  EMPTY_CHAT_SETUP,
  normaliseChatSetup,
  validateChatSetup,
  type ChatSetupConfig,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";

const Uuid = z.string().uuid();
const CACHE_TTL_MS = 5 * 60_000;
const REFRESH_MIN_AGE_MS = 3 * 60_000;

const NOT_CONNECTED = "Meta is not connected on this server.";
const SWITCHED_OFF = "This account is switched off in Channels.";
const NO_LIVE_READ = "We could not read the live set-up from Meta. Try again in a few minutes.";

// ── The live read cache (5 minutes), per Page and kind ───────────────────────

interface CachedLive {
  at: number;
  live: LiveProfile;
}
const liveCache = new Map<string, CachedLive>();
const cacheKey = (a: ChannelAccount) => `${a.pageId ?? ""}:${a.kind}`;

/** Forget every cached read (tests; a restart does the same). */
export function clearChatSetupCache(): void {
  liveCache.clear();
}

type LiveRead = { ok: true; live: LiveProfile; at: number } | { ok: false; error: string };

// ── Shapes ───────────────────────────────────────────────────────────────────

const MenuItemBody = z.object({
  type: z.enum(["postback", "web_url"]),
  title: z.string().max(500),
  url: z.string().max(2000).optional(),
});
const ConfigBody = z.object({
  greeting: z.string().max(5000).nullable(),
  getStarted: z.boolean(),
  iceBreakers: z.array(z.string().max(1000)).max(50),
  menu: z.array(MenuItemBody).max(50),
});
const DraftBody = z.object({ config: ConfigBody });
const PublishBody = z.object({ version: z.number().int().positive(), confirm: z.literal(true) });

type SetupStatus = "pushing" | "live" | "failed" | "unknown" | "superseded";

export interface ChatSetupView {
  account: { id: string; label: string; kind: "messenger" | "instagram"; is_active: boolean };
  supports: { greeting: boolean; getStarted: boolean; iceBreakers: true; menu: true };
  limits: typeof CHAT_SETUP_LIMITS;
  draft: { version: number; config: ChatSetupConfig; updated_at: string; updated_by_name: string | null } | null;
  live: {
    config: ChatSetupConfig;
    other_locales: string[];
    foreign_payloads: boolean;
    composer_disabled: boolean;
    read_at: string;
  } | null;
  live_error: string | null;
  draft_differs_from_live: boolean;
  last_publish: {
    version: number;
    status: SetupStatus;
    by_name: string | null;
    at: string;
    error_message: string | null;
    error_code: string | null;
  } | null;
  can_publish_at: string | null;
}

function lagosClock(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" }).format(d);
}

function asConfig(raw: unknown, kind: "messenger" | "instagram"): ChatSetupConfig {
  const c = raw as Partial<ChatSetupConfig> | null;
  return normaliseChatSetup({ ...EMPTY_CHAT_SETUP, ...(c ?? {}) }, kind);
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadAccount(db: DbClient, c: Context): Promise<ChannelAccount> {
  const id = Uuid.safeParse(c.req.param("accountId"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  const [r] = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      externalId: inboxPhoneNumber.externalId,
      pageId: inboxPhoneNumber.pageExternalId,
      isActive: inboxPhoneNumber.isActive,
    })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, id.data));
  if (!r || (r.kind !== "messenger" && r.kind !== "instagram")) throw new BusinessError("not_found", "not found", 404);
  return { ...r, kind: r.kind };
}

function needActive(account: ChannelAccount): void {
  if (!account.isActive) throw new BusinessError("conflict", SWITCHED_OFF, 409);
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_CONNECTED, 503);
  return cfg;
}

/** A live read through the cache; `force` skips it. Meta trouble becomes a plain sentence, not an exception. */
async function readLive(account: ChannelAccount, opts: { force?: boolean } = {}): Promise<LiveRead & { fresh: boolean }> {
  const key = cacheKey(account);
  const hit = liveCache.get(key);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, live: hit.live, at: hit.at, fresh: false };
  const cfg = metaConfigFromEnv();
  if (!cfg) return { ok: false, error: NOT_CONNECTED, fresh: false };
  try {
    const live = await readMessengerProfile(cfg, account);
    const at = Date.now();
    liveCache.set(key, { at, live });
    return { ok: true, live, at, fresh: true };
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
    return { ok: false, error: describeChatSetupMetaError(err, account.label).text, fresh: false };
  }
}

/**
 * R9: when a fresh live read shows the latest failed or unknown version is in fact
 * what Meta now shows, mark it live (and the previous live one superseded).
 */
async function settleLatest(db: DbClient, account: ChannelAccount, live: LiveProfile): Promise<void> {
  const [latest] = await db
    .select()
    .from(channelChatSetup)
    .where(and(eq(channelChatSetup.accountId, account.id), ne(channelChatSetup.status, "draft")))
    .orderBy(sql`${channelChatSetup.pushedAt} desc nulls last`, desc(channelChatSetup.version))
    .limit(1);
  if (!latest || !["failed", "unknown"].includes(latest.status)) return;
  const config = asConfig(latest.config, account.kind as "messenger" | "instagram");
  if (!liveMatches(config, live, account.kind as "messenger" | "instagram")) return;
  await db.transaction(async (tx) => {
    await tx
      .update(channelChatSetup)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(channelChatSetup.accountId, account.id), eq(channelChatSetup.status, "live"), ne(channelChatSetup.id, latest.id)));
    await tx
      .update(channelChatSetup)
      .set({ status: "live", errorCode: null, errorMessage: null, liveAfter: live, updatedAt: new Date() })
      .where(and(eq(channelChatSetup.id, latest.id), inArray(channelChatSetup.status, ["failed", "unknown"])));
  });
}

async function buildView(db: DbClient, account: ChannelAccount, read: LiveRead): Promise<ChatSetupView> {
  const kind = account.kind as "messenger" | "instagram";
  const messenger = kind === "messenger";

  const [draft] = await db
    .select({ row: channelChatSetup, by: adminUser.name })
    .from(channelChatSetup)
    .leftJoin(adminUser, eq(adminUser.id, channelChatSetup.createdByUserId))
    .where(and(eq(channelChatSetup.accountId, account.id), eq(channelChatSetup.status, "draft")))
    .limit(1);

  const [last] = await db
    .select({ row: channelChatSetup, by: adminUser.name })
    .from(channelChatSetup)
    .leftJoin(adminUser, eq(adminUser.id, channelChatSetup.pushedByUserId))
    .where(and(eq(channelChatSetup.accountId, account.id), ne(channelChatSetup.status, "draft")))
    .orderBy(sql`${channelChatSetup.pushedAt} desc nulls last`, desc(channelChatSetup.version))
    .limit(1);

  let live: ChatSetupView["live"] = null;
  let differs = false;
  if (read.ok) {
    const p = profileToConfig(read.live, kind);
    live = {
      config: p.config,
      other_locales: p.otherLocales,
      foreign_payloads: p.foreignPayloads,
      composer_disabled: p.composerDisabled,
      read_at: new Date(read.at).toISOString(),
    };
    if (draft) differs = !liveMatches(asConfig(draft.row.config, kind), read.live, kind);
  }

  const allowedAt = account.pageId ? await nextPublishAllowedAt(db, account.pageId) : null;

  return {
    account: { id: account.id, label: account.label, kind, is_active: account.isActive },
    supports: { greeting: messenger, getStarted: messenger, iceBreakers: true, menu: true },
    limits: CHAT_SETUP_LIMITS,
    draft: draft
      ? {
          version: draft.row.version,
          config: asConfig(draft.row.config, kind),
          updated_at: draft.row.updatedAt.toISOString(),
          updated_by_name: draft.by ?? null,
        }
      : null,
    live,
    live_error: read.ok ? null : read.error,
    draft_differs_from_live: differs,
    last_publish: last
      ? {
          version: last.row.version,
          status: last.row.status as SetupStatus,
          by_name: last.by ?? null,
          at: (last.row.pushedAt ?? last.row.updatedAt).toISOString(),
          error_message: last.row.errorMessage,
          error_code: last.row.errorCode,
        }
      : null,
    can_publish_at: allowedAt ? allowedAt.toISOString() : null,
  };
}

/** Replace the account's draft with `config`, or create one with the next version number. */
async function saveDraft(
  db: DbClient,
  account: ChannelAccount,
  config: ChatSetupConfig,
  userId: string,
): Promise<{ before: ChatSetupConfig | null; row: ChatSetupRow }> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(channelChatSetup)
        .where(and(eq(channelChatSetup.accountId, account.id), eq(channelChatSetup.status, "draft")))
        .for("update");
      if (existing) {
        const [row] = await tx
          .update(channelChatSetup)
          .set({ config, createdByUserId: userId, updatedAt: new Date() })
          .where(eq(channelChatSetup.id, existing.id))
          .returning();
        return { before: asConfig(existing.config, account.kind as "messenger" | "instagram"), row: row! };
      }
      const [{ max } = { max: 0 }] = await tx
        .select({ max: sql<number>`coalesce(max(${channelChatSetup.version}), 0)::int` })
        .from(channelChatSetup)
        .where(eq(channelChatSetup.accountId, account.id));
      const [row] = await tx
        .insert(channelChatSetup)
        .values({ accountId: account.id, version: max + 1, status: "draft", config, createdByUserId: userId })
        .returning();
      return { before: null, row: row! };
    });
  } catch (err) {
    // Two people creating the first draft at the same moment: the second one loses the race.
    if (pgErrorCode(err) === "23505") {
      throw new BusinessError("conflict", "Someone else just saved a draft. Reload the page and try again.", 409);
    }
    throw err;
  }
}

function userIdOf(c: Context): string {
  return (c.get("auth") as { userId: string }).userId;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function channelChatSetupRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("channels.manage"));

  /** The page in one answer: draft, what is live, last publish. Always 200 once the account is valid. */
  r.get("/", async (c) => {
    const account = await loadAccount(db, c);
    await repairStuckPublish(db, account.id);
    const read = await readLive(account);
    if (read.ok && read.fresh) await settleLatest(db, account, read.live);
    return c.json({ data: await buildView(db, account, read) });
  });

  r.put("/draft", async (c) => {
    const account = await loadAccount(db, c);
    needActive(account);
    const body = DraftBody.parse(await c.req.json());
    const kind = account.kind as "messenger" | "instagram";
    const config = normaliseChatSetup(body.config as ChatSetupConfig, kind);
    const problems = validateChatSetup(config, kind);
    if (problems.length > 0) {
      throw new BusinessError("validation_failed", problems[0]!.message, 400, { field: problems[0]!.field, problems });
    }
    const saved = await saveDraft(db, account, config, userIdOf(c));
    await writeAudit(db, c, {
      action: "channels.chat_setup_draft",
      entityType: "channel_chat_setup",
      entityId: saved.row.id,
      before: saved.before,
      after: config,
      notify: false,
    });
    return c.json({ data: await buildView(db, account, await readLive(account)) });
  });

  r.post("/draft/from-live", async (c) => {
    const account = await loadAccount(db, c);
    needActive(account);
    const read = await readLive(account);
    if (!read.ok) throw new BusinessError("conflict", NO_LIVE_READ, 409);
    const kind = account.kind as "messenger" | "instagram";
    const config = normaliseChatSetup(profileToConfig(read.live, kind).config, kind);
    const saved = await saveDraft(db, account, config, userIdOf(c));
    await writeAudit(db, c, {
      action: "channels.chat_setup_draft",
      entityType: "channel_chat_setup",
      entityId: saved.row.id,
      before: saved.before,
      after: config,
      notify: false,
    });
    return c.json({ data: await buildView(db, account, read) });
  });

  r.delete("/draft", async (c) => {
    const account = await loadAccount(db, c);
    needActive(account);
    const [gone] = await db
      .delete(channelChatSetup)
      .where(and(eq(channelChatSetup.accountId, account.id), eq(channelChatSetup.status, "draft")))
      .returning();
    if (gone) {
      await writeAudit(db, c, {
        action: "channels.chat_setup_draft",
        entityType: "channel_chat_setup",
        entityId: gone.id,
        before: asConfig(gone.config, account.kind as "messenger" | "instagram"),
        after: null,
        notify: false,
      });
    }
    return c.json({ data: await buildView(db, account, await readLive(account)) });
  });

  r.post("/publish", async (c) => {
    const account = await loadAccount(db, c);
    needActive(account);
    const body = PublishBody.parse(await c.req.json().catch(() => ({})));
    const cfg = needConfig();
    const kind = account.kind as "messenger" | "instagram";

    let row: ChatSetupRow;
    try {
      row = await publishChatSetup(db, cfg, { accountId: account.id, version: body.version, userId: userIdOf(c) });
    } catch (err) {
      if (err instanceof ChatSetupError) {
        if (err.code === "not_found") throw new BusinessError("not_found", err.message, 404);
        if (err.code === "too_soon") {
          const at = err.retryAt ? ` You can publish again at ${lagosClock(err.retryAt)}.` : "";
          throw new BusinessError(
            "rate_limited",
            `Meta allows only a few set-up changes every 10 minutes.${at}`,
            429,
            err.retryAt ? { can_publish_at: err.retryAt.toISOString() } : undefined,
          );
        }
        throw new BusinessError("conflict", err.message, 409, { reason: err.code });
      }
      throw err;
    }

    // The read-back is the freshest picture of Meta there is: keep it for the next screen.
    const after = row.liveAfter as LiveProfile | null;
    if (after) liveCache.set(cacheKey(account), { at: Date.now(), live: after });
    else liveCache.delete(cacheKey(account));

    const before = row.liveBefore ? profileToConfig(row.liveBefore as LiveProfile, kind).config : null;
    await writeAudit(db, c, {
      action: "channels.chat_setup_publish",
      entityType: "channel_chat_setup",
      entityId: row.id,
      before,
      after: { config: row.config, status: row.status, error_code: row.errorCode },
      notify: true,
    });

    const read: LiveRead = after
      ? { ok: true, live: after, at: Date.now() }
      : { ok: false, error: row.errorMessage ?? NO_LIVE_READ };
    const view = await buildView(db, account, read);
    return c.json({ data: view }, row.status === "live" ? 200 : 502);
  });

  r.post("/refresh", async (c) => {
    const account = await loadAccount(db, c);
    needConfig();
    const hit = liveCache.get(cacheKey(account));
    const recentlyRead = hit !== undefined && Date.now() - hit.at < REFRESH_MIN_AGE_MS;
    const publishesInWindow = account.pageId ? (await nextPublishAllowedAt(db, account.pageId)) !== null : false;
    if (recentlyRead || publishesInWindow) {
      throw new BusinessError("rate_limited", "Checked a moment ago. Try again in a few minutes.", 429);
    }
    await repairStuckPublish(db, account.id);
    const read = await readLive(account, { force: true });
    if (read.ok) await settleLatest(db, account, read.live);
    return c.json({ data: await buildView(db, account, read) });
  });

  r.get("/history", async (c) => {
    const account = await loadAccount(db, c);
    const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") ?? "20", 10) || 20));
    const rows = await db
      .select({ row: channelChatSetup, by: adminUser.name })
      .from(channelChatSetup)
      .leftJoin(adminUser, eq(adminUser.id, channelChatSetup.pushedByUserId))
      .where(and(eq(channelChatSetup.accountId, account.id), ne(channelChatSetup.status, "draft")))
      .orderBy(sql`${channelChatSetup.pushedAt} desc nulls last`, desc(channelChatSetup.version))
      .limit(limit);
    const kind = account.kind as "messenger" | "instagram";
    return c.json({
      data: rows.map(({ row, by }) => ({
        version: row.version,
        status: row.status,
        config: asConfig(row.config, kind),
        by_name: by ?? null,
        at: (row.pushedAt ?? row.updatedAt).toISOString(),
        error_message: row.errorMessage,
      })),
    });
  });

  r.post("/history/:version/restore", async (c) => {
    const account = await loadAccount(db, c);
    needActive(account);
    const version = Number.parseInt(c.req.param("version"), 10);
    if (!Number.isInteger(version) || version < 1) throw new BusinessError("not_found", "not found", 404);
    const [old] = await db
      .select()
      .from(channelChatSetup)
      .where(
        and(
          eq(channelChatSetup.accountId, account.id),
          eq(channelChatSetup.version, version),
          ne(channelChatSetup.status, "draft"),
        ),
      );
    if (!old) throw new BusinessError("not_found", "not found", 404);
    const kind = account.kind as "messenger" | "instagram";
    const config = asConfig(old.config, kind);
    const saved = await saveDraft(db, account, config, userIdOf(c));
    await writeAudit(db, c, {
      action: "channels.chat_setup_draft",
      entityType: "channel_chat_setup",
      entityId: saved.row.id,
      before: saved.before,
      after: config,
      notify: false,
    });
    return c.json({ data: await buildView(db, account, await readLive(account)) });
  });

  return r;
}
