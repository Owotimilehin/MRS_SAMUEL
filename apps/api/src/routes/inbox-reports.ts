import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { adminUser, inboxCall, inboxConversation, inboxMessage, inboxPhoneNumber, type DbClient } from "@ms/db";
import { conversationScope } from "@ms/domain";
import { requireAuth } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { reloadViewer } from "../inbox/realtime.js";

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  number: z.string().uuid().optional(),
});

/**
 * Inbox reports, limited to what the viewer can see (view_all → everything,
 * view_team → their teams, otherwise their own work). Dates are Lagos days,
 * `to` inclusive.
 */
export function inboxReportRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", async (c) => {
    const viewer = await reloadViewer(db, c.get("auth").userId);
    if (!viewer || !viewer.capabilities.includes("inbox.reports")) {
      throw new BusinessError("forbidden", "missing capability: inbox.reports", 403);
    }
    const q = Range.parse(c.req.query());
    const from = new Date(`${q.from}T00:00:00+01:00`);
    const to = new Date(new Date(`${q.to}T00:00:00+01:00`).getTime() + 86_400_000);
    if (!(to > from) || to.getTime() - from.getTime() > 400 * 86_400_000) {
      throw new BusinessError("validation_failed", "Pick a range of up to 400 days", 400);
    }

    const scope: SQL[] = [conversationScope(viewer)];
    if (q.number) scope.push(eq(inboxConversation.phoneNumberId, q.number));
    const lagosDay = (col: SQL | typeof inboxMessage.createdAt | typeof inboxCall.startedAt) =>
      sql<string>`to_char(${col} at time zone 'Africa/Lagos', 'YYYY-MM-DD')`;

    const messagesPerDay = await db
      .select({
        day: lagosDay(inboxMessage.createdAt),
        inbound: sql<number>`count(*) filter (where ${inboxMessage.direction} = 'in')::int`,
        outbound: sql<number>`count(*) filter (where ${inboxMessage.direction} = 'out')::int`,
      })
      .from(inboxMessage)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
      .where(and(...scope, gte(inboxMessage.createdAt, from), lt(inboxMessage.createdAt, to)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const callsPerDay = await db
      .select({
        day: lagosDay(inboxCall.startedAt),
        total: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${inboxCall.outcome} = 'answered')::int`,
        missed: sql<number>`count(*) filter (where ${inboxCall.outcome} in ('missed','voicemail'))::int`,
        after_hours: sql<number>`count(*) filter (where ${inboxCall.outcome} = 'after_hours')::int`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope, eq(inboxCall.direction, "in"), gte(inboxCall.startedAt, from), lt(inboxCall.startedAt, to)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [response] = await db
      .select({
        conversations: sql<number>`count(*)::int`,
        responded: sql<number>`count(${inboxConversation.firstResponseAt})::int`,
        median_first_response_s: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from ${inboxConversation.firstResponseAt} - ${inboxConversation.createdAt}))`,
        median_resolution_s: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from ${inboxConversation.closedAt} - ${inboxConversation.createdAt}))`,
      })
      .from(inboxConversation)
      .where(and(...scope, gte(inboxConversation.createdAt, from), lt(inboxConversation.createdAt, to)));

    const perStaff = await db
      .select({
        user_id: adminUser.id,
        name: sql<string>`coalesce(${adminUser.name}, ${adminUser.email})`,
        replies: sql<number>`count(*)::int`,
      })
      .from(inboxMessage)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxMessage.conversationId))
      .innerJoin(adminUser, eq(adminUser.id, inboxMessage.senderUserId))
      .where(and(...scope, eq(inboxMessage.direction, "out"), gte(inboxMessage.createdAt, from), lt(inboxMessage.createdAt, to)))
      .groupBy(adminUser.id);

    const callsPerStaff = await db
      .select({ user_id: inboxCall.answeredByUserId, calls: sql<number>`count(*)::int`, talk_s: sql<number>`coalesce(sum(${inboxCall.durationS}),0)::int` })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .where(and(...scope, eq(inboxCall.outcome, "answered"), gte(inboxCall.startedAt, from), lt(inboxCall.startedAt, to)))
      .groupBy(inboxCall.answeredByUserId);

    const perNumber = await db
      .select({
        number_id: inboxPhoneNumber.id,
        label: inboxPhoneNumber.label,
        conversations: sql<number>`count(*)::int`,
      })
      .from(inboxConversation)
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
      .where(and(...scope, gte(inboxConversation.createdAt, from), lt(inboxConversation.createdAt, to)))
      .groupBy(inboxPhoneNumber.id);

    return c.json({
      data: {
        range: { from: q.from, to: q.to },
        messages_per_day: messagesPerDay,
        calls_per_day: callsPerDay,
        response: response ?? null,
        staff: perStaff.map((s) => ({ ...s, ...(callsPerStaff.find((x) => x.user_id === s.user_id) ?? { calls: 0, talk_s: 0 }) })),
        staff_calls: callsPerStaff,
        per_number: perNumber,
      },
    });
  });

  return r;
}
