/**
 * The only place a ContactFilter becomes SQL (suite spec 14, rules R3, R4, R23).
 * Every fragment is written against `contact_summary` aliased "s" and
 * `customer` aliased "c":  FROM contact_summary s JOIN customer c ON c.id = s.customer_id
 */
import { sql, type SQL } from "drizzle-orm";
import { CUSTOMER_SOURCES, contactPhoneDigits, type ContactFilter } from "@ms/shared";
import { uuidArray } from "./summary.js";

/** Escape a user's text for a LIKE pattern and wrap it in %…% (as likeTerm in the inbox routes). */
function likeTerm(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}

function daysAgo(now: Date, days: number): SQL {
  return sql`${new Date(now.getTime() - days * 86_400_000).toISOString()}::timestamptz`;
}

const CURRENT_WA_MARKETING = sql`k.customer_id = s.customer_id AND k.is_current AND k.channel = 'whatsapp' AND k.purpose = 'marketing'`;

/**
 * A WHERE fragment (all parts joined with AND; `true` for an empty filter).
 * The filter must already have passed parseContactFilter. A `list_id` is
 * matched against contact_list_member only: the caller checks it names a
 * static list.
 */
export function contactFilterSql(f: ContactFilter, now: Date): SQL {
  const parts: SQL[] = [];

  if (f.q) {
    const q = f.q.trim();
    const matches: SQL[] = [sql`s.search_text LIKE ${likeTerm(q.replace(/^@/, "").toLowerCase())}`];
    const d = contactPhoneDigits(q);
    if (d.length >= 4) matches.push(sql`s.phone_digits LIKE ${`%${d}%`}`);
    parts.push(sql`(${sql.join(matches, sql` OR `)})`);
  }
  if (f.channels?.length) parts.push(sql`s.channels && ${textArray(f.channels)}`);
  if (f.has_phone !== undefined) parts.push(f.has_phone ? sql`s.has_phone` : sql`NOT s.has_phone`);
  if (f.has_email !== undefined) parts.push(f.has_email ? sql`s.has_email` : sql`NOT s.has_email`);
  if (f.has_address !== undefined) parts.push(f.has_address ? sql`s.has_address` : sql`NOT s.has_address`);
  if (f.ordered_within_days !== undefined) parts.push(sql`s.last_order_key >= ${daysAgo(now, f.ordered_within_days)}`);
  if (f.never_ordered) parts.push(sql`s.orders_count = 0`);
  if (f.min_spent_ngn !== undefined) parts.push(sql`s.spent_ngn >= ${f.min_spent_ngn}`);
  if (f.min_orders !== undefined) parts.push(sql`s.orders_count >= ${f.min_orders}`);
  if (f.last_contact_within_days !== undefined) parts.push(sql`s.last_contact_key >= ${daysAgo(now, f.last_contact_within_days)}`);
  if (f.label_ids?.length) {
    parts.push(sql`EXISTS (SELECT 1 FROM contact_label_member lm WHERE lm.customer_id = s.customer_id AND lm.label_id = ANY(${uuidArray(f.label_ids)}))`);
  }
  if (f.sources?.length) {
    const shop = f.sources.filter((x) => (CUSTOMER_SOURCES as readonly string[]).includes(x));
    const origins = f.sources.filter((x) => x === "manual" || x === "import");
    const any: SQL[] = [];
    if (shop.length) any.push(sql`c.source::text = ANY(${textArray(shop)})`);
    if (origins.length) {
      any.push(sql`EXISTS (SELECT 1 FROM contact_origin og WHERE og.customer_id = s.customer_id AND og.origin = ANY(${textArray(origins)}))`);
    }
    if (any.length) parts.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  if (f.consent === "agreed") {
    parts.push(sql`EXISTS (SELECT 1 FROM contact_consent k WHERE ${CURRENT_WA_MARKETING} AND k.state = 'granted')`);
  } else if (f.consent === "stopped") {
    parts.push(sql`EXISTS (SELECT 1 FROM contact_consent k WHERE ${CURRENT_WA_MARKETING} AND k.state = 'withdrawn')`);
  } else if (f.consent === "not_asked") {
    parts.push(sql`NOT EXISTS (SELECT 1 FROM contact_consent k WHERE ${CURRENT_WA_MARKETING})`);
  }
  if (f.list_id) {
    parts.push(sql`EXISTS (SELECT 1 FROM contact_list_member lsm WHERE lsm.customer_id = s.customer_id AND lsm.list_id = ${f.list_id}::uuid)`);
  }

  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}

/**
 * The customer ids of a list, as a sub-select (rule R23). A static list: its
 * members that still have a summary row. A smart list: whoever matches its
 * filter at this moment; nothing is stored.
 */
export function listMembersSql(
  list: { id: string; kind: "static" | "smart"; filter: ContactFilter | null },
  now: Date,
): SQL {
  if (list.kind === "smart") {
    return sql`SELECT s.customer_id FROM contact_summary s JOIN customer c ON c.id = s.customer_id WHERE ${contactFilterSql(list.filter ?? {}, now)}`;
  }
  return sql`SELECT s.customer_id FROM contact_list_member lmm JOIN contact_summary s ON s.customer_id = lmm.customer_id WHERE lmm.list_id = ${list.id}::uuid`;
}
