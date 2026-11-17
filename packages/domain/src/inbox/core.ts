/**
 * Inbox core: customer matching, conversation lifecycle and real-time signals.
 * Used by the API (webhooks, staff actions) and the worker (retries, jobs).
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  customer,
  inboxConversation,
  inboxPhoneNumber,
  type DbExecutor,
} from "@ms/db";
import { toE164, type InboxEventName } from "@ms/shared";

/** Postgres NOTIFY channel the API listens on to fan events out to staff apps. */
export const INBOX_NOTIFY_CHANNEL = "inbox_events";

/**
 * Minimal routing facts for an event. The API checks these against each
 * connected user's scope before forwarding; clients then refetch through the
 * permission-checked REST API, so no message content ever rides the bus.
 */
export interface InboxSignal {
  event: InboxEventName;
  conversationId?: string;
  phoneNumberId?: string;
  teamId?: string | null;
  assigneeId?: string | null;
  /** Message/call/recording id the event is about. */
  id?: string;
  /** For call.ringing: the users being rung. */
  userIds?: string[];
}

/** Queue a signal. Inside a transaction it is delivered only on commit. */
export async function publishInboxEvent(db: DbExecutor, signal: InboxSignal): Promise<void> {
  await db.execute(sql`select pg_notify(${INBOX_NOTIFY_CHANNEL}, ${JSON.stringify(signal)})`);
}

export function signalFor(
  event: InboxEventName,
  conv: { id: string; phoneNumberId: string; teamId: string | null; assigneeId: string | null },
  id?: string,
): InboxSignal {
  const signal: InboxSignal = {
    event,
    conversationId: conv.id,
    phoneNumberId: conv.phoneNumberId,
    teamId: conv.teamId,
    assigneeId: conv.assigneeId,
  };
  if (id) signal.id = id;
  return signal;
}

/**
 * Find the customer for a phone number, or create one. Existing customer.phone
 * values were typed in many formats, so match on digits: +2347067220914 matches
 * "2347067220914", "07067220914" and "7067220914". The oldest live record wins
 * when there are duplicates. Existing customer rows are never modified; a new
 * row is inserted only when nothing matches. Must run inside a transaction
 * (uses a transaction-scoped advisory lock).
 */
export async function findOrCreateCustomer(
  db: DbExecutor,
  rawPhone: string,
  opts: { name?: string | null; source: "whatsapp" | "phone" },
): Promise<{ id: string; created: boolean }> {
  const e164 = toE164(rawPhone);
  if (!e164) throw new Error(`unusable phone number: ${rawPhone}`);
  const digits = e164.slice(1);
  const variants = digits.startsWith("234") && digits.length === 13
    ? [digits, `0${digits.slice(3)}`, digits.slice(3)]
    : [digits];

  // Serialise per phone number for the rest of this transaction, so two
  // webhooks arriving together for a new customer can't both insert.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbox-customer:${e164}`}))`);

  const live = isNull(customer.deletedAt);
  // Fast path: canonical form, uses the phone index.
  let [existing] = await db
    .select({ id: customer.id })
    .from(customer)
    .where(and(live, eq(customer.phone, e164)))
    .orderBy(asc(customer.createdAt))
    .limit(1);
  if (!existing) {
    // Slow path: phones typed in other formats (scans; only on a miss).
    [existing] = await db
      .select({ id: customer.id })
      .from(customer)
      .where(
        and(
          live,
          sql`regexp_replace(coalesce(${customer.phone}, ''), '\\D', '', 'g') in (${sql.join(
            variants.map((v) => sql`${v}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(asc(customer.createdAt))
      .limit(1);
  }
  // Existing customer rows are never modified by the inbox.
  if (existing) return { id: existing.id, created: false };

  const [row] = await db
    .insert(customer)
    .values({ phone: e164, name: opts.name ?? null, source: opts.source })
    .returning({ id: customer.id });
  return { id: row!.id, created: true };
}

const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ConversationRow = typeof inboxConversation.$inferSelect;

/**
 * The thread for (customer, business number): the latest one if it is still
 * open, or closed less than 7 days ago (reopened); otherwise a new one owned by
 * the number's default team.
 */
export async function findOrOpenConversation(
  db: DbExecutor,
  customerId: string,
  phoneNumberId: string,
  now: Date = new Date(),
): Promise<{ conversation: ConversationRow; created: boolean; reopened: boolean }> {
  const [latest] = await db
    .select()
    .from(inboxConversation)
    .where(and(eq(inboxConversation.customerId, customerId), eq(inboxConversation.phoneNumberId, phoneNumberId)))
    .orderBy(desc(inboxConversation.createdAt))
    .limit(1);

  if (latest && latest.status !== "closed") return { conversation: latest, created: false, reopened: false };
  if (latest && latest.closedAt && now.getTime() - latest.closedAt.getTime() < REOPEN_WINDOW_MS) {
    const [reopened] = await db
      .update(inboxConversation)
      .set({ status: "open", closedAt: null })
      .where(eq(inboxConversation.id, latest.id))
      .returning();
    return { conversation: reopened!, created: false, reopened: true };
  }

  const [num] = await db
    .select({ teamId: inboxPhoneNumber.defaultTeamId })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, phoneNumberId));
  const [created] = await db
    .insert(inboxConversation)
    .values({ customerId, phoneNumberId, teamId: num?.teamId ?? null, status: "open", lastActivityAt: now })
    .returning();
  return { conversation: created!, created: true, reopened: false };
}

/** Bump the list ordering and preview after any timeline activity. */
export async function touchConversation(
  db: DbExecutor,
  conversationId: string,
  patch: { preview?: string; inboundWa?: Date; unreadIncrement?: boolean; at?: Date },
): Promise<ConversationRow> {
  const at = patch.at ?? new Date();
  const [row] = await db
    .update(inboxConversation)
    .set({
      // Forward-only, so a late retry of an old event can't move things back.
      lastActivityAt: sql`greatest(${inboxConversation.lastActivityAt}, ${at})`,
      ...(patch.preview !== undefined
        ? { lastPreview: sql`case when ${at} >= ${inboxConversation.lastActivityAt} then ${patch.preview} else ${inboxConversation.lastPreview} end` }
        : {}),
      ...(patch.inboundWa
        ? { lastInboundWaAt: sql`greatest(coalesce(${inboxConversation.lastInboundWaAt}, '-infinity'::timestamptz), ${patch.inboundWa})` }
        : {}),
      ...(patch.unreadIncrement ? { unreadCount: sql`${inboxConversation.unreadCount} + 1` } : {}),
      // A new inbound message on a pending/closed-but-reopened thread is open work.
      ...(patch.unreadIncrement ? { status: "open" as const } : {}),
    })
    .where(eq(inboxConversation.id, conversationId))
    .returning();
  return row!;
}
