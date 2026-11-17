/**
 * Phone calls (Twilio Programmable Voice) for the unified inbox.
 *
 * Two routers:
 *   voiceWebhookRoutes(db) – public, Twilio-signed. Mount at /v1/voice.
 *   voiceAppRoutes(db)     – staff, authenticated. Mount at /v1/inbox/voice.
 *
 * Twilio console set-up this code expects:
 *   Business number → "A call comes in"      POST {PUBLIC_API_URL}/v1/voice/incoming
 *   Business number → "Call status changes"  POST {PUBLIC_API_URL}/v1/voice/status
 *   TwiML App (TWILIO_TWIML_APP_SID) Voice URL POST {PUBLIC_API_URL}/v1/voice/outbound
 *   TwiML App Status Callback               POST {PUBLIC_API_URL}/v1/voice/status
 *
 * Every webhook is checked against X-Twilio-Signature using the exact URL
 * {PUBLIC_API_URL}/v1/voice/<path>?<query>, so PUBLIC_API_URL must be the URL
 * Twilio is configured with (scheme, host, no trailing path).
 *
 * Missed-call / after-hours WhatsApp follow-ups are NOT sent here; the worker
 * picks them up (apps/worker/src/jobs/inbox-voice.ts).
 */
import { Hono, type Context } from "hono";
import { and, asc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  adminUser,
  customer,
  inboxCall,
  inboxConversation,
  inboxHoliday,
  inboxHoursProfile,
  inboxHoursRule,
  inboxIvrMenu,
  inboxIvrOption,
  inboxPhoneNumber,
  inboxPresence,
  inboxRecording,
  inboxTeamMember,
  inboxUserNumberAccess,
  inboxWebhookEvent,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  findOrCreateCustomer,
  findOrOpenConversation,
  publishInboxEvent,
  signalFor,
  touchConversation,
  twiml,
  userIdFromVoiceIdentity,
  verifyTwilioSignature,
  voiceAccessToken,
  voiceIdentityFor,
  type ConversationRow,
  type TwiML,
} from "@ms/domain";
import { isOpenNow, resolveCapabilities, toE164, type Capability, type PermissionOverrides } from "@ms/shared";
import { requireAnyCapability, requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";

export const VOICE_WEBHOOK_PREFIX = "/v1/voice";

const RECORDING_NOTICE = "This call may be recorded for quality and training.";
const DEFAULT_AFTER_HOURS =
  "Thank you for calling. We are closed right now. Please leave a message after the tone and we will get back to you.";
const VOICEMAIL_PROMPT = "Sorry, no one is available to take your call. Please leave a message after the tone.";
const UNKNOWN_NUMBER = "Sorry, this number is not in service. Goodbye.";
const WITHHELD_CALLER = "Sorry, we cannot take calls from withheld numbers. Please call again with your number shown. Goodbye.";
const ERROR_MESSAGE = "Sorry, we are having trouble right now. Please try again later. Goodbye.";
const RING_TIMEOUT_S = 25;
/** "Online" = heartbeat within this window. The web app beats every 30s. */
const PRESENCE_FRESH_MS = 90_000;
/** Twilio allows at most 10 nouns in one <Dial>. */
const MAX_DIAL_CLIENTS = 10;
const FINAL_CALL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NumberRow = typeof inboxPhoneNumber.$inferSelect;
type CallRow = typeof inboxCall.$inferSelect;
type Params = Record<string, string>;

// ── URL helpers ──────────────────────────────────────────────────────────────

function publicBase(): string {
  return (process.env.PUBLIC_API_URL ?? "").replace(/\/+$/, "");
}

/** Absolute webhook URL Twilio should call next (and that we verify against). */
function voiceUrl(path: string, query: Record<string, string | number> = {}): string {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return `${publicBase()}${VOICE_WEBHOOK_PREFIX}${path}${qs ? `?${qs}` : ""}`;
}

function xml(c: Context, body: TwiML | string) {
  return c.body(typeof body === "string" ? body : body.toString(), 200, { "content-type": "text/xml; charset=utf-8" });
}

const emptyResponse = () => twiml();

// ── Webhook wrapper: signature, raw log, error handling ──────────────────────

type WebhookHandler = (ctx: {
  c: Context;
  params: Params;
  query: Params;
}) => Promise<TwiML>;

function twilioWebhook(db: DbClient, path: string, handler: WebhookHandler) {
  return async (c: Context) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
    const body = await c.req.parseBody({ all: true });
    const signed: Record<string, string | string[]> = {};
    const params: Params = {};
    for (const [k, v] of Object.entries(body)) {
      const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      if (values.length === 0) continue;
      signed[k] = values.length === 1 ? values[0]! : values;
      params[k] = values[0]!;
    }
    const search = new URL(c.req.url).search;
    const url = `${publicBase()}${VOICE_WEBHOOK_PREFIX}${path}${search}`;
    if (!authToken || !verifyTwilioSignature(url, signed, c.req.header("x-twilio-signature"), authToken)) {
      logger.warn({ path }, "twilio webhook signature rejected");
      return c.text("forbidden", 403);
    }
    const query: Params = Object.fromEntries(new URL(c.req.url).searchParams.entries());

    const [event] = await db
      .insert(inboxWebhookEvent)
      .values({ source: "twilio", kind: path.replace(/^\//, ""), payload: { params, query } })
      .returning({ id: inboxWebhookEvent.id });

    try {
      const out = await handler({ c, params, query });
      await db.update(inboxWebhookEvent).set({ processedAt: new Date() }).where(eq(inboxWebhookEvent.id, event!.id));
      return xml(c, out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, path, callSid: params.CallSid }, "twilio webhook failed");
      await db
        .update(inboxWebhookEvent)
        .set({ attempts: sql`${inboxWebhookEvent.attempts} + 1`, lastError: message.slice(0, 1000) })
        .where(eq(inboxWebhookEvent.id, event!.id))
        .catch(() => undefined);
      // Answer with TwiML anyway: a 5xx makes Twilio play its own error message.
      return xml(c, twiml().say(ERROR_MESSAGE).hangup());
    }
  };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

async function findBusinessNumber(db: DbExecutor, to: string | undefined): Promise<NumberRow | null> {
  if (!to) return null;
  const byMatch = await db
    .select()
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.inboundMatch, to), eq(inboxPhoneNumber.isActive, true)))
    .limit(1);
  if (byMatch[0]) return byMatch[0];
  const e164 = toE164(to);
  if (!e164) return null;
  const [byE164] = await db
    .select()
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.e164, e164), eq(inboxPhoneNumber.isActive, true)))
    .limit(1);
  return byE164 ?? null;
}

