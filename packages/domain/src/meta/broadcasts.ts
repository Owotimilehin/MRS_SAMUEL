/**
 * WhatsApp broadcasts (suite spec 14, Phase B): confirm, send, stop and settle.
 *
 * The rules that keep customers and the number safe, and where each lives:
 *   - The owner switch is off by default (R40). sendFromConversation refuses a broadcast send
 *     while it is off; the worker stops anything scheduled or sending; confirm and resume refuse.
 *   - A broadcast is confirmed only after a test of the exact message and the typed count (R44, R53).
 *   - Never twice (R57): a recipient leaves `pending` only through the claim in runBroadcastTick,
 *     which commits before Meta is called; nothing moves a row back to `pending` except a refusal
 *     where Meta answered and said it did not send. sendFromConversation re-checks the row under a
 *     lock and writes the message before calling Meta.
 *   - A timeout is `unknown`, never resent, and only a delivery report settles it (R58).
 *   - The system only ever stops (R55, R56). A person resumes.
 *
 * Nothing in here logs, stores or returns a Meta token.
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  appSetting,
  broadcast,
  broadcastEvent,
  broadcastRecipient,
  customer,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  outboxEvent,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  BROADCAST_ACCOUNT_BLOCK_KEY,
  BROADCAST_CALLBACK_PREFIX,
  BROADCAST_LIMITS,
  BROADCAST_SETTINGS_KEY,
  blanksProblem,
  estimateDays,
  fillBlanks,
  plainFailure,
  readBlanks,
  readBroadcastSettings,
  scheduleProblem,
  stopReasonText,
  templateBroadcastUse,
  templateNeeds,
  tickBatch,
  toE164,
  valuesProblem,
  withinSendingHours,
  type BroadcastBlanks,
  type BroadcastCounts,
  type BroadcastSettings,
  type FilledBlanks,
} from "@ms/shared";
import { findOrCreateCustomer, findOrOpenConversation } from "../inbox/core.js";
import { getNumberInfo, graph, graphRaw, MetaApiError, numberMessagingLimit, type MetaConfig } from "../inbox/meta.js";
import { InboxSendError, sendFromConversation, type SentMessage } from "../inbox/send.js";
import { isStoppedOnWhatsApp, recordConsent, resolveContactId } from "../contacts/consent.js";
import { audienceAddress, audienceListCount, buildAudience, dailyAllowance, loadAudienceList } from "../contacts/audience.js";

export { markBroadcastOptOut, markBroadcastReply } from "./broadcast-marks.js";

export type BroadcastRow = typeof broadcast.$inferSelect;

/** Seams for tests: the pause between two sends. */
export const broadcastDeps = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A refusal with the words a person sees; the API turns it into a response with this status. */
export class BroadcastRefusal extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 422 | 429,
    message: string,
    public readonly code: string = "refused",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BroadcastRefusal";
  }
}

export const BROADCAST_TEXT = {
  off: "Broadcasts are switched off. The owner can switch them on in Broadcast settings.",
  alreadyConfirmed: "This broadcast has already been confirmed.",
  noWhatsapp: "This number has no WhatsApp.",
  addPicture: "Add the picture.",
  testFirst: "Send a test first.",
  testStale: "You changed the message after the test. Send a new test.",
  lineBusy: "Another broadcast is already going out from this number. Wait for it to finish, or schedule this one.",
  nobody: "Nobody on this list can be sent this message.",
  tooBig: "This list is too big for one broadcast. Split it.",
  noList: "Pick a list.",
  noTemplate: "Pick a template.",
  tooManyTests: "You've sent several tests. Wait a little.",
  notConfigured: "WhatsApp is not configured on this server.",
} as const;

// ── Settings ────────────────────────────────────────────────────────────────

export async function loadBroadcastSettings(db: DbExecutor): Promise<BroadcastSettings> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, BROADCAST_SETTINGS_KEY));
  return readBroadcastSettings(row?.value);
}

export type AccountBlock = { waba_id: string; event: string; detail: string | null; at: string };

export async function loadAccountBlocks(db: DbExecutor): Promise<Record<string, AccountBlock>> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, BROADCAST_ACCOUNT_BLOCK_KEY));
  const v = row?.value;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, AccountBlock>) : {};
}

// ── The message's fingerprint (R44) ─────────────────────────────────────────

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** SHA-256 of what decides the message: template, its components, the blanks, the picture and the line. */
export function broadcastFingerprint(f: {
  templateId: string | null;
  components: unknown;
  blanks: BroadcastBlanks;
  headerMediaKey: string | null;
  phoneNumberId: string;
}): string {
  const text = JSON.stringify(
    stable({
      template_id: f.templateId,
      components: f.components ?? null,
      blanks: f.blanks,
      header_media_key: f.headerMediaKey,
      phone_number_id: f.phoneNumberId,
    }),
  );
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ── Meta errors (section 3) ─────────────────────────────────────────────────

const RECIPIENT_CODES = new Set(["131026", "131049", "131050", "130472", "131062"]);
const TEMPORARY_CODES = new Set(["130429", "131056", "80007", "4", "2", "131057", "131000"]);
const STOP_CODES: Record<string, string> = {
  "131042": "payment",
  "131031": "account",
  "368": "account",
  "131064": "account",
  "131048": "quality",
  "132001": "template",
  "132015": "template",
  "132016": "template",
  "132000": "blanks",
  "132012": "blanks",
  "131008": "blanks",
  "135000": "blanks",
  "190": "config",
  "10": "config",
  "200": "config",
  "299": "config",
  "283": "config",
};

/**
 * Sort a Meta refusal. `recipient`: that person's result, never retried. `temporary`: put them
 * back to wait. `stop`: stop the whole broadcast. HTTP status 0 means we never reached Meta.
 */
export function classifyBroadcastError(
  code: string | null,
  httpStatus?: number,
): { cls: "recipient" | "temporary" | "stop"; stopReason?: string } {
  const c = code ?? "";
  if (STOP_CODES[c]) return { cls: "stop", stopReason: STOP_CODES[c] };
  if (RECIPIENT_CODES.has(c)) return { cls: "recipient" };
  if (TEMPORARY_CODES.has(c)) return { cls: "temporary" };
  if (httpStatus === 429) return { cls: "temporary" };
  if (httpStatus !== undefined && httpStatus >= 500 && code !== null) return { cls: "temporary" };
  if (httpStatus === 0) return { cls: "temporary" };
  return { cls: "recipient" };
}

// ── Meta calls (through the shared Graph helper; mocked in every test) ──────

/** Upload a header picture to Meta once (M30); its ID lasts 30 days. */
export async function uploadWaMedia(
  cfg: MetaConfig,
  phoneNumberId: string,
  file: { bytes: Uint8Array; mime: string; filename: string },
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.mime);
  form.append("file", new Blob([file.bytes], { type: file.mime }), file.filename);
  const res = await graphRaw<{ id?: string }>(cfg, "POST", `${phoneNumberId}/media`, { body: form, timeoutMs: 60_000 }, { service: "WhatsApp" });
  if (!res?.id) throw new MetaApiError("WhatsApp returned no file id", 502, null, true);
  return res.id;
}

/** Whether Meta's marketing route is open for this account (M27). null on any error. */
export async function getMmStatus(cfg: MetaConfig, wabaId: string): Promise<"ELIGIBLE" | "ONBOARDED" | null> {
  try {
    const res = await graph<{ marketing_messages_onboarding_status?: string }>(
      cfg,
      "GET",
      `${wabaId}?fields=marketing_messages_onboarding_status`,
      undefined,
      { service: "WhatsApp" },
    );
    const v = String(res?.marketing_messages_onboarding_status ?? "").toUpperCase();
    return v === "ELIGIBLE" || v === "ONBOARDED" ? v : null;
  } catch {
    return null;
  }
}

// ── Owner alerts (ruling 9.2.10; the cases are in apps/worker/src/outbox.ts) ─

export type BroadcastAlertType = "broadcast.stopped" | "broadcast.finished" | "inbox.meta_config";

