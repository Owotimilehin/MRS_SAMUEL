/**
 * The live switchboard (Business Suite /calls/switchboard). Mounted at
 * /v1/inbox/switchboard. Everything needs calls.switchboard (owners, admins,
 * managers by default) on top of the inbox.
 *
 *   GET  /                          every live call the viewer may see, every
 *                                   staff member who takes calls, and teams
 *   POST /calls/:id/pickup          ring a call that is ringing for others on
 *                                   MY app instead (needs calls.answer too)
 *   POST /calls/:id/transfer        { team_id } | { user_id } — hand someone's
 *                                   live call to a team or a person
 *   POST /staff/:userId/presence    { available } — mark a colleague away or
 *                                   available (audited)
 *
 * Calls are listed with the inbox's own rule (conversationScope), so the board
 * never shows a call whose chat the viewer could not open. Staff states use
 * every live call, so "on a call" is right even for calls the viewer can't see
 * (no customer details are given for those).
 *
 * Pick-up and transfer use the same Twilio redirect as the call bar's transfer:
 * the customer's leg is pointed at /v1/voice/connect, which rings one person.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  adminUser,
  customer,
  inboxCall,
  inboxConversation,
  inboxPhoneNumber,
  inboxPresence,
  inboxPushToken,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
  type DbClient,
} from "@ms/db";
import {
  LIVE_CALL_MAX_AGE_MS,
  canSeeConversation,
  conversationScope,
  lineSince,
  lineState,
  publishInboxEvent,
  redirectCall,
  signalFor,
  staffState,
  twilioRestConfigFromEnv,
} from "@ms/domain";
import { resolveCapabilities, type PermissionOverrides } from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";
import { need, withViewer } from "./inbox.js";
import { transferLiveCall, voiceUrl } from "./voice.js";

type CallRow = typeof inboxCall.$inferSelect;

const LIVE_OUTCOMES = ["in_progress", "answered"] as const;

function liveWhere(now: Date) {
  return and(
    isNull(inboxCall.endedAt),
    inArray(inboxCall.outcome, [...LIVE_OUTCOMES]),
    gte(inboxCall.startedAt, new Date(now.getTime() - LIVE_CALL_MAX_AGE_MS)),
  );
}

function notConfigured(): never {
  throw new BusinessError("service_unavailable", "Phone calls are not configured on this server", 503);
}

/** Staff who take calls: active, not deleted, holding calls.answer. */
async function callStaff(db: DbClient) {
  const users = await db
    .select({
      id: adminUser.id,
      name: adminUser.name,
      email: adminUser.email,
      role: adminUser.role,
      permissionOverrides: adminUser.permissionOverrides,
    })
    .from(adminUser)
    .where(and(eq(adminUser.isActive, true), isNull(adminUser.deletedAt)))
    .orderBy(asc(adminUser.name), asc(adminUser.email));
  return users
    .map((u) => ({ ...u, caps: resolveCapabilities(u.role, u.permissionOverrides as PermissionOverrides) }))
    .filter((u) => u.caps.includes("calls.answer"));
}

/** A live call the viewer may see, or 404. */
async function visibleLiveCall(db: DbClient, c: Context, id: string): Promise<{ call: CallRow; conv: typeof inboxConversation.$inferSelect }> {
  if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "call not found", 404);
  const [row] = await db
    .select({ call: inboxCall, conv: inboxConversation })
    .from(inboxCall)
    .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
    .where(eq(inboxCall.id, id));
  if (!row || !canSeeConversation(c.get("inboxViewer"), row.conv)) throw new BusinessError("not_found", "call not found", 404);
  return row;
}

