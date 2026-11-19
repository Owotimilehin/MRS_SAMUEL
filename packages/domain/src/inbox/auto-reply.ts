/**
 * Automatic WhatsApp reply to customers who write while the business is closed.
 *
 * Runs from the inbox worker loop, never from the webhook, so receiving a
 * message is never slowed down or broken by it. Each run looks only at
 * WhatsApp messages that arrived in the last 10 minutes (no backlog after
 * downtime) and sends the number's "after-hours message" when ALL of these hold:
 *   - the conversation is a WhatsApp one on a phone line (never Messenger or Instagram)
 *   - the number uses WhatsApp, is in use, and has an after-hours message
 *   - the number has an opening-hours schedule (no schedule = always open)
 *   - the business was closed when the customer wrote and is still closed now
 *     (same hours and holiday rules as phone calls)
 *   - no member of staff has replied in that conversation since closing
 *   - no automatic reply went to that conversation since closing, nor in the
 *     last 12 hours
 *
 * At most once: the message row, marked payload.auto = "after_hours", is saved
 * before Meta is called, and that row is what later runs look for. A crash
 * between saving and sending therefore means "not sent", never "sent twice".
 * Only a send Meta certainly refused for a passing reason (rate limit) is
 * tried again, up to 3 times.
 *
 * It is not a staff reply: no sender, no first-response time, no assignment.
 */