/** At most one alert of this type per `payload.account` per 24 hours (as alertOnce in the API). */
export async function raiseBroadcastAlert(
  db: DbExecutor,
  eventType: BroadcastAlertType,
  payload: Record<string, unknown> & { account: string },
): Promise<boolean> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, eventType),
        sql`${outboxEvent.createdAt} > now() - interval '24 hours'`,
        sql`${outboxEvent.payload}->>'account' = ${payload.account}`,
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(outboxEvent).values({ eventType, payload });
  return true;
}

// ── Counts ──────────────────────────────────────────────────────────────────

export type CountsWithList = BroadcastCounts & { list: number };

const EMPTY_COUNTS: CountsWithList = { list: 0, waiting: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, unknown: 0, skipped: 0, opted_out: 0 };

/** Recipient counts for each broadcast. `sent` counts every row that reached sent, delivered or read (R62). */
export async function broadcastCounts(db: DbExecutor, ids: readonly string[]): Promise<Map<string, CountsWithList>> {
  const out = new Map<string, CountsWithList>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT broadcast_id,
      count(*)::int AS list,
      count(*) FILTER (WHERE state IN ('pending','sending'))::int AS waiting,
      count(*) FILTER (WHERE state IN ('sent','delivered','read'))::int AS sent,
      count(*) FILTER (WHERE state IN ('delivered','read'))::int AS delivered,
      count(*) FILTER (WHERE state = 'read')::int AS read,
      count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
      count(*) FILTER (WHERE state = 'failed')::int AS failed,
      count(*) FILTER (WHERE state = 'unknown')::int AS unknown,
      count(*) FILTER (WHERE state = 'skipped')::int AS skipped,
      count(*) FILTER (WHERE opted_out_at IS NOT NULL)::int AS opted_out
    FROM broadcast_recipient
    WHERE broadcast_id = ANY(ARRAY[${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}])
    GROUP BY broadcast_id`)) as unknown as (CountsWithList & { broadcast_id: string })[];
  for (const id of ids) out.set(id, { ...EMPTY_COUNTS });
  for (const r of rows) {
    const { broadcast_id, ...c } = r;
    out.set(broadcast_id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])) as unknown as CountsWithList);
  }
  return out;
}

async function writeEvent(db: DbExecutor, broadcastId: string, kind: string, detail: string | null = null, userId: string | null = null, at?: Date): Promise<void> {
  await db.insert(broadcastEvent).values({ broadcastId, kind, detail, userId, ...(at ? { at } : {}) });
}

// ── Stopping (R55) ──────────────────────────────────────────────────────────

/**
 * Stop a broadcast: status, event and ONE owner alert. Only a broadcast that is scheduled or
 * sending can be stopped, and the status change is the guard, so two stops at once raise one
 * alert. Returns whether this call stopped it.
 */
export async function stopBroadcast(db: DbExecutor, id: string, reason: string, detail: string): Promise<boolean> {
  const [row] = await db
    .update(broadcast)
    .set({ status: "stopped", stopReason: reason, stopDetail: detail.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(broadcast.id, id), inArray(broadcast.status, ["sending", "scheduled"])))
    .returning();
  if (!row) return false;
  await writeEvent(db, id, "stopped", `${reason}: ${detail}`.slice(0, 500));
  const counts = (await broadcastCounts(db, [id])).get(id) ?? EMPTY_COUNTS;
  await raiseBroadcastAlert(db, "broadcast.stopped", {
    account: `${id}:${reason}`,
    broadcast_id: id,
    name: row.name,
    reason,
    reason_text: stopReasonText(reason),
    sent: counts.sent,
    waiting: counts.waiting,
  });
  return true;
}

export interface SafetyFacts {
  enabled: boolean;
  lineQuality: string | null;
  lineStatus: string | null;
  template: { status: string | null; qualityScore: string | null } | null;
  accountBlocked: { event: string; detail: string | null } | null;
  /** States and codes of the last 50 recipients that reached sent, delivered, read or failed. */
  lastResults: { state: string; errorCode: string | null }[];
  optedOut: number;
  deliveredOrRead: number;
  headerMediaKey: string | null;
  headerMediaUploadedAt: Date | null;
  startedAt: Date | null;
}

/** R55 as a pure rule: the first stop that applies, or null. */
export function safetyVerdict(f: SafetyFacts, now: Date): { stop: string; detail: string } | null {
  if (!f.enabled) return { stop: "switched_off", detail: "The owner switch is off." };
  const q = (f.lineQuality ?? "").toUpperCase();
  const st = (f.lineStatus ?? "").toUpperCase();
  if (q === "RED" || st === "FLAGGED" || st === "RESTRICTED") {
    return { stop: "quality", detail: `Number quality ${q || "unknown"}, status ${st || "unknown"}.` };
  }
  if (!f.template) return { stop: "template", detail: "The template is gone." };
  if ((f.template.status ?? "").toUpperCase() !== "APPROVED") return { stop: "template", detail: `Template status ${f.template.status ?? "unknown"}.` };
  if ((f.template.qualityScore ?? "").toUpperCase() === "RED") return { stop: "template", detail: "Template quality RED." };
  if (f.accountBlocked) return { stop: "account", detail: `${f.accountBlocked.event}${f.accountBlocked.detail ? `: ${f.accountBlocked.detail}` : ""}` };
  if (f.lastResults.length >= 20) {
    const bad = f.lastResults.filter((r) => r.state === "failed" && r.errorCode !== "131026" && r.errorCode !== "131050").length;
    if (bad / f.lastResults.length >= 0.3) {
      return { stop: "failure_spike", detail: `${bad} of the last ${f.lastResults.length} messages failed.` };
    }
  }
  if (f.optedOut >= 5 && f.optedOut >= 0.05 * f.deliveredOrRead) {
    return { stop: "optout_spike", detail: `${f.optedOut} people asked us to stop after ${f.deliveredOrRead} deliveries.` };
  }
  if (f.headerMediaKey && f.headerMediaUploadedAt && now.getTime() - f.headerMediaUploadedAt.getTime() > BROADCAST_LIMITS.mediaExpiredDays * 86_400_000) {
    return { stop: "media_expired", detail: "The picture was uploaded to WhatsApp more than 25 days ago." };
  }
  if (f.startedAt && now.getTime() - f.startedAt.getTime() > BROADCAST_LIMITS.maxDays * 86_400_000) {
    return { stop: "too_long", detail: "Started more than 14 days ago." };
  }
  return null;
}

/** R55: read the facts and decide. */
export async function checkBroadcastSafety(
  db: DbExecutor,
  b: BroadcastRow,
  s: BroadcastSettings,
  now: Date,
): Promise<{ stop: string; detail: string } | null> {
  const [line] = await db
    .select({ quality: inboxPhoneNumber.qualityRating, status: inboxPhoneNumber.waStatus, wabaId: inboxPhoneNumber.wabaId })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, b.phoneNumberId));
  const [tpl] = b.templateId
    ? await db.select({ status: inboxTemplate.status, qualityScore: inboxTemplate.qualityScore }).from(inboxTemplate).where(eq(inboxTemplate.id, b.templateId))
    : [];
  const blocks = await loadAccountBlocks(db);
  const block = line?.wabaId ? blocks[line.wabaId] : undefined;
  const last = await db
    .select({ state: broadcastRecipient.state, errorCode: broadcastRecipient.errorCode })
    .from(broadcastRecipient)
    .where(and(eq(broadcastRecipient.broadcastId, b.id), inArray(broadcastRecipient.state, ["sent", "delivered", "read", "failed"])))
    .orderBy(desc(sql`coalesce(${broadcastRecipient.failedAt}, ${broadcastRecipient.sentAt}, ${broadcastRecipient.claimedAt})`))
    .limit(50);
  const [oo] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE opted_out_at IS NOT NULL)::int AS opted, count(*) FILTER (WHERE state IN ('delivered','read'))::int AS dr
    FROM broadcast_recipient WHERE broadcast_id = ${b.id}::uuid`)) as unknown as { opted: number; dr: number }[];
  return safetyVerdict(
    {
      enabled: s.enabled,
      lineQuality: line?.quality ?? null,
      lineStatus: line?.status ?? null,
      template: tpl ? { status: tpl.status, qualityScore: tpl.qualityScore } : null,
      accountBlocked: block ? { event: block.event, detail: block.detail } : null,
      lastResults: last,
      optedOut: Number(oo?.opted ?? 0),
      deliveredOrRead: Number(oo?.dr ?? 0),
      headerMediaKey: b.headerMediaKey,
      headerMediaUploadedAt: b.headerMediaUploadedAt,
      startedAt: b.startedAt,
    },
    now,
  );
}

