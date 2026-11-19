/**
 * Push notifications for new WhatsApp, Messenger and Instagram messages, sent to staff phones through
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
  inboxIdentity,
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

/** Sends pushes; returns the tokens the push service says are dead. */
export type PushSender = (messages: PushMessage[]) => Promise<string[] | void>;

/** Tokens Expo reports as DeviceNotRegistered (app uninstalled). Exported for tests. */
export function deadTokens(messages: PushMessage[], tickets: unknown): string[] {
  if (!Array.isArray(tickets)) return [];
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    const ticket = t as { status?: string; details?: { error?: string } } | null;
    if (ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered" && messages[i]) {
      dead.push(messages[i]!.to);
    }
  });
  return dead;
}

export const expoPushSender: PushSender = async (messages) => {
  const dead: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`expo push ${res.status}`);
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    dead.push(...deadTokens(batch, json?.data));
  }
  return dead;
};

/**
 * The push title: the contact's name, else phone, else what Meta calls them on
 * the channel (a Facebook name or an Instagram username). Exported for tests.
 */
export function pushTitle(
  conv: {
    name: string | null;
    phone: string | null;
    identityName: string | null;
    identityUsername: string | null;
  },
  /** Spec 02: the last fallback names the app ("New Instagram message"). */
  channel?: string | null,
): string {
  return (
    conv.name ||
    conv.phone ||
    conv.identityName ||
    (conv.identityUsername ? `@${conv.identityUsername}` : "") ||
    (channel ? `New ${channelWord(channel)} message` : "New message")
  );
}

function channelWord(channel: string): string {
  return channel === "messenger" ? "Messenger" : channel === "instagram" ? "Instagram" : "WhatsApp";
}

/** The push body: which app, then the preview, cut to 120 characters (spec 02, 6.6). Exported for tests. */
export function pushBody(channel: string | null | undefined, type: string, body: string | null): string {
  return `${channelWord(channel ?? "whatsapp")}: ${messagePreview(type, body)}`.slice(0, 120);
}

/**
 * The newest message per conversation that deserves a push. A referral ("came
 * from an advert") never does (spec 02, rule R14); it is only marked handled.
 * Exported for tests.
 */
export function latestPushable<T extends { type: string; conversationId: string }>(pending: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const m of pending) if (m.type !== "referral") out.set(m.conversationId, m);
  return out;
}

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
      channel: inboxMessage.channel,
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
        identityName: inboxIdentity.displayName,
        identityUsername: inboxIdentity.username,
      })
      .from(inboxConversation)
      .innerJoin(customer, eq(customer.id, inboxConversation.customerId))
      .leftJoin(inboxIdentity, eq(inboxIdentity.id, inboxConversation.identityId))
      .where(inArray(inboxConversation.id, convIds));

    // One push per conversation per person (the latest message), not one per message.
    const latestByConv = latestPushable(pending);

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
          title: pushTitle(conv, msg.channel),
          body: pushBody(msg.channel, msg.type, msg.body),
          data: { conversationId: convId },
          sound: "default",
          channelId: "messages",
        });
      }
    }
  }

  try {
    if (outgoing.length) {
      const dead = await send(outgoing);
      // Uninstalled apps: stop pushing to them (and stop counting them as reachable).
      if (dead && dead.length) {
        await db.delete(inboxPushToken).where(inArray(inboxPushToken.token, dead));
        log.info({ removed: dead.length }, "dead push tokens removed");
      }
    }
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