async function isNumberOpen(db: DbExecutor, num: NumberRow, now: Date): Promise<boolean> {
  if (!num.hoursProfileId) return true;
  const [profile] = await db.select().from(inboxHoursProfile).where(eq(inboxHoursProfile.id, num.hoursProfileId));
  if (!profile) return true;
  const rules = await db
    .select({ weekday: inboxHoursRule.weekday, openTime: inboxHoursRule.openTime, closeTime: inboxHoursRule.closeTime })
    .from(inboxHoursRule)
    .where(eq(inboxHoursRule.profileId, profile.id));
  const holidays = await db
    .select({ date: inboxHoliday.date })
    .from(inboxHoliday)
    .where(sql`${inboxHoliday.profileId} = ${profile.id} or ${inboxHoliday.profileId} is null`);
  return isOpenNow(rules, holidays.map((h) => String(h.date)), now, profile.timeZone);
}

async function loadCallContext(db: DbExecutor, callId: string | undefined) {
  if (!callId || !UUID_RE.test(callId)) return null;
  const [row] = await db
    .select({ call: inboxCall, num: inboxPhoneNumber, conv: inboxConversation })
    .from(inboxCall)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxCall.phoneNumberId))
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
    .where(eq(inboxCall.id, callId));
  return row ?? null;
}

async function loadMenu(db: DbExecutor, menuId: string | null) {
  if (!menuId) return null;
  const [menu] = await db.select().from(inboxIvrMenu).where(eq(inboxIvrMenu.id, menuId));
  if (!menu) return null;
  const options = await db
    .select()
    .from(inboxIvrOption)
    .where(eq(inboxIvrOption.menuId, menu.id))
    .orderBy(asc(inboxIvrOption.digit));
  return { menu, options };
}

type Menu = NonNullable<Awaited<ReturnType<typeof loadMenu>>>;
type MenuOption = Menu["options"][number];