// ── Templates and lines ─────────────────────────────────────────────────────

export async function broadcastTemplate(db: DbExecutor, b: Pick<BroadcastRow, "templateId">) {
  if (!b.templateId) return null;
  const [t] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, b.templateId));
  return t ?? null;
}

export async function broadcastLine(db: DbExecutor, lineId: string) {
  const [l] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, lineId));
  return l ?? null;
}

type TemplateRow = typeof inboxTemplate.$inferSelect;
type LineRow = typeof inboxPhoneNumber.$inferSelect;

/** Why this template cannot be broadcast from this line (R41, R42); null when it can. */
export function templateProblemFor(t: TemplateRow | null, line: LineRow | null): string | null {
  if (!t) return BROADCAST_TEXT.noTemplate;
  if (line?.wabaId && t.wabaId !== line.wabaId) return "This template belongs to another WhatsApp account.";
  const use = templateBroadcastUse({
    status: t.status,
    category: t.category,
    components: t.components as unknown[] | null,
    qualityScore: t.qualityScore,
    reviewInfo: (t.reviewInfo as { pause?: unknown } | null) ?? null,
  });
  return use.usable ? null : use.why_not;
}

export function lineProblem(line: LineRow | null): string | null {
  if (!line || !line.isActive || line.kind !== "phone" || !line.waPhoneNumberId || line.channels === "voice") return BROADCAST_TEXT.noWhatsapp;
  return null;
}

/** The fingerprint of the broadcast as it stands now. */
export function currentFingerprint(b: BroadcastRow, t: TemplateRow | null): string {
  return broadcastFingerprint({
    templateId: b.templateId,
    components: t?.components ?? null,
    blanks: readBlanks(b.blanks),
    headerMediaKey: b.headerMediaKey,
    phoneNumberId: b.phoneNumberId,
  });
}

/** R44: why the last test does not cover this message; null when it does. */
export async function testProblem(db: DbExecutor, b: BroadcastRow, fingerprint: string, now: Date): Promise<string | null> {
  if (!b.testSentAt || !b.testFingerprint) return BROADCAST_TEXT.testFirst;
  if (b.testFingerprint !== fingerprint) return BROADCAST_TEXT.testStale;
  if (now.getTime() - b.testSentAt.getTime() > BROADCAST_LIMITS.testValidHours * 3600_000) return BROADCAST_TEXT.testFirst;
  if (b.testMessageId) {
    const [m] = await db.select({ status: inboxMessage.status }).from(inboxMessage).where(eq(inboxMessage.id, b.testMessageId));
    if (m?.status === "failed") return BROADCAST_TEXT.testFirst;
  }
  return null;
}

// ── The header picture (R53 step 5) ─────────────────────────────────────────

export type HeaderBytesLoader = () => Promise<Uint8Array>;

/**
 * The Meta media ID of the header picture, uploading it first when there is none or it is
 * older than 20 days. Returns null when the template needs no picture.
 */
export async function ensureHeaderMedia(
  db: DbExecutor,
  cfg: MetaConfig,
  b: BroadcastRow,
  t: TemplateRow,
  line: LineRow,
  loadBytes: HeaderBytesLoader | undefined,
  now: Date,
): Promise<string | null> {
  const needs = templateNeeds(t.components as unknown[] | null, t.category);
  if (!needs.headerMedia) return null;
  if (!b.headerMediaKey) throw new BroadcastRefusal(409, BROADCAST_TEXT.addPicture);
  const fresh =
    b.headerMediaId && b.headerMediaUploadedAt && now.getTime() - b.headerMediaUploadedAt.getTime() < BROADCAST_LIMITS.mediaReuploadDays * 86_400_000;
  if (fresh) return b.headerMediaId;
  if (!loadBytes) throw new BroadcastRefusal(409, BROADCAST_TEXT.addPicture);
  let id: string;
  try {
    const bytes = await loadBytes();
    const mime = b.headerMediaMime ?? "image/jpeg";
    id = await uploadWaMedia(cfg, line.waPhoneNumberId!, { bytes, mime, filename: mime === "image/png" ? "picture.png" : "picture.jpg" });
  } catch (err) {
    if (err instanceof BroadcastRefusal) throw err;
    const code = err instanceof MetaApiError ? err.code : null;
    throw new BroadcastRefusal(422, `WhatsApp did not take the picture: ${code ? plainFailure(code) : "it could not be uploaded"}. Try again.`);
  }
  await db.update(broadcast).set({ headerMediaId: id, headerMediaUploadedAt: now, updatedAt: now }).where(eq(broadcast.id, b.id));
  return id;
}

function templateContent(b: BroadcastRow, t: TemplateRow, values: FilledBlanks, headerMediaId: string | null) {
  const blanks = readBlanks(b.blanks);
  return {
    type: "template" as const,
    name: t.name,
    language: t.language,
    ...(values.body.length ? { bodyParams: values.body } : {}),
    ...(values.header ? { headerText: values.header } : {}),
    ...(headerMediaId ? { headerMedia: { type: "image" as const, id: headerMediaId } } : {}),
    ...(blanks.buttons?.length ? { buttonParams: blanks.buttons.map((x) => ({ index: x.index, text: x.text.trim() })) } : {}),
  };
}

// ── Test send (R43) ─────────────────────────────────────────────────────────

/**
 * Send the broadcast's message to one number as an ordinary template send by the signed-in
 * person. Needs no consent and makes no recipient row. At most 5 per broadcast per hour.
 */
