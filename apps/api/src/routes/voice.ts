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
import { bodyLimit } from "hono/body-limit";
import { Hono, type Context } from "hono";
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CALL_FEATURES_KEY,
  appSetting,
  type CallFeaturesValue,
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
  inboxPushToken,
  inboxTeam,
  inboxRecording,
  inboxTeamMember,
  inboxUserNumberAccess,
  inboxWebhookEvent,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  canSeeConversation,
  redirectCall,
  twilioRestConfigFromEnv,
  findOrCreateCustomer,
  ts,
  findOrOpenConversation,
  publishInboxEvent,
  signalFor,
  touchConversation,
  twiml,
  userIdFromVoiceIdentity,
  verifyTwilioSignature,
  voiceAccessToken,
  voiceIdentityFor,
  nextPresence,
  LIVE_CALL_MAX_AGE_MS,
  MONITOR_MODES,
  conferenceRoomFor,
  queueNameFor,
  queuePositionMessage,
  queueWaitPlan,
  readCallFeatures,
  ringPlan,
  type MonitorMode,
  type ConversationRow,
  type TwiML,
} from "@ms/domain";
import { isOpenNow, resolveCapabilities, toE164, type Capability, type PermissionOverrides } from "@ms/shared";
import { requireAnyCapability, requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";
import { reloadViewer } from "../inbox/realtime.js";
import { presignInboxGet } from "../lib/r2.js";
import { writeAudit } from "../middleware/audit.js";

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
export function voiceUrl(path: string, query: Record<string, string | number> = {}): string {
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
    .where(and(eq(inboxPhoneNumber.inboundMatch, to), eq(inboxPhoneNumber.isActive, true), eq(inboxPhoneNumber.kind, "phone")))
    .limit(1);
  if (byMatch[0]) return byMatch[0];
  const e164 = toE164(to);
  if (!e164) return null;
  const [byE164] = await db
    .select()
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.e164, e164), eq(inboxPhoneNumber.isActive, true), eq(inboxPhoneNumber.kind, "phone")))
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
/**
 * A phone that opened the app within this window can be rung while closed
 * (Twilio wakes it by push). 30 days: staff who marked themselves available
 * keep ringing over nights and weekends; signing out removes the device.
 */
const MOBILE_REACHABLE_MS = 30 * 24 * 60 * 60 * 1000;

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
        or(
          gte(inboxPresence.lastSeenAt, new Date(now.getTime() - PRESENCE_FRESH_MS)),
          // A phone with the app installed rings even when closed (Twilio push).
          sql`exists (select 1 from ${inboxPushToken} where ${inboxPushToken.userId} = ${adminUser.id}
                and ${inboxPushToken.platform} in ('ios','android')
                and ${inboxPushToken.lastSeenAt} > ${ts(new Date(now.getTime() - MOBILE_REACHABLE_MS))})`,
        ),
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

/** A short-lived link Twilio can fetch an uploaded greeting from; null if storage is off. */
async function greetingUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    return await presignInboxGet(key, { expiresIn: 3600 });
  } catch {
    return null; // fall back to the typed text
  }
}

function appendVoicemail(t: TwiML, callId: string, prompt: string, audioUrl: string | null = null): TwiML {
  return (audioUrl ? t.play(audioUrl) : t.say(prompt))
    .record({
      maxLength: 120,
      playBeep: true,
      action: voiceUrl("/done"),
      recordingStatusCallback: voiceUrl("/recording", { kind: "voicemail", callId }),
    })
    .hangup();
}

