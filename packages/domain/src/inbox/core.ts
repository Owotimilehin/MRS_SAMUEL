/**
 * Inbox core: customer matching, conversation lifecycle and real-time signals.
 * Used by the API (webhooks, staff actions) and the worker (retries, jobs).
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  customer,
  inboxConversation,
  inboxIdentity,
  inboxPhoneNumber,
  type DbExecutor,
} from "@ms/db";
import {
  channelForKind,
  toE164,
  WHATSAPP_ACCOUNT_KEY,
  type ChannelKind,
  type IdentityChannel,
  type InboxEventName,
} from "@ms/shared";

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
  /**
   * For message.created: "in" when the customer wrote. Lets the staff apps
   * alert on customer messages only, without fetching the message first.
   */
  direction?: "in" | "out";
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

/** Lock key shared by every path that may create a customer for this E.164 number. */
async function lockPhone(db: DbExecutor, e164: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbox-customer:${e164}`}))`);
}

async function lockIdentity(db: DbExecutor, channel: string, accountExternalId: string, externalId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`inbox-identity:${channel}:${accountExternalId}:${externalId}`}))`,
  );
}

/**
 * The oldest live customer whose phone is this number, in any of the formats
 * staff have typed it (+2347067220914, 2347067220914, 07067220914, 7067220914).
 */
async function matchCustomerByPhone(db: DbExecutor, e164: string): Promise<{ id: string } | null> {
  const digits = e164.slice(1);
  const variants = digits.startsWith("234") && digits.length === 13
    ? [digits, `0${digits.slice(3)}`, digits.slice(3)]
    : [digits];
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
  return existing ?? null;
}

type IdentityKey = { channel: IdentityChannel; accountExternalId: string; externalId: string };
type IdentityNames = { displayName?: string | null | undefined; username?: string | null | undefined };

/** The identity for a key, with whether its customer is live. */
async function identityByKey(
  db: DbExecutor,
  key: IdentityKey,
): Promise<{ id: string; customerId: string; customerLive: boolean } | null> {
  const [row] = await db
    .select({ id: inboxIdentity.id, customerId: inboxIdentity.customerId, deletedAt: customer.deletedAt })
    .from(inboxIdentity)
    .innerJoin(customer, eq(customer.id, inboxIdentity.customerId))
    .where(
      and(
        eq(inboxIdentity.channel, key.channel),
        eq(inboxIdentity.accountExternalId, key.accountExternalId),
        eq(inboxIdentity.externalId, key.externalId),
      ),
    )
    .limit(1);
  return row ? { id: row.id, customerId: row.customerId, customerLive: row.deletedAt === null } : null;
}

/**
 * Write the identity for a customer if it does not exist. If it exists but
 * belongs to a soft-deleted customer, point it at this one (rule R17). An
 * identity on a live customer is never moved here (rule R15). Returns its id.
 */
async function ensureIdentity(
  db: DbExecutor,
  customerId: string,
  key: IdentityKey,
  names: IdentityNames = {},
): Promise<string> {
  const [inserted] = await db
    .insert(inboxIdentity)
    .values({
      customerId,
      channel: key.channel,
      accountExternalId: key.accountExternalId,
      externalId: key.externalId,
      displayName: nonEmpty(names.displayName),
      username: nonEmpty(names.username),
      lastSeenAt: null,
    })
    .onConflictDoNothing({ target: [inboxIdentity.channel, inboxIdentity.accountExternalId, inboxIdentity.externalId] })
    .returning({ id: inboxIdentity.id });
  if (inserted) return inserted.id;
  const existing = await identityByKey(db, key);
  if (!existing) throw new Error("identity vanished during insert");
  if (!existing.customerLive && existing.customerId !== customerId) {
    await db
      .update(inboxIdentity)
      .set({ customerId, updatedAt: new Date() })
      .where(eq(inboxIdentity.id, existing.id));
  }
  return existing.id;
}

function nonEmpty(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Refresh an identity after its owner wrote: names only when Meta sent them, plus last_seen_at. */
async function touchIdentity(
  db: DbExecutor,
  identityId: string,
  names: IdentityNames,
): Promise<void> {
  const displayName = nonEmpty(names.displayName);
  const username = nonEmpty(names.username);
  await db
    .update(inboxIdentity)
    .set({
      displayName: sql`coalesce(${displayName}, ${inboxIdentity.displayName})`,
      username: sql`coalesce(${username}, ${inboxIdentity.username})`,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(inboxIdentity.id, identityId));
}

/**
 * Find the customer for a phone number, or create one.
 *
 * Order (suite spec 01, rule R6): a WhatsApp identity for this number whose
 * customer is live wins, so a merge sticks. Otherwise match on customer.phone:
 * existing customer.phone values were typed in many formats, so match on
 * digits. The oldest live record wins when there are duplicates. Otherwise
 * insert a customer.
 *
 * With source "whatsapp" the WhatsApp identity for the number is written for
 * the resulting customer. A call (source "phone") never writes one (rule R8),
 * and neither does a lead form (source "online", suite spec 13): the person
 * has not written to us on WhatsApp yet.
 *
 * Existing customer rows are never modified. Must run inside a transaction
 * (uses a transaction-scoped advisory lock).
 */
export async function findOrCreateCustomer(
  db: DbExecutor,
  rawPhone: string,
  opts: { name?: string | null; email?: string | null; source: "whatsapp" | "phone" | "online" },
): Promise<{ id: string; created: boolean }> {
  const e164 = toE164(rawPhone);
  if (!e164) throw new Error(`unusable phone number: ${rawPhone}`);
  const key: IdentityKey = { channel: "whatsapp", accountExternalId: WHATSAPP_ACCOUNT_KEY, externalId: e164.slice(1) };

  // Serialise per phone number for the rest of this transaction, so two
  // webhooks arriving together for a new customer can't both insert.
  await lockPhone(db, e164);

  // Identity first: after a merge the identity points at the kept contact.
  const ident = await identityByKey(db, key);
  if (ident?.customerLive) return { id: ident.customerId, created: false };

  let result: { id: string; created: boolean };
  const existing = await matchCustomerByPhone(db, e164);
  if (existing) {
    // Existing customer rows are never modified by the inbox.
    result = { id: existing.id, created: false };
  } else {
    const [row] = await db
      .insert(customer)
      // email is set on a NEW row only (a lead form gave it, suite spec 13); existing rows are never changed.
      .values({ phone: e164, name: opts.name ?? null, email: opts.email ?? null, source: opts.source })
      .returning({ id: customer.id });
    result = { id: row!.id, created: true };
  }
  if (opts.source === "whatsapp") await ensureIdentity(db, result.id, key, { displayName: opts.name ?? null });
  return result;
}

/**
 * Find the customer for an identity on a channel, or create customer +
 * identity (foundation D13). Runs inside a transaction. The customer row is
 * never changed; a soft-deleted customer is never re-used (rule R17).
 */
export async function findOrCreateCustomerByIdentity(
  db: DbExecutor,
  identity: {
    channel: IdentityChannel;
    accountExternalId: string;
    externalId: string;
    displayName?: string | null;
    username?: string | null;
  },
): Promise<{ customerId: string; identityId: string; created: boolean }> {
  const accountExternalId = identity.accountExternalId?.trim() ?? "";
  const externalId = identity.externalId?.trim() ?? "";
  if (!accountExternalId || !externalId) throw new Error("identity needs an account and an id");
  const key: IdentityKey = { channel: identity.channel, accountExternalId, externalId };
  const names = { displayName: identity.displayName, username: identity.username };

  await lockIdentity(db, key.channel, accountExternalId, externalId);

  const found = await identityByKey(db, key);
  if (found?.customerLive) {
    await touchIdentity(db, found.id, names);
    return { customerId: found.customerId, identityId: found.id, created: false };
  }

  const customerId = await insertIdentityCustomer(db, key.channel, names);
  if (found) {
    // The old contact was deleted: this identity starts afresh on a new one.
    await db
      .update(inboxIdentity)
      .set({ customerId, updatedAt: new Date() })
      .where(eq(inboxIdentity.id, found.id));
    await touchIdentity(db, found.id, names);
    return { customerId, identityId: found.id, created: true };
  }
  const [row] = await db
    .insert(inboxIdentity)
    .values({
      customerId,
      channel: key.channel,
      accountExternalId,
      externalId,
      displayName: nonEmpty(names.displayName),
      username: nonEmpty(names.username),
      lastSeenAt: new Date(),
    })
    .returning({ id: inboxIdentity.id });
  return { customerId, identityId: row!.id, created: true };
}

/** A phone-less customer for an identity. Messenger/Instagram → "online"; BSUID-only WhatsApp → "whatsapp" (spec 01, Q2). */
async function insertIdentityCustomer(
  db: DbExecutor,
  channel: IdentityChannel,
  names: IdentityNames,
): Promise<string> {
  const displayName = nonEmpty(names.displayName);
  const username = nonEmpty(names.username);
  const [row] = await db
    .insert(customer)
    .values({
      name: displayName ?? (username ? `@${username}` : null),
      phone: null,
      source: channel === "whatsapp" ? "whatsapp" : "online",
    })
    .returning({ id: customer.id });
  return row!.id;
}

/**
 * Set an identity's profile. Only the keys present in `p` change (a present
 * null clears); profile_fetched_at and updated_at are always set.
 */
export async function updateIdentityProfile(
  db: DbExecutor,
  identityId: string,
  p: { displayName?: string | null; username?: string | null; profilePicUrl?: string | null },
): Promise<void> {
  const now = new Date();
  await db
    .update(inboxIdentity)
    .set({
      ...("displayName" in p ? { displayName: p.displayName ?? null } : {}),
      ...("username" in p ? { username: p.username ?? null } : {}),
      ...("profilePicUrl" in p ? { profilePicUrl: p.profilePicUrl ?? null } : {}),
      profileFetchedAt: now,
      updatedAt: now,
    })
    .where(eq(inboxIdentity.id, identityId));
}

/**
 * The customer for an incoming WhatsApp message, by phone number (E.164),
 * business-scoped user ID (BSUID), or both (suite spec 01, 5.3 (d)). At least
 * one must be set. Locks are taken phone first, then BSUID, so two calls can
 * never deadlock. When the phone and the BSUID belong to two different live
 * contacts the phone's contact wins and nothing moves (rule R15).
 */
export async function resolveWhatsAppCustomer(
  db: DbExecutor,
  who: { phone: string | null; userId: string | null; name?: string | null; username?: string | null },
): Promise<{ customerId: string; identityId: string; created: boolean }> {
  const e164 = who.phone ? toE164(who.phone) : null;
  const userId = who.userId?.trim() || null;
  if (!e164 && !userId) throw new Error("a WhatsApp sender needs a phone number or a user id");
  const names = { displayName: who.name ?? null, username: who.username ?? null };

  if (!e164) {
    return findOrCreateCustomerByIdentity(db, {
      channel: "whatsapp",
      accountExternalId: WHATSAPP_ACCOUNT_KEY,
      externalId: userId!,
      displayName: who.name ?? null,
      username: who.username ?? null,
    });
  }

  const phoneKey: IdentityKey = { channel: "whatsapp", accountExternalId: WHATSAPP_ACCOUNT_KEY, externalId: e164.slice(1) };
  await lockPhone(db, e164);
  if (!userId) {
    const cust = await findOrCreateCustomer(db, e164, { name: who.name ?? null, source: "whatsapp" });
    const phoneIdentityId = await ensureIdentity(db, cust.id, phoneKey, { displayName: who.name ?? null });
    await touchIdentity(db, phoneIdentityId, { displayName: who.name ?? null });
    return { customerId: cust.id, identityId: phoneIdentityId, created: cust.created };
  }

  const bsuidKey: IdentityKey = { channel: "whatsapp", accountExternalId: WHATSAPP_ACCOUNT_KEY, externalId: userId };
  await lockIdentity(db, bsuidKey.channel, bsuidKey.accountExternalId, bsuidKey.externalId);

  const phoneIdent = await identityByKey(db, phoneKey);
  const bsuidIdent = await identityByKey(db, bsuidKey);

  let customerId: string;
  let created = false;
  if (bsuidIdent?.customerLive && !phoneIdent?.customerLive && !(await matchCustomerByPhone(db, e164))) {
    // The customer wrote before with their number hidden; now it shows. Same thread.
    customerId = bsuidIdent.customerId;
  } else {
    const cust = await findOrCreateCustomer(db, e164, { name: who.name ?? null, source: "whatsapp" });
    customerId = cust.id;
    created = cust.created;
  }

  const phoneIdentityId = await ensureIdentity(db, customerId, phoneKey, { displayName: who.name ?? null });
  const bsuidIdentityId = await ensureIdentity(db, customerId, bsuidKey, names);
  await touchIdentity(db, phoneIdentityId, { displayName: who.name ?? null });
  // Refresh the BSUID identity only when it belongs to the same contact (R15: never touch the other one).
  const [bsuidNow] = await db
    .select({ customerId: inboxIdentity.customerId })
    .from(inboxIdentity)
    .where(eq(inboxIdentity.id, bsuidIdentityId));
  if (bsuidNow?.customerId === customerId) await touchIdentity(db, bsuidIdentityId, names);
  return { customerId, identityId: phoneIdentityId, created };
}

/**
 * A Date as a SQL parameter inside a raw sql`` fragment. The driver only
 * serialises Dates for typed columns, so raw fragments need text + a cast.
 */
export function ts(d: Date) {
  return sql`${d.toISOString()}::timestamptz`;
}

const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ConversationRow = typeof inboxConversation.$inferSelect;

/**
 * The thread for (customer, business number): the latest one if it is still
 * open, or closed less than 7 days ago (reopened); otherwise a new one owned by
 * the number's default team, on the line's channel.
 *
 * `opts.identityId`: the identity that just wrote. A new thread records it;
 * an existing thread follows it (the last identity to write is the one replies
 * go to; rule R12).
 */
export async function findOrOpenConversation(
  db: DbExecutor,
  customerId: string,
  phoneNumberId: string,
  now: Date = new Date(),
  opts: { identityId?: string | null } = {},
): Promise<{ conversation: ConversationRow; created: boolean; reopened: boolean }> {
  const [latest] = await db
    .select()
    .from(inboxConversation)
    .where(and(eq(inboxConversation.customerId, customerId), eq(inboxConversation.phoneNumberId, phoneNumberId)))
    .orderBy(desc(inboxConversation.createdAt))
    .limit(1);

  const identityId = opts.identityId ?? null;
  const followIdentity = identityId && latest && latest.identityId !== identityId ? { identityId } : {};

  if (latest && latest.status !== "closed") {
    if (!("identityId" in followIdentity)) return { conversation: latest, created: false, reopened: false };
    const [followed] = await db
      .update(inboxConversation)
      .set(followIdentity)
      .where(eq(inboxConversation.id, latest.id))
      .returning();
    return { conversation: followed!, created: false, reopened: false };
  }
  if (latest && latest.closedAt && now.getTime() - latest.closedAt.getTime() < REOPEN_WINDOW_MS) {
    const [reopened] = await db
      .update(inboxConversation)
      .set({ status: "open", closedAt: null, ...followIdentity })
      .where(eq(inboxConversation.id, latest.id))
      .returning();
    return { conversation: reopened!, created: false, reopened: true };
  }

  const [num] = await db
    .select({ teamId: inboxPhoneNumber.defaultTeamId, kind: inboxPhoneNumber.kind })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, phoneNumberId));
  const [created] = await db
    .insert(inboxConversation)
    .values({
      customerId,
      phoneNumberId,
      teamId: num?.teamId ?? null,
      status: "open",
      lastActivityAt: now,
      channel: channelForKind((num?.kind ?? "phone") as ChannelKind),
      identityId,
    })
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
      lastActivityAt: sql`greatest(${inboxConversation.lastActivityAt}, ${ts(at)})`,
      ...(patch.preview !== undefined
        ? { lastPreview: sql`case when ${ts(at)} >= ${inboxConversation.lastActivityAt} then ${patch.preview} else ${inboxConversation.lastPreview} end` }
        : {}),
      ...(patch.inboundWa
        ? { lastInboundWaAt: sql`greatest(coalesce(${inboxConversation.lastInboundWaAt}, '-infinity'::timestamptz), ${ts(patch.inboundWa)})` }
        : {}),
      ...(patch.unreadIncrement ? { unreadCount: sql`${inboxConversation.unreadCount} + 1` } : {}),
      // A new inbound message on a pending/closed-but-reopened thread is open work.
      ...(patch.unreadIncrement ? { status: "open" as const } : {}),
    })
    .where(eq(inboxConversation.id, conversationId))
    .returning();
  return row!;
}