export async function sendBroadcastTest(
  db: DbClient,
  cfg: MetaConfig | null,
  id: string,
  a: { userId: string; to: string; loadHeaderBytes?: HeaderBytesLoader },
  now: Date,
): Promise<{ message_id: string; status: string; to: string }> {
  if (!cfg) throw new BroadcastRefusal(409, BROADCAST_TEXT.notConfigured);
  const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
  if (!b) throw new BroadcastRefusal(404, "We couldn't find that broadcast.");
  if (b.status !== "draft") throw new BroadcastRefusal(409, "This broadcast can no longer be changed.");
  const e164 = toE164(a.to);
  if (!e164) throw new BroadcastRefusal(422, "That phone number doesn't look right. Use a number like 0803 123 4567.");
  const t = await broadcastTemplate(db, b);
  const line = await broadcastLine(db, b.phoneNumberId);
  const lp = lineProblem(line);
  if (lp) throw new BroadcastRefusal(409, lp);
  const tp = templateProblemFor(t, line);
  if (tp) throw new BroadcastRefusal(409, `This template can't be used: ${tp}`);
  const needs = templateNeeds(t!.components as unknown[] | null, t!.category);
  const bp = blanksProblem(readBlanks(b.blanks), needs);
  if (bp) throw new BroadcastRefusal(409, bp);
  const [recent] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM broadcast_event WHERE broadcast_id = ${id}::uuid AND kind = 'test'
      AND at > ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`)) as unknown as { n: number }[];
  if (Number(recent?.n ?? 0) >= BROADCAST_LIMITS.testsPerHour) throw new BroadcastRefusal(429, BROADCAST_TEXT.tooManyTests);

  const headerMediaId = await ensureHeaderMedia(db, cfg, b, t!, line!, a.loadHeaderBytes, now);
  const fingerprint = currentFingerprint(b, t);
  const { conversationId, name } = await db.transaction(async (tx) => {
    const who = await findOrCreateCustomer(tx, e164, { source: "whatsapp" });
    const [c] = await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, who.id));
    const { conversation } = await findOrOpenConversation(tx, who.id, b.phoneNumberId, now);
    return { conversationId: conversation.id, name: c?.name ?? null };
  });
  await writeEvent(db, id, "test", `to ${e164}`, a.userId, now);
  const values = fillBlanks(readBlanks(b.blanks), { name });
  let msg: SentMessage;
  try {
    msg = await sendFromConversation(db, cfg, { conversationId, userId: a.userId, content: templateContent(b, t!, values, headerMediaId) }, now);
  } catch (err) {
    if (err instanceof InboxSendError) throw new BroadcastRefusal(422, `The test did not go: ${err.message}.`);
    throw err;
  }
  if (msg.status === "failed") {
    throw new BroadcastRefusal(422, `The test did not go: ${plainFailure(msg.errorCode)}.`, "test_failed", { code: msg.errorCode });
  }
  await db
    .update(broadcast)
    .set({ testTo: e164, testMessageId: msg.id, testSentAt: now, testFingerprint: fingerprint, fingerprint, updatedAt: now })
    .where(eq(broadcast.id, id));
  return { message_id: msg.id, status: msg.status, to: e164 };
}

// ── Confirm (R53) ───────────────────────────────────────────────────────────

/** The audience of a draft with its counts (R46 to R52). Never writes. */
export async function draftAudience(db: DbExecutor, b: BroadcastRow, t: TemplateRow | null, s: BroadcastSettings, now: Date) {
  if (!b.listId) throw new BroadcastRefusal(409, BROADCAST_TEXT.noList);
  const list = await loadAudienceList(db, b.listId);
  if (!list) throw new BroadcastRefusal(409, BROADCAST_TEXT.noList);
  const listCount = await audienceListCount(db, list, now);
  if (listCount > BROADCAST_LIMITS.listMax) throw new BroadcastRefusal(409, BROADCAST_TEXT.tooBig);
  const rows = await buildAudience(
    db,
    { listId: list.id, phoneNumberId: b.phoneNumberId, templateCategory: (t?.category ?? "MARKETING").toUpperCase(), broadcastId: b.id },
    s,
    now,
  );
  const allowance = await dailyAllowance(db, b.phoneNumberId, s, now);
  const willSend = rows.filter((r) => !r.reason).length;
  return { list, listCount: rows.length, rows, willSend, allowance, days: estimateDays(willSend, allowance.perDay) };
}

/**
 * The one click that sends to customers (foundation rule 7). Every check of R53 in order;
 * each refusal is a BroadcastRefusal with the words on screen. The people are fixed here.
 */
export async function confirmBroadcast(
  db: DbClient,
  cfg: MetaConfig | null,
  id: string,
  a: { userId: string; confirmCount: number; when: "now" | "scheduled"; loadHeaderBytes?: HeaderBytesLoader },
  now: Date,
): Promise<{ status: string; recipients: number; skipped: number }> {
  const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
  if (!b) throw new BroadcastRefusal(404, "We couldn't find that broadcast.");
  // 1.
  if (b.status !== "draft") throw new BroadcastRefusal(409, BROADCAST_TEXT.alreadyConfirmed);
  // 2.
  const s = await loadBroadcastSettings(db);
  if (!s.enabled) throw new BroadcastRefusal(409, BROADCAST_TEXT.off, "switched_off");
  if (!cfg) throw new BroadcastRefusal(409, BROADCAST_TEXT.notConfigured);
  const t = await broadcastTemplate(db, b);
  const line = await broadcastLine(db, b.phoneNumberId);
  const tp = templateProblemFor(t, line);
  if (tp) throw new BroadcastRefusal(409, `This template can't be used: ${tp}`);
  const lp = lineProblem(line);
  if (lp) throw new BroadcastRefusal(409, lp);
  const needs = templateNeeds(t!.components as unknown[] | null, t!.category);
  const blanks = readBlanks(b.blanks);
  const bp = blanksProblem(blanks, needs);
  if (bp) throw new BroadcastRefusal(409, bp);
  if (needs.headerMedia && !b.headerMediaKey) throw new BroadcastRefusal(409, BROADCAST_TEXT.addPicture);
  const fingerprint = currentFingerprint(b, t);
  const tested = await testProblem(db, b, fingerprint, now);
  if (tested) throw new BroadcastRefusal(409, tested, tested === BROADCAST_TEXT.testStale ? "test_stale" : "test_needed");
  if (a.when === "scheduled") {
    const sp = scheduleProblem(b.scheduledAt, now, s);
    if (sp) throw new BroadcastRefusal(409, sp);
  }
  // 3.
  if (a.when === "now") {
    const [busy] = await db
      .select({ id: broadcast.id })
      .from(broadcast)
      .where(and(eq(broadcast.phoneNumberId, b.phoneNumberId), eq(broadcast.status, "sending")))
      .limit(1);
    if (busy) throw new BroadcastRefusal(409, BROADCAST_TEXT.lineBusy);
  }
  // 4.
  const aud = await draftAudience(db, b, t, s, now);
  if (aud.willSend < 1) throw new BroadcastRefusal(409, BROADCAST_TEXT.nobody);
  if (aud.willSend !== a.confirmCount) {
    throw new BroadcastRefusal(
      409,
      `The number of people changed from ${a.confirmCount} to ${aud.willSend} while you were looking. Check the list again.`,
      "count_changed",
      { old: a.confirmCount, new: aud.willSend },
    );
  }
  if (aud.days > BROADCAST_LIMITS.maxDays) {
    throw new BroadcastRefusal(409, `This would take ${aud.days} days at your current WhatsApp limit. Choose a smaller list.`);
  }
  // 5.
  await ensureHeaderMedia(db, cfg, b, t!, line!, a.loadHeaderBytes, now);
  // 6.
  const status = a.when === "now" ? "sending" : "scheduled";
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(broadcast).where(eq(broadcast.id, id)).for("update");
    if (!locked || locked.status !== "draft") throw new BroadcastRefusal(409, BROADCAST_TEXT.alreadyConfirmed);
    const rows = aud.rows.map((r) => ({
      broadcastId: id,
      customerId: r.customerId,
      toWa: r.toWa,
      state: r.reason ? "skipped" : "pending",
      skipReason: r.reason,
      values: r.reason ? null : fillBlanks(blanks, { name: r.name }),
      createdAt: now,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(broadcastRecipient).values(rows.slice(i, i + 1000)).onConflictDoNothing();
    }
    await tx
      .update(broadcast)
      .set({
        status,
        confirmedBy: a.userId,
        confirmedAt: now,
        confirmedCount: aud.willSend,
        fingerprint,
        templateName: t!.name,
        templateLanguage: t!.language,
        templateCategory: (t!.category ?? "").toUpperCase(),
        listName: aud.list.name,
        attributionDays: s.attribution_days,
        route: s.route,
        ...(status === "sending" ? { startedAt: now, warmupUntil: null } : {}),
        updatedAt: now,
      })
      .where(eq(broadcast.id, id));
    await writeEvent(tx, id, "confirmed", `${aud.willSend} people, ${status === "sending" ? "now" : `scheduled for ${b.scheduledAt?.toISOString()}`}`, a.userId, now);
    if (status === "sending") await writeEvent(tx, id, "started", null, null, now);
    return { status, recipients: aud.willSend, skipped: aud.rows.length - aud.willSend };
  });
}

// ── Pause, resume, cancel (people only) ─────────────────────────────────────

export async function pauseBroadcast(db: DbExecutor, id: string, userId: string, now: Date): Promise<{ status: string }> {
  const [row] = await db
    .update(broadcast)
    .set({ status: "paused", updatedAt: now })
    .where(and(eq(broadcast.id, id), inArray(broadcast.status, ["sending", "scheduled"])))
    .returning();
  if (!row) throw new BroadcastRefusal(409, "Only a broadcast that is sending or scheduled can be paused.");
  await writeEvent(db, id, "paused", null, userId, now);
  return { status: "paused" };
}