async function appendMenu(t: TwiML, callId: string, menu: Menu, attempt: number): Promise<TwiML> {
  const next = voiceUrl("/menu", { callId, attempt });
  const audio = await greetingUrl(menu.menu.greetingAudioKey);
  return t
    .gather({ numDigits: 1, timeout: 5, action: next }, audio ? { play: audio } : { say: menu.menu.greetingText })
    .redirect(next);
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
  const online = teamId ? await onlineStaffFor(db, teamId, num.id) : [];
  // Call queue (owner's beta switch): skip people already on a call; queue if all are busy.
  // Switched off (the default) nothing below changes: everyone online is rung, as before.
  if (online.length > 0 && (await loadCallFeatures(db)).enabled) {
    const plan = ringPlan(online, await busyStaff(db, online), true);
    if (plan.kind === "queue") return enqueueCall(db, ctx, t);
    if (plan.kind === "dial") return dialStaff(db, ctx, plan.userIds.slice(0, MAX_DIAL_CLIENTS), t);
  }
  const userIds = online.slice(0, MAX_DIAL_CLIENTS);
  if (userIds.length === 0) {
    await markMissed(db, call);
    return appendVoicemail(t, call.id, VOICEMAIL_PROMPT);
  }
  return dialStaff(db, ctx, userIds, t);
}

// ── Call queue and supervisor tools (owner's beta switch, OFF by default) ────

/** The owner's "call queue and supervisor tools" setting. No row = OFF. */
export async function loadCallFeatures(db: DbExecutor): Promise<CallFeaturesValue> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, CALL_FEATURES_KEY));
  return readCallFeatures(row?.value);
}

/** Which of these people are talking on a live call right now. */
export async function busyStaff(db: DbExecutor, userIds: readonly string[], now: Date = new Date()): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ answeredBy: inboxCall.answeredByUserId, startedBy: inboxCall.startedByUserId, direction: inboxCall.direction })
    .from(inboxCall)
    .where(
      and(
        isNull(inboxCall.endedAt),
        eq(inboxCall.outcome, "answered"),
        gte(inboxCall.startedAt, new Date(now.getTime() - LIVE_CALL_MAX_AGE_MS)),
        or(
          inArray(inboxCall.answeredByUserId, [...userIds]),
          and(eq(inboxCall.direction, "out"), inArray(inboxCall.startedByUserId, [...userIds])),
        ),
      ),
    );
  const busy = new Set<string>();
  for (const r of rows) {
    const who = r.direction === "out" ? r.startedBy : r.answeredBy;
    if (who) busy.add(who);
  }
  return busy;
}

/** Staff who could take this call right now and are not on another call. */
async function freeStaffFor(db: DbExecutor, ctx: { call: CallRow; num: NumberRow }): Promise<string[]> {
  const teamId = ctx.call.teamId ?? ctx.num.defaultTeamId;
  if (!teamId) return [];
  const online = await onlineStaffFor(db, teamId, ctx.num.id);
  const busy = await busyStaff(db, online);
  return online.filter((id) => !busy.has(id));
}

/** Everyone is busy: the caller waits in this line's queue with hold music. */
async function enqueueCall(db: DbExecutor, ctx: { call: CallRow; num: NumberRow; conv: ConversationRow }, t: TwiML): Promise<TwiML> {
  await db.update(inboxCall).set({ queuedAt: new Date() }).where(eq(inboxCall.id, ctx.call.id));
  await publishCall(db, ctx.conv, ctx.call.id);
  return t.enqueue(queueNameFor(ctx.num.id), {
    action: voiceUrl("/queue-result", { callId: ctx.call.id }),
    waitUrl: voiceUrl("/queue-wait", { callId: ctx.call.id }),
  });
}

/** The supervisor is no longer listening in. */
export async function clearMonitor(db: DbExecutor, callId: string | undefined): Promise<void> {
  if (!callId || !UUID_RE.test(callId)) return;
  const [row] = await db
    .update(inboxCall)
    .set({ monitorUserId: null, monitorCallSid: null, monitorMode: null })
    .where(eq(inboxCall.id, callId))
    .returning({ conversationId: inboxCall.conversationId });
  if (!row) return;
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, row.conversationId));
  if (conv) await publishCall(db, conv, callId);
}