/** The option used when the caller presses nothing: the lowest digit. */
function defaultOption(options: readonly MenuOption[]): MenuOption | null {
  const numeric = options.filter((o) => /^\d$/.test(o.digit)).sort((a, b) => Number(a.digit) - Number(b.digit));
  return numeric[0] ?? options[0] ?? null;
}

function capsOf(user: { role: typeof adminUser.$inferSelect.role; permissionOverrides: unknown }): Capability[] {
  return resolveCapabilities(user.role, user.permissionOverrides as PermissionOverrides);
}

async function hasNumberAccess(db: DbExecutor, userId: string, caps: readonly Capability[], numberId: string) {
  if (caps.includes("inbox.view_all")) return true;
  const [row] = await db
    .select({ userId: inboxUserNumberAccess.userId })
    .from(inboxUserNumberAccess)
    .where(and(eq(inboxUserNumberAccess.userId, userId), eq(inboxUserNumberAccess.phoneNumberId, numberId)));
  return !!row;
}

/**
 * Staff of `teamId` who can be rung on `numberId` right now: available, seen in
 * the last 90s, active, holding calls.answer, and (unless inbox.view_all)
 * granted that number.
 */
export async function onlineStaffFor(
  db: DbExecutor,
  teamId: string,
  numberId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: adminUser.id, role: adminUser.role, permissionOverrides: adminUser.permissionOverrides })
    .from(inboxTeamMember)
    .innerJoin(adminUser, eq(adminUser.id, inboxTeamMember.userId))
    .innerJoin(inboxPresence, eq(inboxPresence.userId, adminUser.id))
    .where(
      and(
        eq(inboxTeamMember.teamId, teamId),
        eq(inboxPresence.available, true),
        gte(inboxPresence.lastSeenAt, new Date(now.getTime() - PRESENCE_FRESH_MS)),
        eq(adminUser.isActive, true),
        isNull(adminUser.deletedAt),
      ),
    )
    .orderBy(asc(inboxPresence.lastSeenAt));
  const eligible = rows
    .map((r) => ({ id: r.id, caps: capsOf(r) }))
    .filter((r) => r.caps.includes("calls.answer"));
  const needAccess = eligible.filter((r) => !r.caps.includes("inbox.view_all")).map((r) => r.id);
  const granted = new Set<string>();
  if (needAccess.length > 0) {
    const access = await db
      .select({ userId: inboxUserNumberAccess.userId })
      .from(inboxUserNumberAccess)
      .where(and(eq(inboxUserNumberAccess.phoneNumberId, numberId), inArray(inboxUserNumberAccess.userId, needAccess)));
    for (const a of access) granted.add(a.userId);
  }
  return eligible.filter((r) => r.caps.includes("inbox.view_all") || granted.has(r.id)).map((r) => r.id);
}

// ── Call-state updates ───────────────────────────────────────────────────────

async function publishCall(db: DbExecutor, conv: ConversationRow, callId: string) {
  await publishInboxEvent(db, signalFor("call.updated", conv, callId));
}

/** Mark an unanswered inbound call missed, bump the thread as unread. */
async function markMissed(db: DbExecutor, call: CallRow, preview = "Missed call") {
  const [updated] = await db
    .update(inboxCall)
    .set({ outcome: "missed" })
    .where(and(eq(inboxCall.id, call.id), eq(inboxCall.outcome, "in_progress")))
    .returning({ id: inboxCall.id });
  if (!updated) return;
  const conv = await touchConversation(db, call.conversationId, { preview, unreadIncrement: true });
  await publishCall(db, conv, call.id);
  await publishInboxEvent(db, signalFor("conversation.updated", conv));
}

// ── TwiML fragments ──────────────────────────────────────────────────────────

function appendVoicemail(t: TwiML, callId: string, prompt: string): TwiML {
  return t
    .say(prompt)
    .record({
      maxLength: 120,
      playBeep: true,
      action: voiceUrl("/done"),
      recordingStatusCallback: voiceUrl("/recording", { kind: "voicemail", callId }),
    })
    .hangup();
}

function appendMenu(t: TwiML, callId: string, menu: Menu, attempt: number): TwiML {
  const next = voiceUrl("/menu", { callId, attempt });
  return t.gather({ numDigits: 1, timeout: 5, action: next }, { say: menu.menu.greetingText }).redirect(next);
}