/** Can this person be rung right now, and are they free? */
async function ringableState(db: DbClient, userId: string, now: Date) {
  const [p] = await db.select().from(inboxPresence).where(eq(inboxPresence.userId, userId));
  const [mobile] = await db
    .select({ at: sql<Date | null>`max(${inboxPushToken.lastSeenAt})` })
    .from(inboxPushToken)
    .where(and(eq(inboxPushToken.userId, userId), inArray(inboxPushToken.platform, ["ios", "android"])));
  const [busy] = await db
    .select({ id: inboxCall.id })
    .from(inboxCall)
    .where(
      and(
        liveWhere(now),
        eq(inboxCall.outcome, "answered"),
        sql`(${inboxCall.answeredByUserId} = ${userId} or (${inboxCall.direction} = 'out' and ${inboxCall.startedByUserId} = ${userId}))`,
      ),
    )
    .limit(1);
  return staffState(
    {
      available: p?.available ?? null,
      lastSeenAt: p?.lastSeenAt ?? null,
      mobileSeenAt: mobile?.at ? new Date(mobile.at) : null,
      onCall: !!busy,
    },
    now,
  );
}

export function switchboardRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withViewer(db));
  r.use("*", async (c, next) => {
    need(c, "calls.switchboard");
    await next();
  });

  r.get("/", async (c) => {
    const v = c.get("inboxViewer");
    const now = new Date();
    const answerer = alias(adminUser, "answerer");
    const starter = alias(adminUser, "starter");
    const ringUser = alias(adminUser, "ring_user");

    const rows = await db
      .select({
        call: inboxCall,
        customer_name: customer.name,
        customer_phone: customer.phone,
        number_label: inboxPhoneNumber.label,
        team_name: inboxTeam.name,
        answered_by: sql<string | null>`coalesce(${answerer.name}, ${answerer.email})`,
        started_by: sql<string | null>`coalesce(${starter.name}, ${starter.email})`,
        ringing_for: sql<string | null>`coalesce(${ringUser.name}, ${ringUser.email})`,
      })
      .from(inboxCall)
      .innerJoin(inboxConversation, eq(inboxConversation.id, inboxCall.conversationId))
      .innerJoin(customer, eq(customer.id, inboxCall.customerId))
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxCall.phoneNumberId))
      .leftJoin(inboxTeam, eq(inboxTeam.id, inboxCall.teamId))
      .leftJoin(answerer, eq(answerer.id, inboxCall.answeredByUserId))
      .leftJoin(starter, eq(starter.id, inboxCall.startedByUserId))
      .leftJoin(ringUser, eq(ringUser.id, inboxCall.ringUserId))
      .where(and(conversationScope(v), liveWhere(now)))
      .orderBy(asc(inboxCall.startedAt));

    const lines = rows.map(({ call, ...x }) => ({
      id: call.id,
      conversation_id: call.conversationId,
      direction: call.direction,
      state: lineState(call),
      since: lineSince(call).toISOString(),
      started_at: call.startedAt.toISOString(),
      customer_name: x.customer_name,
      customer_phone: x.customer_phone ?? (call.direction === "in" ? call.fromE164 : call.toE164),
      number_label: x.number_label,
      number_e164: call.direction === "in" ? call.toE164 : call.fromE164,
      team_id: call.teamId,
      team_name: x.team_name,
      ivr_choice: call.ivrChoice,
      staff_id: call.direction === "in" ? call.answeredByUserId : call.startedByUserId,
      staff_name: call.direction === "in" ? x.answered_by : x.started_by,
      ringing_for_id: call.ringUserId,
      ringing_for: x.ringing_for,
    }));

    // Who is on a call: every live call, seen or not (no details given for unseen ones).
    const busyRows = await db
      .select({ in: inboxCall.answeredByUserId, out: inboxCall.startedByUserId, direction: inboxCall.direction, id: inboxCall.id })
      .from(inboxCall)
      .where(and(liveWhere(now), eq(inboxCall.outcome, "answered")));
    const visibleIds = new Set(lines.map((l) => l.id));
    const onCall = new Map<string, string | null>();
    for (const b of busyRows) {
      const who = b.direction === "in" ? b.in : b.out;
      if (who) onCall.set(who, visibleIds.has(b.id) ? b.id : null);
    }

    const staff = await callStaff(db);
    const ids = staff.map((s) => s.id);
    const presence = ids.length ? await db.select().from(inboxPresence).where(inArray(inboxPresence.userId, ids)) : [];
    const phones = ids.length
      ? await db
          .select({ userId: inboxPushToken.userId, at: sql<Date>`max(${inboxPushToken.lastSeenAt})` })
          .from(inboxPushToken)
          .where(and(inArray(inboxPushToken.userId, ids), inArray(inboxPushToken.platform, ["ios", "android"])))
          .groupBy(inboxPushToken.userId)
      : [];
    const memberships = ids.length
      ? await db
          .select({ userId: inboxTeamMember.userId, name: inboxTeam.name })
          .from(inboxTeamMember)
          .innerJoin(inboxTeam, eq(inboxTeam.id, inboxTeamMember.teamId))
          .where(inArray(inboxTeamMember.userId, ids))
      : [];
    const awayBy = alias(adminUser, "away_by");
    const awayNames = ids.length
      ? await db
          .select({ userId: inboxPresence.userId, by: sql<string | null>`coalesce(${awayBy.name}, ${awayBy.email})` })
          .from(inboxPresence)
          .innerJoin(awayBy, eq(awayBy.id, inboxPresence.awaySetBy))
          .where(inArray(inboxPresence.userId, ids))
      : [];

    const staffOut = staff.map((s) => {
      const p = presence.find((x) => x.userId === s.id);
      const phone = phones.find((x) => x.userId === s.id);
      return {
        id: s.id,
        name: s.name || s.email,
        state: staffState(
          {
            available: p?.available ?? null,
            lastSeenAt: p?.lastSeenAt ?? null,
            mobileSeenAt: phone?.at ? new Date(phone.at) : null,
            onCall: onCall.has(s.id),
          },
          now,
        ),
        call_id: onCall.get(s.id) ?? null,
        last_seen_at: p?.lastSeenAt?.toISOString() ?? null,
        away_set_by: awayNames.find((x) => x.userId === s.id)?.by ?? null,
        teams: memberships.filter((m) => m.userId === s.id).map((m) => m.name),
      };
    });

    const teams = await db
      .select({ id: inboxTeam.id, name: inboxTeam.name })
      .from(inboxTeam)
      .where(eq(inboxTeam.isActive, true))
      .orderBy(asc(inboxTeam.name));

    return c.json({
      data: {
        now: now.toISOString(),
        lines,
        staff: staffOut,
        teams,
        can_pick_up: v.capabilities.includes("calls.answer"),
      },
    });
  });

  // Ring a call that is ringing for someone else on my app instead.
  r.post("/calls/:id/pickup", async (c) => {
    need(c, "calls.answer");
    const auth = c.get("auth");
    const cfg = twilioRestConfigFromEnv() ?? notConfigured();
    const now = new Date();
    const { call, conv } = await visibleLiveCall(db, c, c.req.param("id"));
    if (call.direction !== "in" || call.endedAt || call.outcome !== "in_progress" || call.answeredByUserId) {
      throw new BusinessError("conflict", "This call has already been answered or has ended.", 409);
    }
    const mine = await ringableState(db, auth.userId, now);
    if (mine === "on_call") throw new BusinessError("conflict", "You are already on a call.", 409);
    if (mine !== "available") {
      throw new BusinessError("conflict", "Switch on “Taking calls” on this device first, so the call can ring here.", 409);
    }

    const [claimed] = await db
      .update(inboxCall)
      .set({ ringUserId: auth.userId })
      .where(and(eq(inboxCall.id, call.id), eq(inboxCall.outcome, "in_progress"), isNull(inboxCall.answeredByUserId), isNull(inboxCall.endedAt)))
      .returning({ id: inboxCall.id });
    if (!claimed) throw new BusinessError("conflict", "This call has already been answered or has ended.", 409);
    try {
      await redirectCall(cfg, call.twilioCallSid, voiceUrl("/connect", { callId: call.id, userId: auth.userId }));
    } catch (err) {
      await db.update(inboxCall).set({ ringUserId: call.ringUserId }).where(eq(inboxCall.id, call.id));
      logger.warn({ err, callId: call.id }, "switchboard pick-up failed");
      throw new BusinessError("conflict", "Couldn't pick up the call — the caller may have just hung up.", 409);
    }
    await writeAudit(db, c, {
      action: "inbox.call_pickup",
      entityType: "inbox_call",
      entityId: call.id,
      after: { ring_user_id: auth.userId },
      notify: false,
    });
    await publishInboxEvent(db, signalFor("call.updated", conv, call.id));
    return c.json({ ok: true });
  });

  // Hand someone's live call to a team or a person.
  const TransferBody = z
    .object({ team_id: z.string().uuid().optional(), user_id: z.string().uuid().optional() })
    .refine((b) => !!b.team_id !== !!b.user_id, "Pick a team or a person");
  r.post("/calls/:id/transfer", async (c) => {
    const body = TransferBody.parse(await c.req.json());
    const cfg = twilioRestConfigFromEnv() ?? notConfigured();
    const { call } = await visibleLiveCall(db, c, c.req.param("id"));
    if (call.direction !== "in" || call.endedAt || call.outcome !== "answered") {
      throw new BusinessError("conflict", "Only a call someone is talking on can be transferred.", 409);
    }
    if (body.user_id) {
      if (body.user_id === call.answeredByUserId) throw new BusinessError("validation_failed", "That person already has the call.", 400);
      const target = (await callStaff(db)).find((s) => s.id === body.user_id);
      if (!target) throw new BusinessError("validation_failed", "That person can't take calls.", 400);
      if (!target.caps.includes("inbox.view_all")) {
        const [access] = await db
          .select({ userId: inboxUserNumberAccess.userId })
          .from(inboxUserNumberAccess)
          .where(and(eq(inboxUserNumberAccess.userId, target.id), eq(inboxUserNumberAccess.phoneNumberId, call.phoneNumberId)));
        if (!access) throw new BusinessError("validation_failed", "That person doesn't take calls on this number.", 400);
      }
      if ((await ringableState(db, target.id, new Date())) !== "available") {
        throw new BusinessError("conflict", `${target.name || target.email} can't take a call right now.`, 409);
      }
      await transferLiveCall(db, c, cfg, call, { userId: target.id }, { fromSwitchboard: true });
    } else {
      await transferLiveCall(db, c, cfg, call, { teamId: body.team_id! }, { fromSwitchboard: true });
    }
    return c.json({ ok: true });
  });

  // Mark a colleague away (their own heartbeat won't undo it) or available.
  r.post("/staff/:userId/presence", async (c) => {
    const auth = c.get("auth");
    const userId = c.req.param("userId");
    const { available } = z.object({ available: z.boolean() }).parse(await c.req.json());
    if (!z.string().uuid().safeParse(userId).success) throw new BusinessError("not_found", "staff member not found", 404);
    const target = (await callStaff(db)).find((s) => s.id === userId);
    if (!target) throw new BusinessError("not_found", "staff member not found", 404);
    const now = new Date();
    const [before] = await db.select().from(inboxPresence).where(eq(inboxPresence.userId, userId));
    const set = available
      ? { available: true, awaySetBy: null, awaySetAt: null }
      : { available: false, awaySetBy: auth.userId, awaySetAt: now };
    await db
      .insert(inboxPresence)
      // A new row has never been seen: "available" then rings only a phone with the app.
      .values({ userId, lastSeenAt: new Date(0), ...set })
      .onConflictDoUpdate({ target: inboxPresence.userId, set });
    await writeAudit(db, c, {
      action: "inbox.presence_set",
      entityType: "admin_user",
      entityId: userId,
      before: { available: before?.available ?? null },
      after: { available },
      notify: false,
    });
    await publishInboxEvent(db, { event: "presence.updated", id: userId });
    return c.json({ ok: true });
  });

  return r;
}