/**
 * The supervisor's own app connected (Voice SDK outbound, listenCallId set).
 * Allowed only for the person the switchboard registered as listening, while
 * the beta is on and the call is in its conference. Joins muted (listen),
 * as a coach (whisper) or plainly (join).
 */
async function monitorLeg(db: DbClient, userId: string, callSid: string, callId: string): Promise<TwiML> {
  const refuse = (): TwiML => twiml().say("Sorry, you can't listen to this call.").hangup();
  const [user] = await db
    .select({ role: adminUser.role, permissionOverrides: adminUser.permissionOverrides })
    .from(adminUser)
    .where(and(eq(adminUser.id, userId), eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));
  if (!user || !capsOf(user).includes("calls.switchboard")) return refuse();
  if (!(await loadCallFeatures(db)).enabled) return refuse();
  const ctx = await loadCallContext(db, callId);
  if (!ctx) return refuse();
  const { call } = ctx;
  if (!call.conferenceName || call.endedAt || call.monitorUserId !== userId) return refuse();
  const mode: MonitorMode = (MONITOR_MODES as readonly string[]).includes(call.monitorMode ?? "") ? (call.monitorMode as MonitorMode) : "listen";
  await db.update(inboxCall).set({ monitorCallSid: callSid }).where(eq(inboxCall.id, call.id));
  await publishCall(db, ctx.conv, call.id);
  return twiml().dialConference(
    conferenceRoomFor(call.id),
    {
      muted: mode === "listen",
      ...(mode === "whisper" && call.agentCallSid ? { coach: call.agentCallSid } : {}),
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      waitUrl: "",
    },
    { action: voiceUrl("/conference-done", { callId: call.id, role: "monitor" }) },
  );
}

/** The conference a call moves into when a supervisor listens in. Ends when the caller or the staff member leaves. */
function conferenceTwiml(callId: string, opts: { record: boolean }): TwiML {
  return twiml().dialConference(
    conferenceRoomFor(callId),
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      waitUrl: "",
      ...(opts.record
        ? { record: "record-from-start" as const, recordingStatusCallback: voiceUrl("/recording", { kind: "call", callId }) }
        : {}),
    },
    { action: voiceUrl("/conference-done", { callId }) },
  );
}

/** Ring these staff members' apps; the first to answer gets the call. */
async function dialStaff(
  db: DbExecutor,
  ctx: { call: CallRow; conv: ConversationRow },
  userIds: string[],
  t: TwiML,
): Promise<TwiML> {
  const { call } = ctx;
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
      {
        const audio = await greetingUrl(option.audioKey);
        return (audio ? t.play(audio) : t.say(option.playText ?? option.label)).hangup();
      }
  }
}

// ── Public webhooks ──────────────────────────────────────────────────────────

