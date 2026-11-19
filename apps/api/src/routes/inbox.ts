import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  adminUser,
  customer,
  inboxCall,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxNote,
  inboxNotifyPref,
  inboxPhoneNumber,
  inboxPushToken,
  inboxQuickReply,
  inboxRecording,
  inboxTeam,
  inboxTeamMember,
  inboxTemplate,
  inboxWebhookEvent,
  waFlow,
  waFlowResponse,
  type DbClient,
  type FlowResponseAction,
} from "@ms/db";
import {
  InboxSendError,
  canSeeConversation,
  canUseNumber,
  conversationScope,
  flowJson,
  SLOT_OVERBOOKED_TEXT,
  flowResponseCard,
  loadFlowPrivateKey,
  makeFlowToken,
  slotOverbooked,
  syncTemplatesForWaba,
  markRead,
  metaConfigFromEnv,
  publishInboxEvent,
  sendFromConversation,
  sendSenderAction,
  signalFor,
  templateParamCount,
  type InboxViewer,
  type OutboundContent,
} from "@ms/domain";
import {
  IDENTITY_CHANNELS,
  FLOW_MESSAGE_LIMITS,
  WA_FLOWS,
  describeChatSetupPayload,
  flowAddressLine,
  flowDef,
  humanAgentRemainingMs,
  resolveCapabilities,
  templateNeeds,
  waWindowOpen,
  waWindowRemainingMs,
  type AdminRole,
  type Capability,
  type IdentityChannel,
  type PermissionOverrides,
} from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { INBOX_UPLOAD_TYPES, deleteInboxObjects, presignInboxGet, presignInboxPut } from "../lib/r2.js";
import { toCsv } from "../lib/csv.js";
import { reloadViewer, subscribe } from "../inbox/realtime.js";
import { logger } from "../logger.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { alias } from "drizzle-orm/pg-core";
import crypto from "node:crypto";
import { env } from "../env.js";

declare module "hono" {
  interface ContextVariableMap {
    inboxViewer: InboxViewer;
  }
}

// ── Viewer (permissions loaded fresh, cached ≤30s) ───────────────────────────

const viewerCache = new Map<string, { at: number; viewer: InboxViewer | null }>();
const VIEWER_TTL_MS = 30_000;

async function cachedViewer(db: DbClient, userId: string): Promise<InboxViewer | null> {
  const hit = viewerCache.get(userId);
  if (hit && Date.now() - hit.at < VIEWER_TTL_MS) return hit.viewer;
  const viewer = await reloadViewer(db, userId);
  viewerCache.set(userId, { at: Date.now(), viewer });
  return viewer;
}

/** Tests and admin changes can drop the cache so changes apply at once. */
export function clearInboxViewerCache(userId?: string): void {
  if (userId) viewerCache.delete(userId);
  else viewerCache.clear();
}

export function withViewer(db: DbClient): MiddlewareHandler {
  return async (c, next) => {
    const viewer = await cachedViewer(db, c.get("auth").userId);
    if (!viewer) throw new BusinessError("forbidden", "no inbox access", 403);
    c.set("inboxViewer", viewer);
    await next();
  };
}

export function need(c: Context, cap: Capability): void {
  if (!c.get("inboxViewer").capabilities.includes(cap)) {
    throw new BusinessError("forbidden", `missing capability: ${cap}`, 403);
  }
}

/** Load a conversation the viewer may see — 404 (not 403) otherwise, so its existence isn't revealed. */
export async function visibleConversation(db: DbClient, c: Context, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "conversation not found", 404);
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, id));
  if (!conv || !canSeeConversation(c.get("inboxViewer"), conv)) {
    throw new BusinessError("not_found", "conversation not found", 404);
  }
  return conv;
}

async function audit(db: DbClient, c: Context, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) {
  await writeAudit(db, c, { action, entityType, entityId, after, before, notify: false });
}

const assignee = alias(adminUser, "assignee");

/** Escape a user's text for an ILIKE pattern and wrap it in %…%. */
function likeTerm(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

/** The contact has an identity (Messenger name, Instagram username, …) matching the search. */
function identityMatches(text: string): SQL {
  const term = likeTerm(text.replace(/^@/, ""));
  return sql`exists (select 1 from ${inboxIdentity} i where i.customer_id = ${customer.id} and (i.username ilike ${term} or i.display_name ilike ${term}))`;
}

/** Up to three handles for a contact ("@username", else the display name), newest first. */
const customerHandles = sql<string[]>`array(
  select coalesce('@' || i.username, i.display_name) from ${inboxIdentity} i
  where i.customer_id = ${customer.id} and coalesce(i.username, i.display_name) is not null
  order by i.last_seen_at desc nulls last, i.created_at desc limit 3)`;

export interface IdentityRow {
  id: string;
  channel: IdentityChannel;
  account_label: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  profile_pic_url: string | null;
  last_seen_at: Date | null;
}

/**
 * Every way a customer has reached us. WhatsApp identities are always shown; a
 * Messenger or Instagram identity only to staff who may use that line (rule R20).
 */
async function identitiesFor(db: DbClient, v: InboxViewer, customerId: string): Promise<IdentityRow[]> {
  const rows = await db
    .select({ ident: inboxIdentity, lineId: inboxPhoneNumber.id, lineLabel: inboxPhoneNumber.label })
    .from(inboxIdentity)
    .leftJoin(
      inboxPhoneNumber,
      and(eq(inboxPhoneNumber.kind, inboxIdentity.channel), eq(inboxPhoneNumber.externalId, inboxIdentity.accountExternalId)),
    )
    .where(eq(inboxIdentity.customerId, customerId))
    .orderBy(sql`${inboxIdentity.lastSeenAt} desc nulls last`, asc(inboxIdentity.createdAt));
  const out: IdentityRow[] = [];
  for (const { ident, lineId, lineLabel } of rows) {
    const channel = ident.channel as IdentityChannel;
    if (channel !== "whatsapp") {
      if (lineId ? !canUseNumber(v, lineId) : v.numberIds !== "all") continue;
    }
    out.push({
      id: ident.id,
      channel,
      account_label: channel === "whatsapp" ? "WhatsApp" : (lineLabel ?? ""),
      display_name: ident.displayName,
      username: ident.username,
      phone: channel === "whatsapp" && /^\d+$/.test(ident.externalId) ? `+${ident.externalId}` : null,
      profile_pic_url: ident.profilePicUrl,
      last_seen_at: ident.lastSeenAt,
    });
  }
  return out;
}

/**
 * Rule R10: what a person must type to erase a contact. The phone if there is
 * one; else one of the usernames; else the name; else the word DELETE.
 */
function eraseConfirmMatches(
  confirm: string,
  cust: { phone: string | null; name: string | null },
  usernames: string[],
): boolean {
  const digits = (v: string | null) => (v ?? "").replace(/\D/g, "").replace(/^(234|0)/, "");
  if (digits(cust.phone)) return digits(confirm) === digits(cust.phone);
  const typed = confirm.trim();
  const named = usernames.filter((u) => u.trim());
  if (named.length) {
    const t = typed.replace(/^@/, "").toLowerCase();
    return named.some((u) => u.trim().replace(/^@/, "").toLowerCase() === t);
  }
  if (cust.name?.trim()) return typed.toLowerCase() === cust.name.trim().toLowerCase();
  return typed === "DELETE";
}

// ── Messenger and Instagram helpers (suite spec 02) ──

function isMetaChannel(channel: string): channel is "messenger" | "instagram" {
  return channel === "messenger" || channel === "instagram";
}

/** Last typing_on sent to Meta per conversation (in memory; at most one every 10 s). */
const typingSentAt = new Map<string, number>();
const TYPING_EVERY_MS = 10_000;

/** Where a sender action for this thread goes: the line's Page and the customer's scoped ID. */
async function metaTarget(
  db: DbClient,
  conv: { phoneNumberId: string; identityId: string | null },
): Promise<{ pageId: string; recipient: string } | null> {
  if (!conv.identityId) return null;
  const [row] = await db
    .select({ pageId: inboxPhoneNumber.pageExternalId, recipient: inboxIdentity.externalId })
    .from(inboxPhoneNumber)
    .innerJoin(inboxIdentity, eq(inboxIdentity.id, conv.identityId))
    .where(eq(inboxPhoneNumber.id, conv.phoneNumberId));
  return row?.pageId && row.recipient ? { pageId: row.pageId, recipient: row.recipient } : null;
}

/** Ms left of the 7-day human-agent window: 0 unless META_HUMAN_AGENT_ENABLED and a Messenger/Instagram thread. */
function humanAgentMs(channel: string, lastInbound: Date | null, now = new Date()): number {
  if (process.env.META_HUMAN_AGENT_ENABLED !== "true" || !isMetaChannel(channel)) return 0;
  return humanAgentRemainingMs(lastInbound, now);
}

// ── Upload tokens: an attachment can only be sent by whoever uploaded it ──

function uploadToken(userId: string, key: string): string {
  return crypto.createHmac("sha256", env.JWT_SIGNING_KEY).update(`inbox-upload:${userId}:${key}`).digest("base64url");
}

function verifyUploadToken(userId: string, key: string, token: string): boolean {
  const a = Buffer.from(uploadToken(userId, key));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/** Where POST /uploads puts outgoing files; nothing else may be sent. */
const OUTGOING_KEY = /^inbox\/outgoing\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,6}$/;

const SendBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), body: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.enum(["image", "document", "audio", "video"]),
    media_key: z.string().regex(OUTGOING_KEY, "invalid upload"),
    /** Proof this user got the upload slot (from POST /uploads). */
    media_token: z.string().min(16).max(128),
    mime: z.string().max(200),
    filename: z.string().max(240).optional(),
    caption: z.string().max(1024).optional(),
  }),
  z.object({
    type: z.literal("template"),
    name: z.string().min(1).max(512),
    language: z.string().min(2).max(15),
    params: z.array(z.string().max(1024)).max(20).default([]),
    /** The blank in a text heading, when the template has one. */
    header_param: z.string().trim().min(1).max(60).optional(),
    /** The picture, video or document for the heading, uploaded via POST /uploads. */
    header_media: z
      .object({
        media_key: z.string().regex(OUTGOING_KEY, "invalid upload"),
        media_token: z.string().min(16).max(128),
        mime: z.string().max(200),
        filename: z.string().max(240).optional(),
      })
      .optional(),
    /** The end of the link for each link button that has a blank; index = the button's position from 0. */
    button_params: z
      .array(z.object({ index: z.number().int().min(0).max(9), text: z.string().trim().min(1).max(2000) }))
      .max(10)
      .default([]),
  }),
]);

