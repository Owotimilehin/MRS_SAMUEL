import type { Capability } from "@ms/shared";
import { Hono } from "hono";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { adminUser, customer, inboxCall, inboxConversation, inboxPhoneNumber, inboxRecording, type DbClient } from "@ms/db";
import { conversationScope, type InboxViewer } from "@ms/domain";
import { requireAuth } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { reloadViewer } from "../inbox/realtime.js";

/**
 * Calls, as their own section of the suite (separate from the Inbox, 22 Nov 2026):
 *   GET /             the call log, newest first, with filters
 *   GET /callbacks    missed calls and voicemails nobody has returned yet
 *   GET /metrics      answer rate, time to answer, talk time, returns, busiest hours, per staff
 *
 * Every query is limited to the conversations the viewer can see in the Inbox (conversationScope),
 * so a member of staff sees exactly the calls they would see in a customer's chat.
 *
 * "Returned" = we made an outgoing call to the same customer after the missed call, or the
 * customer called again and someone answered. That is the definition shown on the page.
 */

/** Inbound calls nobody spoke to. "information" (menu played a message) and in-progress calls are not misses. */
const MISSED_OUTCOMES = ["missed", "voicemail", "after_hours", "failed"] as const;
/** How far back the call-back list looks. */
const CALLBACK_DAYS = 14;

const ListQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(["in", "out"]).optional(),
  outcome: z.enum(["answered", "missed", "voicemail", "after_hours", "information", "failed", "in_progress"]).optional(),
  staff: z.string().uuid().optional(),
  number: z.string().uuid().optional(),
  customer: z.string().uuid().optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  number: z.string().uuid().optional(),
});