async function ringTeam(
  db: DbExecutor,
  ctx: { call: CallRow; num: NumberRow; conv: ConversationRow },
  teamId: string | null,
  t: TwiML,
): Promise<TwiML> {
  const { call, num } = ctx;
  if (teamId && teamId !== call.teamId) {
    await db.update(inboxCall).set({ teamId }).where(eq(inboxCall.id, call.id));
  }
  const userIds = teamId ? (await onlineStaffFor(db, teamId, num.id)).slice(0, MAX_DIAL_CLIENTS) : [];
  if (userIds.length === 0) {
    await markMissed(db, call);
    return appendVoicemail(t, call.id, VOICEMAIL_PROMPT);
  }
  await publishInboxEvent(db, { ...signalFor("call.ringing", ctx.conv, call.id), userIds });
  return t.dialClients(
    userIds.map((id) => ({ identity: voiceIdentityFor(id), params: { callId: call.id, callSid: call.twilioCallSid } })),
    {
      timeout: RING_TIMEOUT_S,
      record: "record-from-answer-dual",
      recordingStatusCallback: voiceUrl("/recording", { kind: "call", callId: call.id }),
      action: voiceUrl("/dial-result", { callId: call.id }),
    },
  );
}

async function runOption(
  db: DbExecutor,
  ctx: { call: CallRow; num: NumberRow; conv: ConversationRow },
  option: MenuOption,
  t: TwiML,
): Promise<TwiML> {
  await db.update(inboxCall).set({ ivrChoice: option.digit }).where(eq(inboxCall.id, ctx.call.id));
  switch (option.action) {
    case "ring_team":
      return ringTeam(db, ctx, option.teamId ?? ctx.num.defaultTeamId, t);
    case "voicemail":
      if (option.teamId) await db.update(inboxCall).set({ teamId: option.teamId }).where(eq(inboxCall.id, ctx.call.id));
      return appendVoicemail(t, ctx.call.id, "Please leave a message after the tone.");
    case "play":
      // Informational only: not a missed call, so no WhatsApp follow-up.
      await db
        .update(inboxCall)
        .set({ outcome: "information" })
        .where(and(eq(inboxCall.id, ctx.call.id), eq(inboxCall.outcome, "in_progress")));
      return t.say(option.playText ?? option.label).hangup();
  }
}

// ── Public webhooks ──────────────────────────────────────────────────────────