import { and, eq, gte, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import {
  inboxConversation,
  inboxHoliday,
  inboxHoursProfile,
  inboxHoursRule,
  inboxMessage,
  inboxPhoneNumber,
  type DbClient,
} from "@ms/db";
import { closedSince, isOpenNow, type HoursRule } from "@ms/shared";
import type { MetaConfig } from "./meta.js";
import { InboxSendError, sendFromConversation } from "./send.js";

export const AFTER_HOURS_AUTO = "after_hours";
/** Only messages this recent are answered (nothing older after downtime). */
export const AUTO_REPLY_RECENT_MS = 10 * 60 * 1000;
/** Never more than one automatic reply to a conversation in this long. */
export const AUTO_REPLY_MIN_GAP_MS = 12 * 60 * 60 * 1000;
const AUTO_REPLY_MAX_TRIES = 3;

interface AutoReplyLog {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

interface Hours {
  rules: HoursRule[];
  holidays: string[];
  timeZone: string;
}

/** A number's schedule, read the same way the phone-call route reads it. */
async function loadHours(db: DbClient, profileId: string): Promise<Hours | null> {
  const [profile] = await db.select().from(inboxHoursProfile).where(eq(inboxHoursProfile.id, profileId));
  if (!profile) return null;
  const rules = await db
    .select({ weekday: inboxHoursRule.weekday, openTime: inboxHoursRule.openTime, closeTime: inboxHoursRule.closeTime })
    .from(inboxHoursRule)
    .where(eq(inboxHoursRule.profileId, profile.id));
  const holidays = await db
    .select({ date: inboxHoliday.date })
    .from(inboxHoliday)
    .where(sql`${inboxHoliday.profileId} = ${profile.id} or ${inboxHoliday.profileId} is null`);
  return { rules, holidays: holidays.map((h) => String(h.date)), timeZone: profile.timeZone };
}

/** Returns how many automatic replies were sent. */
export async function sendAfterHoursAutoReplies(
  db: DbClient,
  cfg: MetaConfig | null,
  log: AutoReplyLog,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  if (!cfg) return 0; // WhatsApp not configured: nothing can be sent.
  const now = opts.now ?? new Date();

  const candidates = await db
    .select({
      conversationId: inboxConversation.id,
      lastInboundAt: sql<Date>`max(${inboxMessage.createdAt})`.mapWith(inboxMessage.createdAt),
      text: inboxPhoneNumber.afterHoursText,
      hoursProfileId: inboxPhoneNumber.hoursProfileId,
    })
    .from(inboxMessage)
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .where(
      and(
        eq(inboxMessage.direction, "in"),
        // WhatsApp only: Messenger and Instagram threads (suite spec 02) share these
        // tables, so the message, the conversation and the line must all be WhatsApp.
        // Calls live in another table.
        eq(inboxMessage.channel, "whatsapp"),
        eq(inboxConversation.channel, "whatsapp"),
        eq(inboxPhoneNumber.kind, "phone"),
        // A reaction (a thumbs-up on an old message) is not someone writing in, nor is
        // a WhatsApp system notice ("changed their number"), which also leaves the window alone.
        notInArray(inboxMessage.type, ["reaction", "system"]),
        gte(inboxMessage.createdAt, new Date(now.getTime() - AUTO_REPLY_RECENT_MS)),
        // Meta stamps messages in whole seconds; allow a little clock difference.
        lte(inboxMessage.createdAt, new Date(now.getTime() + 60_000)),
        eq(inboxPhoneNumber.isActive, true),
        ne(inboxPhoneNumber.channels, "voice"),
        isNotNull(inboxPhoneNumber.waPhoneNumberId),
        isNotNull(inboxPhoneNumber.hoursProfileId),
        sql`btrim(coalesce(${inboxPhoneNumber.afterHoursText}, '')) <> ''`,
      ),
    )
    .groupBy(inboxConversation.id, inboxPhoneNumber.id)
    .orderBy(sql`max(${inboxMessage.createdAt})`)
    .limit(opts.batchSize ?? 50);

  const hoursCache = new Map<string, Hours | null>();
  let sent = 0;
  for (const c of candidates) {
    try {
      const profileId = c.hoursProfileId!;
      if (!hoursCache.has(profileId)) hoursCache.set(profileId, await loadHours(db, profileId));
      const hours = hoursCache.get(profileId);
      if (!hours) continue; // schedule was removed: treated as always open

      if (isOpenNow(hours.rules, hours.holidays, c.lastInboundAt, hours.timeZone)) continue; // wrote while open
      const since = closedSince(hours.rules, hours.holidays, now, hours.timeZone);
      if (!since) continue; // open now: staff are there to answer

      const gapStart = new Date(now.getTime() - AUTO_REPLY_MIN_GAP_MS);
      const from = since < gapStart ? since : gapStart;
      const outbound = await db
        .select({
          createdAt: inboxMessage.createdAt,
          status: inboxMessage.status,
          senderUserId: inboxMessage.senderUserId,
          payload: inboxMessage.payload,
        })
        .from(inboxMessage)
        .where(
          and(
            eq(inboxMessage.conversationId, c.conversationId),
            eq(inboxMessage.direction, "out"),
            gte(inboxMessage.createdAt, from),
          ),
        );

      const staffReplied = outbound.some((m) => m.senderUserId !== null && m.status !== "failed" && m.createdAt >= since);
      if (staffReplied) continue;

      const autos = outbound.filter((m) => m.payload?.auto === AFTER_HOURS_AUTO);
      // "Certainly not sent, worth another go" is the only kind that may be retried.
      const retryable = (m: (typeof autos)[number]): boolean => m.status === "failed" && m.payload?.retryable === true;
      if (autos.some((m) => !retryable(m))) continue; // already sent (or possibly sent) this closed period / in the last 12h
      if (autos.length >= AUTO_REPLY_MAX_TRIES) continue;

      const msg = await sendFromConversation(
        db,
        cfg,
        { conversationId: c.conversationId, userId: null, content: { type: "text", body: c.text!.trim() }, auto: AFTER_HOURS_AUTO },
        now,
      );
      if (msg.status === "failed") {
        log.warn({ conversationId: c.conversationId, messageId: msg.id, error: msg.errorMessage }, "after-hours auto-reply failed");
      } else {
        sent++;
      }
    } catch (err) {
      if (err instanceof InboxSendError) {
        log.warn({ conversationId: c.conversationId, code: err.code, err: err.message }, "after-hours auto-reply not sent");
      } else {
        // One conversation's problem must not stop the others.
        log.error({ err, conversationId: c.conversationId }, "after-hours auto-reply error");
      }
    }
  }
  return sent;
}