/** Send a form (suite spec 07, 5.5). `test` sends a draft to try it out; it needs templates.manage as well. */
const FlowSendBody = z
  .object({
    flow_key: z.string().min(1).max(60),
    message: z.string().trim().min(1).max(FLOW_MESSAGE_LIMITS.body).optional(),
    test: z.boolean().optional(),
  })
  .strict();

const FlowActionBody = z.object({ action: z.enum(["handled", "reopen", "save_address", "add_note"]) }).strict();

/** Forms the inbox can send: built-in ones whose JSON is in this build (Phase B only once it has been created). */
function sendableForms(rows: { key: string }[]) {
  return WA_FLOWS.filter((f) => flowJson(f.key) !== null && (f.phase === "A" || rows.some((x) => x.key === f.key)));
}

const PatchBody = z
  .object({
    assignee_id: z.string().uuid().nullable().optional(),
    team_id: z.string().uuid().nullable().optional(),
    status: z.enum(["open", "pending", "closed"]).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .strict();

// ── Routes ───────────────────────────────────────────────────────────────────

export function inboxRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withViewer(db));

  /** Who am I in the inbox: capabilities, teams, numbers I can use. */
  r.get("/me", async (c) => {
    const v = c.get("inboxViewer");
    const numbers = await db
      .select({
        id: inboxPhoneNumber.id,
        label: inboxPhoneNumber.label,
        e164: inboxPhoneNumber.e164,
        channels: inboxPhoneNumber.channels,
        kind: inboxPhoneNumber.kind,
        external_name: inboxPhoneNumber.externalName,
      })
      .from(inboxPhoneNumber)
      .where(
        and(
          eq(inboxPhoneNumber.isActive, true),
          v.numberIds === "all" ? sql`true` : v.numberIds.length ? inArray(inboxPhoneNumber.id, v.numberIds) : sql`false`,
        ),
      )
      .orderBy(asc(inboxPhoneNumber.label));
    return c.json({
      data: {
        user_id: v.userId,
        capabilities: v.capabilities.filter((x) => /^(inbox|calls|recordings|transcripts|channels)\./.test(x)),
        team_ids: v.teamIds,
        numbers,
      },
    });
  });

  // ── Live updates (Server-Sent Events) ──
  r.get("/stream", async (c) => {
    const viewer = c.get("inboxViewer");
    // nginx buffers proxied responses by default, which would hold events back.
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");
    return streamSSE(c, async (stream) => {
      let closed = false;
      let seq = 0;
      const unsubscribe = await subscribe(
        db,
        viewer,
        (event, data) => {
          if (closed) return;
          void stream.writeSSE({ event, data: JSON.stringify(data), id: String(++seq) }).catch(() => undefined);
        },
        () => {
          closed = true;
          void stream.close();
        },
      );
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      // Keep-alive comment every 25s so proxies don't cut the connection.
      while (!closed) {
        await stream.sleep(25_000);
        if (!closed) await stream.write(": ping\n\n").catch(() => undefined);
      }
      unsubscribe();
    });
  });

  /** Unread count for the nav badge: open conversations the viewer can see. */
  r.get("/unread", async (c) => {
    const [row] = await db
      .select({
        messages: sql<number>`coalesce(sum(${inboxConversation.unreadCount}), 0)::int`,
        conversations: sql<number>`count(*) filter (where ${inboxConversation.unreadCount} > 0)::int`,
      })
      .from(inboxConversation)
      .where(and(conversationScope(c.get("inboxViewer")), inArray(inboxConversation.status, ["open", "pending"])));
    return c.json({ data: row ?? { messages: 0, conversations: 0 } });
  });

  // ── Mobile devices and notification settings ──
  r.post("/devices", async (c) => {
    const body = z
      .object({ token: z.string().min(10).max(400), platform: z.enum(["ios", "android", "web"]) })
      .parse(await c.req.json());
    const userId = c.get("inboxViewer").userId;
    // A token belongs to one device; if someone else signs in on it, move it.
    await db
      .insert(inboxPushToken)
      .values({ userId, token: body.token, platform: body.platform, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: inboxPushToken.token, set: { userId, platform: body.platform, lastSeenAt: new Date() } });
    return c.json({ ok: true }, 201);
  });

  r.delete("/devices", async (c) => {
    const { token } = z.object({ token: z.string().min(10).max(400) }).parse(await c.req.json());
    await db
      .delete(inboxPushToken)
      .where(and(eq(inboxPushToken.token, token), eq(inboxPushToken.userId, c.get("inboxViewer").userId)));
    return c.json({ ok: true });
  });

  r.get("/notifications", async (c) => {
    const [pref] = await db.select().from(inboxNotifyPref).where(eq(inboxNotifyPref.userId, c.get("inboxViewer").userId));
    return c.json({ data: { level: pref?.level ?? "assigned" } });
  });

  r.put("/notifications", async (c) => {
    const { level } = z.object({ level: z.enum(["all", "assigned", "none"]) }).parse(await c.req.json());
    const userId = c.get("inboxViewer").userId;
    await db
      .insert(inboxNotifyPref)
      .values({ userId, level })
      .onConflictDoUpdate({ target: inboxNotifyPref.userId, set: { level } });
    return c.json({ data: { level } });
  });

  // ── Lists for pickers ──
  r.get("/staff", async (c) => {
    const users = await db
      .select({ id: adminUser.id, name: adminUser.name, email: adminUser.email, role: adminUser.role, overrides: adminUser.permissionOverrides })
      .from(adminUser)
      .where(and(eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));
    const teams = await db.select().from(inboxTeamMember);
    const data = users
      .filter((u) => resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides).includes("inbox.view"))
      .map((u) => ({
        id: u.id,
        name: u.name ?? u.email,
        team_ids: teams.filter((t) => t.userId === u.id).map((t) => t.teamId),
      }));
    return c.json({ data });
  });

  r.get("/teams", async (c) => {
    const rows = await db.select().from(inboxTeam).where(eq(inboxTeam.isActive, true)).orderBy(asc(inboxTeam.name));
    return c.json({ data: rows });
  });

  // ── Conversations ──
  r.get("/conversations", async (c) => {
    const v = c.get("inboxViewer");
    const q = c.req.query();
    const conds: SQL[] = [conversationScope(v)];

    const status = q.status ?? "open";
    if (status === "open") conds.push(inArray(inboxConversation.status, ["open", "pending"]));
    else if (status === "closed" || status === "pending") conds.push(eq(inboxConversation.status, status));

    if (q.view === "mine") conds.push(eq(inboxConversation.assigneeId, v.userId));
    else if (q.view === "unassigned") conds.push(isNull(inboxConversation.assigneeId));
    else if (q.view === "team") {
      conds.push(v.teamIds.length ? inArray(inboxConversation.teamId, v.teamIds) : sql`false`);
    }
    if (q.number && z.string().uuid().safeParse(q.number).success) conds.push(eq(inboxConversation.phoneNumberId, q.number));
    if (q.team && z.string().uuid().safeParse(q.team).success) conds.push(eq(inboxConversation.teamId, q.team));
    if (q.label) conds.push(sql`${q.label} = any(${inboxConversation.labels})`);
    if (q.channel && (IDENTITY_CHANNELS as readonly string[]).includes(q.channel)) {
      conds.push(eq(inboxConversation.channel, q.channel));
    }
    if (q.q && q.q.trim()) {
      const term = likeTerm(q.q.trim());
      const digits = q.q.replace(/\D/g, "");
      conds.push(
        or(
          ilike(customer.name, term),
          ...(digits.length >= 4 ? [sql`regexp_replace(coalesce(${customer.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`] : []),
          identityMatches(q.q.trim()),
        )!,
      );
    }
    if (q.before) {
      const d = new Date(q.before);
      if (!Number.isNaN(d.getTime())) conds.push(lt(inboxConversation.lastActivityAt, d));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);

    const rows = await db
      .select({
        id: inboxConversation.id,
        status: inboxConversation.status,
        labels: inboxConversation.labels,
        unread: inboxConversation.unreadCount,
        preview: inboxConversation.lastPreview,
        last_activity_at: inboxConversation.lastActivityAt,
        last_inbound_wa_at: inboxConversation.lastInboundWaAt,
        customer_id: customer.id,
        customer_name: customer.name,
        customer_phone: customer.phone,
        number_id: inboxPhoneNumber.id,
        number_label: inboxPhoneNumber.label,
        number_kind: inboxPhoneNumber.kind,
        channel: inboxConversation.channel,
        identity_name: sql<string | null>`coalesce(${inboxIdentity.displayName}, '@' || ${inboxIdentity.username})`,
        team_id: inboxConversation.teamId,
        team_name: inboxTeam.name,
        assignee_id: inboxConversation.assigneeId,
        assignee_name: sql<string | null>`coalesce(${assignee.name}, ${assignee.email})`,
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
      .leftJoin(inboxTeam, eq(inboxTeam.id, inboxConversation.teamId))
      .leftJoin(assignee, eq(assignee.id, inboxConversation.assigneeId))
      .leftJoin(inboxIdentity, eq(inboxIdentity.id, inboxConversation.identityId))
      .where(and(...conds))
      .orderBy(desc(inboxConversation.lastActivityAt))
      .limit(limit + 1);

    const now = new Date();
    const page = rows.slice(0, limit).map((row) => ({
      ...row,
      window_remaining_ms: waWindowRemainingMs(row.last_inbound_wa_at, now),
      human_agent_remaining_ms: humanAgentMs(row.channel, row.last_inbound_wa_at, now),
    }));
    const next = rows.length > limit ? page[page.length - 1]!.last_activity_at.toISOString() : null;
    return c.json({ data: page, next_before: next });
  });

  r.get("/conversations/:id", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const [cust] = await db.select().from(customer).where(eq(customer.id, conv.customerId));
    const [num] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, conv.phoneNumberId));
    const [ass] = conv.assigneeId
      ? await db.select({ id: adminUser.id, name: adminUser.name, email: adminUser.email }).from(adminUser).where(eq(adminUser.id, conv.assigneeId))
      : [];
    const [team] = conv.teamId ? await db.select().from(inboxTeam).where(eq(inboxTeam.id, conv.teamId)) : [];
    const [ident] = conv.identityId ? await db.select().from(inboxIdentity).where(eq(inboxIdentity.id, conv.identityId)) : [];
    return c.json({
      data: {
        ...conv,
        customer: cust ? { id: cust.id, name: cust.name, phone: cust.phone, email: cust.email, notes: cust.notes } : null,
        number: num
          ? {
              id: num.id,
              label: num.label,
              e164: num.e164,
              channels: num.channels,
              kind: num.kind,
              external_name: num.externalName,
              is_active: num.isActive,
              problem_text: num.problemText,
            }
          : null,
        identity: ident
          ? {
              id: ident.id,
              channel: ident.channel,
              display_name: ident.displayName,
              username: ident.username,
              profile_pic_url: ident.profilePicUrl,
            }
          : null,
        assignee: ass ? { id: ass.id, name: ass.name ?? ass.email } : null,
        team: team ? { id: team.id, name: team.name } : null,
        window_remaining_ms: waWindowRemainingMs(conv.lastInboundWaAt),
        human_agent_remaining_ms: humanAgentMs(conv.channel, conv.lastInboundWaAt),
        human_agent_enabled: process.env.META_HUMAN_AGENT_ENABLED === "true",
        can_use_number: canUseNumber(c.get("inboxViewer"), conv.phoneNumberId),
      },
    });
  });

  /** Messages, calls (with recordings) and notes in time order. */
  r.get("/conversations/:id/timeline", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const before = c.req.query("before") ? new Date(String(c.req.query("before"))) : null;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 200);
    const page = await buildTimelinePage(db, c.get("inboxViewer"), [conv.id], {
      before: before && !Number.isNaN(before.getTime()) ? before : null,
      limit,
    });
    return c.json(page);
  });

  r.post("/conversations/:id/read", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    if (conv.unreadCount > 0) {
      const [updated] = await db
        .update(inboxConversation)
        .set({ unreadCount: 0 })
        .where(eq(inboxConversation.id, conv.id))
        .returning();
      await publishInboxEvent(db, signalFor("conversation.updated", updated!));
      const cfg = metaConfigFromEnv();
      if (isMetaChannel(conv.channel)) {
        // Messenger/Instagram: "seen" to the customer, best effort (rule R24).
        const target = cfg ? await metaTarget(db, conv) : null;
        if (cfg && target) {
          sendSenderAction(cfg, target.pageId, target.recipient, "mark_seen").catch((err: unknown) =>
            logger.warn({ err }, "meta mark-seen failed"),
          );
        }
        return c.json({ ok: true });
      }
      // Blue ticks on WhatsApp for the newest inbound message (best effort).
      const [lastIn] = await db
        .select({ wamid: inboxMessage.waMessageId })
        .from(inboxMessage)
        .where(and(eq(inboxMessage.conversationId, conv.id), eq(inboxMessage.direction, "in")))
        .orderBy(desc(inboxMessage.createdAt))
        .limit(1);
      const [num] = await db.select({ wa: inboxPhoneNumber.waPhoneNumberId }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, conv.phoneNumberId));
      if (cfg && lastIn?.wamid && num?.wa) {
        markRead(cfg, num.wa, lastIn.wamid).catch((err: unknown) => logger.warn({ err }, "whatsapp mark-read failed"));
      }
    }
    return c.json({ ok: true });
  });

  r.post("/conversations/:id/messages", async (c) => {
    need(c, "inbox.reply");
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const v = c.get("inboxViewer");
    if (!canUseNumber(v, conv.phoneNumberId)) throw new BusinessError("forbidden", "You can't reply from this number", 403);
    const body = SendBody.parse(await c.req.json());

    let content: OutboundContent;
    let mediaKey: string | null = null;
    let mediaMime: string | null = null;
    if (body.type === "text") {
      content = { type: "text", body: body.body };
    } else if (body.type === "template") {
      need(c, "inbox.templates");
      content = { type: "template", name: body.name, language: body.language, bodyParams: body.params };
      if (body.header_param) content.headerText = body.header_param;
      if (body.button_params.length) content.buttonParams = body.button_params;
      if (body.header_media) {
        const hm = body.header_media;
        if (!verifyUploadToken(v.userId, hm.media_key, hm.media_token)) {
          throw new BusinessError("forbidden", "That attachment wasn't uploaded by you", 403);
        }
        const kind = INBOX_UPLOAD_TYPES[hm.mime]?.kind;
        if (kind !== "image" && kind !== "video" && kind !== "document") {
          throw new BusinessError("validation_failed", "That file can't be used with a template. Use a picture, a video or a document", 400);
        }
        // Handed to Meta the same way as an ordinary attachment: a short-lived signed link.
        const link = await presignInboxGet(hm.media_key, { expiresIn: 600 });
        content.headerMedia = { type: kind, link, ...(hm.filename ? { filename: hm.filename } : {}) };
        // Kept on the message only if the template really has a place for it (decided in sendFromConversation).
        mediaKey = hm.media_key;
        mediaMime = hm.mime;
      }
    } else {
      if (!verifyUploadToken(v.userId, body.media_key, body.media_token)) {
        throw new BusinessError("forbidden", "That attachment wasn't uploaded by you", 403);
      }
      // Meta fetches the file from a short-lived signed link.
      const link = await presignInboxGet(body.media_key, { expiresIn: 600 });
      content = { type: body.type, link };
      if (body.caption) content.caption = body.caption;
      if (body.filename) content.filename = body.filename;
      mediaKey = body.media_key;
      mediaMime = body.mime;
    }

    try {
      const msg = await sendFromConversation(db, metaConfigFromEnv(), {
        conversationId: conv.id,
        userId: v.userId,
        content,
        mediaKey,
        mediaMime,
        // A template whose button opens a form carries a signed token (suite spec 07).
        flowTokenSecret: env.JWT_SIGNING_KEY,
      });
      await audit(db, c, "inbox.message_send", "inbox_message", msg.id, { conversation_id: conv.id, type: msg.type, status: msg.status });
      // Messenger/Instagram configuration problem (spec 02, rule R20): tell the owner once a day per account.
      const p = (msg.payload ?? {}) as { config?: boolean; account?: string };
      if (p.config === true && p.account) {
        await alertOnce(db, "inbox.meta_config", { account: p.account, code: msg.errorCode ?? "", text: msg.errorMessage ?? "" });
      }
      return c.json({ data: msg }, msg.status === "failed" ? 502 : 201);
    } catch (err) {
      if (err instanceof InboxSendError) {
        if (err.code === "template_incomplete") {
          throw new BusinessError("validation_failed", err.message, 400, { reason: err.code });
        }
        const status = err.code === "not_configured" ? 503 : 409;
        throw new BusinessError(status === 503 ? "service_unavailable" : "conflict", err.message, status, { reason: err.code });
      }
      throw err;
    }
  });

  // ── WhatsApp forms (suite spec 07) ──

  /** The forms staff can send, and whether each is live at WhatsApp. No Meta call. */
  r.get("/flows", async (c) => {
    // With a conversation, "live" means live on that conversation's WhatsApp account.
    const convId = c.req.query("conversation_id");
    let waba: string | null = null;
    if (convId) {
      const conv = await visibleConversation(db, c, convId);
      const [num] = await db.select({ waba: inboxPhoneNumber.wabaId }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, conv.phoneNumberId));
      waba = num?.waba ?? null;
    }
    const rows = await db
      .select({ key: waFlow.key, status: waFlow.status, metaFlowId: waFlow.metaFlowId })
      .from(waFlow)
      .where(waba ? eq(waFlow.wabaId, waba) : undefined);
    const usable = rows.filter((x) => x.metaFlowId !== null);
    return c.json({
      data: sendableForms(rows).map((f) => ({
        key: f.key,
        title: f.title,
        description: f.description,
        cta: f.cta,
        default_message: f.defaultMessage,
        live: usable.some((x) => x.key === f.key && x.status === "PUBLISHED"),
        testable: usable.some((x) => x.key === f.key && (x.status === "DRAFT" || x.status === "PUBLISHED")),
      })),
    });
  });

  /**
   * Send a form in a chat: a message with a button that opens the form inside WhatsApp. A person
   * pressed "Send form"; nothing here runs on its own. Inside the 24-hour window only (checked by
   * sendFromConversation before Meta is called).
   */
  r.post("/conversations/:id/flows", async (c) => {
    need(c, "inbox.reply");
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const v = c.get("inboxViewer");
    if (!canUseNumber(v, conv.phoneNumberId)) throw new BusinessError("forbidden", "You can't reply from this number", 403);
    const body = FlowSendBody.parse(await c.req.json());
    const def = flowDef(body.flow_key);
    if (!def || flowJson(def.key) === null) throw new BusinessError("validation_failed", "Unknown form.", 400);
    const test = body.test === true;
    if (test) need(c, "templates.manage");
    if (conv.channel !== "whatsapp") throw new BusinessError("conflict", "Forms are only for WhatsApp.", 409, { reason: "not_supported" });

    const [num] = await db.select({ waba: inboxPhoneNumber.wabaId }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, conv.phoneNumberId));
    const candidates = num?.waba
      ? await db
          .select()
          .from(waFlow)
          .where(and(eq(waFlow.wabaId, num.waba), eq(waFlow.key, def.key)))
          .orderBy(desc(waFlow.version))
      : [];
    const row = candidates.find((x) => x.metaFlowId !== null && (x.status === "PUBLISHED" || (test && x.status === "DRAFT")));
    if (!row) {
      throw new BusinessError(
        "conflict",
        test
          ? "This form is not at WhatsApp yet. Create it under Templates and forms first."
          : "This form is not live at WhatsApp yet. Ask an admin to publish it under Templates and forms.",
        409,
        { reason: "form_not_live" },
      );
    }
    // A form that talks to our server cannot work while the server has no key (rule 23).
    if (def.usesEndpoint && loadFlowPrivateKey(process.env) === null) {
      throw new BusinessError("conflict", "The secure connection is not set up on this server yet.", 409, { reason: "no_secure_connection" });
    }
    const mode = row.status === "PUBLISHED" ? "published" : "draft";
    const token = makeFlowToken(env.JWT_SIGNING_KEY, def.key, conv.id, new Date());

    try {
      const msg = await sendFromConversation(db, metaConfigFromEnv(), {
        conversationId: conv.id,
        userId: v.userId,
        content: {
          type: "flow",
          flowId: row.metaFlowId!,
          flowToken: token,
          cta: def.cta,
          body: body.message ?? def.defaultMessage,
          action: def.usesEndpoint ? "data_exchange" : "navigate",
          screen: def.entryScreen,
          mode,
        },
        payloadExtra: { flow: { key: def.key, flow_row_id: row.id, token, title: def.title, cta: def.cta, ...(test ? { test: true } : {}) } },
      });
      await writeAudit(db, c, {
        action: "inbox.flow_send",
        entityType: "inbox_conversation",
        entityId: conv.id,
        after: { flow_key: def.key, message_id: msg.id, status: msg.status, mode, flow_version: row.version },
        notify: false,
      });
      return c.json({ data: msg }, msg.status === "failed" ? 502 : 201);
    } catch (err) {
      if (err instanceof InboxSendError) {
        const status = err.code === "not_configured" ? 503 : 409;
        throw new BusinessError(status === 503 ? "service_unavailable" : "conflict", err.message, status, { reason: err.code });
      }
      throw err;
    }
  });

  /**
   * What staff do with a completed form: mark it handled, undo that, save a delivery address to
   * the contact, or copy the answers into a note. Nothing here sends anything to the customer.
   */
  r.post("/flow-responses/:id/action", async (c) => {
    need(c, "inbox.reply");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const [resp] = await db.select().from(waFlowResponse).where(eq(waFlowResponse.id, id));
    if (!resp) throw new BusinessError("not_found", "not found", 404);
    const conv = await visibleConversation(db, c, resp.conversationId);
    const { action } = FlowActionBody.parse(await c.req.json());
    const v = c.get("inboxViewer");
    const now = new Date();
    const card = flowResponseCard(resp.flowKey, resp.data);
    const entry = (detail?: string): FlowResponseAction => ({ action, by: v.userId, at: now.toISOString(), ...(detail ? { detail } : {}) });
    const append = (e: FlowResponseAction) => sql`${waFlowResponse.actions} || ${JSON.stringify([e])}::jsonb`;
    let before: unknown;
    let after: unknown;
    let result: Record<string, unknown> = {};

    if (action === "handled") {
      const done = await db
        .update(waFlowResponse)
        .set({ status: "handled", handledBy: v.userId, handledAt: now, actions: append(entry()) })
        .where(and(eq(waFlowResponse.id, resp.id), eq(waFlowResponse.status, "new")))
        .returning({ id: waFlowResponse.id });
      if (done.length === 0) throw new BusinessError("conflict", "This form is already marked as handled.", 409);
      before = { status: "new" };
      after = { status: "handled" };
    } else if (action === "reopen") {
      const done = await db
        .update(waFlowResponse)
        .set({ status: "new", handledBy: null, handledAt: null, actions: append(entry()) })
        .where(and(eq(waFlowResponse.id, resp.id), eq(waFlowResponse.status, "handled")))
        .returning({ id: waFlowResponse.id });
      if (done.length === 0) throw new BusinessError("conflict", "This form is not marked as handled.", 409);
      before = { status: "handled" };
      after = { status: "new" };
    } else if (action === "save_address") {
      if (resp.flowKey !== "delivery_address") {
        throw new BusinessError("conflict", "Only a delivery address form can be saved to the contact.", 409);
      }
      const address = flowAddressLine(resp.data);
      if (!address) throw new BusinessError("conflict", "This answer has no address to save.", 409);
      // The only place a form changes a customer record, and only on this button press (rule 14).
      const saved = await db.transaction(async (tx) => {
        const [cust] = await tx.select({ address: customer.defaultAddress }).from(customer).where(eq(customer.id, conv.customerId)).for("update");
        if (!cust) throw new BusinessError("not_found", "not found", 404);
        await tx.update(customer).set({ defaultAddress: address, updatedAt: now }).where(eq(customer.id, conv.customerId));
        await tx.update(waFlowResponse).set({ actions: append(entry("Saved to the contact")) }).where(eq(waFlowResponse.id, resp.id));
        return { before: cust.address ?? null, after: address };
      });
      before = { default_address: saved.before };
      after = { default_address: saved.after };
      result = saved;
    } else {
      need(c, "inbox.notes");
      const text = [card.title, ...card.rows.map((row) => `${row.label}: ${row.value}`)].join("\n").slice(0, 4000);
      const [note] = await db.insert(inboxNote).values({ conversationId: conv.id, authorUserId: v.userId, body: text }).returning();
      await db.update(waFlowResponse).set({ actions: append(entry("Added to notes")) }).where(eq(waFlowResponse.id, resp.id));
      await publishInboxEvent(db, signalFor("note.created", conv, note!.id));
      after = { note_id: note!.id };
      result = { note_id: note!.id };
    }

    await writeAudit(db, c, {
      action: "inbox.flow_response_action",
      entityType: "wa_flow_response",
      entityId: resp.id,
      before,
      after: { action, flow_key: resp.flowKey, conversation_id: conv.id, ...(after as Record<string, unknown>) },
      notify: false,
    });
    // Open screens redraw the card.
    await publishInboxEvent(db, signalFor("message.status", conv, resp.messageId));
    const [fresh] = await db.select({ status: waFlowResponse.status, handledAt: waFlowResponse.handledAt }).from(waFlowResponse).where(eq(waFlowResponse.id, resp.id));
    return c.json({ data: { id: resp.id, status: fresh?.status ?? resp.status, handled_at: fresh?.handledAt ?? null, ...result } });
  });

  r.post("/conversations/:id/notes", async (c) => {
    need(c, "inbox.notes");
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    const [note] = await db
      .insert(inboxNote)
      .values({ conversationId: conv.id, authorUserId: c.get("inboxViewer").userId, body })
      .returning();
    await publishInboxEvent(db, signalFor("note.created", conv, note!.id));
    await audit(db, c, "inbox.note_add", "inbox_note", note!.id, { conversation_id: conv.id });
    return c.json({ data: note }, 201);
  });

  r.post("/conversations/:id/typing", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    await publishInboxEvent(db, { ...signalFor("conversation.typing", conv), id: c.get("inboxViewer").userId });
    // Messenger/Instagram: "typing…" to the customer, at most every 10 s per chat, never awaited (rule R24).
    if (isMetaChannel(conv.channel) && waWindowOpen(conv.lastInboundWaAt)) {
      const last = typingSentAt.get(conv.id) ?? 0;
      const cfg = metaConfigFromEnv();
      if (cfg && Date.now() - last >= TYPING_EVERY_MS) {
        typingSentAt.set(conv.id, Date.now());
        void metaTarget(db, conv)
          .then((t) => (t ? sendSenderAction(cfg, t.pageId, t.recipient, "typing_on") : undefined))
          .catch((err: unknown) => logger.warn({ err }, "meta typing signal failed"));
      }
    }
    return c.json({ ok: true });
  });

  r.patch("/conversations/:id", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    const v = c.get("inboxViewer");
    const body = PatchBody.parse(await c.req.json());
    const patch: Partial<typeof inboxConversation.$inferInsert> = {};

    if (body.assignee_id !== undefined) {
      const self = body.assignee_id === v.userId;
      if (!self) need(c, "inbox.assign");
      if (body.assignee_id) {
        const assigneeViewer = await reloadViewer(db, body.assignee_id);
        if (!assigneeViewer || !canUseNumber(assigneeViewer, conv.phoneNumberId)) {
          throw new BusinessError("validation_failed", "That person can't work on this number", 400);
        }
      }
      patch.assigneeId = body.assignee_id;
    }
    if (body.team_id !== undefined) {
      need(c, "inbox.assign");
      patch.teamId = body.team_id;
    }
    if (body.status !== undefined) {
      need(c, "inbox.close");
      patch.status = body.status;
      patch.closedAt = body.status === "closed" ? new Date() : null;
    }
    if (body.labels !== undefined) {
      need(c, "inbox.reply");
      patch.labels = [...new Set(body.labels.map((l) => l.toLowerCase()))];
    }
    if (Object.keys(patch).length === 0) return c.json({ data: conv });

    const [updated] = await db.update(inboxConversation).set(patch).where(eq(inboxConversation.id, conv.id)).returning();
    // Signal both the old and new routing so people losing sight of it refresh too.
    await publishInboxEvent(db, signalFor("conversation.updated", conv));
    await publishInboxEvent(db, signalFor("conversation.updated", updated!));
    await audit(db, c, "inbox.conversation_update", "inbox_conversation", conv.id, body, {
      assignee_id: conv.assigneeId,
      team_id: conv.teamId,
      status: conv.status,
      labels: conv.labels,
    });
    return c.json({ data: updated });
  });

  // ── Files ──
  r.post("/uploads", async (c) => {
    need(c, "inbox.reply");
    const body = z
      .object({
        filename: z.string().min(1).max(240),
        content_type: z.string().max(200),
        size_bytes: z.number().int().positive(),
        /** When given, the file is checked against that conversation's channel (spec 02). */
        conversation_id: z.string().uuid().optional(),
      })
      .parse(await c.req.json());
    let channel: "whatsapp" | "messenger" | "instagram" = "whatsapp";
    if (body.conversation_id) {
      const conv = await visibleConversation(db, c, body.conversation_id);
      if (conv.channel === "messenger" || conv.channel === "instagram") channel = conv.channel;
    }
    const res = await presignInboxPut({ filename: body.filename, contentType: body.content_type, sizeBytes: body.size_bytes, channel });
    return c.json({ data: { ...res, media_token: uploadToken(c.get("inboxViewer").userId, res.object_key) } }, 201);
  });

  r.get("/messages/:id/media", async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, id));
    if (!msg) throw new BusinessError("not_found", "not found", 404);
    await visibleConversation(db, c, msg.conversationId);
    if (!msg.mediaKey) throw new BusinessError("not_found", "media not available yet", 404);
    const url = await presignInboxGet(msg.mediaKey, c.req.query("download") ? { downloadName: msg.mediaFilename ?? "file" } : {});
    return c.json({ data: { url, mime: msg.mediaMime, expires_in: 600 } });
  });

  r.get("/recordings/:id/url", async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const download = !!c.req.query("download");
    need(c, download ? "recordings.download" : "recordings.listen");
    const [rec] = await db
      .select({ rec: inboxRecording, conversationId: inboxCall.conversationId })
      .from(inboxRecording)
      .innerJoin(inboxCall, eq(inboxCall.id, inboxRecording.callId))
      .where(eq(inboxRecording.id, id));
    if (!rec) throw new BusinessError("not_found", "not found", 404);
    await visibleConversation(db, c, rec.conversationId);
    if (!rec.rec.storageKey) throw new BusinessError("not_found", "recording is still processing", 404);
    const url = await presignInboxGet(rec.rec.storageKey, download ? { downloadName: `call-${rec.rec.id}.mp3` } : {});
    await audit(db, c, download ? "inbox.recording_download" : "inbox.recording_play", "inbox_recording", rec.rec.id);
    return c.json({ data: { url, expires_in: 600 } });
  });

  /** Permanently delete one recording: audio file, transcript and summary. The call stays on the timeline. */
  r.delete("/recordings/:id", async (c) => {
    need(c, "recordings.delete");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const [rec] = await db
      .select({ rec: inboxRecording, conversationId: inboxCall.conversationId })
      .from(inboxRecording)
      .innerJoin(inboxCall, eq(inboxCall.id, inboxRecording.callId))
      .where(eq(inboxRecording.id, id));
    if (!rec) throw new BusinessError("not_found", "not found", 404);
    const conv = await visibleConversation(db, c, rec.conversationId);
    await deleteInboxObjects([rec.rec.storageKey]);
    await db
      .update(inboxRecording)
      .set({ status: "deleted", storageKey: null, transcript: null, summaryJson: null, twilioRecordingUrl: null, processedAt: new Date() })
      .where(eq(inboxRecording.id, id));
    await publishInboxEvent(db, signalFor("recording.processed", conv, id));
    await audit(db, c, "inbox.recording_delete", "inbox_recording", id, { call_id: rec.rec.callId, kind: rec.rec.kind });
    return c.json({ ok: true });
  });

  // ── Templates and quick replies ──
  r.get("/templates", async (c) => {
    // Drafts live only in the suite (spec 06): the picker and older apps never see them.
    const rows = await db.select().from(inboxTemplate).where(ne(inboxTemplate.status, "DRAFT")).orderBy(asc(inboxTemplate.name));
    return c.json({
      data: rows.map((t) => {
        const needs = templateNeeds(t.components, t.category);
        return {
          id: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components,
          param_count: templateParamCount(t.components),
          waba_id: t.wabaId,
          // What the template needs to be sent (additive; older apps ignore it).
          sendable: needs.sendable,
          unsendable_reason: needs.reason,
          header_media: needs.headerMedia,
          header_param_count: needs.headerParams,
          url_buttons: needs.urlButtons,
        };
      }),
    });
  });

  r.post("/templates/sync", async (c) => {
    need(c, "inbox.settings");
    const cfg = metaConfigFromEnv();
    if (!cfg) throw new BusinessError("service_unavailable", "WhatsApp is not configured on this server", 503);
    const wabas = await db.selectDistinct({ waba: inboxPhoneNumber.wabaId }).from(inboxPhoneNumber);
    let count = 0;
    for (const { waba } of wabas) {
      if (!waba) continue;
      count += await syncTemplatesForWaba(db, cfg, waba);
    }
    await audit(db, c, "inbox.templates_sync", "inbox_template", "all", { count });
    return c.json({ data: { synced: count } });
  });

  r.get("/quick-replies", async (c) => {
    const rows = await db.select().from(inboxQuickReply).orderBy(asc(inboxQuickReply.title));
    return c.json({ data: rows });
  });

  const QuickReplyBody = z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(4096) });
  r.post("/quick-replies", async (c) => {
    need(c, "inbox.settings");
    const body = QuickReplyBody.parse(await c.req.json());
    const [row] = await db.insert(inboxQuickReply).values({ ...body, createdBy: c.get("inboxViewer").userId }).returning();
    await audit(db, c, "inbox.quick_reply_create", "inbox_quick_reply", row!.id, body);
    return c.json({ data: row }, 201);
  });
  r.patch("/quick-replies/:id", async (c) => {
    need(c, "inbox.settings");
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = QuickReplyBody.partial().parse(await c.req.json());
    const [row] = await db.update(inboxQuickReply).set(body).where(eq(inboxQuickReply.id, id)).returning();
    if (!row) throw new BusinessError("not_found", "not found", 404);
    await audit(db, c, "inbox.quick_reply_update", "inbox_quick_reply", id, body);
    return c.json({ data: row });
  });
  r.delete("/quick-replies/:id", async (c) => {
    need(c, "inbox.settings");
    const id = z.string().uuid().parse(c.req.param("id"));
    const [row] = await db.delete(inboxQuickReply).where(eq(inboxQuickReply.id, id)).returning();
    if (!row) throw new BusinessError("not_found", "not found", 404);
    await audit(db, c, "inbox.quick_reply_delete", "inbox_quick_reply", id, undefined, row);
    return c.json({ ok: true });
  });

  /** Contacts that have inbox history the viewer can see, for the merge picker. */
  r.get("/contacts/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json({ data: [] });
    const term = likeTerm(q);
    const digits = q.replace(/\D/g, "");
    const rows = await db
      .select({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        conversations: sql<number>`count(*)::int`,
        handles: customerHandles,
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .where(
        and(
          conversationScope(c.get("inboxViewer")),
          or(
            ilike(customer.name, term),
            ...(digits.length >= 4 ? [sql`regexp_replace(coalesce(${customer.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`] : []),
            identityMatches(q),
          ),
        ),
      )
      .groupBy(customer.id)
      .orderBy(asc(customer.name))
      .limit(20);
    return c.json({ data: rows });
  });

  // ── Contacts: combined timeline across every number the viewer may see ──
  r.get("/contacts/:customerId", async (c) => {
    const id = c.req.param("customerId");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const v = c.get("inboxViewer");
    const convs = await db
      .select({
        id: inboxConversation.id,
        status: inboxConversation.status,
        number_label: inboxPhoneNumber.label,
        last_activity_at: inboxConversation.lastActivityAt,
        labels: inboxConversation.labels,
        channel: inboxConversation.channel,
      })
      .from(inboxConversation)
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
      .where(and(eq(inboxConversation.customerId, id), conversationScope(v)))
      .orderBy(desc(inboxConversation.lastActivityAt));
    if (convs.length === 0) throw new BusinessError("not_found", "not found", 404);
    const [cust] = await db.select().from(customer).where(eq(customer.id, id));
    return c.json({
      data: {
        customer: { id: cust!.id, name: cust!.name, phone: cust!.phone, email: cust!.email, notes: cust!.notes },
        identities: await identitiesFor(db, v, id),
        conversations: convs,
        timeline: c.req.query("timeline") ? await buildTimeline(db, v, convs.map((x) => x.id)) : undefined,
      },
    });
  });

  /**
   * Erase a customer's inbox history on request: chats, calls, recordings,
   * notes, the stored files, their WhatsApp / Facebook / Instagram identities
   * and the raw webhook copies that mention them. Their customer record and
   * orders are the shop's own records and are not touched (spec 01, Q3).
   */
  r.post("/contacts/:customerId/erase", async (c) => {
    need(c, "inbox.erase");
    const id = c.req.param("customerId");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const body = z
      .object({
        confirm: z.string().min(1).max(120).optional(),
        // Older clients send the phone under this key.
        confirm_phone: z.string().min(1).max(120).optional(),
      })
      .parse(await c.req.json());
    const confirm = body.confirm ?? body.confirm_phone;
    if (!confirm) throw new BusinessError("validation_failed", "That doesn't match this customer", 400);
    const [cust] = await db.select().from(customer).where(eq(customer.id, id));
    if (!cust) throw new BusinessError("not_found", "not found", 404);
    const identities = await db.select().from(inboxIdentity).where(eq(inboxIdentity.customerId, id));
    const usernames = identities.map((i) => i.username).filter((u): u is string => !!u);
    if (!eraseConfirmMatches(confirm, cust, usernames)) {
      throw new BusinessError("validation_failed", "That doesn't match this customer", 400);
    }
    const digits = (v: string | null) => (v ?? "").replace(/\D/g, "").replace(/^(234|0)/, "");

    const result = await db.transaction(async (tx) => {
      const convs = await tx.select().from(inboxConversation).where(eq(inboxConversation.customerId, id));
      const convIds = convs.map((x) => x.id);
      let calls: { id: string }[] = [];
      let recs: { key: string | null }[] = [];
      let msgs: { key: string | null }[] = [];
      let forms: { id: string }[] = [];
      if (convIds.length) {
        calls = await tx.select({ id: inboxCall.id }).from(inboxCall).where(inArray(inboxCall.conversationId, convIds));
        const callIds = calls.map((x) => x.id);
        recs = callIds.length
          ? await tx.delete(inboxRecording).where(inArray(inboxRecording.callId, callIds)).returning({ key: inboxRecording.storageKey })
          : [];
        if (callIds.length) await tx.delete(inboxCall).where(inArray(inboxCall.id, callIds));
        // Their form answers (suite spec 07, rule 16) go first, before the messages they hang off.
        forms = await tx.delete(waFlowResponse).where(inArray(waFlowResponse.conversationId, convIds)).returning({ id: waFlowResponse.id });
        msgs = await tx.delete(inboxMessage).where(inArray(inboxMessage.conversationId, convIds)).returning({ key: inboxMessage.mediaKey });
        await tx.delete(inboxNote).where(inArray(inboxNote.conversationId, convIds));
        for (const conv of convs) await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        await tx.delete(inboxConversation).where(inArray(inboxConversation.id, convIds));
      }
      const gone = await tx.delete(inboxIdentity).where(eq(inboxIdentity.customerId, id)).returning({ id: inboxIdentity.id });
      // Raw webhook copies of their messages and calls: by phone digits and by every identity ID.
      const needles = new Set<string>();
      const d = digits(cust.phone);
      if (d.length >= 7) needles.add(d);
      for (const ident of identities) if (ident.externalId.length >= 7) needles.add(ident.externalId);
      for (const needle of needles) {
        await tx.delete(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like ${likeTerm(needle)}`);
      }
      return {
        conversations: convIds.length,
        messages: msgs.length,
        calls: calls.length,
        recordings: recs.length,
        form_answers: forms.length,
        identities: gone.length,
        keys: [...recs.map((x) => x.key), ...msgs.map((x) => x.key)],
      };
    });
    const { keys, ...counts } = result;
    await deleteInboxObjects(keys).catch((err: unknown) => logger.error({ err, customerId: id }, "inbox erase: file delete failed"));
    await writeAudit(db, c, {
      action: "inbox.contact_erase",
      entityType: "customer",
      entityId: id,
      // The customer row stays (the inbox never changes it); the owner removes it in the shop admin if asked.
      after: { ...counts, customer_row_kept: true },
      notify: true,
    });
    return c.json({ data: counts });
  });

  /**
   * Merge a duplicate contact's inbox history into another contact. Only inbox
   * threads move; customer records and orders are left exactly as they are.
   */
  r.post("/contacts/:customerId/merge", async (c) => {
    need(c, "inbox.erase");
    const fromId = c.req.param("customerId");
    const { into_customer_id: intoId } = z.object({ into_customer_id: z.string().uuid() }).parse(await c.req.json());
    if (!z.string().uuid().safeParse(fromId).success || fromId === intoId) {
      throw new BusinessError("validation_failed", "Pick a different contact to merge into", 400);
    }
    const [target] = await db.select({ id: customer.id }).from(customer).where(and(eq(customer.id, intoId), isNull(customer.deletedAt)));
    if (!target) throw new BusinessError("not_found", "contact not found", 404);

    const moved = await db.transaction(async (tx) => {
      const convs = await tx.select().from(inboxConversation).where(eq(inboxConversation.customerId, fromId));
      for (const conv of convs) {
        const [clash] =
          conv.status === "closed"
            ? []
            : await tx
                .select()
                .from(inboxConversation)
                .where(
                  and(
                    eq(inboxConversation.customerId, intoId),
                    eq(inboxConversation.phoneNumberId, conv.phoneNumberId),
                    sql`${inboxConversation.status} <> 'closed'`,
                  ),
                );
        if (clash) {
          // Both have a live thread on this number: fold this one into the target's.
          await tx.update(inboxMessage).set({ conversationId: clash.id }).where(eq(inboxMessage.conversationId, conv.id));
          // Form answers follow their messages (ruling 9.2.8); otherwise deleting the folded thread would delete them.
          await tx.update(waFlowResponse).set({ conversationId: clash.id }).where(eq(waFlowResponse.conversationId, conv.id));
          await tx.update(inboxNote).set({ conversationId: clash.id }).where(eq(inboxNote.conversationId, conv.id));
          await tx.update(inboxCall).set({ conversationId: clash.id, customerId: intoId }).where(eq(inboxCall.conversationId, conv.id));
          await tx
            .update(inboxConversation)
            .set({
              unreadCount: sql`${inboxConversation.unreadCount} + ${conv.unreadCount}`,
              lastActivityAt: sql`greatest(${inboxConversation.lastActivityAt}, ${conv.lastActivityAt.toISOString()}::timestamptz)`,
              ...(conv.lastInboundWaAt
                ? { lastInboundWaAt: sql`greatest(coalesce(${inboxConversation.lastInboundWaAt}, '-infinity'::timestamptz), ${conv.lastInboundWaAt.toISOString()}::timestamptz)` }
                : {}),
              // The kept thread remembers who it is with if it didn't know yet.
              ...(conv.identityId ? { identityId: sql`coalesce(${inboxConversation.identityId}, ${conv.identityId}::uuid)` } : {}),
            })
            .where(eq(inboxConversation.id, clash.id));
          await publishInboxEvent(tx, signalFor("conversation.updated", conv));
          await tx.delete(inboxConversation).where(eq(inboxConversation.id, conv.id));
          await publishInboxEvent(tx, signalFor("conversation.updated", clash));
        } else {
          await tx.update(inboxCall).set({ customerId: intoId }).where(eq(inboxCall.conversationId, conv.id));
          const [updated] = await tx.update(inboxConversation).set({ customerId: intoId }).where(eq(inboxConversation.id, conv.id)).returning();
          await publishInboxEvent(tx, signalFor("conversation.updated", updated!));
        }
      }
      // Their WhatsApp, Facebook and Instagram identities move too, so future
      // messages land on the kept contact (rule R7).
      const identities = await tx
        .update(inboxIdentity)
        .set({ customerId: intoId, updatedAt: new Date() })
        .where(eq(inboxIdentity.customerId, fromId))
        .returning({ id: inboxIdentity.id });
      return { conversations: convs.length, identities: identities.length };
    });
    await writeAudit(db, c, {
      action: "inbox.contact_merge",
      entityType: "customer",
      entityId: fromId,
      after: { into_customer_id: intoId, moved_conversations: moved.conversations, moved_identities: moved.identities },
      notify: true,
    });
    return c.json({ data: { moved_conversations: moved.conversations, moved_identities: moved.identities } });
  });

  r.patch("/contacts/:customerId", async (c) => {
    need(c, "inbox.reply");
    const id = c.req.param("customerId");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "not found", 404);
    const [visible] = await db
      .select({ id: inboxConversation.id })
      .from(inboxConversation)
      .where(and(eq(inboxConversation.customerId, id), conversationScope(c.get("inboxViewer"))))
      .limit(1);
    if (!visible) throw new BusinessError("not_found", "not found", 404);
    const body = z
      .object({ name: z.string().trim().min(1).max(120).optional(), notes: z.string().max(4000).nullable().optional() })
      .strict()
      .parse(await c.req.json());
    const [before] = await db.select().from(customer).where(eq(customer.id, id));
    const [row] = await db
      .update(customer)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customer.id, id))
      .returning();
    await audit(db, c, "inbox.contact_update", "customer", id, body, { name: before?.name, notes: before?.notes });
    return c.json({ data: { id: row!.id, name: row!.name, phone: row!.phone, notes: row!.notes } });
  });

  /** CSV of the contacts the viewer can see, with conversation counts. */
  r.get("/export/contacts.csv", async (c) => {
    need(c, "inbox.export");
    const rows = await db
      .select({
        name: customer.name,
        phone: customer.phone,
        conversations: sql<number>`count(*)::int`,
        last_activity: sql<string>`max(${inboxConversation.lastActivityAt})`,
        other_names: sql<string | null>`(select string_agg(h, '; ' order by h) from (
          select distinct coalesce('@' || i.username, i.display_name) as h from ${inboxIdentity} i
          where i.customer_id = ${customer.id} and coalesce(i.username, i.display_name) is not null) handles)`,
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .where(conversationScope(c.get("inboxViewer")))
      .groupBy(customer.id)
      .orderBy(desc(sql`max(${inboxConversation.lastActivityAt})`));
    await audit(db, c, "inbox.contacts_export", "customer", "export", { rows: rows.length });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="inbox-contacts.csv"');
    return c.body(
      toCsv(
        ["Name", "Phone", "Conversations", "Last activity", "Other names"],
        rows.map((r2) => [r2.name, r2.phone, r2.conversations, r2.last_activity, r2.other_names]),
      ),
    );
  });

  return r;
}

// ── Helpers shared with settings / worker-style jobs ─────────────────────────

type TimelineItem =
  | { kind: "message"; at: string; data: Record<string, unknown> }
  | { kind: "call"; at: string; data: Record<string, unknown> }
  | { kind: "note"; at: string; data: Record<string, unknown> };

const TIMELINE_LIMIT = 500;

/** Whole (capped) timeline, for the contact view. */
async function buildTimeline(db: DbClient, v: InboxViewer, conversationIds: string[]): Promise<TimelineItem[]> {
  return (await buildTimelinePage(db, v, conversationIds, { before: null, limit: TIMELINE_LIMIT })).data;
}

/**
 * One page of the timeline, newest `limit` items older than `before`, returned
 * oldest → newest. Page back with before = next_before.
 */
async function buildTimelinePage(
  db: DbClient,
  v: InboxViewer,
  conversationIds: string[],
  opts: { before: Date | null; limit: number },
): Promise<{ data: TimelineItem[]; has_more: boolean; next_before: string | null }> {
  if (conversationIds.length === 0) return { data: [], has_more: false, next_before: null };
  const take = opts.limit + 1;
  const staff = alias(adminUser, "staff");
  const handler = alias(adminUser, "flow_handler");

  const messages = await db
    .select({
      id: inboxMessage.id,
      conversation_id: inboxMessage.conversationId,
      direction: inboxMessage.direction,
      type: inboxMessage.type,
      body: inboxMessage.body,
      has_media: sql<boolean>`${inboxMessage.mediaKey} is not null`,
      media_pending: sql<boolean>`(${inboxMessage.mediaId} is not null or ${inboxMessage.mediaUrl} is not null) and ${inboxMessage.mediaKey} is null`,
      channel: inboxMessage.channel,
      edited: sql<boolean>`${inboxMessage.editedAt} is not null`,
      deleted: sql<boolean>`${inboxMessage.deletedAt} is not null`,
      // Answered from Meta's own apps (an echo we did not send).
      external_sender: sql<boolean>`${inboxMessage.direction} = 'out' and ${inboxMessage.senderUserId} is null and coalesce(${inboxMessage.payload} ? 'echo', false)`,
      story_reply: sql<boolean>`${inboxMessage.payload} #> '{message,reply_to,story}' is not null`,
      // A shared post's link; a story mention's link only while the story can still exist (24 hours).
      link: sql<string | null>`case
        when ${inboxMessage.deletedAt} is not null then null
        when ${inboxMessage.type} = 'share' then coalesce(
          ${inboxMessage.payload} -> 'share' ->> 'url',
          (select a -> 'payload' ->> 'url' from jsonb_array_elements(coalesce(${inboxMessage.payload} #> '{message,attachments}', '[]'::jsonb)) a
            where a ->> 'type' in ('share','post','ig_post','reel','ig_reel','story','ig_story','media') limit 1))
        when ${inboxMessage.type} = 'story_mention' and ${inboxMessage.createdAt} > now() - interval '24 hours' then
          (select a -> 'payload' ->> 'url' from jsonb_array_elements(coalesce(${inboxMessage.payload} #> '{message,attachments}', '[]'::jsonb)) a
            where a ->> 'type' = 'story_mention' limit 1)
        else null end`,
      advert: sql<string | null>`case
        when ${inboxMessage.payload} #>> '{message,referral,source}' = 'ADS' then ${inboxMessage.payload} #>> '{message,referral,ads_context_data,ad_title}'
        when ${inboxMessage.payload} #>> '{postback,referral,source}' = 'ADS' then ${inboxMessage.payload} #>> '{postback,referral,ads_context_data,ad_title}'
        else null end`,
      tap_payload: sql<string | null>`${inboxMessage.payload} #>> '{postback,payload}'`,
      media_mime: inboxMessage.mediaMime,
      media_filename: inboxMessage.mediaFilename,
      template_name: inboxMessage.templateName,
      status: inboxMessage.status,
      error_message: inboxMessage.errorMessage,
      unconfirmed: sql<boolean>`${inboxMessage.direction} = 'out' and coalesce((${inboxMessage.payload}->>'unconfirmed')::boolean, false)`,
      sender_name: sql<string | null>`coalesce(${staff.name}, ${staff.email})`,
      // Sent by the system, not a person: "after_hours" (closed-hours reply) or "system" (e.g. missed-call follow-up).
      // A Messenger/Instagram echo answered from Meta's own apps is a person, not the system (external_sender above).
      auto: sql<string | null>`case when ${inboxMessage.direction} = 'out' and ${inboxMessage.senderUserId} is null and not coalesce(${inboxMessage.payload} ? 'echo', false) then coalesce(${inboxMessage.payload}->>'auto', 'system') end`,
      // A WhatsApp form (suite spec 07): what we sent, and the customer's answers.
      flow_sent_title: sql<string | null>`case when ${inboxMessage.direction} = 'out' and ${inboxMessage.type} = 'flow' then ${inboxMessage.payload} #>> '{flow,title}' end`,
      flow_sent_cta: sql<string | null>`case when ${inboxMessage.direction} = 'out' and ${inboxMessage.type} = 'flow' then ${inboxMessage.payload} #>> '{flow,cta}' end`,
      flow_response_id: waFlowResponse.id,
      flow_key: waFlowResponse.flowKey,
      flow_data: waFlowResponse.data,
      flow_status: waFlowResponse.status,
      flow_handled_at: waFlowResponse.handledAt,
      flow_handled_by_name: sql<string | null>`coalesce(${handler.name}, ${handler.email})`,
      created_at: inboxMessage.createdAt,
    })
    .from(inboxMessage)
    .leftJoin(staff, eq(staff.id, inboxMessage.senderUserId))
    .leftJoin(waFlowResponse, eq(waFlowResponse.messageId, inboxMessage.id))
    .leftJoin(handler, eq(handler.id, waFlowResponse.handledBy))
    .where(and(inArray(inboxMessage.conversationId, conversationIds), ...(opts.before ? [lt(inboxMessage.createdAt, opts.before)] : [])))
    .orderBy(desc(inboxMessage.createdAt))
    .limit(take);

  const calls = await db
    .select({
      id: inboxCall.id,
      conversation_id: inboxCall.conversationId,
      direction: inboxCall.direction,
      outcome: inboxCall.outcome,
      ivr_choice: inboxCall.ivrChoice,
      duration_s: inboxCall.durationS,
      started_at: inboxCall.startedAt,
      answered_by: sql<string | null>`coalesce(${staff.name}, ${staff.email})`,
    })
    .from(inboxCall)
    .leftJoin(staff, eq(staff.id, inboxCall.answeredByUserId))
    .where(and(inArray(inboxCall.conversationId, conversationIds), ...(opts.before ? [lt(inboxCall.startedAt, opts.before)] : [])))
    .orderBy(desc(inboxCall.startedAt))
    .limit(take);

  // A delivery-time booking that arrived after its window was already full gets an amber line (5.10).
  const overbooked = new Set<string>();
  for (const m of messages) {
    if (m.flow_response_id && m.flow_key === "delivery_slot" && (await slotOverbooked(db, { id: m.flow_response_id, data: m.flow_data ?? {} }))) {
      overbooked.add(m.flow_response_id);
    }
  }

  const recordings = calls.length
    ? await db.select().from(inboxRecording).where(inArray(inboxRecording.callId, calls.map((x) => x.id)))
    : [];
  const canListen = v.capabilities.includes("recordings.listen");
  const canTranscript = v.capabilities.includes("transcripts.view");

  const notes = await db
    .select({
      id: inboxNote.id,
      conversation_id: inboxNote.conversationId,
      body: inboxNote.body,
      author_name: sql<string | null>`coalesce(${staff.name}, ${staff.email})`,
      created_at: inboxNote.createdAt,
    })
    .from(inboxNote)
    .leftJoin(staff, eq(staff.id, inboxNote.authorUserId))
    .where(and(inArray(inboxNote.conversationId, conversationIds), ...(opts.before ? [lt(inboxNote.createdAt, opts.before)] : [])))
    .orderBy(desc(inboxNote.createdAt))
    .limit(take);

  const items: TimelineItem[] = [
    ...messages.map(({ tap_payload, flow_sent_title, flow_sent_cta, flow_response_id, flow_key, flow_data, flow_status, flow_handled_at, flow_handled_by_name, ...m }) => ({
      kind: "message" as const,
      at: m.created_at.toISOString(),
      data: {
        ...m,
        flow_sent: flow_sent_title !== null || flow_sent_cta !== null ? { title: flow_sent_title ?? "Form", cta: flow_sent_cta ?? "Open form" } : null,
        flow_response:
          flow_response_id !== null && flow_key !== null
            ? {
                id: flow_response_id,
                flow_key,
                status: flow_status ?? "new",
                handled_by_name: flow_handled_by_name,
                handled_at: flow_handled_at ? flow_handled_at.toISOString() : null,
                ...flowResponseCard(flow_key, flow_data ?? {}),
                warning: overbooked.has(flow_response_id) ? SLOT_OVERBOOKED_TEXT : null,
              }
            : null,
        // A tapped Messenger/Instagram button: what it was (spec 04, section 5.6). Null otherwise.
        tap_caption: m.type === "interactive" && tap_payload !== null ? (describeChatSetupPayload(tap_payload)?.caption ?? "Tapped a button") : null,
      },
    })),
    ...calls.map((call) => ({
      kind: "call" as const,
      at: call.started_at.toISOString(),
      data: {
        ...call,
        recordings: recordings
          .filter((rec) => rec.callId === call.id)
          .map((rec) => ({
            id: rec.id,
            kind: rec.kind,
            status: rec.status,
            duration_s: rec.durationS,
            playable: canListen && !!rec.storageKey,
            transcript: canTranscript ? rec.transcript : null,
            summary: canTranscript ? rec.summaryJson : null,
          })),
      },
    })),
    ...notes.map((n) => ({ kind: "note" as const, at: n.created_at.toISOString(), data: n })),
  ];
  items.sort((a, b) => a.at.localeCompare(b.at));
  const data = items.slice(-opts.limit);
  const has_more = items.length > opts.limit;
  return { data, has_more, next_before: has_more && data[0] ? data[0].at : null };
}