export function voiceWebhookRoutes(db: DbClient) {
  const r = new Hono();
  // Twilio form posts are tiny; reject anything large before parsing.
  r.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("payload too large", 413) }));

  r.post(
    "/incoming",
    twilioWebhook(db, "/incoming", async ({ params }) => {
      const now = new Date();
      const num = await findBusinessNumber(db, params.To);
      // Only a phone line can take a call: a Page or an Instagram account never matches (rule R21).
      if (!num || num.channels === "whatsapp" || num.kind !== "phone" || !num.e164) {
        return twiml().say(UNKNOWN_NUMBER).hangup();
      }
      const businessE164 = num.e164;
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
            toE164: businessE164,
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
          return appendVoicemail(
            twiml(),
            call!.id,
            num.afterHoursText || DEFAULT_AFTER_HOURS,
            await greetingUrl(num.afterHoursAudioKey),
          );
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

  // A staff member transferred the call: ring the chosen team (voicemail if nobody is online).
  r.post(
    "/transfer",
    twilioWebhook(db, "/transfer", async ({ query }) => {
      return db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx || !query.teamId) return twiml().hangup();
        return ringTeam(tx, ctx, query.teamId, twiml().say("Please hold while we transfer your call."));
      });
    }),
  );

  // Switchboard: ring one person only — they picked the call up, or it was
  // transferred to them. The call's ring_user_id must name them.
  r.post(
    "/connect",
    twilioWebhook(db, "/connect", async ({ query }) => {
      return db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx || !query.userId || ctx.call.ringUserId !== query.userId || ctx.call.endedAt || ctx.call.outcome !== "in_progress") {
          return twiml().hangup();
        }
        const t = query.transfer === "1" ? twiml().say("Please hold while we transfer your call.") : twiml();
        return dialStaff(tx, ctx, [query.userId], t);
      });
    }),
  );

  // ── Call queue (beta). Only reached by calls that were enqueued while it was on. ──

  // Twilio asks this each time the hold music ends: keep waiting, or leave the queue.
  r.post(
    "/queue-wait",
    twilioWebhook(db, "/queue-wait", async ({ params, query }) => {
      const ctx = await loadCallContext(db, query.callId);
      if (!ctx || ctx.call.endedAt || ctx.call.outcome !== "in_progress") return twiml().leave();
      const features = await loadCallFeatures(db);
      // Switched off while someone waits: let them out (rung as usual, or voicemail).
      if (!features.enabled) return twiml().leave();
      const free = await freeStaffFor(db, ctx);
      const plan = queueWaitPlan({ queueTimeS: Number(params.QueueTime ?? "0") || 0, maxWaitS: features.max_wait_s, freeNow: free.length > 0 });
      if (plan === "leave") return twiml().leave();
      const t = twiml().say(queuePositionMessage(Number(params.QueuePosition ?? "") || null));
      const music = await greetingUrl(features.hold_audio_key);
      return music ? t.play(music) : t.pause(20);
    }),
  );

  // The caller left the queue (Enqueue action): ring whoever is free now, else voicemail.
  r.post(
    "/queue-result",
    twilioWebhook(db, "/queue-result", async ({ params, query }) => {
      const result = params.QueueResult ?? "";
      return db.transaction(async (tx) => {
        const ctx = await loadCallContext(tx, query.callId);
        if (!ctx) return twiml().hangup();
        await tx.update(inboxCall).set({ queuedAt: null }).where(eq(inboxCall.id, ctx.call.id));
        await publishCall(tx, ctx.conv, ctx.call.id);
        // Taken out of the queue from the switchboard: Twilio is already running the new instructions.
        if (result === "redirected" || result === "bridged" || result === "bridging-in-process") return twiml();
        if (result === "hangup" || ctx.call.endedAt || ctx.call.outcome !== "in_progress") return twiml().hangup();
        const free = (await freeStaffFor(tx, ctx)).slice(0, MAX_DIAL_CLIENTS);
        if (free.length > 0) return dialStaff(tx, ctx, free, twiml());
        await markMissed(tx, ctx.call);
        return appendVoicemail(twiml(), ctx.call.id, VOICEMAIL_PROMPT);
      });
    }),
  );

  // ── Supervisor tools (beta): a call moved into a conference room. ──

  // The staff member's leg, redirected here when a supervisor starts listening.
  r.post(
    "/conference",
    twilioWebhook(db, "/conference", async ({ query }) => {
      const ctx = await loadCallContext(db, query.callId);
      if (!ctx || !ctx.call.conferenceName || ctx.call.endedAt) return twiml().hangup();
      return conferenceTwiml(ctx.call.id, { record: false });
    }),
  );

  // A conference <Dial> ended (the room closed, or this leg was moved). role=monitor: the supervisor left.
  r.post(
    "/conference-done",
    twilioWebhook(db, "/conference-done", async ({ query }) => {
      if (query.role === "monitor") await clearMonitor(db, query.callId);
      return twiml().hangup();
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
            // "missed" included: a late /status may have marked it before this ran.
            .where(and(eq(inboxCall.id, call.id), inArray(inboxCall.outcome, ["in_progress", "answered", "missed"])));
          await publishCall(tx, ctx.conv, call.id);
          // Supervisor tools (beta): the staff leg was moved into a conference, so the caller joins it too.
          // conference_name is only ever set by the switchboard's "Listen in", so normally this is skipped.
          if (call.conferenceName && call.direction === "in" && !call.endedAt) return conferenceTwiml(call.id, { record: true });
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
        if (!call) {
          // A supervisor's listen-in leg ended (beta): they are no longer listening.
          const [watched] = await tx.select({ id: inboxCall.id }).from(inboxCall).where(eq(inboxCall.monitorCallSid, params.CallSid!));
          if (watched) await clearMonitor(tx, watched.id);
          return;
        }
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
      // Supervisor tools (beta): the switchboard's "Listen in" connects here with listenCallId.
      if (params.listenCallId !== undefined) return monitorLeg(db, userId, callSid, params.listenCallId);

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
      if (!num || num.channels === "whatsapp" || num.kind !== "phone" || !num.e164) {
        return twiml().say("Sorry, that business number cannot make calls.").hangup();
      }
      const callerE164 = num.e164;
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
            fromE164: callerE164,
            toE164: dialTo,
            startedByUserId: user.id,
          })
          .onConflictDoNothing({ target: inboxCall.twilioCallSid });
        const [call] = await tx.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, callSid));
        const conv = await touchConversation(tx, conversation.id, { preview: "Outgoing call" });
        await publishCall(tx, conv, call!.id);
        await publishInboxEvent(tx, signalFor("conversation.updated", conv));
        return twiml().dialNumber(dialTo, {
          callerId: callerE164,
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

// heartbeat: sent by the app's 30-second timer (not the person's own switch). Missing = the switch.
const PresenceBody = z.object({ available: z.boolean(), heartbeat: z.boolean().optional() });

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
    // The mobile app asks with ?platform=ios|android so Twilio can wake a closed phone.
    const platform = c.req.query("platform");
    const pushCredentialSid =
      platform === "ios"
        ? process.env.TWILIO_PUSH_CREDENTIAL_SID_IOS
        : platform === "android"
          ? process.env.TWILIO_PUSH_CREDENTIAL_SID_ANDROID
          : undefined;
    const token = voiceAccessToken({
      accountSid,
      apiKeySid,
      apiKeySecret,
      identity,
      outgoingApplicationSid: appSid,
      ttlSeconds: TOKEN_TTL_S,
      incomingAllow: auth.capabilities.includes("calls.answer"),
      ...(pushCredentialSid ? { pushCredentialSid } : {}),
    });
    return c.json({ data: { token, identity, ttl: TOKEN_TTL_S } });
  });

  /** Heartbeat: the web app calls this every 30s while open. */
  /** What this person last chose, so a new device starts in the same state. */
  // Is calling set up on this server at all? The admin's call bar hides itself
  // when it is not, so staff never see controls that cannot work.
  r.get("/status", (c) => {
    const configured = Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_API_KEY_SID &&
        process.env.TWILIO_API_KEY_SECRET &&
        process.env.TWILIO_TWIML_APP_SID,
    );
    return c.json({ data: { configured } });
  });

  r.get("/presence", requireCapability("calls.answer"), async (c) => {
    const [row] = await db.select().from(inboxPresence).where(eq(inboxPresence.userId, c.get("auth").userId));
    return c.json({ data: { available: row?.available ?? false, last_seen_at: row?.lastSeenAt ?? null } });
  });

  r.post("/presence", requireCapability("calls.answer"), async (c) => {
    const auth = c.get("auth");
    const body = PresenceBody.parse(await c.req.json());
    const now = new Date();
    const [current] = await db
      .select({ available: inboxPresence.available, awaySetBy: inboxPresence.awaySetBy })
      .from(inboxPresence)
      .where(eq(inboxPresence.userId, auth.userId));
    // A manager's "away" (switchboard) survives the app's own heartbeat; the person's switch clears it.
    const next = nextPresence(current ?? null, { available: body.available, heartbeat: body.heartbeat === true });
    if (next.keepManagerAway) {
      await db.update(inboxPresence).set({ lastSeenAt: now }).where(eq(inboxPresence.userId, auth.userId));
      return c.json({ data: { available: false, last_seen_at: now.toISOString(), set_away_by_manager: true } });
    }
    const changed = !current || current.available !== next.available || current.awaySetBy !== null;
    await db
      .insert(inboxPresence)
      .values({ userId: auth.userId, available: next.available, lastSeenAt: now })
      .onConflictDoUpdate({
        target: inboxPresence.userId,
        set: { available: next.available, lastSeenAt: now, awaySetBy: null, awaySetAt: null },
      });
    if (changed) await publishInboxEvent(db, { event: "presence.updated", id: auth.userId });
    return c.json({ data: { available: next.available, last_seen_at: now.toISOString() } });
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
      if (!call || call.direction !== "in") throw new BusinessError("not_found", "call not found", 404);
      // Fresh permissions (not the JWT): must see the conversation, still hold
      // calls.answer, and be in the team being rung (unless they see everything).
      const viewer = await reloadViewer(db, auth.userId);
      const [convRow] = await tx.select().from(inboxConversation).where(eq(inboxConversation.id, call.conversationId));
      if (!viewer || !convRow || !viewer.capabilities.includes("calls.answer")) {
        throw new BusinessError("not_found", "call not found", 404);
      }
      const routing = { phoneNumberId: call.phoneNumberId, teamId: call.teamId, assigneeId: null };
      const inRungTeam = viewer.capabilities.includes("inbox.view_all") || (call.teamId !== null && viewer.teamIds.includes(call.teamId));
      // Or the one person it was put through to from the switchboard (checked there).
      const putThrough = call.ringUserId === auth.userId;
      if (!putThrough && (!canSeeConversation(viewer, routing) || !inRungTeam)) {
        throw new BusinessError("not_found", "call not found", 404);
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

  /**
   * Transfer a call I answered to another team. The customer's leg is sent to
   * /transfer (rings that team); my own leg ends.
   */
  r.post("/calls/:ref/transfer", requireCapability("calls.answer"), async (c) => {
    const auth = c.get("auth");
    const ref = c.req.param("ref");
    const { team_id } = z.object({ team_id: z.string().uuid() }).parse(await c.req.json());
    const cfg = twilioRestConfigFromEnv();
    if (!cfg) throw new BusinessError("service_unavailable", "Phone calls are not configured on this server", 503);
    const [call] = await db
      .select()
      .from(inboxCall)
      .where(UUID_RE.test(ref) ? eq(inboxCall.id, ref) : eq(inboxCall.twilioCallSid, ref));
    if (!call || call.direction !== "in" || call.answeredByUserId !== auth.userId) {
      throw new BusinessError("not_found", "call not found", 404);
    }
    if (call.endedAt || call.outcome !== "answered") {
      throw new BusinessError("conflict", "This call can't be transferred", 409);
    }
    await transferLiveCall(db, c, cfg, call, { teamId: team_id });
    return c.json({ ok: true });
  });

  /**
   * Hold / resume, reported by the app so the switchboard can show it. The
   * hold itself happens in the app (the phone provider is not told). Only the
   * staff member on the call may report it.
   */
  r.post("/calls/:ref/hold", requireAnyCapability("calls.answer", "calls.outbound"), async (c) => {
    const auth = c.get("auth");
    const ref = c.req.param("ref");
    const { held } = z.object({ held: z.boolean() }).parse(await c.req.json());
    const [call] = await db
      .select()
      .from(inboxCall)
      .where(UUID_RE.test(ref) ? eq(inboxCall.id, ref) : eq(inboxCall.twilioCallSid, ref));
    const mine = call && (call.direction === "in" ? call.answeredByUserId === auth.userId : call.startedByUserId === auth.userId);
    if (!call || !mine) throw new BusinessError("not_found", "call not found", 404);
    if (call.endedAt) return c.json({ ok: true });
    await db
      .update(inboxCall)
      .set({ heldAt: held ? (call.heldAt ?? new Date()) : null })
      .where(eq(inboxCall.id, call.id));
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, call.conversationId));
    if (conv) await publishCall(db, conv, call.id);
    return c.json({ ok: true });
  });

  return r;
}