export function voiceWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post(
    "/incoming",
    twilioWebhook(db, "/incoming", async ({ params }) => {
      const now = new Date();
      const num = await findBusinessNumber(db, params.To);
      if (!num || num.channels === "whatsapp") return twiml().say(UNKNOWN_NUMBER).hangup();
      const fromE164 = toE164(params.From);
      if (!fromE164) return twiml().say(WITHHELD_CALLER).hangup();
      const callSid = params.CallSid;
      if (!callSid) throw new Error("missing CallSid");

      return db.transaction(async (tx) => {
        const cust = await findOrCreateCustomer(tx, fromE164, { name: params.CallerName || null, source: "phone" });
        const { conversation } = await findOrOpenConversation(tx, cust.id, num.id, now);
        await tx
          .insert(inboxCall)
          .values({
            conversationId: conversation.id,
            customerId: cust.id,
            phoneNumberId: num.id,
            teamId: num.defaultTeamId,
            twilioCallSid: callSid,
            direction: "in",
            fromE164,
            toE164: num.e164,
            startedAt: now,
          })
          .onConflictDoNothing({ target: inboxCall.twilioCallSid });
        // A Twilio retry of the same call reuses the row.
        const [call] = await tx.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, callSid));
        const conv = await touchConversation(tx, conversation.id, { preview: "Incoming call", at: now });
        await publishCall(tx, conv, call!.id);
        await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        const ctx = { call: call!, num, conv };

        if (!(await isNumberOpen(tx, num, now))) {
          await tx
            .update(inboxCall)
            .set({ outcome: "after_hours" })
            .where(and(eq(inboxCall.id, call!.id), eq(inboxCall.outcome, "in_progress")));
          const closedConv = await touchConversation(tx, conv.id, { preview: "After-hours call", unreadIncrement: true, at: now });
          await publishCall(tx, closedConv, call!.id);
          return appendVoicemail(twiml(), call!.id, num.afterHoursText || DEFAULT_AFTER_HOURS);
        }

        const t = twiml().say(RECORDING_NOTICE);
        const menu = await loadMenu(tx, num.ivrMenuId);
        if (!menu || menu.options.length === 0) return ringTeam(tx, ctx, num.defaultTeamId, t);
        return appendMenu(t, call!.id, menu, 1);
      });
    }),
  );

  r.post(
    "/menu",
    twilioWebhook(db, "/menu", async ({ params, query }) => {
      const attempt = Math.max(1, Number(query.attempt ?? "1") || 1);
      return db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx) return twiml().say(ERROR_MESSAGE).hangup();
        const menu = await loadMenu(tx, ctx.num.ivrMenuId);
        if (!menu || menu.options.length === 0) return ringTeam(tx, ctx, ctx.num.defaultTeamId, twiml());

        const digits = params.Digits?.trim();
        const chosen = digits ? menu.options.find((o) => o.digit === digits) : undefined;
        if (chosen) return runOption(tx, ctx, chosen, twiml());

        // No input, or a key that isn't on the menu: prompt once more, then fall back.
        if (attempt < 2) {
          const t = digits ? twiml().say("Sorry, that is not an option.") : twiml();
          return appendMenu(t, ctx.call.id, menu, attempt + 1);
        }
        const fallback = defaultOption(menu.options);
        if (!fallback) return ringTeam(tx, ctx, ctx.num.defaultTeamId, twiml());
        return runOption(tx, ctx, fallback, twiml());
      });
    }),
  );

  r.post(
    "/dial-result",
    twilioWebhook(db, "/dial-result", async ({ params, query }) => {
      const status = params.DialCallStatus ?? "";
      const answered = status === "completed" || status === "answered";
      const dialSeconds = Number(params.DialCallDuration ?? "");
      return db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx) return twiml().hangup();
        const { call } = ctx;

        if (answered) {
          const answeredAt =
            call.answeredAt ??
            (Number.isFinite(dialSeconds) && dialSeconds > 0 ? new Date(Date.now() - dialSeconds * 1000) : new Date());
          await tx
            .update(inboxCall)
            .set({
              outcome: "answered",
              answeredAt,
              ...(call.direction === "out" && !call.answeredByUserId && call.startedByUserId
                ? { answeredByUserId: call.startedByUserId }
                : {}),
            })
            .where(and(eq(inboxCall.id, call.id), inArray(inboxCall.outcome, ["in_progress", "answered"])));
          await publishCall(tx, ctx.conv, call.id);
          return twiml().hangup();
        }

        if (call.direction === "out") {
          await tx
            .update(inboxCall)
            .set({ outcome: status === "failed" ? "failed" : "missed" })
            .where(and(eq(inboxCall.id, call.id), eq(inboxCall.outcome, "in_progress")));
          await publishCall(tx, ctx.conv, call.id);
          return twiml().hangup();
        }

        // Inbound and nobody picked up (or someone accepted then the leg failed).
        if (call.outcome === "answered") return twiml().hangup();
        await markMissed(tx, call);
        return appendVoicemail(twiml(), call.id, VOICEMAIL_PROMPT);
      });
    }),
  );

  r.post(
    "/recording",
    twilioWebhook(db, "/recording", async ({ params, query }) => {
      if (params.RecordingStatus !== "completed" || !params.RecordingSid) return emptyResponse();
      const kind = query.kind === "voicemail" ? "voicemail" : "call";
      await db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx) {
          logger.warn({ callId: query.callId, recordingSid: params.RecordingSid }, "recording for unknown call");
          return;
        }
        const duration = Number(params.RecordingDuration ?? "");
        const channels = Number(params.RecordingChannels ?? "");
        const inserted = await tx
          .insert(inboxRecording)
          .values({
            callId: ctx.call.id,
            twilioRecordingSid: params.RecordingSid!,
            twilioRecordingUrl: params.RecordingUrl ?? null,
            kind,
            status: "pending",
            durationS: Number.isFinite(duration) ? Math.round(duration) : null,
            channels: Number.isFinite(channels) && channels > 0 ? channels : null,
          })
          .onConflictDoNothing({ target: inboxRecording.twilioRecordingSid })
          .returning({ id: inboxRecording.id });
        if (inserted.length === 0) return; // Twilio retry; already have it.

        let conv = ctx.conv;
        if (kind === "voicemail") {
          await tx
            .update(inboxCall)
            .set({ outcome: "voicemail" })
            .where(and(eq(inboxCall.id, ctx.call.id), ne(inboxCall.outcome, "after_hours")));
          conv = await touchConversation(tx, ctx.conv.id, { preview: "Voicemail", unreadIncrement: true });
          await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        }
        await publishCall(tx, conv, ctx.call.id);
      });
      return emptyResponse();
    }),
  );

  r.post(
    "/status",
    twilioWebhook(db, "/status", async ({ params }) => {
      const status = params.CallStatus ?? "";
      if (!FINAL_CALL_STATUSES.has(status) || !params.CallSid) return emptyResponse();
      await db.transaction(async (tx) => {
        const [call] = await tx.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, params.CallSid!));
        if (!call) return;
        const duration = Number(params.CallDuration ?? "");
        const neverAnswered = call.outcome === "in_progress" && !call.answeredAt;
        await tx
          .update(inboxCall)
          .set({
            endedAt: call.endedAt ?? new Date(),
            ...(Number.isFinite(duration) ? { durationS: Math.round(duration) } : {}),
            ...(neverAnswered && call.direction === "out" ? { outcome: status === "failed" ? "failed" : "missed" } : {}),
          })
          .where(eq(inboxCall.id, call.id));
        if (neverAnswered && call.direction === "in") {
          await markMissed(tx, call);
        }
        const [conv] = await tx.select().from(inboxConversation).where(eq(inboxConversation.id, call.conversationId));
        if (conv) await publishCall(tx, conv, call.id);
      });
      return emptyResponse();
    }),
  );

  /** Browser (Voice SDK) outbound call: the TwiML App's Voice URL. */
  r.post(
    "/outbound",
    twilioWebhook(db, "/outbound", async ({ params }) => {
      const userId = userIdFromVoiceIdentity(params.From ?? params.Caller);
      const callSid = params.CallSid;
      if (!userId || !callSid) return twiml().say("Sorry, this call is not allowed.").hangup();

      const [user] = await db
        .select({ id: adminUser.id, role: adminUser.role, permissionOverrides: adminUser.permissionOverrides })
        .from(adminUser)
        .where(and(eq(adminUser.id, userId), eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));
      if (!user) return twiml().say("Sorry, this call is not allowed.").hangup();
      const caps = capsOf(user);
      if (!caps.includes("calls.outbound")) return twiml().say("Sorry, you are not allowed to make calls.").hangup();

      const numberId = params.callerNumberId;
      const [num] =
        numberId && UUID_RE.test(numberId)
          ? await db
              .select()
              .from(inboxPhoneNumber)
              .where(and(eq(inboxPhoneNumber.id, numberId), eq(inboxPhoneNumber.isActive, true)))
          : [];
      if (!num || num.channels === "whatsapp") return twiml().say("Sorry, that business number cannot make calls.").hangup();
      if (!(await hasNumberAccess(db, user.id, caps, num.id))) {
        return twiml().say("Sorry, you cannot call from that business number.").hangup();
      }

      // "To" is a customer id or a phone number.
      const rawTo = (params.To ?? "").trim();
      let customerId: string | null = null;
      let toNumber: string | null = null;
      if (UUID_RE.test(rawTo)) {
        const [cust] = await db
          .select({ id: customer.id, phone: customer.phone })
          .from(customer)
          .where(and(eq(customer.id, rawTo), isNull(customer.deletedAt)));
        if (cust) {
          customerId = cust.id;
          toNumber = toE164(cust.phone);
        }
      } else {
        toNumber = toE164(rawTo);
      }
      if (!toNumber) return twiml().say("Sorry, that phone number is not valid.").hangup();
      const dialTo = toNumber;

      return db.transaction(async (tx) => {
        const custId = customerId ?? (await findOrCreateCustomer(tx, dialTo, { source: "phone" })).id;
        const { conversation } = await findOrOpenConversation(tx, custId, num.id);
        await tx
          .insert(inboxCall)
          .values({
            conversationId: conversation.id,
            customerId: custId,
            phoneNumberId: num.id,
            teamId: conversation.teamId,
            twilioCallSid: callSid,
            direction: "out",
            fromE164: num.e164,
            toE164: dialTo,
            startedByUserId: user.id,
          })
          .onConflictDoNothing({ target: inboxCall.twilioCallSid });
        const [call] = await tx.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, callSid));
        const conv = await touchConversation(tx, conversation.id, { preview: "Outgoing call" });
        await publishCall(tx, conv, call!.id);
        await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        return twiml().dialNumber(dialTo, {
          callerId: num.e164,
          answerOnBridge: true,
          timeout: 30,
          record: "record-from-answer-dual",
          recordingStatusCallback: voiceUrl("/recording", { kind: "call", callId: call!.id }),
          action: voiceUrl("/dial-result", { callId: call!.id }),
        });
      });
    }),
  );

  /** <Record action>: without it Twilio would re-request the current URL. */
  r.post(
    "/done",
    twilioWebhook(db, "/done", async () => twiml().hangup()),
  );

  return r;
}