/** R56: a person resumes. Nobody already handled is sent again; the warm-up starts afresh. */
export async function resumeBroadcast(db: DbClient, id: string, a: { userId: string; confirmCount: number }, now: Date): Promise<{ status: string }> {
  const [b] = await db.select().from(broadcast).where(eq(broadcast.id, id));
  if (!b) throw new BroadcastRefusal(404, "We couldn't find that broadcast.");
  if (b.status !== "paused" && b.status !== "stopped") throw new BroadcastRefusal(409, "Only a paused or stopped broadcast can be resumed.");
  const s = await loadBroadcastSettings(db);
  if (!s.enabled) throw new BroadcastRefusal(409, BROADCAST_TEXT.off, "switched_off");
  const t = await broadcastTemplate(db, b);
  const line = await broadcastLine(db, b.phoneNumberId);
  const tp = templateProblemFor(t, line);
  if (tp) throw new BroadcastRefusal(409, `This template can't be used: ${tp}`);
  const lp = lineProblem(line);
  if (lp) throw new BroadcastRefusal(409, lp);
  const [busy] = await db
    .select({ id: broadcast.id })
    .from(broadcast)
    .where(and(eq(broadcast.phoneNumberId, b.phoneNumberId), eq(broadcast.status, "sending")))
    .limit(1);
  if (busy) throw new BroadcastRefusal(409, BROADCAST_TEXT.lineBusy);
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(broadcast).where(eq(broadcast.id, id)).for("update");
    if (!locked || (locked.status !== "paused" && locked.status !== "stopped")) {
      throw new BroadcastRefusal(409, "Only a paused or stopped broadcast can be resumed.");
    }
    const [p] = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid AND state = 'pending'`,
    )) as unknown as { n: number }[];
    const pending = Number(p?.n ?? 0);
    if (pending !== a.confirmCount) {
      throw new BroadcastRefusal(
        409,
        `The number of people changed from ${a.confirmCount} to ${pending} while you were looking. Check the list again.`,
        "count_changed",
        { old: a.confirmCount, new: pending },
      );
    }
    if (pending < 1) throw new BroadcastRefusal(409, "Nobody is still waiting for this broadcast.");
    await tx
      .update(broadcast)
      .set({ status: "sending", waitUntil: null, tempErrors: 0, warmupUntil: null, stopReason: null, stopDetail: null, startedAt: locked.startedAt ?? now, updatedAt: now })
      .where(eq(broadcast.id, id));
    await writeEvent(tx, id, "resumed", `${pending} people still waiting`, a.userId, now);
    return { status: "sending" };
  });
}

export async function cancelBroadcast(db: DbClient, id: string, userId: string, now: Date): Promise<{ status: string; not_sent: number }> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(broadcast).where(eq(broadcast.id, id)).for("update");
    if (!b) throw new BroadcastRefusal(404, "We couldn't find that broadcast.");
    if (!["scheduled", "sending", "paused", "stopped"].includes(b.status)) {
      throw new BroadcastRefusal(409, b.status === "draft" ? "A draft is deleted, not cancelled." : "This broadcast has already ended.");
    }
    const skipped = await tx
      .update(broadcastRecipient)
      .set({ state: "skipped", skipReason: "cancelled" })
      .where(and(eq(broadcastRecipient.broadcastId, id), eq(broadcastRecipient.state, "pending")))
      .returning({ id: broadcastRecipient.id });
    await tx.update(broadcast).set({ status: "cancelled", finishedAt: now, updatedAt: now }).where(eq(broadcast.id, id));
    await writeEvent(tx, id, "cancelled", `${skipped.length} people not sent`, userId, now);
    return { status: "cancelled", not_sent: skipped.length };
  });
}

// ── The worker (section 6) ──────────────────────────────────────────────────

/** Lagos calendar day of `at`, as YYYY-MM-DD (UTC+1 all year). */
function lagosDay(at: Date): string {
  return new Date(at.getTime() + 3600_000).toISOString().slice(0, 10);
}

async function eventOncePerDay(db: DbExecutor, id: string, kind: string, now: Date): Promise<void> {
  const [last] = await db
    .select({ at: broadcastEvent.at })
    .from(broadcastEvent)
    .where(and(eq(broadcastEvent.broadcastId, id), eq(broadcastEvent.kind, kind)))
    .orderBy(desc(broadcastEvent.at))
    .limit(1);
  if (last && lagosDay(last.at) === lagosDay(now)) return;
  await writeEvent(db, id, kind, null, null, now);
}

/** Done when nobody is waiting or in flight. Raises `broadcast.finished` once. */
export async function finishIfComplete(db: DbExecutor, id: string, now: Date): Promise<boolean> {
  const [left] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid AND state IN ('pending','sending')`)) as unknown as { n: number }[];
  if (Number(left?.n ?? 0) > 0) return false;
  const [row] = await db
    .update(broadcast)
    .set({ status: "done", finishedAt: now, updatedAt: now })
    .where(and(eq(broadcast.id, id), eq(broadcast.status, "sending")))
    .returning();
  if (!row) return false;
  await writeEvent(db, id, "finished", null, null, now);
  const c = (await broadcastCounts(db, [id])).get(id) ?? EMPTY_COUNTS;
  await raiseBroadcastAlert(db, "broadcast.finished", {
    account: `${id}:finished`,
    broadcast_id: id,
    name: row.name,
    sent: c.sent,
    failed: c.failed,
    skipped: c.skipped,
  });
  return true;
}

type ClaimedRow = typeof broadcastRecipient.$inferSelect;

/** Step 6: claim up to `n` waiting recipients. Commits before Meta is called (foundation rule 9). */
export async function claimRecipients(db: DbClient, id: string, n: number, now: Date): Promise<ClaimedRow[]> {
  if (n <= 0) return [];
  const rows = (await db.execute(sql`
    UPDATE broadcast_recipient SET state = 'sending', claimed_at = ${now.toISOString()}::timestamptz, attempts = attempts + 1
    WHERE state = 'pending' AND id IN (
      SELECT id FROM broadcast_recipient
      WHERE broadcast_id = ${id}::uuid AND state = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now.toISOString()}::timestamptz)
      ORDER BY created_at, id
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`)) as unknown as { id: string }[];
  if (rows.length === 0) return [];
  return db
    .select()
    .from(broadcastRecipient)
    .where(inArray(broadcastRecipient.id, rows.map((r) => r.id)))
    .orderBy(asc(broadcastRecipient.createdAt), asc(broadcastRecipient.id));
}

/** R54: is this person still someone we may send to? Returns a skip reason, or null. */
async function recheckRecipient(db: DbExecutor, r: ClaimedRow): Promise<string | null> {
  if (!r.customerId) return "erased";
  const [c] = await db.select({ phone: customer.phone, deletedAt: customer.deletedAt }).from(customer).where(eq(customer.id, r.customerId));
  if (!c || c.deletedAt) return "erased";
  if (await isStoppedOnWhatsApp(db, r.customerId)) return "opted_out";
  const contactId = await resolveContactId(db, r.customerId);
  const unreachable = (await db.execute(
    sql`SELECT 1 AS x FROM contact_summary WHERE customer_id = ${contactId}::uuid AND wa_unreachable_at IS NOT NULL`,
  )) as unknown as unknown[];
  if (unreachable.length > 0) return "not_whatsapp";
  const [ident] = await db
    .select({ externalId: inboxIdentity.externalId })
    .from(inboxIdentity)
    .where(and(eq(inboxIdentity.customerId, r.customerId), eq(inboxIdentity.channel, "whatsapp")))
    .orderBy(desc(inboxIdentity.updatedAt))
    .limit(1);
  if (!audienceAddress(ident?.externalId ?? null, c.phone) || !r.toWa) return "no_phone";
  return null;
}

/** Step 7b: the thread for this person on this line, without disturbing the inbox. */
async function broadcastConversation(db: DbExecutor, customerId: string, lineId: string, now: Date): Promise<string> {
  const [latest] = await db
    .select({ id: inboxConversation.id })
    .from(inboxConversation)
    .where(and(eq(inboxConversation.customerId, customerId), eq(inboxConversation.phoneNumberId, lineId)))
    .orderBy(desc(inboxConversation.createdAt))
    .limit(1);
  if (latest) return latest.id;
  const [line] = await db.select({ teamId: inboxPhoneNumber.defaultTeamId }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, lineId));
  const [ident] = await db
    .select({ id: inboxIdentity.id })
    .from(inboxIdentity)
    .where(and(eq(inboxIdentity.customerId, customerId), eq(inboxIdentity.channel, "whatsapp")))
    .orderBy(desc(inboxIdentity.updatedAt))
    .limit(1);
  const [made] = await db
    .insert(inboxConversation)
    .values({
      customerId,
      phoneNumberId: lineId,
      teamId: line?.teamId ?? null,
      status: "closed",
      closedAt: now,
      channel: "whatsapp",
      identityId: ident?.id ?? null,
      lastActivityAt: now,
    })
    .returning({ id: inboxConversation.id });
  return made!.id;
}

