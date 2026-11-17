/**
 * Push notifications for new WhatsApp messages, sent to staff phones through
 * Expo's push service. Each person gets a push only for conversations they may
 * see (the same canSeeConversation rule as the inbox), filtered by their
 * notification setting:
 *   all       → every visible conversation
 *   assigned  → assigned to me, or unassigned in my teams (default)
 *   none      → nothing
 * Messages older than 10 minutes are marked handled without a push (no
 * late-night flood after downtime).
 */
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  adminUser,
  customer,
  inboxConversation,
  inboxMessage,
  inboxNotifyPref,
  inboxPushToken,
  type DbClient,
} from "@ms/db";
import { canSeeConversation, loadViewer, type InboxViewer } from "@ms/domain";
import { messagePreview, resolveCapabilities, type AdminRole, type PermissionOverrides } from "@ms/shared";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const FRESH_MS = 10 * 60 * 1000;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  channelId: string;
}

export type PushSender = (messages: PushMessage[]) => Promise<void>;

export const expoPushSender: PushSender = async (messages) => {
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages.slice(i, i + 100)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`expo push ${res.status}`);
  }
};

/** Exported for tests. */
export function wantsPush(
  viewer: InboxViewer,
  level: string,
  conv: { phoneNumberId: string; teamId: string | null; assigneeId: string | null },
): boolean {
  if (level === "none") return false;
  if (!canSeeConversation(viewer, conv)) return false;
  if (level === "all") return true;
  if (conv.assigneeId) return conv.assigneeId === viewer.userId;
  return conv.teamId !== null && viewer.teamIds.includes(conv.teamId);
}

export async function sendMessagePushes(db: DbClient, log: Log, send: PushSender = expoPushSender): Promise<number> {
  // Stale ones: mark handled, no push.
  await db
    .update(inboxMessage)
    .set({ notifiedAt: new Date() })
    .where(
      and(
        eq(inboxMessage.direction, "in"),
        isNull(inboxMessage.notifiedAt),
        lt(inboxMessage.createdAt, new Date(Date.now() - FRESH_MS)),
      ),
    );

  const pending = await db
    .select({
      id: inboxMessage.id,
      type: inboxMessage.type,
      body: inboxMessage.body,
      conversationId: inboxMessage.conversationId,
    })
    .from(inboxMessage)
    .where(and(eq(inboxMessage.direction, "in"), isNull(inboxMessage.notifiedAt), gt(inboxMessage.createdAt, new Date(Date.now() - FRESH_MS))))
    .orderBy(asc(inboxMessage.createdAt))
    .limit(100);
  if (pending.length === 0) return 0;

  const tokens = await db
    .select({ userId: inboxPushToken.userId, token: inboxPushToken.token })
    .from(inboxPushToken)
    .innerJoin(adminUser, eq(adminUser.id, inboxPushToken.userId))
    .where(and(inArray(inboxPushToken.platform, ["ios", "android"]), eq(adminUser.isActive, true), isNull(adminUser.deletedAt)));

  const outgoing: PushMessage[] = [];
  if (tokens.length > 0) {
    const userIds = [...new Set(tokens.map((t) => t.userId))];
    const users = await db
      .select({ id: adminUser.id, role: adminUser.role, overrides: adminUser.permissionOverrides })
      .from(adminUser)
      .where(inArray(adminUser.id, userIds));
    const prefs = await db.select().from(inboxNotifyPref).where(inArray(inboxNotifyPref.userId, userIds));
    const viewers = new Map<string, InboxViewer>();
    for (const u of users) {
      const caps = resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides);
      if (caps.includes("inbox.view")) viewers.set(u.id, await loadViewer(db, u.id, caps));
    }

    const convIds = [...new Set(pending.map((p) => p.conversationId))];
    const convs = await db
      .select({
        id: inboxConversation.id,
        phoneNumberId: inboxConversation.phoneNumberId,
        teamId: inboxConversation.teamId,
        assigneeId: inboxConversation.assigneeId,
        name: customer.name,
        phone: customer.phone,
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .where(inArray(inboxConversation.id, convIds));

    // One push per conversation per person (the latest message), not one per message.
    const latestByConv = new Map<string, (typeof pending)[number]>();
    for (const m of pending) latestByConv.set(m.conversationId, m);

    for (const [convId, msg] of latestByConv) {
      const conv = convs.find((c) => c.id === convId);
      if (!conv) continue;
      for (const t of tokens) {
        const viewer = viewers.get(t.userId);
        if (!viewer) continue;
        const level = prefs.find((p) => p.userId === t.userId)?.level ?? "assigned";
        if (!wantsPush(viewer, level, conv)) continue;
        outgoing.push({
          to: t.token,
          title: conv.name || conv.phone || "New WhatsApp message",
          body: messagePreview(msg.type, msg.body).slice(0, 120),
          data: { conversationId: convId },
          sound: "default",
          channelId: "messages",
        });
      }
    }
  }

  try {
    if (outgoing.length) await send(outgoing);
  } catch (err) {
    log.warn({ err, count: outgoing.length }, "inbox push send failed");
  }
  await db
    .update(inboxMessage)
    .set({ notifiedAt: sql`now()` })
    .where(inArray(inboxMessage.id, pending.map((p) => p.id)));
  if (outgoing.length) log.info({ pushes: outgoing.length }, "inbox pushes sent");
  return outgoing.length;
}
