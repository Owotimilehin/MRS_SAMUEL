/**
 * Tasks and reminders (suite spec 15):
 *   wakeSnoozed     — chats whose snooze has ended come back to the top
 *   alertDueReminders — a reminder that falls due alerts its assignee once:
 *                     a reminder.due signal (sound, pop-up or banner in the suite)
 *                     and a push to their phones
 * Neither calls Meta or sends anything to a customer.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  adminUser,
  customer,
  inboxConversation,
  inboxNotifyPref,
  inboxPushToken,
  inboxReminder,
  type DbClient,
} from "@ms/db";
import { canSeeReminder, loadViewer, publishInboxEvent, wakeSnoozedConversations, type InboxViewer, type ReminderFacts } from "@ms/domain";
import { resolveCapabilities, type AdminRole, type PermissionOverrides } from "@ms/shared";
import { expoPushSender, type PushMessage, type PushSender } from "./inbox-push.js";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

/** A reminder first seen more than this long after it fell due (worker was down) is marked without an alert. */
export const STALE_REMINDER_MS = 12 * 60 * 60 * 1000;

export async function wakeSnoozed(db: DbClient, log: Log): Promise<number> {
  const rows = await wakeSnoozedConversations(db);
  if (rows.length) log.info({ woken: rows.length }, "snoozed chats woken");
  return rows.length;
}

export interface DueReminder {
  id: string;
  dueAt: Date;
  facts: ReminderFacts;
}

/**
 * Should this reminder alert its assignee now? Pure, exported for tests.
 * Too old, or the assignee can no longer see it, or their alerts are off: no.
 */
export function shouldAlertReminder(r: DueReminder, assignee: InboxViewer | undefined, level: string, now: Date = new Date()): boolean {
  if (now.getTime() - r.dueAt.getTime() > STALE_REMINDER_MS) return false;
  if (!assignee) return false;
  if (level === "none") return false;
  return canSeeReminder(assignee, r.facts);
}

/** "Reminder: Ada" / the note, cut to 120 characters. Exported for tests. */
export function reminderPush(note: string, who: string | null): { title: string; body: string } {
  return { title: who ? `Reminder: ${who}` : "Reminder", body: note.slice(0, 120) };
}

export async function alertDueReminders(db: DbClient, log: Log, send: PushSender = expoPushSender, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ r: inboxReminder, conv: inboxConversation, name: customer.name, phone: customer.phone })
    .from(inboxReminder)
    .innerJoin(customer, eq(customer.id, inboxReminder.customerId))
    .leftJoin(inboxConversation, eq(inboxConversation.id, inboxReminder.conversationId))
    .where(and(isNull(inboxReminder.doneAt), isNull(inboxReminder.notifiedAt), lte(inboxReminder.dueAt, now)))
    .orderBy(asc(inboxReminder.dueAt))
    .limit(100);
  if (due.length === 0) return 0;

  const userIds = [...new Set(due.map((d) => d.r.assigneeId))];
  const users = await db
    .select({ id: adminUser.id, role: adminUser.role, overrides: adminUser.permissionOverrides })
    .from(adminUser)
    .where(and(inArray(adminUser.id, userIds), eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));
  const viewers = new Map<string, InboxViewer>();
  for (const u of users) {
    const caps = resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides);
    if (caps.includes("inbox.view")) viewers.set(u.id, await loadViewer(db, u.id, caps));
  }
  const prefs = await db.select().from(inboxNotifyPref).where(inArray(inboxNotifyPref.userId, userIds));
  const tokens = await db
    .select({ userId: inboxPushToken.userId, token: inboxPushToken.token })
    .from(inboxPushToken)
    .where(and(inArray(inboxPushToken.userId, userIds), inArray(inboxPushToken.platform, ["ios", "android"])));

  const outgoing: PushMessage[] = [];
  let alerted = 0;
  for (const d of due) {
    const facts: ReminderFacts = {
      conversation: d.conv ? { phoneNumberId: d.conv.phoneNumberId, teamId: d.conv.teamId, assigneeId: d.conv.assigneeId } : null,
      assigneeId: d.r.assigneeId,
      createdBy: d.r.createdBy,
    };
    const level = prefs.find((p) => p.userId === d.r.assigneeId)?.level ?? "assigned";
    if (!shouldAlertReminder({ id: d.r.id, dueAt: d.r.dueAt, facts }, viewers.get(d.r.assigneeId), level, now)) continue;
    alerted++;
    // Only the assignee's own apps receive it (see shouldDeliver in the API).
    await publishInboxEvent(db, {
      event: "reminder.due",
      id: d.r.id,
      userIds: [d.r.assigneeId],
      ...(d.conv ? { conversationId: d.conv.id, phoneNumberId: d.conv.phoneNumberId, teamId: d.conv.teamId, assigneeId: d.conv.assigneeId } : {}),
    });
    const { title, body } = reminderPush(d.r.note, d.name || d.phone);
    for (const t of tokens.filter((x) => x.userId === d.r.assigneeId)) {
      outgoing.push({
        to: t.token,
        title,
        body,
        data: d.conv ? { conversationId: d.conv.id, reminderId: d.r.id } : { reminderId: d.r.id },
        sound: "default",
        channelId: "messages",
      });
    }
  }

  // Marked first, so a slow or failing push service can never make a reminder alert twice.
  await db
    .update(inboxReminder)
    .set({ notifiedAt: sql`now()` })
    .where(inArray(inboxReminder.id, due.map((d) => d.r.id)));
  try {
    if (outgoing.length) await send(outgoing);
  } catch (err) {
    log.warn({ err, count: outgoing.length }, "reminder push send failed");
  }
  if (alerted) log.info({ alerted, pushes: outgoing.length }, "due reminders alerted");
  return alerted;
}