async function skipRecipient(db: DbExecutor, rid: string, reason: string): Promise<void> {
  await db.update(broadcastRecipient).set({ state: "skipped", skipReason: reason }).where(and(eq(broadcastRecipient.id, rid), eq(broadcastRecipient.state, "sending")));
}

/** Back to waiting: only when Meta was never asked, or answered and said it did not send (R57). */
async function backToPending(db: DbExecutor, rid: string, o: { undoAttempt?: boolean; nextAttemptAt?: Date | null }): Promise<void> {
  await db
    .update(broadcastRecipient)
    .set({
      state: "pending",
      messageId: null,
      claimedAt: null,
      ...(o.undoAttempt ? { attempts: sql`greatest(${broadcastRecipient.attempts} - 1, 0)` } : {}),
      ...(o.nextAttemptAt !== undefined ? { nextAttemptAt: o.nextAttemptAt } : {}),
    })
    .where(and(eq(broadcastRecipient.id, rid), eq(broadcastRecipient.state, "sending")));
}

/** A recipient result's side effects (step 7d, R59): not on WhatsApp, or switched promotions off. */
async function failureSideEffects(db: DbClient, customerId: string | null, code: string | null, now: Date): Promise<void> {
  if (!customerId) return;
  if (code === "131026") {
    const contactId = await resolveContactId(db, customerId);
    await db.execute(sql`UPDATE contact_summary SET wa_unreachable_at = ${now.toISOString()}::timestamptz WHERE customer_id = ${contactId}::uuid`);
  } else if (code === "131050") {
    await db.transaction(async (tx) => {
      const contactId = await resolveContactId(tx, customerId);
      await recordConsent(tx, contactId, {
        channel: "whatsapp",
        purpose: "marketing",
        state: "withdrawn",
        method: "meta_refusal",
        wording: "WhatsApp said they switched off promotions from us",
      });
    });
  }
}

const TEMP_ERRORS_STOP = 5;
const TEMP_RETRY_MS = 10 * 60_000;

/**
 * One tick for one broadcast (section 6). Returns what happened. Never throws for a Meta
 * refusal; a database error leaves the claimed rows `sending`, which the sweep settles
 * as `unknown` (never back to waiting).
 */
