/**
 * Consent (suite spec 14, rules R24 to R31): who agreed to what, when and how,
 * and who asked us to stop.
 *
 * contact_consent is a history. Rows are never edited except `is_current` and
 * `confirm_state`. The current answer for a contact, channel and purpose is
 * the one row with `is_current`; no row means "not asked".
 *
 * The rule that matters most: a "stopped" record always wins over any bulk or
 * carried "yes". Only a person (staff), the customer's own START, or the
 * customer's own WhatsApp setting can lift a stop.
 *
 * PHASE B: before every broadcast send, call `isStoppedOnWhatsApp` (rule R54).
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  appSetting,
  contactAlias,
  contactConsent,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  CONTACT_SETTINGS_KEY,
  WHATSAPP_ACCOUNT_KEY,
  consentKeyword,
  readContactSettings,
  waWindowOpen,
  type ConsentChannel,
  type ConsentMethod,
  type ConsentPurpose,
  type ConsentState,
  type ContactSettings,
} from "@ms/shared";
import type { MetaConfig } from "../inbox/meta.js";
import { InboxSendError, sendFromConversation } from "../inbox/send.js";

export type ConsentChange = {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  state: ConsentState;
  method: ConsentMethod;
  wording?: string | null;
  note?: string | null;
  /** "YYYY-MM-DD": when the customer gave it (not when we wrote it down). */
  collectedOn?: string | null;
  recordedBy?: string | null;
  importId?: string | null;
  messageId?: string | null;
  /** Queue the automatic WhatsApp confirmation (rule R29). */
  confirm?: boolean;
  /** When it happened, if not now: the time of the customer's own STOP or START message. */
  recordedAt?: Date;
};

/** The methods that may turn a "stopped" back into "agreed" (rule R26). */
const MAY_LIFT_A_STOP: readonly ConsentMethod[] = ["staff", "keyword", "whatsapp_setting"];

export const OPT_OUT_AUTO = "opt_out";
export const OPT_IN_AUTO = "opt_in";
/** A confirmation is only sent this soon after the customer's message (rule R29). */
export const CONSENT_CONFIRM_MAX_AGE_MS = 10 * 60 * 1000;
/** Never two confirmations of the same kind to one customer inside this long. */
export const CONSENT_CONFIRM_GAP_MS = 24 * 60 * 60 * 1000;
const CONFIRM_BATCH = 20;

/**
 * The contact a customer record stands for: itself, or the contact it was
 * merged into (contact_alias). Consent belongs to the contact, so a STOP from
 * a merged record's number stops the kept contact (rule R28).
 */
export async function resolveContactId(db: DbExecutor, customerId: string): Promise<string> {
  const [alias] = await db
    .select({ into: contactAlias.intoCustomerId })
    .from(contactAlias)
    .where(eq(contactAlias.customerId, customerId));
  return alias?.into ?? customerId;
}

/**
 * Insert a history row and make it current, in the caller's transaction.
 * Returns false (and writes nothing) when the current row already has this
 * state, or when a bulk or carried "yes" meets a "stopped" (rule R26).
 *
 * Must run inside a transaction: it takes a transaction-scoped lock per
 * customer so two changes at once cannot both become current.
 */
