/**
 * Real-time fan-out for the inbox.
 *
 * Producers (API requests, webhooks, the worker) call publishInboxEvent(),
 * which is a Postgres NOTIFY. This module LISTENs once per API process and
 * forwards each signal over Server-Sent Events to the connected staff who may
 * see it — the same canSeeConversation() rule the REST API filters with.
 *
 * Signals carry ids only; the apps refetch through the REST API.
 *
 * Each connection reloads its viewer (role, overrides, teams, numbers,
 * is_active) every 60 seconds, so permission changes apply within a minute and
 * a deactivated user's stream is closed.
 */
import { eq } from "drizzle-orm";
import { adminUser, type DbClient } from "@ms/db";
import { INBOX_NOTIFY_CHANNEL, canSeeConversation, canUseNumber, loadViewer, type InboxSignal, type InboxViewer } from "@ms/domain";
import { resolveCapabilities, type AdminRole, type PermissionOverrides } from "@ms/shared";
import { logger } from "../logger.js";

export interface Subscriber {
  id: number;
  viewer: InboxViewer;
  send: (event: string, data: unknown) => void;
  close: () => void;
}

const subscribers = new Map<number, Subscriber>();
let nextId = 1;
let listening: Promise<void> | null = null;

/** Exported for tests: should this subscriber receive this signal? */
export function shouldDeliver(viewer: InboxViewer, s: InboxSignal): boolean {
  if (s.event === "call.ringing") return !!s.userIds?.includes(viewer.userId);
  // Comments (suite spec 03): social.comments plus the existing per-line access, never the conversation rule.
  if (s.event.startsWith("comment.")) {
    return viewer.capabilities.includes("social.comments") && !!s.phoneNumberId && canUseNumber(viewer, s.phoneNumberId);
  }
  if (!s.conversationId || !s.phoneNumberId) return viewer.capabilities.includes("inbox.view_all");
  return canSeeConversation(viewer, {
    phoneNumberId: s.phoneNumberId,
    teamId: s.teamId ?? null,
    assigneeId: s.assigneeId ?? null,
  });
}

function dispatch(raw: string): void {
  let signal: InboxSignal;
  try {
    signal = JSON.parse(raw) as InboxSignal;
  } catch {
    return;
  }
  // Strip routing facts other users don't need.
  const publicSignal: InboxSignal = { ...signal };
  delete publicSignal.userIds;
  for (const sub of subscribers.values()) {
    if (shouldDeliver(sub.viewer, signal)) sub.send(signal.event, publicSignal);
  }
}

function ensureListening(db: DbClient): Promise<void> {
  if (!listening) {
    listening = db.$client
      .listen(INBOX_NOTIFY_CHANNEL, dispatch)
      .then(() => logger.info("inbox realtime listening"))
      .catch((err: unknown) => {
        listening = null;
        logger.error({ err }, "inbox realtime listen failed");
        throw err;
      });
  }
  return listening;
}

/** Fresh viewer from the database, or null when the user is gone/inactive. */
export async function reloadViewer(db: DbClient, userId: string): Promise<InboxViewer | null> {
  const [u] = await db
    .select({ role: adminUser.role, overrides: adminUser.permissionOverrides, isActive: adminUser.isActive, deletedAt: adminUser.deletedAt })
    .from(adminUser)
    .where(eq(adminUser.id, userId));
  if (!u || !u.isActive || u.deletedAt) return null;
  const caps = resolveCapabilities(u.role as AdminRole, u.overrides as PermissionOverrides);
  if (!caps.includes("inbox.view")) return null;
  return loadViewer(db, userId, caps);
}

export async function subscribe(
  db: DbClient,
  viewer: InboxViewer,
  send: Subscriber["send"],
  close: () => void,
): Promise<() => void> {
  await ensureListening(db);
  const id = nextId++;
  const sub: Subscriber = { id, viewer, send, close };
  subscribers.set(id, sub);

  const refresh = setInterval(() => {
    reloadViewer(db, viewer.userId)
      .then((v) => {
        if (!v) {
          sub.send("session.ended", {});
          unsubscribe();
          sub.close();
        } else {
          sub.viewer = v;
        }
      })
      .catch((err: unknown) => logger.warn({ err }, "inbox viewer refresh failed"));
  }, 60_000);

  function unsubscribe(): void {
    clearInterval(refresh);
    subscribers.delete(id);
  }
  return unsubscribe;
}

/** For tests and health: how many staff apps are connected. */
export function subscriberCount(): number {
  return subscribers.size;
}
