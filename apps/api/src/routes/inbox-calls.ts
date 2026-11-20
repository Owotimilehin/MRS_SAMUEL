/**
 * The call list (Business Suite "Calls" page). Read-only.
 *
 *   GET /v1/inbox/calls?from=YYYY-MM-DD&to=YYYY-MM-DD&number=<id>&staff=<id>&outcome=<outcome>&direction=in|out&limit=50&before=<cursor>
 *
 * A call is listed only when its conversation is one the viewer may see: the
 * same rule as the inbox list (conversationScope), so a call never shows up
 * here for someone who could not open its chat. Recordings follow the
 * timeline's rules: playable needs recordings.listen, transcript and AI
 * summary need transcripts.view. Dates are Lagos days, `to` inclusive.
 * Newest first; `next_before` is the cursor for the next page.
 */
import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { adminUser, customer, inboxCall, inboxConversation, inboxPhoneNumber, inboxRecording, type DbClient } from "@ms/db";
import { conversationScope } from "@ms/domain";
import { requireAuth } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { need, withViewer } from "./inbox.js";

export const CALL_OUTCOMES = ["in_progress", "answered", "missed", "voicemail", "after_hours", "information", "failed"] as const;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query = z.object({
  from: Day.optional(),
  to: Day.optional(),
  number: z.string().uuid().optional(),
  staff: z.string().uuid().optional(),
  outcome: z.enum(CALL_OUTCOMES).optional(),
  direction: z.enum(["in", "out"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // "<started_at as text>|<call id>", exactly as a previous page returned it.
  before: z.string().max(120).optional(),
});

/** Lagos is UTC+1 all year (no summer time). */
function lagosStart(day: string): Date {
  return new Date(`${day}T00:00:00+01:00`);
}

function parseCursor(raw: string): { at: string; id: string } {
  const i = raw.lastIndexOf("|");
  const at = i > 0 ? raw.slice(0, i) : "";
  const id = i > 0 ? raw.slice(i + 1) : "";
  if (!z.string().uuid().safeParse(id).success || !/^\d{4}-\d{2}-\d{2}[ T][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/.test(at)) {
    throw new BusinessError("validation_failed", "That page link is out of date. Reload the list.", 400);
  }
  return { at, id };
}

export function inboxCallRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withViewer(db));

  r.get("/", async (c) => {
    need(c, "inbox.view");
    const v = c.get("inboxViewer");
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) throw new BusinessError("validation_failed", "Check the filters and try again.", 400);
    const q = parsed.data;

    const conds: SQL[] = [conversationScope(v)];
    if (q.from) conds.push(gte(inboxCall.startedAt, lagosStart(q.from)));
    if (q.to) conds.push(lt(inboxCall.startedAt, new Date(lagosStart(q.to).getTime() + 86_400_000)));
    if (q.from && q.to && q.from > q.to) throw new BusinessError("validation_failed", "The start date is after the end date.", 400);
    if (q.number) conds.push(eq(inboxCall.phoneNumberId, q.number));
    if (q.staff) conds.push(or(eq(inboxCall.answeredByUserId, q.staff), eq(inboxCall.startedByUserId, q.staff))!);
    if (q.outcome) conds.push(eq(inboxCall.outcome, q.outcome));
    if (q.direction) conds.push(eq(inboxCall.direction, q.direction));
    if (q.before) {
      const cur = parseCursor(q.before);
      conds.push(sql`(${inboxCall.startedAt}, ${inboxCall.id}) < (${cur.at}::timestamptz, ${cur.id}::uuid)`);
    }

    const answerer = alias(adminUser, "answerer");
    const starter = alias(adminUser, "starter");
    const rows = await db
      .select({
        id: inboxCall.id,
        conversation_id: inboxCall.conversationId,
        customer_id: inboxCall.customerId,
        customer_name: customer.name,
        customer_phone: customer.phone,
        from_e164: inboxCall.fromE164,
        to_e164: inboxCall.toE164,
        number_id: inboxCall.phoneNumberId,
        number_label: inboxPhoneNumber.label,
        direction: inboxCall.direction,
        outcome: inboxCall.outcome,
        ivr_choice: inboxCall.ivrChoice,
        duration_s: inboxCall.durationS,
        started_at: inboxCall.startedAt,
        answered_at: inboxCall.answeredAt,
        ended_at: inboxCall.endedAt,
        answered_by_id: inboxCall.answeredByUserId,
        answered_by: sql<string | null>`coalesce(${answerer.name}, ${answerer.email})`,
        started_by_id: inboxCall.startedByUserId,
        started_by: sql<string | null>`coalesce(${starter.name}, ${starter.email})`,
        // Full precision (microseconds) so the next page starts exactly after this row.
        cursor_at: sql<string>`${inboxCall.startedAt}::text`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .innerJoin(customer, eq(customer.id, inboxCall.customerId))
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxCall.phoneNumberId))
      .leftJoin(answerer, eq(answerer.id, inboxCall.answeredByUserId))
      .leftJoin(starter, eq(starter.id, inboxCall.startedByUserId))
      .where(and(...conds))
      .orderBy(desc(inboxCall.startedAt), desc(inboxCall.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const recordings = page.length
      ? await db.select().from(inboxRecording).where(inArray(inboxRecording.callId, page.map((x) => x.id)))
      : [];
    const canListen = v.capabilities.includes("recordings.listen");
    const canTranscript = v.capabilities.includes("transcripts.view");

    const data = page.map((row) => ({
      ...row,
      cursor_at: undefined,
      recordings: recordings
        .filter((rec) => rec.callId === row.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((rec) => ({
          id: rec.id,
          kind: rec.kind,
          status: rec.status,
          duration_s: rec.durationS,
          playable: canListen && !!rec.storageKey,
          transcript: canTranscript ? rec.transcript : null,
          summary: canTranscript ? rec.summaryJson : null,
        })),
    }));
    const last = rows.length > q.limit ? page[page.length - 1] : undefined;
    return c.json({ data, next_before: last ? `${last.cursor_at}|${last.id}` : null });
  });

  return r;
}