export async function recordConsent(db: DbExecutor, customerId: string, c: ConsentChange): Promise<boolean> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`contact-consent:${customerId}`}))`);
  const [current] = await db
    .select({ id: contactConsent.id, state: contactConsent.state })
    .from(contactConsent)
    .where(
      and(
        eq(contactConsent.customerId, customerId),
        eq(contactConsent.channel, c.channel),
        eq(contactConsent.purpose, c.purpose),
        eq(contactConsent.isCurrent, true),
      ),
    );
  if (current?.state === c.state) return false;
  // A stop always wins over a bulk yes.
  if (current?.state === "withdrawn" && c.state === "granted" && !MAY_LIFT_A_STOP.includes(c.method)) return false;

  if (current) await db.update(contactConsent).set({ isCurrent: false }).where(eq(contactConsent.id, current.id));
  await db.insert(contactConsent).values({
    customerId,
    channel: c.channel,
    purpose: c.purpose,
    state: c.state,
    method: c.method,
    wording: c.wording ?? null,
    note: c.note ?? null,
    collectedOn: c.collectedOn ?? null,
    recordedBy: c.recordedBy ?? null,
    importId: c.importId ?? null,
    messageId: c.messageId ?? null,
    isCurrent: true,
    confirmState: c.confirm ? "pending" : "none",
    ...(c.recordedAt ? { recordedAt: c.recordedAt } : {}),
  });
  return true;
}

/** Every current answer of a contact (one per channel and purpose that has a record). */
export async function currentConsent(
  db: DbExecutor,
  customerId: string,
): Promise<{ channel: string; purpose: string; state: string; method: string; recorded_at: Date }[]> {
  return db
    .select({
      channel: contactConsent.channel,
      purpose: contactConsent.purpose,
      state: contactConsent.state,
      method: contactConsent.method,
      recorded_at: contactConsent.recordedAt,
    })
    .from(contactConsent)
    .where(and(eq(contactConsent.customerId, customerId), eq(contactConsent.isCurrent, true)))
    .orderBy(asc(contactConsent.channel), asc(contactConsent.purpose));
}

/** The current WhatsApp promotions answer: "granted", "withdrawn", or null for "not asked". */
export async function whatsappMarketingConsent(
  db: DbExecutor,
  customerId: string,
): Promise<{ state: ConsentState; method: ConsentMethod; recordedAt: Date } | null> {
  const [row] = await db
    .select({ state: contactConsent.state, method: contactConsent.method, recordedAt: contactConsent.recordedAt })
    .from(contactConsent)
    .where(
      and(
        eq(contactConsent.customerId, customerId),
        eq(contactConsent.channel, "whatsapp"),
        eq(contactConsent.purpose, "marketing"),
        eq(contactConsent.isCurrent, true),
      ),
    );
  return row ? { state: row.state as ConsentState, method: row.method as ConsentMethod, recordedAt: row.recordedAt } : null;
}

/**
 * Has this contact asked us to stop promotions on WhatsApp? Follows a merged
 * record to the contact it stands for. PHASE B must call this just before
 * every send (rule R54) and when it builds an audience (rule R47).
 */
export async function isStoppedOnWhatsApp(db: DbExecutor, customerId: string): Promise<boolean> {
  const contactId = await resolveContactId(db, customerId);
  return (await whatsappMarketingConsent(db, contactId))?.state === "withdrawn";
}

/**
 * Called by WhatsApp ingest for every inbound customer message (rule R27).
 * No Meta call. Acts only when the whole message is one of the words.
 *
 * "stop": withdraws promotions on WhatsApp and queues one confirmation. A
 * second STOP while already stopped changes nothing and queues nothing (R30),
 * but is still reported as "stop" so the message is marked as a consent word.
 * "start": only for someone who had stopped; otherwise it is an ordinary
 * message and null is returned.
 */
export async function applyConsentKeyword(
  db: DbExecutor,
  a: { customerId: string; messageId: string; type: string; body: string | null; at: Date },
): Promise<"stop" | "start" | null> {
  if (a.type !== "text" && a.type !== "button" && a.type !== "interactive") return null;
  const kw = consentKeyword(a.body);
  if (!kw) return null;
  const contactId = await resolveContactId(db, a.customerId);

  if (kw === "stop") {
    await recordConsent(db, contactId, {
      channel: "whatsapp",
      purpose: "marketing",
      state: "withdrawn",
      method: "keyword",
      wording: "Replied STOP on WhatsApp",
      messageId: a.messageId,
      confirm: true,
      recordedAt: a.at,
    });
    return "stop";
  }

  // A bare START from someone who never stopped is not an agreement (Q-A4).
  const current = await whatsappMarketingConsent(db, contactId);
  if (current?.state !== "withdrawn") return null;
  await recordConsent(db, contactId, {
    channel: "whatsapp",
    purpose: "marketing",
    state: "granted",
    method: "keyword",
    wording: "Replied START on WhatsApp",
    messageId: a.messageId,
    confirm: true,
    recordedAt: a.at,
  });
  return "start";
}

/**
 * Called by WhatsApp ingest for a `user_preferences` change (rule R31): the
 * customer stopped or resumed "Offers and announcements" from us in WhatsApp's
 * own settings. A resume lifts only a stop that came from WhatsApp itself; a
 * person who wrote STOP to us stays stopped until they write START or tell
 * staff. No confirmation is sent for either. Returns whether anything changed.
 */
export async function applyUserPreference(
  db: DbExecutor,
  p: { wa_id?: string; user_id?: string; category?: string; value?: string; timestamp?: number },
): Promise<boolean> {
  if (!p || p.category !== "marketing_messages") return false;
  if (p.value !== "stop" && p.value !== "resume") return false;
  let customerId: string | null = null;
  for (const externalId of [p.wa_id, p.user_id]) {
    if (typeof externalId !== "string" || !externalId.trim()) continue;
    const [ident] = await db
      .select({ customerId: inboxIdentity.customerId })
      .from(inboxIdentity)
      .where(
        and(
          eq(inboxIdentity.channel, "whatsapp"),
          eq(inboxIdentity.accountExternalId, WHATSAPP_ACCOUNT_KEY),
          eq(inboxIdentity.externalId, externalId.trim().replace(/^\+/, "")),
        ),
      );
    if (ident) {
      customerId = ident.customerId;
      break;
    }
  }
  if (!customerId) return false;
  const contactId = await resolveContactId(db, customerId);

  if (p.value === "stop") {
    return recordConsent(db, contactId, {
      channel: "whatsapp",
      purpose: "marketing",
      state: "withdrawn",
      method: "whatsapp_setting",
      wording: "Turned promotions off in WhatsApp",
    });
  }
  const current = await whatsappMarketingConsent(db, contactId);
  if (current?.state !== "withdrawn") return false;
  if (current.method !== "whatsapp_setting" && current.method !== "meta_refusal") return false;
  return recordConsent(db, contactId, {
    channel: "whatsapp",
    purpose: "marketing",
    state: "granted",
    method: "whatsapp_setting",
    wording: "Turned promotions back on in WhatsApp",
  });
}

/** Contact settings from app_settings, with the defaults for anything missing. */
export async function loadContactSettings(db: DbExecutor): Promise<ContactSettings> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, CONTACT_SETTINGS_KEY));
  return readContactSettings(row?.value);
}

/**
 * Worker (rule R29): answer a STOP or START once, as ordinary free text inside
 * the 24-hour window, in the conversation the customer wrote in.
 *
 * Each row is marked `sending` (and that is committed) before anything else,
 * so nothing is ever sent twice. It is never retried: a row found `sending`
 * from an earlier, interrupted run becomes `skipped`. A row is `skipped` when
 * the switch is off, the row is older than 10 minutes, the conversation is not
 * an open-window WhatsApp one, or the same kind of confirmation already went
 * to this customer in the last 24 hours. Returns how many were sent.
 */
export async function sendConsentConfirmations(db: DbClient, cfg: MetaConfig | null, now: Date = new Date()): Promise<number> {
  if (!cfg) return 0;
  // Left over from a run that stopped part-way: it may have been sent. Never again.
  await db.update(contactConsent).set({ confirmState: "skipped" }).where(eq(contactConsent.confirmState, "sending"));

  const pending = await db
    .select()
    .from(contactConsent)
    .where(eq(contactConsent.confirmState, "pending"))
    .orderBy(asc(contactConsent.recordedAt))
    .limit(CONFIRM_BATCH);
  if (pending.length === 0) return 0;
  const settings = await loadContactSettings(db);

  let sent = 0;
  for (const row of pending) {
    const [claimed] = await db
      .update(contactConsent)
      .set({ confirmState: "sending" })
      .where(and(eq(contactConsent.id, row.id), eq(contactConsent.confirmState, "pending")))
      .returning({ id: contactConsent.id });
    if (!claimed) continue;

    const finish = (state: "sent" | "skipped" | "failed") =>
      db.update(contactConsent).set({ confirmState: state }).where(eq(contactConsent.id, row.id));
    try {
      const kind = row.state === "withdrawn" ? OPT_OUT_AUTO : OPT_IN_AUTO;
      const text = (row.state === "withdrawn" ? settings.stop_text : settings.start_text).trim();
      const tooOld = now.getTime() - row.recordedAt.getTime() > CONSENT_CONFIRM_MAX_AGE_MS;
      if (!settings.stop_confirmation || tooOld || !text || row.channel !== "whatsapp" || !row.messageId) {
        await finish("skipped");
        continue;
      }
      // The conversation of the customer's own STOP or START message.
      const [conv] = await db
        .select({
          id: inboxConversation.id,
          channel: inboxConversation.channel,
          lastInboundWaAt: inboxConversation.lastInboundWaAt,
        })
        .from(inboxMessage)
        .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
        .where(eq(inboxMessage.id, row.messageId));
      if (!conv || conv.channel !== "whatsapp" || !waWindowOpen(conv.lastInboundWaAt, now)) {
        await finish("skipped");
        continue;
      }
      // One of a kind per customer per day, whatever became of the earlier one.
      const theirConversations = db
        .select({ id: inboxConversation.id })
        .from(inboxConversation)
        .where(eq(inboxConversation.customerId, row.customerId));
      const [earlier] = await db
        .select({ id: inboxMessage.id })
        .from(inboxMessage)
        .where(
          and(
            inArray(inboxMessage.conversationId, theirConversations),
            eq(inboxMessage.direction, "out"),
            gte(inboxMessage.createdAt, new Date(now.getTime() - CONSENT_CONFIRM_GAP_MS)),
            sql`${inboxMessage.payload}->>'auto' = ${kind}`,
          ),
        )
        .limit(1);
      if (earlier) {
        await finish("skipped");
        continue;
      }

      const msg = await sendFromConversation(
        db,
        cfg,
        { conversationId: conv.id, userId: null, auto: kind, content: { type: "text", body: text } },
        now,
      );
      if (msg.status === "failed") {
        await finish("failed");
      } else {
        await finish("sent");
        sent++;
      }
    } catch (err) {
      // Refused before anything was sent (window closed, no WhatsApp on the line): skipped. Anything else: failed. Never retried.
      await finish(err instanceof InboxSendError ? "skipped" : "failed");
    }
  }
  return sent;
}

/** A contact's whole consent history, newest first. */
export async function consentHistory(db: DbExecutor, customerId: string) {
  return db
    .select()
    .from(contactConsent)
    .where(eq(contactConsent.customerId, customerId))
    .orderBy(desc(contactConsent.recordedAt), desc(contactConsent.isCurrent));
}