// ── Staff routes ─────────────────────────────────────────────────────────────

const PresenceBody = z.object({ available: z.boolean() });

const TOKEN_TTL_S = 3600;

export function voiceAppRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  /** Voice SDK access token for the signed-in user. */
  r.get("/token", requireAnyCapability("calls.answer", "calls.outbound"), async (c) => {
    const auth = c.get("auth");
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const appSid = process.env.TWILIO_TWIML_APP_SID;
    if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
      throw new BusinessError("service_unavailable", "Phone calls are not configured on this server", 503);
    }
    const identity = voiceIdentityFor(auth.userId);
    const token = voiceAccessToken({
      accountSid,
      apiKeySid,
      apiKeySecret,
      identity,
      outgoingApplicationSid: appSid,
      ttlSeconds: TOKEN_TTL_S,
      incomingAllow: auth.capabilities.includes("calls.answer"),
    });
    return c.json({ data: { token, identity, ttl: TOKEN_TTL_S } });
  });

  /** Heartbeat: the web app calls this every 30s while open. */
  r.post("/presence", requireCapability("calls.answer"), async (c) => {
    const auth = c.get("auth");
    const body = PresenceBody.parse(await c.req.json());
    const now = new Date();
    await db
      .insert(inboxPresence)
      .values({ userId: auth.userId, available: body.available, lastSeenAt: now })
      .onConflictDoUpdate({ target: inboxPresence.userId, set: { available: body.available, lastSeenAt: now } });
    return c.json({ data: { available: body.available, last_seen_at: now.toISOString() } });
  });

  /**
   * The browser accepted a ringing call. `:ref` is the inbox call id (the
   * Client <Parameter name="callId">, i.e. call.customParameters.get("callId"))
   * or the parent Twilio CallSid. First accept wins.
   */
  r.post("/calls/:ref/accepted", requireCapability("calls.answer"), async (c) => {
    const auth = c.get("auth");
    const ref = c.req.param("ref");
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [call] = await tx
        .select()
        .from(inboxCall)
        .where(UUID_RE.test(ref) ? eq(inboxCall.id, ref) : eq(inboxCall.twilioCallSid, ref));
      if (!call) throw new BusinessError("not_found", "call not found", 404);
      if (!(await hasNumberAccess(tx, auth.userId, auth.capabilities, call.phoneNumberId))) {
        throw new BusinessError("forbidden", "no access to this business number", 403);
      }
      const [updated] = await tx
        .update(inboxCall)
        .set({ answeredByUserId: auth.userId, answeredAt: now, outcome: "answered" })
        .where(and(eq(inboxCall.id, call.id), isNull(inboxCall.answeredByUserId), eq(inboxCall.outcome, "in_progress")))
        .returning();
      if (!updated) {
        if (call.answeredByUserId === auth.userId) return call;
        throw new BusinessError("conflict", "call already answered or ended", 409);
      }
      const [conv] = await tx.select().from(inboxConversation).where(eq(inboxConversation.id, call.conversationId));
      if (conv) await publishCall(tx, conv, call.id);
      return updated;
    });
    return c.json({ data: result });
  });

  return r;
}