export type TransferTarget = { teamId: string } | { userId: string };

/**
 * Hand a live, answered inbound call to a team (rings its free staff) or to
 * one person (the switchboard). The customer's leg is redirected; the staff
 * leg ends. Puts the call back as it was if Twilio refuses. Audited.
 */
export async function transferLiveCall(
  db: DbClient,
  c: Context,
  cfg: NonNullable<ReturnType<typeof twilioRestConfigFromEnv>>,
  call: CallRow,
  target: TransferTarget,
  opts: { fromSwitchboard?: boolean } = {},
): Promise<void> {
  let after: Record<string, unknown>;
  let url: string;
  // The caller leaves any conference (beta) when redirected, which closes it; start clean.
  const leaveRoom = { conferenceName: null, agentCallSid: null, monitorUserId: null, monitorCallSid: null, monitorMode: null };
  if ("teamId" in target) {
    const [team] = await db.select().from(inboxTeam).where(and(eq(inboxTeam.id, target.teamId), eq(inboxTeam.isActive, true)));
    if (!team) throw new BusinessError("validation_failed", "Pick a team to transfer to", 400);
    after = { team_id: team.id, team: team.name };
    url = voiceUrl("/transfer", { callId: call.id, teamId: team.id });
    // Back to "ringing" for the new team, so their accept works; remember who had it.
    await db
      .update(inboxCall)
      .set({ outcome: "in_progress", answeredByUserId: null, teamId: team.id, ringUserId: null, heldAt: null, ...leaveRoom })
      .where(eq(inboxCall.id, call.id));
  } else {
    after = { user_id: target.userId };
    url = voiceUrl("/connect", { callId: call.id, userId: target.userId, transfer: 1 });
    await db
      .update(inboxCall)
      .set({ outcome: "in_progress", answeredByUserId: null, ringUserId: target.userId, heldAt: null, ...leaveRoom })
      .where(eq(inboxCall.id, call.id));
  }
  try {
    await redirectCall(cfg, call.twilioCallSid, url);
  } catch (err) {
    // Put it back: the caller is still talking to the same staff member.
    await db
      .update(inboxCall)
      .set({
        outcome: "answered",
        answeredByUserId: call.answeredByUserId,
        teamId: call.teamId,
        ringUserId: call.ringUserId,
        heldAt: call.heldAt,
        conferenceName: call.conferenceName,
        agentCallSid: call.agentCallSid,
        monitorUserId: call.monitorUserId,
        monitorCallSid: call.monitorCallSid,
        monitorMode: call.monitorMode,
      })
      .where(eq(inboxCall.id, call.id));
    logger.warn({ err, callId: call.id }, "call transfer failed");
    throw new BusinessError("conflict", "Couldn't transfer the call — it may have just ended", 409);
  }
  await writeAudit(db, c, {
    action: "inbox.call_transfer",
    entityType: "inbox_call",
    entityId: call.id,
    ...(opts.fromSwitchboard ? { before: { answered_by: call.answeredByUserId } } : {}),
    after: opts.fromSwitchboard ? { ...after, from_switchboard: true } : after,
    notify: false,
  });
  const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, call.conversationId));
  if (conv) await publishCall(db, conv, call.id);
}