/** Lagos calendar days → [from, to) instants; `to` is inclusive of its whole day. */
function lagosRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00+01:00`);
  const end = new Date(new Date(`${to}T00:00:00+01:00`).getTime() + 86_400_000);
  if (!(end > start) || end.getTime() - start.getTime() > 400 * 86_400_000) {
    throw new BusinessError("validation_failed", "Pick a range of up to 400 days", 400);
  }
  return { start, end };
}

/** SQL: has this (inbound, missed) call been returned? Used by the list, the call-back queue and the metrics. */
function returnedAt(): SQL<string | null> {
  return sql<string | null>`(
    select min(later_call.started_at) from inbox_call later_call
    where later_call.customer_id = ${inboxCall.customerId}
      and later_call.started_at > ${inboxCall.startedAt}
      and (later_call.direction = 'out' or (later_call.direction = 'in' and later_call.outcome = 'answered'))
  )`;
}

async function viewerWith(db: DbClient, userId: string, cap: Capability): Promise<InboxViewer> {
  const viewer = await reloadViewer(db, userId);
  if (!viewer || !(viewer.capabilities as readonly string[]).includes(cap)) {
    throw new BusinessError("forbidden", `missing capability: ${cap}`, 403);
  }
  return viewer;
}

export function inboxCallRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  /** The call log. Each row carries the customer, the line, who answered, waits, and any recording or voicemail. */
  r.get("/", async (c) => {
    const viewer = await viewerWith(db, c.get("auth").userId, "inbox.view");
    const q = ListQuery.parse(c.req.query());
    const where: SQL[] = [conversationScope(viewer)];
    if (q.from && q.to) {
      const { start, end } = lagosRange(q.from, q.to);
      where.push(gte(inboxCall.startedAt, start), lt(inboxCall.startedAt, end));
    }
    if (q.direction) where.push(eq(inboxCall.direction, q.direction));
    if (q.outcome) where.push(eq(inboxCall.outcome, q.outcome));
    if (q.staff) where.push(eq(inboxCall.answeredByUserId, q.staff));
    if (q.number) where.push(eq(inboxCall.phoneNumberId, q.number));
    if (q.customer) where.push(eq(inboxCall.customerId, q.customer));
    if (q.before) where.push(lt(inboxCall.startedAt, new Date(q.before)));
    return c.json(await callRows(db, viewer, where, q.limit));
  });

  /** Missed calls and voicemails in the last 14 days that nobody has returned yet, oldest waiting first. */
  r.get("/callbacks", async (c) => {
    const viewer = await viewerWith(db, c.get("auth").userId, "inbox.view");
    const since = new Date(Date.now() - CALLBACK_DAYS * 86_400_000);
    const where: SQL[] = [
      conversationScope(viewer),
      eq(inboxCall.direction, "in"),
      inArray(inboxCall.outcome, [...MISSED_OUTCOMES]),
      gte(inboxCall.startedAt, since),
      sql`${returnedAt()} is null`,
    ];
    // One line per customer: their most recent unreturned call, with how many times they tried.
    const page = await callRows(db, viewer, where, 200);
    const byCustomer = new Map<string, (typeof page.data)[number] & { attempts: number }>();
    for (const row of page.data) {
      const seen = byCustomer.get(row.customer.id);
      if (seen) seen.attempts += 1;
      else byCustomer.set(row.customer.id, { ...row, attempts: 1 });
    }
    const data = [...byCustomer.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
    return c.json({ data, count: data.length, window_days: CALLBACK_DAYS });
  });

  /** Figures for a date range (Lagos days, `to` inclusive). */
  r.get("/metrics", async (c) => {
    const viewer = await viewerWith(db, c.get("auth").userId, "inbox.reports");
    const q = Range.parse(c.req.query());
    const { start, end } = lagosRange(q.from, q.to);
    const scope: SQL[] = [conversationScope(viewer), gte(inboxCall.startedAt, start), lt(inboxCall.startedAt, end)];
    if (q.number) scope.push(eq(inboxCall.phoneNumberId, q.number));
    const missedList = sql.raw(MISSED_OUTCOMES.map((o) => `'${o}'`).join(","));
    const isIn = sql`${inboxCall.direction} = 'in'`;
    const isMissedIn = sql`${inboxCall.direction} = 'in' and ${inboxCall.outcome} in (${missedList})`;
    const waitS = sql`extract(epoch from (${inboxCall.answeredAt} - ${inboxCall.startedAt}))`;
    const returned = returnedAt();

    const [totals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        inbound: sql<number>`count(*) filter (where ${isIn})::int`,
        outbound: sql<number>`count(*) filter (where ${inboxCall.direction} = 'out')::int`,
        answered_in: sql<number>`count(*) filter (where ${isIn} and ${inboxCall.outcome} = 'answered')::int`,
        missed_in: sql<number>`count(*) filter (where ${isMissedIn})::int`,
        voicemail: sql<number>`count(*) filter (where ${inboxCall.outcome} = 'voicemail')::int`,
        after_hours: sql<number>`count(*) filter (where ${inboxCall.outcome} = 'after_hours')::int`,
        information: sql<number>`count(*) filter (where ${inboxCall.outcome} = 'information')::int`,
        avg_wait_s: sql<number | null>`round(avg(${waitS}) filter (where ${isIn} and ${inboxCall.answeredAt} is not null))::int`,
        avg_duration_s: sql<number | null>`round(avg(${inboxCall.durationS}) filter (where ${inboxCall.outcome} = 'answered'))::int`,
        talk_s: sql<number>`coalesce(sum(${inboxCall.durationS}) filter (where ${inboxCall.outcome} = 'answered'), 0)::int`,
        returned: sql<number>`count(*) filter (where ${isMissedIn} and ${returned} is not null)::int`,
        median_return_s: sql<number | null>`round(percentile_cont(0.5) within group (order by extract(epoch from (${returned}::timestamptz - ${inboxCall.startedAt}))) filter (where ${isMissedIn} and ${returned} is not null))::int`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope));

    const lagos = (col: unknown) => sql`(${col} at time zone 'Africa/Lagos')`;
    const perDay = await db
      .select({
        day: sql<string>`to_char(${lagos(inboxCall.startedAt)}, 'YYYY-MM-DD')`,
        inbound: sql<number>`count(*) filter (where ${isIn})::int`,
        outbound: sql<number>`count(*) filter (where ${inboxCall.direction} = 'out')::int`,
        answered: sql<number>`count(*) filter (where ${isIn} and ${inboxCall.outcome} = 'answered')::int`,
        missed: sql<number>`count(*) filter (where ${isMissedIn})::int`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // Busiest times for incoming calls: weekday (0 = Sunday) × hour, Lagos time.
    const heat = await db
      .select({
        dow: sql<number>`extract(dow from ${lagos(inboxCall.startedAt)})::int`,
        hour: sql<number>`extract(hour from ${lagos(inboxCall.startedAt)})::int`,
        calls: sql<number>`count(*)::int`,
        missed: sql<number>`count(*) filter (where ${isMissedIn})::int`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope, isIn))
      .groupBy(sql`1`, sql`2`);

    const staffUser = alias(adminUser, "call_staff");
    const staff = await db
      .select({
        user_id: staffUser.id,
        name: sql<string>`coalesce(${staffUser.name}, ${staffUser.email})`,
        answered: sql<number>`count(*) filter (where ${inboxCall.direction} = 'in' and ${inboxCall.outcome} = 'answered')::int`,
        made: sql<number>`count(*) filter (where ${inboxCall.direction} = 'out')::int`,
        talk_s: sql<number>`coalesce(sum(${inboxCall.durationS}) filter (where ${inboxCall.outcome} = 'answered'), 0)::int`,
        avg_wait_s: sql<number | null>`round(avg(${waitS}) filter (where ${isIn} and ${inboxCall.answeredAt} is not null))::int`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .innerJoin(
        staffUser,
        sql`${staffUser.id} = coalesce(${inboxCall.answeredByUserId}, ${inboxCall.startedByUserId})`,
      )
      .where(and(...scope))
      .groupBy(staffUser.id, staffUser.name, staffUser.email)
      .orderBy(desc(sql`3`));

    const menu = await db
      .select({ choice: inboxCall.ivrChoice, calls: sql<number>`count(*)::int` })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope, isIn, sql`${inboxCall.ivrChoice} is not null`))
      .groupBy(inboxCall.ivrChoice)
      .orderBy(desc(sql`2`));

    return c.json({
      data: {
        totals: totals ?? null,
        per_day: perDay,
        heat,
        staff,
        menu,
        definitions: {
          missed: "An incoming call nobody spoke to: missed, voicemail, after hours, or failed.",
          returned: "We called the customer back afterwards, or they called again and someone answered.",
        },
      },
    });
  });

  return r;
}

/** Shared row builder for the log and the call-back queue. */
async function callRows(db: DbClient, viewer: InboxViewer, where: SQL[], limit: number) {
  const answerer = alias(adminUser, "answerer");
  const rows = await db
    .select({
      id: inboxCall.id,
      conversation_id: inboxCall.conversationId,
      direction: inboxCall.direction,
      outcome: inboxCall.outcome,
      from_e164: inboxCall.fromE164,
      to_e164: inboxCall.toE164,
      ivr_choice: inboxCall.ivrChoice,
      started_at: inboxCall.startedAt,
      answered_at: inboxCall.answeredAt,
      duration_s: inboxCall.durationS,
      followup_sent_at: inboxCall.followupSentAt,
      returned_at: returnedAt(),
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      line: inboxPhoneNumber.label,
      phone_number_id: inboxCall.phoneNumberId,
      answered_by: sql<string | null>`coalesce(${answerer.name}, ${answerer.email})`,
    })
    .from(inboxCall)
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
    .innerJoin(customer, eq(customer.id, inboxCall.customerId))
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxCall.phoneNumberId))
    .leftJoin(answerer, sql`${answerer.id} = coalesce(${inboxCall.answeredByUserId}, ${inboxCall.startedByUserId})`)
    .where(and(...where))
    .orderBy(desc(inboxCall.startedAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const recordings = page.length
    ? await db.select().from(inboxRecording).where(inArray(inboxRecording.callId, page.map((x) => x.id)))
    : [];
  const canListen = viewer.capabilities.includes("recordings.listen");
  const canTranscript = viewer.capabilities.includes("transcripts.view");

  const data = page.map(({ customer_id, customer_name, customer_phone, started_at, answered_at, returned_at, followup_sent_at, ...row }) => ({
    ...row,
    started_at: started_at.toISOString(),
    answered_at: answered_at ? answered_at.toISOString() : null,
    wait_s: answered_at ? Math.max(0, Math.round((answered_at.getTime() - started_at.getTime()) / 1000)) : null,
    returned_at: returned_at ? new Date(returned_at).toISOString() : null,
    followup_sent_at: followup_sent_at ? followup_sent_at.toISOString() : null,
    customer: { id: customer_id, name: customer_name, phone: customer_phone },
    recordings: recordings
      .filter((rec) => rec.callId === row.id)
      .map((rec) => ({
        id: rec.id,
        kind: rec.kind,
        status: rec.status,
        duration_s: rec.durationS,
        playable: canListen && !!rec.storageKey,
        transcript: canTranscript ? rec.transcript : null,
        transcript_lines: canTranscript ? rec.transcriptLines : null,
        summary: canTranscript ? rec.summaryJson : null,
        // Sent to Fireflies and its result not in yet.
        transcribing: !!rec.firefliesSentAt && rec.status !== "summarised" && rec.status !== "deleted",
      })),
  }));
  const last = data[data.length - 1];
  return { data, has_more: rows.length > limit, next_before: rows.length > limit && last ? last.started_at : null };
}