export async function runBroadcastTick(
  db: DbClient,
  cfg: MetaConfig | null,
  broadcastId: string,
  now: Date,
): Promise<"sent" | "waiting" | "stopped" | "done"> {
  // 1.
  const [b] = await db.select().from(broadcast).where(eq(broadcast.id, broadcastId));
  if (!b || b.status !== "sending") return "waiting";
  const s = await loadBroadcastSettings(db);
  // 2.
  const verdict = await checkBroadcastSafety(db, b, s, now);
  if (verdict) {
    await stopBroadcast(db, b.id, verdict.stop, verdict.detail);
    return "stopped";
  }
  if (!cfg) return "waiting";
  // 3.
  if (!withinSendingHours(now, s)) {
    await eventOncePerDay(db, b.id, "waiting_hours", now);
    return "waiting";
  }
  // 4.
  if ((b.waitUntil && b.waitUntil > now) || (b.warmupUntil && b.warmupUntil > now)) return "waiting";
  // 5.
  const allowance = await dailyAllowance(db, b.phoneNumberId, s, now);
  if (allowance.leftToday <= 0) {
    await eventOncePerDay(db, b.id, "waiting_limit", now);
    return "waiting";
  }
  // 6.
  const claimed = await claimRecipients(db, b.id, Math.min(tickBatch(s.rate_per_minute), allowance.leftToday), now);
  if (claimed.length === 0) return (await finishIfComplete(db, b.id, now)) ? "done" : "waiting";

  const t = await broadcastTemplate(db, b);
  const needs = t ? templateNeeds(t.components as unknown[] | null, t.category) : null;
  const gap = Math.floor(60_000 / s.rate_per_minute);
  let sentAny = false;
  let stopped = false;
  for (let i = 0; i < claimed.length; i++) {
    const r = claimed[i]!;
    if (stopped) {
      await backToPending(db, r.id, { undoAttempt: true });
      continue;
    }
    const started = Date.now();
    // a.
    const skip = await recheckRecipient(db, r);
    if (skip) {
      await skipRecipient(db, r.id, skip);
      continue;
    }
    const vp = needs ? valuesProblem(r.values, needs) : "The template is gone.";
    if (vp || !t) {
      await backToPending(db, r.id, { undoAttempt: true });
      await stopBroadcast(db, b.id, t ? "blanks" : "template", vp ?? "The template is gone.");
      stopped = true;
      continue;
    }
    // b.
    const conversationId = await broadcastConversation(db, r.customerId!, b.phoneNumberId, now);
    // c.
    let msg: SentMessage;
    try {
      msg = await sendFromConversation(
        db,
        cfg,
        {
          conversationId,
          userId: null,
          auto: "broadcast",
          broadcast: { broadcastId: b.id, recipientId: r.id, route: b.route === "mm" ? "mm" : "cloud" },
          content: templateContent(b, t, r.values!, b.headerMediaId),
        },
        now,
      );
    } catch (err) {
      if (!(err instanceof InboxSendError)) throw err;
      if (err.code === "broadcast_duplicate") continue; // already handled elsewhere: never touched again
      if (err.code === "no_phone") {
        await skipRecipient(db, r.id, "no_phone");
        continue;
      }
      await backToPending(db, r.id, { undoAttempt: true });
      if (err.code === "broadcast_off") {
        const now2 = await loadBroadcastSettings(db);
        if (!now2.enabled) await stopBroadcast(db, b.id, "switched_off", "The owner switch is off.");
        stopped = true; // paused or stopped by a person meanwhile: leave the rest waiting
        continue;
      }
      const reason = err.code === "template_incomplete" ? "blanks" : err.code.startsWith("template") ? "template" : "config";
      await stopBroadcast(db, b.id, reason, err.message);
      if (reason === "config") await raiseConfigAlert(db, b, null, err.message);
      stopped = true;
      continue;
    }
    // d.
    if (msg.status !== "failed") {
      await db
        .update(broadcastRecipient)
        .set({
          state: sql`case when ${broadcastRecipient.state} in ('sending','unknown') then 'sent' else ${broadcastRecipient.state} end`,
          messageId: msg.id,
          waMessageId: msg.waMessageId,
          sentAt: sql`coalesce(${broadcastRecipient.sentAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(eq(broadcastRecipient.id, r.id));
      if (b.tempErrors > 0) await db.update(broadcast).set({ tempErrors: 0 }).where(eq(broadcast.id, b.id));
      b.tempErrors = 0;
      sentAny = true;
    } else {
      const payload = (msg.payload as Record<string, unknown> | null) ?? {};
      const http = typeof payload.http_status === "number" ? payload.http_status : undefined;
      const code = msg.errorCode ?? null;
      if (payload.unconfirmed === true || (code === null && http !== undefined && http >= 500)) {
        // R58: it may have arrived. Never resent; only the delivery report settles it.
        await db.update(broadcastRecipient).set({ state: "unknown", messageId: msg.id }).where(eq(broadcastRecipient.id, r.id));
      } else {
        const cls = classifyBroadcastError(code, http);
        if (cls.cls === "temporary" && r.attempts < 3) {
          const tempErrors = b.tempErrors + 1;
          await backToPending(db, r.id, { nextAttemptAt: new Date(now.getTime() + TEMP_RETRY_MS) });
          const waitMs = Math.min(60_000 * 2 ** (tempErrors - 1), 15 * 60_000);
          await db.update(broadcast).set({ tempErrors, waitUntil: new Date(now.getTime() + waitMs), updatedAt: now }).where(eq(broadcast.id, b.id));
          b.tempErrors = tempErrors;
          if (tempErrors >= TEMP_ERRORS_STOP) await stopBroadcast(db, b.id, "meta_busy", `WhatsApp asked us to slow down ${tempErrors} times in a row (code ${code ?? http}).`);
          stopped = true;
          continue;
        }
        await db
          .update(broadcastRecipient)
          .set({ state: "failed", messageId: msg.id, errorCode: code, errorText: plainFailure(code), failedAt: now })
          .where(eq(broadcastRecipient.id, r.id));
        if (cls.cls === "recipient" || cls.cls === "temporary") {
          await failureSideEffects(db, r.customerId, code, now);
        } else {
          await stopBroadcast(db, b.id, cls.stopReason ?? "config", `WhatsApp refused with code ${code}: ${plainFailure(code)}`);
          if (cls.stopReason === "config") await raiseConfigAlert(db, b, code, msg.errorMessage ?? "");
          stopped = true;
          continue;
        }
      }
    }
    // e.
    if (i < claimed.length - 1) {
      const wait = gap - (Date.now() - started);
      if (wait > 0) await broadcastDeps.sleep(wait);
    }
  }
  if (stopped) {
    const [after] = await db.select({ status: broadcast.status }).from(broadcast).where(eq(broadcast.id, b.id));
    return after?.status === "stopped" ? "stopped" : "waiting";
  }
  // 8. Warm-up: after the first 20 since the start (or the last resume), wait 10 minutes.
  await maybeWarmup(db, b.id, now);
  if (await finishIfComplete(db, b.id, now)) return "done";
  return sentAny ? "sent" : "waiting";
}

async function raiseConfigAlert(db: DbExecutor, b: BroadcastRow, code: string | null, message: string): Promise<void> {
  await raiseBroadcastAlert(db, "inbox.meta_config", {
    account: `broadcasts:${b.phoneNumberId}`,
    area: "whatsapp_broadcasts",
    code: code ?? "",
    message: message.slice(0, 300),
  });
}

async function maybeWarmup(db: DbExecutor, id: string, now: Date): Promise<void> {
  const [mark] = await db
    .select({ at: broadcastEvent.at })
    .from(broadcastEvent)
    .where(and(eq(broadcastEvent.broadcastId, id), inArray(broadcastEvent.kind, ["started", "resumed"])))
    .orderBy(desc(broadcastEvent.at))
    .limit(1);
  const since = mark?.at ?? new Date(0);
  const [warm] = await db
    .select({ id: broadcastEvent.id })
    .from(broadcastEvent)
    .where(and(eq(broadcastEvent.broadcastId, id), eq(broadcastEvent.kind, "warmup"), gte(broadcastEvent.at, since)))
    .limit(1);
  if (warm) return;
  const [c] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE claimed_at >= ${since.toISOString()}::timestamptz AND state <> 'pending')::int AS claimed,
      count(*) FILTER (WHERE state = 'pending')::int AS pending
    FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid`)) as unknown as { claimed: number; pending: number }[];
  if (Number(c?.claimed ?? 0) >= BROADCAST_LIMITS.warmupCount && Number(c?.pending ?? 0) > 0) {
    await db
      .update(broadcast)
      .set({ warmupUntil: new Date(now.getTime() + BROADCAST_LIMITS.warmupMinutes * 60_000), updatedAt: now })
      .where(eq(broadcast.id, id));
    await writeEvent(db, id, "warmup", null, null, now);
  }
}

/**
 * `broadcast_start` (every 30 s): scheduled broadcasts whose time has come start sending, one
 * per line at a time, oldest first. With the owner switch off, every scheduled broadcast is
 * stopped instead (R40: switching off is an emergency stop for everything).
 */
export async function startDueBroadcasts(db: DbExecutor, now: Date): Promise<{ started: number; stopped: number }> {
  const s = await loadBroadcastSettings(db);
  let started = 0;
  let stopped = 0;
  if (!s.enabled) {
    const due = await db.select({ id: broadcast.id }).from(broadcast).where(inArray(broadcast.status, ["scheduled", "sending"]));
    for (const d of due) if (await stopBroadcast(db, d.id, "switched_off", "The owner switch is off.")) stopped++;
    return { started, stopped };
  }
  const due = await db
    .select()
    .from(broadcast)
    .where(and(eq(broadcast.status, "scheduled"), sql`${broadcast.scheduledAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(asc(broadcast.scheduledAt), asc(broadcast.createdAt));
  for (const d of due) {
    const [busy] = await db
      .select({ id: broadcast.id })
      .from(broadcast)
      .where(and(eq(broadcast.phoneNumberId, d.phoneNumberId), eq(broadcast.status, "sending")))
      .limit(1);
    if (busy) continue;
    const [row] = await db
      .update(broadcast)
      .set({ status: "sending", startedAt: now, warmupUntil: null, updatedAt: now })
      .where(and(eq(broadcast.id, d.id), eq(broadcast.status, "scheduled")))
      .returning({ id: broadcast.id });
    if (!row) continue;
    await writeEvent(db, d.id, "started", null, null, now);
    started++;
  }
  return { started, stopped };
}

/** `broadcast_send` (every 5 s): one tick for each sending broadcast, oldest first. */
export async function runSendingBroadcasts(db: DbClient, cfg: MetaConfig | null, now: Date): Promise<number> {
  const sending = await db.select({ id: broadcast.id }).from(broadcast).where(eq(broadcast.status, "sending")).orderBy(asc(broadcast.startedAt), asc(broadcast.createdAt));
  for (const b of sending) await runBroadcastTick(db, cfg, b.id, now);
  return sending.length;
}

/**
 * `broadcast_sweep` (every 60 s): a recipient left `sending` for more than 5 minutes becomes
 * `sent` when its message reached Meta, else `unknown`, never back to waiting. Broadcasts with
 * nobody waiting or in flight finish.
 */
export async function sweepBroadcasts(db: DbExecutor, now: Date): Promise<{ settled: number; finished: number }> {
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const stuck = await db
    .select({ id: broadcastRecipient.id })
    .from(broadcastRecipient)
    .where(and(eq(broadcastRecipient.state, "sending"), lt(broadcastRecipient.claimedAt, cutoff)));
  for (const r of stuck) {
    const [m] = await db
      .select({ id: inboxMessage.id, waMessageId: inboxMessage.waMessageId, createdAt: inboxMessage.createdAt })
      .from(inboxMessage)
      .where(sql`${inboxMessage.payload}->>'recipient_id' = ${r.id}`)
      .orderBy(desc(inboxMessage.createdAt))
      .limit(1);
    if (m?.waMessageId) {
      await db
        .update(broadcastRecipient)
        .set({ state: "sent", messageId: m.id, waMessageId: m.waMessageId, sentAt: m.createdAt })
        .where(and(eq(broadcastRecipient.id, r.id), eq(broadcastRecipient.state, "sending")));
    } else {
      await db
        .update(broadcastRecipient)
        .set({ state: "unknown", ...(m ? { messageId: m.id } : {}) })
        .where(and(eq(broadcastRecipient.id, r.id), eq(broadcastRecipient.state, "sending")));
    }
  }
  let finished = 0;
  const sending = await db.select({ id: broadcast.id }).from(broadcast).where(eq(broadcast.status, "sending"));
  for (const b of sending) if (await finishIfComplete(db, b.id, now)) finished++;
  return { settled: stuck.length, finished };
}

/**
 * `broadcast_health` (every 5 minutes, only while a broadcast is sending, scheduled or paused):
 * read the line's quality and limit from Meta and store them. Errors are returned, not thrown.
 */
export async function refreshBroadcastHealth(db: DbExecutor, cfg: MetaConfig | null): Promise<{ lines: number; errors: string[] }> {
  if (!cfg) return { lines: 0, errors: [] };
  const lines = await db
    .selectDistinct({ id: inboxPhoneNumber.id, waId: inboxPhoneNumber.waPhoneNumberId })
    .from(broadcast)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, broadcast.phoneNumberId))
    .where(inArray(broadcast.status, ["sending", "scheduled", "paused"]));
  const errors: string[] = [];
  for (const l of lines) {
    if (!l.waId) continue;
    try {
      const info = await getNumberInfo(cfg, l.waId);
      await db
        .update(inboxPhoneNumber)
        .set({
          ...(info.quality_rating ? { qualityRating: info.quality_rating } : {}),
          ...(numberMessagingLimit(info) ? { messagingLimit: numberMessagingLimit(info) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(inboxPhoneNumber.id, l.id));
    } catch (err) {
      errors.push(err instanceof MetaApiError ? `code ${err.code ?? err.status}` : "error");
    }
  }
  return { lines: lines.length, errors };
}

// ── Webhook hooks (section 5.10) ────────────────────────────────────────────

const RECIPIENT_RANK: Record<string, number> = { pending: 0, sending: 1, unknown: 2, sent: 3, delivered: 4, read: 5 };

/**
 * A delivery report for a broadcast message (R58, R59). With `messageId: null` it settles a
 * recipient whose send timed out, by the callback value `bc:<recipient id>`, and returns true so
 * the status is then applied to the message as usual. States only move forward.
 */
export async function applyBroadcastStatus(
  db: DbExecutor,
  a: { messageId: string | null; waMessageId: string; callbackData?: string | null; status: string; at: Date; errorCode?: string | null; errorTitle?: string | null },
): Promise<boolean> {
  if (a.messageId === null) {
    const cb = a.callbackData ?? "";
    if (!cb.startsWith(BROADCAST_CALLBACK_PREFIX)) return false;
    const rid = cb.slice(BROADCAST_CALLBACK_PREFIX.length);
    if (!/^[0-9a-f-]{36}$/i.test(rid)) return false;
    const [r] = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.id, rid));
    if (!r || (r.state !== "unknown" && r.state !== "sending")) return false;
    const [m] = await db
      .select({ id: inboxMessage.id })
      .from(inboxMessage)
      .where(and(sql`${inboxMessage.payload}->>'recipient_id' = ${rid}`, isNull(inboxMessage.waMessageId)))
      .orderBy(desc(inboxMessage.createdAt))
      .limit(1);
    if (!m) return false;
    await db
      .update(inboxMessage)
      .set({
        waMessageId: a.waMessageId,
        status: "sent",
        errorCode: null,
        errorMessage: null,
        payload: sql`coalesce(${inboxMessage.payload}, '{}'::jsonb) - 'unconfirmed' - 'retryable'`,
      })
      .where(eq(inboxMessage.id, m.id));
    await db
      .update(broadcastRecipient)
      .set({ state: "sent", messageId: m.id, waMessageId: a.waMessageId, sentAt: sql`coalesce(${broadcastRecipient.sentAt}, ${a.at.toISOString()}::timestamptz)` })
      .where(eq(broadcastRecipient.id, rid));
    return true;
  }

  const [r] = await db.select().from(broadcastRecipient).where(eq(broadcastRecipient.messageId, a.messageId));
  if (!r) return false;
  const at = a.at.toISOString();
  if (a.status === "failed") {
    if (!["sending", "unknown", "sent"].includes(r.state)) return false;
    const code = a.errorCode ?? null;
    await db
      .update(broadcastRecipient)
      .set({ state: "failed", errorCode: code, errorText: plainFailure(code), failedAt: a.at })
      .where(eq(broadcastRecipient.id, r.id));
    if (r.customerId && code === "131026") {
      const contactId = await resolveContactId(db, r.customerId);
      await db.execute(sql`UPDATE contact_summary SET wa_unreachable_at = ${at}::timestamptz WHERE customer_id = ${contactId}::uuid`);
    } else if (r.customerId && code === "131050") {
      const contactId = await resolveContactId(db, r.customerId);
      await recordConsent(db, contactId, {
        channel: "whatsapp",
        purpose: "marketing",
        state: "withdrawn",
        method: "meta_refusal",
        wording: "WhatsApp said they switched off promotions from us",
      });
    }
    return true;
  }
  const target = a.status === "sent" ? "sent" : a.status === "delivered" ? "delivered" : a.status === "read" ? "read" : null;
  if (!target) return false;
  if (r.state === "failed" || r.state === "skipped") return false;
  if ((RECIPIENT_RANK[r.state] ?? 0) >= RECIPIENT_RANK[target]!) return false;
  await db
    .update(broadcastRecipient)
    .set({
      state: target,
      waMessageId: a.waMessageId,
      sentAt: sql`coalesce(${broadcastRecipient.sentAt}, ${at}::timestamptz)`,
      ...(target === "delivered" ? { deliveredAt: a.at } : {}),
      ...(target === "read" ? { readAt: a.at, deliveredAt: sql`coalesce(${broadcastRecipient.deliveredAt}, ${at}::timestamptz)` } : {}),
    })
    .where(eq(broadcastRecipient.id, r.id));
  return true;
}

const BLOCKING_EVENTS = new Set(["ACCOUNT_VIOLATION", "ACCOUNT_RESTRICTION", "DISABLED_UPDATE", "ACCOUNT_DELETED"]);

/**
 * `account_update` and `business_capability_update` for one of our WhatsApp accounts (R55).
 * A restriction is written to `broadcast_account_block` and stops every broadcast of that
 * account on the next tick; only a person clears it. A new limit is stored on every line.
 */
export async function applyAccountEvent(db: DbExecutor, wabaId: string, field: string, value: Record<string, unknown>): Promise<void> {
  if (field === "business_capability_update") {
    const raw = value.max_daily_conversations_per_business;
    if (typeof raw === "string" || typeof raw === "number") {
      await db.update(inboxPhoneNumber).set({ messagingLimit: String(raw), updatedAt: new Date() }).where(eq(inboxPhoneNumber.wabaId, wabaId));
    }
    return;
  }
  if (field !== "account_update") return;
  const event = String(value.event ?? "").toUpperCase();
  if (!BLOCKING_EVENTS.has(event)) return;
  if (event === "ACCOUNT_RESTRICTION") {
    const list = Array.isArray(value.restriction_info) ? (value.restriction_info as { restriction_type?: unknown }[]) : [];
    if (!list.some((x) => String(x?.restriction_type ?? "") === "RESTRICTED_BIZ_INITIATED_MESSAGING")) return;
  }
  const info = (value.violation_info ?? value.ban_info ?? value.restriction_info ?? null) as unknown;
  const detail = info ? JSON.stringify(info).slice(0, 300) : null;
  const blocks = await loadAccountBlocks(db);
  blocks[wabaId] = { waba_id: wabaId, event, detail, at: new Date().toISOString() };
  await db
    .insert(appSetting)
    .values({ key: BROADCAST_ACCOUNT_BLOCK_KEY, value: blocks })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: blocks, updatedAt: new Date() } });
}

// ── Results (R62) ───────────────────────────────────────────────────────────

/** Orders placed by recipients within the attribution window of their message (R62's order rule). */
export async function broadcastOrders(db: DbExecutor, id: string, days: number): Promise<{ days: number; people: number; orders: number; total_ngn: number }> {
  const [row] = (await db.execute(sql`
    WITH r AS (
      SELECT r.id, r.customer_id, r.sent_at FROM broadcast_recipient r
      WHERE r.broadcast_id = ${id}::uuid AND r.customer_id IS NOT NULL AND r.sent_at IS NOT NULL AND r.state IN ('sent','delivered','read')
    ), o AS (
      SELECT DISTINCT ON (so.id) so.id, so.total_ngn, r.customer_id
      FROM r
      JOIN sale_order so ON (so.customer_id = r.customer_id OR so.customer_id IN (SELECT a.customer_id FROM contact_alias a WHERE a.into_customer_id = r.customer_id))
      WHERE so.status NOT IN ('cancelled','failed')
        AND so.created_at_local > r.sent_at
        AND so.created_at_local <= r.sent_at + make_interval(days => ${days}::int)
        AND NOT EXISTS (
          SELECT 1 FROM broadcast_recipient r2 JOIN broadcast b2 ON b2.id = r2.broadcast_id
          WHERE r2.customer_id = r.customer_id AND r2.broadcast_id <> ${id}::uuid AND r2.state IN ('sent','delivered','read')
            AND r2.sent_at > r.sent_at AND r2.sent_at < so.created_at_local
            AND so.created_at_local <= r2.sent_at + make_interval(days => b2.attribution_days)
        )
    )
    SELECT count(DISTINCT customer_id)::int AS people, count(*)::int AS orders, coalesce(sum(total_ngn), 0)::bigint AS total
    FROM o`)) as unknown as { people: number; orders: number; total: string | number }[];
  return { days, people: Number(row?.people ?? 0), orders: Number(row?.orders ?? 0), total_ngn: Number(row?.total ?? 0) };
}

/** Is there a broadcast still holding recipients for this phone number in flight? (used by screens) */
export async function recipientsWaiting(db: DbExecutor, id: string): Promise<number> {
  const [r] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = ${id}::uuid AND state = 'pending'`,
  )) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

