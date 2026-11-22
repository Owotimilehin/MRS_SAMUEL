/**
 * Tasks and reminders (suite spec 15), mounted at /v1/inbox/tasks:
 *
 *   POST   /snooze/:conversationId      snooze a chat until a time ({ until })
 *   DELETE /snooze/:conversationId      wake it now
 *   GET    /reminders                   ?view=due|upcoming|done|everyone, or ?conversation_id= / ?customer_id=
 *   GET    /reminders/count             my reminders that are due now (the menu badge)
 *   POST   /reminders                   add one, on a chat or on a contact
 *   PATCH  /reminders/:id               change the note, time or person; mark done or not done
 *   DELETE /reminders/:id               remove (its creator, or inbox.assign)
 *   GET    /reply-target                how many open chats are over the reply-time target
 *
 * Every read is filtered by the one reminder rule (reminderScope, built on the
 * chat-visibility rule); a reminder or chat the viewer may not see answers 404.
 * Nothing here calls Meta or sends anything to a customer.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { adminUser, customer, inboxConversation, inboxIdentity, inboxPhoneNumber, inboxReminder, type DbClient } from "@ms/db";
import {
  canBeGivenReminder,
  canChangeReminder,
  canSeeReminder,
  conversationScope,
  publishInboxEvent,
  reminderScope,
  signalFor,
  waitingSinceSql,
  type ReminderFacts,
} from "@ms/domain";
import { REMINDER_NOTE_MAX, reminderTimeProblem, snoozeTimeProblem } from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { reloadViewer } from "../inbox/realtime.js";
import { loadLineHours, loadReplyTarget, waitingMinutes } from "../lib/reply-target.js";
import { need, visibleConversation, withViewer } from "./inbox.js";

const Uuid = z.string().uuid();
const assignee = alias(adminUser, "reminder_assignee");
const creator = alias(adminUser, "reminder_creator");

async function audit(db: DbClient, c: Context, action: string, entityId: string, after?: unknown, before?: unknown, entityType = "inbox_reminder") {
  await writeAudit(db, c, { action, entityType, entityId, after, before, notify: false });
}

function idParam(c: Context, name: string): string {
  const parsed = Uuid.safeParse(c.req.param(name));
  if (!parsed.success) throw new BusinessError("not_found", "not found", 404);
  return parsed.data;
}

const SnoozeBody = z.object({ until: z.string().datetime({ offset: true }) }).strict();

const ReminderBody = z
  .object({
    note: z.string().trim().min(1).max(REMINDER_NOTE_MAX),
    due_at: z.string().datetime({ offset: true }),
    assignee_id: Uuid.optional(),
    conversation_id: Uuid.optional(),
    customer_id: Uuid.optional(),
  })
  .strict()
  .refine((b) => !!b.conversation_id !== !!b.customer_id, { message: "Give a chat or a contact, not both" });

const ReminderPatch = z
  .object({
    note: z.string().trim().min(1).max(REMINDER_NOTE_MAX).optional(),
    due_at: z.string().datetime({ offset: true }).optional(),
    assignee_id: Uuid.optional(),
    done: z.boolean().optional(),
  })
  .strict();

/** Columns every reminder list returns. */
const reminderFields = {
  id: inboxReminder.id,
  note: inboxReminder.note,
  due_at: inboxReminder.dueAt,
  done_at: inboxReminder.doneAt,
  created_at: inboxReminder.createdAt,
  conversation_id: inboxReminder.conversationId,
  customer_id: inboxReminder.customerId,
  customer_name: customer.name,
  customer_phone: customer.phone,
  identity_name: sql<string | null>`coalesce(${inboxIdentity.displayName}, '@' || ${inboxIdentity.username})`,
  channel: inboxConversation.channel,
  assignee_id: inboxReminder.assigneeId,
  assignee_name: sql<string | null>`coalesce(${assignee.name}, ${assignee.email})`,
  created_by: inboxReminder.createdBy,
  created_by_name: sql<string | null>`coalesce(${creator.name}, ${creator.email})`,
};

/** The facts the reminder rule needs, for one stored reminder. */
async function reminderFacts(db: DbClient, id: string) {
  const [row] = await db
    .select({ r: inboxReminder, conv: inboxConversation })
    .from(inboxReminder)
    .leftJoin(inboxConversation, eq(inboxConversation.id, inboxReminder.conversationId))
    .where(eq(inboxReminder.id, id));
  if (!row) return null;
  const facts: ReminderFacts = {
    conversation: row.conv ? { phoneNumberId: row.conv.phoneNumberId, teamId: row.conv.teamId, assigneeId: row.conv.assigneeId } : null,
    assigneeId: row.r.assigneeId,
    createdBy: row.r.createdBy,
  };
  return { reminder: row.r, conversation: row.conv, facts };
}

