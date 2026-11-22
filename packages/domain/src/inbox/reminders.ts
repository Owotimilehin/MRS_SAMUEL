/**
 * Who may see and change a reminder (suite spec 15, 5.4). One rule, used by
 * the API's SQL filters, its per-row checks and the worker's alerts.
 *
 *   On a chat      → whoever may see that chat (canSeeConversation). Nothing else.
 *   On a contact   → its assignee, its creator, and anyone with contacts.view.
 *
 * Changing (done, move, edit) needs: the assignee, the creator, or inbox.assign,
 * and always the right to see it.
 */
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { inboxReminder } from "@ms/db";
import { canSeeConversation, conversationScope, type InboxViewer, type ScopeFacts } from "./scope.js";

export interface ReminderFacts {
  /** The chat it was added on, or null for a contact-only reminder. */
  conversation: ScopeFacts | null;
  assigneeId: string;
  createdBy: string | null;
}

export function canSeeReminder(v: InboxViewer, r: ReminderFacts): boolean {
  if (!v.capabilities.includes("inbox.view")) return false;
  if (r.conversation) return canSeeConversation(v, r.conversation);
  return r.assigneeId === v.userId || r.createdBy === v.userId || v.capabilities.includes("contacts.view");
}

export function canChangeReminder(v: InboxViewer, r: ReminderFacts): boolean {
  if (!canSeeReminder(v, r)) return false;
  return r.assigneeId === v.userId || r.createdBy === v.userId || v.capabilities.includes("inbox.assign");
}

/** May this person be given (assigned) the reminder? They must be able to see it once it is theirs. */
export function canBeGivenReminder(assignee: InboxViewer | null, r: { conversation: ScopeFacts | null }): boolean {
  if (!assignee || !assignee.capabilities.includes("inbox.view")) return false;
  if (r.conversation) return canSeeConversation(assignee, r.conversation);
  return assignee.capabilities.includes("contacts.view");
}

/**
 * SQL condition on inbox_reminder, mirroring canSeeReminder. The query must
 * LEFT JOIN inbox_conversation on inbox_reminder.conversation_id.
 */
export function reminderScope(v: InboxViewer): SQL {
  if (!v.capabilities.includes("inbox.view")) return sql`false`;
  const onChat = and(isNotNull(inboxReminder.conversationId), conversationScope(v))!;
  const onContact = and(
    isNull(inboxReminder.conversationId),
    v.capabilities.includes("contacts.view")
      ? sql`true`
      : or(eq(inboxReminder.assigneeId, v.userId), eq(inboxReminder.createdBy, v.userId))!,
  )!;
  return or(onChat, onContact)!;
}

/** A reminder is "due" from its due time until it is done. */
export function isReminderDue(r: { dueAt: Date; doneAt: Date | null }, now: Date = new Date()): boolean {
  return r.doneAt === null && r.dueAt.getTime() <= now.getTime();
}
