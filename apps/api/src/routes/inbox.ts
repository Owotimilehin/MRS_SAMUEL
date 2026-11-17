import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  adminUser,
  customer,
  inboxCall,
  inboxConversation,
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
  type DbClient,
} from "@ms/db";
import {
  InboxSendError,
  canSeeConversation,
  canUseNumber,
  conversationScope,
  listTemplates,
  markRead,
  metaConfigFromEnv,
  publishInboxEvent,
  sendFromConversation,
  signalFor,
  templateParamCount,
  type InboxViewer,
  type OutboundContent,
} from "@ms/domain";
import { resolveCapabilities, waWindowRemainingMs, type AdminRole, type Capability, type PermissionOverrides } from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { presignInboxGet, presignInboxPut } from "../lib/r2.js";
import { toCsv } from "../lib/csv.js";
import { reloadViewer, subscribe } from "../inbox/realtime.js";
import { logger } from "../logger.js";
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

function withViewer(db: DbClient): MiddlewareHandler {
  return async (c, next) => {
    const viewer = await cachedViewer(db, c.get("auth").userId);
    if (!viewer) throw new BusinessError("forbidden", "no inbox access", 403);
    c.set("inboxViewer", viewer);
    await next();
  };
}

function need(c: Context, cap: Capability): void {
  if (!c.get("inboxViewer").capabilities.includes(cap)) {
    throw new BusinessError("forbidden", `missing capability: ${cap}`, 403);
  }
}