export function inboxTaskRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withViewer(db));

  // ── Snooze ──
  r.post("/snooze/:conversationId", async (c) => {
    need(c, "inbox.reply");
    const conv = await visibleConversation(db, c, c.req.param("conversationId"));
    if (conv.status === "closed") throw new BusinessError("validation_failed", "A closed chat can't be snoozed. Reopen it first.", 400);
    const { until } = SnoozeBody.parse(await c.req.json());
    const at = new Date(until);
    const problem = snoozeTimeProblem(at);
    if (problem) throw new BusinessError("validation_failed", problem, 400);
    const [updated] = await db
      .update(inboxConversation)
      .set({ snoozedUntil: at, snoozedBy: c.get("inboxViewer").userId, wokeAt: null })
      .where(eq(inboxConversation.id, conv.id))
      .returning();
    await publishInboxEvent(db, signalFor("conversation.updated", updated!));
    await audit(db, c, "inbox.conversation_snooze", conv.id, { snoozed_until: at.toISOString() }, { snoozed_until: conv.snoozedUntil }, "inbox_conversation");
    return c.json({ data: updated });
  });

  r.delete("/snooze/:conversationId", async (c) => {
    need(c, "inbox.reply");
    const conv = await visibleConversation(db, c, c.req.param("conversationId"));
    if (!conv.snoozedUntil) return c.json({ data: conv });
    const [updated] = await db
      .update(inboxConversation)
      .set({ snoozedUntil: null, snoozedBy: null })
      .where(eq(inboxConversation.id, conv.id))
      .returning();
    await publishInboxEvent(db, signalFor("conversation.updated", updated!));
    await audit(db, c, "inbox.conversation_unsnooze", conv.id, { snoozed_until: null }, { snoozed_until: conv.snoozedUntil }, "inbox_conversation");
    return c.json({ data: updated });
  });

  // ── Reminders ──
  r.get("/reminders", async (c) => {
    const v = c.get("inboxViewer");
    const q = c.req.query();
    const conds: SQL[] = [reminderScope(v)];
    const now = new Date();
    let order: SQL[] = [asc(inboxReminder.dueAt)];
    if (q.conversation_id || q.customer_id) {
      // A chat's or a contact's own reminders: everything open that this viewer may see.
      if (q.conversation_id) conds.push(eq(inboxReminder.conversationId, Uuid.parse(q.conversation_id)));
      if (q.customer_id) conds.push(eq(inboxReminder.customerId, Uuid.parse(q.customer_id)));
      conds.push(isNull(inboxReminder.doneAt));
    } else {
      const view = q.view ?? "due";
      if (view === "due") conds.push(eq(inboxReminder.assigneeId, v.userId), isNull(inboxReminder.doneAt), lte(inboxReminder.dueAt, now));
      else if (view === "upcoming") conds.push(eq(inboxReminder.assigneeId, v.userId), isNull(inboxReminder.doneAt), gt(inboxReminder.dueAt, now));
      else if (view === "everyone") {
        need(c, "inbox.assign");
        conds.push(isNull(inboxReminder.doneAt));
      } else if (view === "done") {
        conds.push(isNotNull(inboxReminder.doneAt), sql`(${inboxReminder.assigneeId} = ${v.userId} or ${inboxReminder.doneBy} = ${v.userId})`);
        order = [desc(inboxReminder.doneAt)];
      } else throw new BusinessError("validation_failed", "Unknown list", 400);
    }
    const rows = await db
      .select(reminderFields)
      .from(inboxReminder)
      .innerJoin(customer, eq(customer.id, inboxReminder.customerId))
      .leftJoin(inboxConversation, eq(inboxConversation.id, inboxReminder.conversationId))
      .leftJoin(inboxIdentity, eq(inboxIdentity.id, inboxConversation.identityId))
      .leftJoin(assignee, eq(assignee.id, inboxReminder.assigneeId))
      .leftJoin(creator, eq(creator.id, inboxReminder.createdBy))
      .where(and(...conds))
      .orderBy(...order)
      .limit(200);
    return c.json({ data: rows });
  });

  r.get("/reminders/count", async (c) => {
    const v = c.get("inboxViewer");
    const [row] = await db
      .select({ due: sql<number>`count(*)::int` })
      .from(inboxReminder)
      .leftJoin(inboxConversation, eq(inboxConversation.id, inboxReminder.conversationId))
      .where(and(reminderScope(v), eq(inboxReminder.assigneeId, v.userId), isNull(inboxReminder.doneAt), lte(inboxReminder.dueAt, new Date())));
    return c.json({ data: { due: row?.due ?? 0 } });
  });

  r.post("/reminders", async (c) => {
    const v = c.get("inboxViewer");
    const body = ReminderBody.parse(await c.req.json());
    const due = new Date(body.due_at);
    const problem = reminderTimeProblem(due);
    if (problem) throw new BusinessError("validation_failed", problem, 400);

    let customerId: string;
    let conversationId: string | null = null;
    let scopeFacts: ReminderFacts["conversation"] = null;
    if (body.conversation_id) {
      const conv = await visibleConversation(db, c, body.conversation_id);
      customerId = conv.customerId;
      conversationId = conv.id;
      scopeFacts = { phoneNumberId: conv.phoneNumberId, teamId: conv.teamId, assigneeId: conv.assigneeId };
    } else {
      need(c, "contacts.view");
      const [cust] = await db.select({ id: customer.id }).from(customer).where(eq(customer.id, body.customer_id!));
      if (!cust) throw new BusinessError("not_found", "contact not found", 404);
      customerId = cust.id;
    }

    const assigneeId = body.assignee_id ?? v.userId;
    if (assigneeId !== v.userId) {
      need(c, "inbox.assign");
      const other = await reloadViewer(db, assigneeId);
      if (!canBeGivenReminder(other, { conversation: scopeFacts })) {
        throw new BusinessError("validation_failed", conversationId ? "That person can't see this chat" : "That person can't see contacts", 400);
      }
    }

    const [row] = await db
      .insert(inboxReminder)
      .values({ customerId, conversationId, note: body.note, dueAt: due, assigneeId, createdBy: v.userId })
      .returning();
    await audit(db, c, "inbox.reminder_add", row!.id, { conversation_id: conversationId, customer_id: customerId, due_at: due.toISOString(), assignee_id: assigneeId });
    return c.json({ data: row }, 201);
  });

  r.patch("/reminders/:id", async (c) => {
    const v = c.get("inboxViewer");
    const id = idParam(c, "id");
    const found = await reminderFacts(db, id);
    if (!found || !canSeeReminder(v, found.facts)) throw new BusinessError("not_found", "reminder not found", 404);
    if (!canChangeReminder(v, found.facts)) throw new BusinessError("forbidden", "Only the person it is for, who added it, or a manager can change this reminder", 403);
    const body = ReminderPatch.parse(await c.req.json());
    const patch: Partial<typeof inboxReminder.$inferInsert> = { updatedAt: new Date() };

    if (body.note !== undefined) patch.note = body.note;
    if (body.due_at !== undefined) {
      const due = new Date(body.due_at);
      const problem = reminderTimeProblem(due);
      if (problem) throw new BusinessError("validation_failed", problem, 400);
      patch.dueAt = due;
      // A new time alerts again.
      patch.notifiedAt = null;
    }
    if (body.assignee_id !== undefined && body.assignee_id !== found.reminder.assigneeId) {
      if (body.assignee_id !== v.userId) need(c, "inbox.assign");
      const other = await reloadViewer(db, body.assignee_id);
      if (!canBeGivenReminder(other, { conversation: found.facts.conversation })) {
        throw new BusinessError("validation_failed", found.facts.conversation ? "That person can't see this chat" : "That person can't see contacts", 400);
      }
      patch.assigneeId = body.assignee_id;
      patch.notifiedAt = null;
    }
    if (body.done !== undefined) {
      patch.doneAt = body.done ? new Date() : null;
      patch.doneBy = body.done ? v.userId : null;
    }
    const [row] = await db.update(inboxReminder).set(patch).where(eq(inboxReminder.id, id)).returning();
    await audit(
      db,
      c,
      "inbox.reminder_update",
      id,
      body,
      { note: found.reminder.note, due_at: found.reminder.dueAt, assignee_id: found.reminder.assigneeId, done_at: found.reminder.doneAt },
    );
    return c.json({ data: row });
  });

  r.delete("/reminders/:id", async (c) => {
    const v = c.get("inboxViewer");
    const id = idParam(c, "id");
    const found = await reminderFacts(db, id);
    if (!found || !canSeeReminder(v, found.facts)) throw new BusinessError("not_found", "reminder not found", 404);
    if (found.reminder.createdBy !== v.userId && !v.capabilities.includes("inbox.assign")) {
      throw new BusinessError("forbidden", "Only the person who added this reminder, or a manager, can remove it", 403);
    }
    await db.delete(inboxReminder).where(eq(inboxReminder.id, id));
    await audit(db, c, "inbox.reminder_delete", id, undefined, { note: found.reminder.note, due_at: found.reminder.dueAt, assignee_id: found.reminder.assigneeId });
    return c.json({ ok: true });
  });

  // ── Reply-time target, for the Overview ──
  r.get("/reply-target", async (c) => {
    const target = await loadReplyTarget(db);
    if (!target) return c.json({ data: { target_minutes: null, late: 0, longest_minutes: null } });
    const v = c.get("inboxViewer");
    const rows = await db
      .select({
        status: inboxConversation.status,
        lineId: inboxConversation.phoneNumberId,
        waitingSince: waitingSinceSql.mapWith((x: string | Date | null) => (x == null ? null : new Date(x))),
      })
      .from(inboxConversation)
      .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
      .where(
        and(
          conversationScope(v),
          inArray(inboxConversation.status, ["open"]),
          sql`(${inboxConversation.snoozedUntil} is null or ${inboxConversation.snoozedUntil} <= now())`,
          sql`${inboxConversation.lastInboundWaAt} is not null`,
        ),
      )
      .orderBy(desc(inboxConversation.lastActivityAt))
      .limit(500);
    const hours = await loadLineHours(db);
    const now = new Date();
    let late = 0;
    let longest: number | null = null;
    for (const row of rows) {
      const m = waitingMinutes(row, hours, now);
      if (m == null || m < target) continue;
      late++;
      longest = Math.max(longest ?? 0, m);
    }
    return c.json({ data: { target_minutes: target, late, longest_minutes: longest } });
  });

  return r;
}
