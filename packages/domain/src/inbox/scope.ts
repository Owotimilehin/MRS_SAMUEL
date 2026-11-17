/**
 * Who may see which conversation. One rule, used in three places so they can
 * never disagree: SQL filters on list/detail queries, the real-time fan-out,
 * and push notifications.
 *
 *   inbox.view_all   → everything, on every number
 *   inbox.view_team  → conversations of my teams, plus anything assigned to me
 *   (neither)        → assigned to me, plus unassigned ones in my teams
 *
 * And unless inbox.view_all: only on business numbers granted to me.
 * Without inbox.view: nothing.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { inboxConversation, inboxTeamMember, inboxUserNumberAccess, type DbExecutor } from "@ms/db";
import type { Capability } from "@ms/shared";

export interface InboxViewer {
  userId: string;
  capabilities: readonly Capability[];
  teamIds: string[];
  /** "all" when the viewer has inbox.view_all. */
  numberIds: string[] | "all";
}

export interface ScopeFacts {
  phoneNumberId: string;
  teamId: string | null;
  assigneeId: string | null;
}

export async function loadViewer(
  db: DbExecutor,
  userId: string,
  capabilities: readonly Capability[],
): Promise<InboxViewer> {
  const teams = await db
    .select({ teamId: inboxTeamMember.teamId })
    .from(inboxTeamMember)
    .where(eq(inboxTeamMember.userId, userId));
  let numberIds: string[] | "all" = "all";
  if (!capabilities.includes("inbox.view_all")) {
    const rows = await db
      .select({ id: inboxUserNumberAccess.phoneNumberId })
      .from(inboxUserNumberAccess)
      .where(eq(inboxUserNumberAccess.userId, userId));
    numberIds = rows.map((r) => r.id);
  }
  return { userId, capabilities, teamIds: teams.map((t) => t.teamId), numberIds };
}

/** In-memory check, mirrors conversationScope(). */
export function canSeeConversation(v: InboxViewer, c: ScopeFacts): boolean {
  if (!v.capabilities.includes("inbox.view")) return false;
  if (v.capabilities.includes("inbox.view_all")) return true;
  if (v.numberIds !== "all" && !v.numberIds.includes(c.phoneNumberId)) return false;
  if (c.assigneeId === v.userId) return true;
  const inMyTeam = c.teamId !== null && v.teamIds.includes(c.teamId);
  if (v.capabilities.includes("inbox.view_team")) return inMyTeam;
  return inMyTeam && c.assigneeId === null;
}

/** SQL condition on inbox_conversation, mirrors canSeeConversation(). */
export function conversationScope(v: InboxViewer): SQL {
  if (!v.capabilities.includes("inbox.view")) return sql`false`;
  if (v.capabilities.includes("inbox.view_all")) return sql`true`;
  const numbers = v.numberIds === "all" ? [] : v.numberIds;
  if (numbers.length === 0) return sql`false`;
  const mine = eq(inboxConversation.assigneeId, v.userId);
  const teamCond = v.teamIds.length > 0 ? inArray(inboxConversation.teamId, v.teamIds) : sql`false`;
  const visible = v.capabilities.includes("inbox.view_team")
    ? or(mine, teamCond)
    : or(mine, and(isNull(inboxConversation.assigneeId), teamCond));
  return and(inArray(inboxConversation.phoneNumberId, numbers), visible)!;
}

/** May this viewer use the number to reply or as caller ID? */
export function canUseNumber(v: InboxViewer, phoneNumberId: string): boolean {
  return v.numberIds === "all" || v.numberIds.includes(phoneNumberId);
}