/** Load a conversation the viewer may see — 404 (not 403) otherwise, so its existence isn't revealed. */
async function visibleConversation(db: DbClient, c: Context, id: string) {
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

const SendBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), body: z.string().trim().min(1).max(4096) }),
  z.object({
    type: z.enum(["image", "document", "audio", "video"]),
    media_key: z
      .string()
      .regex(/^inbox\/outgoing\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,6}$/, "invalid upload"),
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
  }),
]);

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
      .select({ id: inboxPhoneNumber.id, label: inboxPhoneNumber.label, e164: inboxPhoneNumber.e164, channels: inboxPhoneNumber.channels })
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
        capabilities: v.capabilities.filter((x) => /^(inbox|calls|recordings|transcripts)\./.test(x)),
        team_ids: v.teamIds,
        numbers,
      },
    });
  });

  // ── Live updates (Server-Sent Events) ──
  r.get("/stream", async (c) => {
    const viewer = c.get("inboxViewer");
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
    if (q.q && q.q.trim()) {
      const term = `%${q.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const digits = q.q.replace(/\D/g, "");
      conds.push(
        or(
          ilike(customer.name, term),
          ...(digits.length >= 4 ? [sql`regexp_replace(coalesce(${customer.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`] : []),
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
      .where(and(...conds))
      .orderBy(desc(inboxConversation.lastActivityAt))
      .limit(limit + 1);

    const now = new Date();
    const page = rows.slice(0, limit).map((row) => ({
      ...row,
      window_remaining_ms: waWindowRemainingMs(row.last_inbound_wa_at, now),
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
    return c.json({
      data: {
        ...conv,
        customer: cust ? { id: cust.id, name: cust.name, phone: cust.phone, email: cust.email, notes: cust.notes } : null,
        number: num ? { id: num.id, label: num.label, e164: num.e164, channels: num.channels } : null,
        assignee: ass ? { id: ass.id, name: ass.name ?? ass.email } : null,
        team: team ? { id: team.id, name: team.name } : null,
        window_remaining_ms: waWindowRemainingMs(conv.lastInboundWaAt),
        can_use_number: canUseNumber(c.get("inboxViewer"), conv.phoneNumberId),
      },
    });
  });

  /** Messages, calls (with recordings) and notes in time order. */
  r.get("/conversations/:id/timeline", async (c) => {
    const conv = await visibleConversation(db, c, c.req.param("id"));
    return c.json({ data: await buildTimeline(db, c.get("inboxViewer"), [conv.id]) });
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
      // Blue ticks on WhatsApp for the newest inbound message (best effort).
      const cfg = metaConfigFromEnv();
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
      });
      await audit(db, c, "inbox.message_send", "inbox_message", msg.id, { conversation_id: conv.id, type: msg.type, status: msg.status });
      return c.json({ data: msg }, msg.status === "failed" ? 502 : 201);
    } catch (err) {
      if (err instanceof InboxSendError) {
        const status = err.code === "not_configured" ? 503 : 409;
        throw new BusinessError(status === 503 ? "service_unavailable" : "conflict", err.message, status, { reason: err.code });
      }
      throw err;
    }
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
      .object({ filename: z.string().min(1).max(240), content_type: z.string().max(200), size_bytes: z.number().int().positive() })
      .parse(await c.req.json());
    const res = await presignInboxPut({ filename: body.filename, contentType: body.content_type, sizeBytes: body.size_bytes });
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

  // ── Templates and quick replies ──
  r.get("/templates", async (c) => {
    const rows = await db.select().from(inboxTemplate).orderBy(asc(inboxTemplate.name));
    return c.json({
      data: rows.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components,
        param_count: templateParamCount(t.components),
        waba_id: t.wabaId,
      })),
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
        conversations: convs,
        timeline: c.req.query("timeline") ? await buildTimeline(db, v, convs.map((x) => x.id)) : undefined,
      },
    });
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
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .where(conversationScope(c.get("inboxViewer")))
      .groupBy(customer.id)
      .orderBy(desc(sql`max(${inboxConversation.lastActivityAt})`));
    await audit(db, c, "inbox.contacts_export", "customer", "export", { rows: rows.length });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="inbox-contacts.csv"');
    return c.body(toCsv(["Name", "Phone", "Conversations", "Last activity"], rows.map((r2) => [r2.name, r2.phone, r2.conversations, r2.last_activity])));
  });

  return r;
}

// ── Helpers shared with settings / worker-style jobs ─────────────────────────

export async function syncTemplatesForWaba(db: DbClient, cfg: NonNullable<ReturnType<typeof metaConfigFromEnv>>, wabaId: string): Promise<number> {
  const templates = await listTemplates(cfg, wabaId);
  const now = new Date();
  for (const t of templates) {
    await db
      .insert(inboxTemplate)
      .values({
        wabaId,
        name: t.name,
        language: t.language,
        category: t.category ?? null,
        status: t.status,
        components: t.components ?? [],
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [inboxTemplate.wabaId, inboxTemplate.name, inboxTemplate.language],
        set: { status: t.status, category: t.category ?? null, components: t.components ?? [], syncedAt: now },
      });
  }
  return templates.length;
}

type TimelineItem =
  | { kind: "message"; at: string; data: Record<string, unknown> }
  | { kind: "call"; at: string; data: Record<string, unknown> }
  | { kind: "note"; at: string; data: Record<string, unknown> };

const TIMELINE_LIMIT = 500;

async function buildTimeline(db: DbClient, v: InboxViewer, conversationIds: string[]): Promise<TimelineItem[]> {
  if (conversationIds.length === 0) return [];
  const staff = alias(adminUser, "staff");

  const messages = await db
    .select({
      id: inboxMessage.id,
      conversation_id: inboxMessage.conversationId,
      direction: inboxMessage.direction,
      type: inboxMessage.type,
      body: inboxMessage.body,
      has_media: sql<boolean>`${inboxMessage.mediaKey} is not null`,
      media_pending: sql<boolean>`${inboxMessage.mediaId} is not null and ${inboxMessage.mediaKey} is null`,
      media_mime: inboxMessage.mediaMime,
      media_filename: inboxMessage.mediaFilename,
      template_name: inboxMessage.templateName,
      status: inboxMessage.status,
      error_message: inboxMessage.errorMessage,
      sender_name: sql<string | null>`coalesce(${staff.name}, ${staff.email})`,
      created_at: inboxMessage.createdAt,
    })
    .from(inboxMessage)
    .leftJoin(staff, eq(staff.id, inboxMessage.senderUserId))
    .where(inArray(inboxMessage.conversationId, conversationIds))
    .orderBy(desc(inboxMessage.createdAt))
    .limit(TIMELINE_LIMIT);

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
    .where(inArray(inboxCall.conversationId, conversationIds))
    .orderBy(desc(inboxCall.startedAt))
    .limit(TIMELINE_LIMIT);

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
    .where(inArray(inboxNote.conversationId, conversationIds))
    .orderBy(desc(inboxNote.createdAt))
    .limit(TIMELINE_LIMIT);

  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.created_at.toISOString(), data: m })),
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
  return items.slice(-TIMELINE_LIMIT);
}
