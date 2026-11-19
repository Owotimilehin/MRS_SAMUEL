/**
 * Reading contacts for the Contacts routes (suite spec 14, rules R1 to R6).
 *
 * The list reads `contact_summary s JOIN customer c`, pages by key with a row
 * comparison that uses the index for the chosen sort, and never uses OFFSET.
 * Labels, handles and consent for a page are fetched in three follow-up
 * queries by customer id, not by joins that would multiply rows.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  adminUser,
  contactAlias,
  contactConsent,
  contactImport,
  contactLabel,
  contactLabelMember,
  contactList,
  contactListMember,
  contactOrigin,
  customer,
  inboxConversation,
  inboxIdentity,
  inboxPhoneNumber,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import { contactFilterSql, conversationScope, loadViewer, refreshContactSummary } from "@ms/domain";
import {
  parseContactFilter,
  type Capability,
  type ConsentNow,
  type ConsentView,
  type ContactChannel,
  type ContactDetail,
  type ContactFilter,
  type ContactLabelView,
  type ContactRow,
  type ContactSort,
  type ContactSource,
} from "@ms/shared";
import { identitiesFor } from "../routes/inbox.js";

/** A timestamptz as an ISO string, straight from SQL (raw queries return text). */
function iso(expr: SQL): SQL {
  return sql`to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

interface SortSpec {
  /** The key column, as SQL over alias s. */
  key: SQL;
  dir: "asc" | "desc";
  /** A cursor's key text turned back into the column's type. */
  param: (k: string) => SQL;
}

const SORTS: Record<ContactSort, SortSpec> = {
  name: { key: sql`s.name_sort`, dir: "asc", param: (k) => sql`${k}::text COLLATE "C"` },
  last_order: { key: sql`s.last_order_key`, dir: "desc", param: (k) => sql`${k}::timestamptz` },
  spent: { key: sql`s.spent_ngn`, dir: "desc", param: (k) => sql`${k}::bigint` },
  last_contact: { key: sql`s.last_contact_key`, dir: "desc", param: (k) => sql`${k}::timestamptz` },
  added: { key: sql`s.created_key`, dir: "desc", param: (k) => sql`${k}::timestamptz` },
};

export interface ContactCursor {
  s: ContactSort;
  k: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: ContactCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Null when the text is not one of our cursors. */
export function decodeCursor(text: string): ContactCursor | null {
  try {
    const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<ContactCursor>;
    if (!v || typeof v !== "object") return null;
    if (typeof v.s !== "string" || !(v.s in SORTS)) return null;
    if (typeof v.k !== "string" || v.k.length > 2000) return null;
    if (typeof v.id !== "string" || !UUID_RE.test(v.id)) return null;
    if (v.s === "spent" ? !/^-?\d{1,18}$/.test(v.k) : false) return null;
    if (v.s !== "name" && v.s !== "spent" && !/^(-?infinity|[\d: .+-]{10,40})$/.test(v.k)) return null;
    return { s: v.s as ContactSort, k: v.k, id: v.id };
  } catch {
    return null;
  }
}

interface RawRow {
  customer_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  address_source: "saved" | "last_delivery" | null;
  channels: string[];
  source: string;
  origin: string | null;
  last_contact_at: string | null;
  orders_count: number;
  spent_ngn: string | number;
  last_order_at: string | null;
  wa_unreachable: boolean;
  created_at: string;
  k: string;
}

const ROW_COLUMNS = sql`
  s.customer_id, c.name, c.phone, c.email, s.address, s.address_source, s.channels,
  c.source::text AS source, og.origin AS origin,
  ${iso(sql`s.last_contact_at`)} AS last_contact_at, s.orders_count, s.spent_ngn,
  ${iso(sql`s.last_order_at`)} AS last_order_at, (s.wa_unreachable_at IS NOT NULL) AS wa_unreachable,
  ${iso(sql`c.created_at`)} AS created_at`;

const ROW_FROM = sql`
  FROM contact_summary s
  JOIN customer c ON c.id = s.customer_id
  LEFT JOIN contact_origin og ON og.customer_id = s.customer_id`;

/** Labels, handles and consent for one page of contacts: three queries by id (rule R6). */
async function decorate(db: DbExecutor, raw: RawRow[]): Promise<ContactRow[]> {
  const ids = raw.map((r) => r.customer_id);
  const labels = new Map<string, ContactLabelView[]>();
  const handles = new Map<string, string[]>();
  const consent = new Map<string, ConsentView>();
  if (ids.length) {
    const labelRows = await db
      .select({ customerId: contactLabelMember.customerId, id: contactLabel.id, name: contactLabel.name, colour: contactLabel.colour })
      .from(contactLabelMember)
      .innerJoin(contactLabel, eq(contactLabel.id, contactLabelMember.labelId))
      .where(inArray(contactLabelMember.customerId, ids))
      .orderBy(contactLabel.nameKey);
    for (const l of labelRows) {
      const list = labels.get(l.customerId) ?? [];
      list.push({ id: l.id, name: l.name, colour: l.colour as ContactLabelView["colour"] });
      labels.set(l.customerId, list);
    }
    const handleRows = await db
      .select({ customerId: inboxIdentity.customerId, username: inboxIdentity.username, displayName: inboxIdentity.displayName })
      .from(inboxIdentity)
      .where(and(inArray(inboxIdentity.customerId, ids), sql`coalesce(${inboxIdentity.username}, ${inboxIdentity.displayName}) is not null`))
      .orderBy(sql`${inboxIdentity.lastSeenAt} desc nulls last`, desc(inboxIdentity.createdAt));
    for (const h of handleRows) {
      const list = handles.get(h.customerId) ?? [];
      const text = h.username ? `@${h.username}` : h.displayName!;
      if (list.length < 3 && !list.includes(text)) list.push(text);
      handles.set(h.customerId, list);
    }
    const consentRows = await db
      .select({ customerId: contactConsent.customerId, state: contactConsent.state })
      .from(contactConsent)
      .where(
        and(
          inArray(contactConsent.customerId, ids),
          eq(contactConsent.isCurrent, true),
          eq(contactConsent.channel, "whatsapp"),
          eq(contactConsent.purpose, "marketing"),
        ),
      );
    for (const k of consentRows) consent.set(k.customerId, k.state === "withdrawn" ? "stopped" : "agreed");
  }
  return raw.map((r) => ({
    id: r.customer_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    address: r.address,
    address_source: r.address_source,
    channels: (r.channels ?? []) as ContactChannel[],
    handles: handles.get(r.customer_id) ?? [],
    source: (r.origin ?? r.source) as ContactSource,
    last_contact_at: r.last_contact_at,
    orders_count: Number(r.orders_count),
    spent_ngn: Number(r.spent_ngn),
    last_order_at: r.last_order_at,
    labels: labels.get(r.customer_id) ?? [],
    consent: consent.get(r.customer_id) ?? "not_asked",
    wa_unreachable: r.wa_unreachable === true,
    created_at: r.created_at,
  }));
}

/**
 * One page of contacts matching `where` (a fragment over s and c), in the
 * given order, starting after `cursor`. Key paging (rule R2): the next page is
 * WHERE (key, customer_id) > (k, id), or < for a descending sort.
 */
export async function contactPage(
  db: DbExecutor,
  where: SQL,
  sort: ContactSort,
  limit: number,
  cursor: ContactCursor | null,
): Promise<{ contacts: ContactRow[]; next_cursor: string | null }> {
  const spec = SORTS[sort];
  const after = cursor
    ? spec.dir === "asc"
      ? sql`AND (${spec.key}, s.customer_id) > (${spec.param(cursor.k)}, ${cursor.id}::uuid)`
      : sql`AND (${spec.key}, s.customer_id) < (${spec.param(cursor.k)}, ${cursor.id}::uuid)`
    : sql``;
  const order = spec.dir === "asc" ? sql`${spec.key} ASC, s.customer_id ASC` : sql`${spec.key} DESC, s.customer_id DESC`;
  const rows = (await db.execute(sql`
    SELECT ${ROW_COLUMNS}, ${spec.key}::text AS k
    ${ROW_FROM}
    WHERE (${where}) ${after}
    ORDER BY ${order}
    LIMIT ${limit + 1}
  `)) as unknown as RawRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const more = rows.length > limit && last !== undefined;
  return {
    contacts: await decorate(db, page),
    next_cursor: more ? encodeCursor({ s: sort, k: last.k, id: last.customer_id }) : null,
  };
}

/** How many contacts match (rule R5: asked only for the first page). */
export async function contactCount(db: DbExecutor, where: SQL): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM contact_summary s JOIN customer c ON c.id = s.customer_id WHERE (${where})
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/** The row of one contact, or null when they have no summary row. */
export async function contactRowById(db: DbExecutor, id: string): Promise<ContactRow | null> {
  const rows = (await db.execute(sql`
    SELECT ${ROW_COLUMNS}, '' AS k ${ROW_FROM} WHERE s.customer_id = ${id}::uuid
  `)) as unknown as RawRow[];
  const [row] = await decorate(db, rows);
  return row ?? null;
}

/** The smart lists this contact matches right now (a handful of small checks). */
async function smartListsFor(db: DbExecutor, id: string, now: Date): Promise<{ id: string; name: string; kind: "smart" }[]> {
  const smart = await db
    .select({ id: contactList.id, name: contactList.name, filter: contactList.filter })
    .from(contactList)
    .where(and(eq(contactList.kind, "smart"), sql`${contactList.archivedAt} is null`))
    .orderBy(contactList.nameKey);
  const out: { id: string; name: string; kind: "smart" }[] = [];
  for (const l of smart) {
    const parsed = parseContactFilter(l.filter, { forSmartList: true });
    if (!parsed.ok) continue;
    const rows = (await db.execute(sql`
      SELECT 1 AS hit FROM contact_summary s JOIN customer c ON c.id = s.customer_id
      WHERE s.customer_id = ${id}::uuid AND (${contactFilterSql(parsed.filter, now)}) LIMIT 1
    `)) as unknown as unknown[];
    if (rows.length) out.push({ id: l.id, name: l.name, kind: "smart" });
  }
  return out;
}

/** A contact's current consent rows with who recorded each. */
export async function consentNow(db: DbExecutor, id: string): Promise<ConsentNow[]> {
  const rows = await db
    .select({
      channel: contactConsent.channel,
      purpose: contactConsent.purpose,
      state: contactConsent.state,
      method: contactConsent.method,
      recordedAt: contactConsent.recordedAt,
      byName: adminUser.name,
      byEmail: adminUser.email,
    })
    .from(contactConsent)
    .leftJoin(adminUser, eq(adminUser.id, contactConsent.recordedBy))
    .where(and(eq(contactConsent.customerId, id), eq(contactConsent.isCurrent, true)))
    .orderBy(contactConsent.channel, contactConsent.purpose);
  return rows.map((r) => ({
    channel: r.channel as ConsentNow["channel"],
    purpose: r.purpose as ConsentNow["purpose"],
    state: r.state as ConsentNow["state"],
    method: r.method as ConsentNow["method"],
    recorded_at: r.recordedAt.toISOString(),
    recorded_by_name: r.byName ?? r.byEmail ?? null,
  }));
}

export type ContactLookup =
  | { kind: "missing" }
  | { kind: "merged"; into: string }
  | { kind: "contact"; detail: ContactDetail };

/**
 * Everything the contact page shows. `viewer`: the signed-in person; their
 * conversations and Messenger/Instagram identities follow the inbox's one
 * visibility rule (foundation rule 6), and a person without inbox.view gets no
 * conversations at all.
 */
export async function contactDetail(
  db: DbClient,
  viewer: { userId: string; capabilities: readonly Capability[] },
  id: string,
  now: Date,
): Promise<ContactLookup> {
  if (!UUID_RE.test(id)) return { kind: "missing" };
  const [cust] = await db.select().from(customer).where(eq(customer.id, id));
  if (!cust || cust.deletedAt) return { kind: "missing" };
  const [alias] = await db.select({ into: contactAlias.intoCustomerId }).from(contactAlias).where(eq(contactAlias.customerId, id));
  if (alias) return { kind: "merged", into: alias.into };

  let row = await contactRowById(db, id);
  if (!row) {
    // A customer the worker has not summarised yet (created in the last minute).
    await refreshContactSummary(db, [id]);
    row = await contactRowById(db, id);
  }
  if (!row) return { kind: "missing" };

  const [origin] = await db
    .select({
      origin: contactOrigin.origin,
      sourceLabel: contactOrigin.sourceLabel,
      createdAt: contactOrigin.createdAt,
      filename: contactImport.filename,
      byName: adminUser.name,
      byEmail: adminUser.email,
    })
    .from(contactOrigin)
    .leftJoin(contactImport, eq(contactImport.id, contactOrigin.importId))
    .leftJoin(adminUser, eq(adminUser.id, contactOrigin.createdBy))
    .where(eq(contactOrigin.customerId, id));

  const inboxViewer = await loadViewer(db, viewer.userId, viewer.capabilities);
  const canSeeConversations = viewer.capabilities.includes("inbox.view");
  const identities = await identitiesFor(db, inboxViewer, id);
  const conversations = canSeeConversations
    ? await db
        .select({
          id: inboxConversation.id,
          channel: inboxConversation.channel,
          number_label: inboxPhoneNumber.label,
          status: inboxConversation.status,
          last_activity_at: inboxConversation.lastActivityAt,
          labels: inboxConversation.labels,
        })
        .from(inboxConversation)
        .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
        .where(and(eq(inboxConversation.customerId, id), conversationScope(inboxViewer)))
        .orderBy(desc(inboxConversation.lastActivityAt))
        .limit(50)
    : [];

  const orderStats = (await db.execute(sql`
    SELECT s.orders_count, s.spent_ngn, ${iso(sql`s.first_order_at`)} AS first_at, ${iso(sql`s.last_order_at`)} AS last_at,
      nullif(btrim(c.default_address), '') AS saved_address,
      (SELECT so.delivery_address_formatted FROM sale_order so
        WHERE (so.customer_id = c.id OR so.customer_id IN (SELECT a.customer_id FROM contact_alias a WHERE a.into_customer_id = c.id))
          AND so.status NOT IN ('cancelled','failed') AND nullif(btrim(so.delivery_address_formatted), '') IS NOT NULL
        ORDER BY so.created_at_local DESC LIMIT 1) AS last_delivery_address
    FROM contact_summary s JOIN customer c ON c.id = s.customer_id WHERE s.customer_id = ${id}::uuid
  `)) as unknown as {
    orders_count: number;
    spent_ngn: string | number;
    first_at: string | null;
    last_at: string | null;
    saved_address: string | null;
    last_delivery_address: string | null;
  }[];
  const stats = orderStats[0];
  const recent = (await db.execute(sql`
    SELECT so.id, so.order_number, ${iso(sql`so.created_at_local`)} AS created_at, so.total_ngn, so.status::text AS status, so.channel::text AS channel
    FROM sale_order so
    WHERE so.customer_id = ${id}::uuid OR so.customer_id IN (SELECT a.customer_id FROM contact_alias a WHERE a.into_customer_id = ${id}::uuid)
    ORDER BY so.created_at_local DESC LIMIT 5
  `)) as unknown as { id: string; order_number: string; created_at: string; total_ngn: number; status: string; channel: string }[];

  const staticLists = await db
    .select({ id: contactList.id, name: contactList.name })
    .from(contactListMember)
    .innerJoin(contactList, eq(contactList.id, contactListMember.listId))
    .where(and(eq(contactListMember.customerId, id), sql`${contactList.archivedAt} is null`))
    .orderBy(contactList.nameKey);

  const adminBase = (process.env.PUBLIC_ADMIN_URL ?? "").replace(/\/+$/, "");
  const detail: ContactDetail = {
    ...row,
    notes: cust.notes,
    saved_address: stats?.saved_address ?? null,
    last_delivery_address: stats?.last_delivery_address ?? null,
    origin: origin
      ? {
          origin: origin.origin as "manual" | "import",
          source_label: origin.sourceLabel,
          import_filename: origin.filename ?? null,
          created_by_name: origin.byName ?? origin.byEmail ?? null,
          created_at: origin.createdAt.toISOString(),
        }
      : null,
    identities: identities.map((i) => ({ ...i, last_seen_at: i.last_seen_at ? i.last_seen_at.toISOString() : null })),
    orders: {
      count: Number(stats?.orders_count ?? 0),
      spent_ngn: Number(stats?.spent_ngn ?? 0),
      first_at: stats?.first_at ?? null,
      last_at: stats?.last_at ?? null,
      recent: recent.map((o) => ({ ...o, total_ngn: Number(o.total_ngn) })),
    },
    conversations: conversations.map((v) => ({ ...v, last_activity_at: v.last_activity_at.toISOString() })),
    conversation_labels: [...new Set(conversations.flatMap((v) => v.labels ?? []))].sort(),
    can_see_conversations: canSeeConversations,
    lists: [...staticLists.map((l) => ({ ...l, kind: "static" as const })), ...(await smartListsFor(db, id, now))],
    consent_now: await consentNow(db, id),
    shop_profile_url: `${adminBase}/owner/customers/${id}`,
  };
  return { kind: "contact", detail };
}

/** Turn a stored or sent filter into a WHERE fragment, or say why not. */
export function filterWhere(
  input: unknown,
  now: Date,
  o: { forSmartList: boolean } = { forSmartList: false },
): { ok: true; filter: ContactFilter; where: SQL } | { ok: false; error: string } {
  const parsed = parseContactFilter(input, o);
  if (!parsed.ok) return parsed;
  return { ok: true, filter: parsed.filter, where: contactFilterSql(parsed.filter, now) };
}
