/**
 * contact_summary (suite spec 14, section 5.4): one derived row per live
 * customer who is not an alias, so the Contacts list can sort by spend or last
 * order through an index and page by key. It can be deleted and rebuilt at any
 * time; nothing here ever changes a `customer` row.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbClient, DbExecutor } from "@ms/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;

/** A list of ids as one uuid[] parameter. Anything that is not a uuid is left out. */
export function uuidArray(ids: readonly string[]): SQL {
  const clean = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  return sql`${`{${clean.join(",")}}`}::uuid[]`;
}

/**
 * Recompute the summary rows of these customers, in the caller's transaction
 * when given one. A deleted customer or an alias loses its row; an alias's
 * orders count under the contact it points to. `wa_unreachable_at` is never
 * touched. No-op for [].
 */
export async function refreshContactSummary(db: DbExecutor, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  const ids = uuidArray(customerIds);
  await db.execute(sql`
    INSERT INTO contact_summary AS s (customer_id, name_sort, search_text, phone_digits, has_phone, has_email, has_address, address, address_source,
      channels, orders_count, spent_ngn, first_order_at, last_order_at, last_order_key, last_contact_at, last_contact_key, created_key, refreshed_at)
    SELECT c.id,
      coalesce(nullif(lower(btrim(c.name)), ''), '~'),
      lower(concat_ws(' ', c.name, c.email, i.handles)),
      nullif(regexp_replace(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), '^(234|0)', ''), ''),
      nullif(btrim(coalesce(c.phone, '')), '') IS NOT NULL,
      nullif(btrim(coalesce(c.email, '')), '') IS NOT NULL,
      coalesce(nullif(btrim(c.default_address), ''), o.last_address) IS NOT NULL,
      coalesce(nullif(btrim(c.default_address), ''), o.last_address),
      CASE WHEN nullif(btrim(c.default_address), '') IS NOT NULL THEN 'saved' WHEN o.last_address IS NOT NULL THEN 'last_delivery' END,
      array_remove(ARRAY[CASE WHEN i.wa THEN 'whatsapp' END, CASE WHEN i.ms THEN 'messenger' END, CASE WHEN i.ig THEN 'instagram' END, CASE WHEN k.called THEN 'phone' END], NULL),
      coalesce(o.n, 0), coalesce(o.spent, 0), o.first_at, o.last_at, coalesce(o.last_at, '-infinity'),
      v.last_at, coalesce(v.last_at, '-infinity'), c.created_at, now()
    FROM customer c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, sum(so.total_ngn)::bigint AS spent, min(so.created_at_local) AS first_at, max(so.created_at_local) AS last_at,
        (array_agg(so.delivery_address_formatted ORDER BY so.created_at_local DESC) FILTER (WHERE nullif(btrim(so.delivery_address_formatted), '') IS NOT NULL))[1] AS last_address
      FROM sale_order so
      WHERE so.status NOT IN ('cancelled','failed')
        AND (so.customer_id = c.id OR so.customer_id IN (SELECT a.customer_id FROM contact_alias a WHERE a.into_customer_id = c.id))
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(channel = 'whatsapp') AS wa, bool_or(channel = 'messenger') AS ms, bool_or(channel = 'instagram') AS ig,
        string_agg(concat_ws(' ', username, display_name), ' ') AS handles
      FROM inbox_identity WHERE customer_id = c.id
    ) i ON true
    LEFT JOIN LATERAL (SELECT max(last_activity_at) AS last_at FROM inbox_conversation WHERE customer_id = c.id) v ON true
    LEFT JOIN LATERAL (SELECT true AS called FROM inbox_call WHERE customer_id = c.id LIMIT 1) k ON true
    WHERE c.id = ANY(${ids}) AND c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id)
    ON CONFLICT (customer_id) DO UPDATE SET
      name_sort = excluded.name_sort, search_text = excluded.search_text, phone_digits = excluded.phone_digits, has_phone = excluded.has_phone,
      has_email = excluded.has_email, has_address = excluded.has_address, address = excluded.address, address_source = excluded.address_source,
      channels = excluded.channels, orders_count = excluded.orders_count, spent_ngn = excluded.spent_ngn, first_order_at = excluded.first_order_at,
      last_order_at = excluded.last_order_at, last_order_key = excluded.last_order_key, last_contact_at = excluded.last_contact_at,
      last_contact_key = excluded.last_contact_key, created_key = excluded.created_key, refreshed_at = now()
  `);
  // Only ever removes rows of the derived summary table; the customer rows are untouched.
  await db.execute(sql`
    DELETE FROM contact_summary s USING customer c
    WHERE s.customer_id = ANY(${ids}) AND c.id = s.customer_id
      AND (c.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id))
  `);
}

function isoParam(d: Date): SQL {
  return sql`${d.toISOString()}::timestamptz`;
}

/**
 * Worker, every minute: refresh every customer something changed for since
 * `since` (minus five minutes of overlap, so a slow transaction is not
 * missed). Returns how many customers were refreshed.
 */
export async function refreshChangedSummaries(db: DbClient, since: Date, _now: Date): Promise<number> {
  const from = isoParam(new Date(since.getTime() - 5 * 60_000));
  const rows = (await db.execute(sql`
    SELECT id FROM customer WHERE updated_at >= ${from} OR created_at >= ${from}
    UNION
    SELECT so.customer_id FROM sale_order so WHERE so.updated_at >= ${from} AND so.customer_id IS NOT NULL
    UNION
    SELECT a.into_customer_id FROM sale_order so JOIN contact_alias a ON a.customer_id = so.customer_id WHERE so.updated_at >= ${from}
    UNION
    SELECT customer_id FROM inbox_conversation WHERE last_activity_at >= ${from}
    UNION
    SELECT customer_id FROM inbox_identity WHERE updated_at >= ${from}
    UNION
    SELECT customer_id FROM inbox_call WHERE started_at >= ${from}
    UNION
    SELECT customer_id FROM contact_alias WHERE created_at >= ${from}
    UNION
    SELECT into_customer_id FROM contact_alias WHERE created_at >= ${from}
  `)) as unknown as { id: string }[];
  const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === "string");
  for (let i = 0; i < ids.length; i += BATCH) await refreshContactSummary(db, ids.slice(i, i + BATCH));
  return ids.length;
}

/**
 * Worker, nightly (and once when the watermark is missing): refresh every live
 * customer in batches of 500 ordered by id, then drop summary rows whose
 * customer no longer qualifies. The safety net if a change was missed.
 */
export async function rebuildAllSummaries(db: DbClient): Promise<number> {
  let after = "00000000-0000-0000-0000-000000000000";
  let total = 0;
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT id FROM customer WHERE deleted_at IS NULL AND id > ${after}::uuid ORDER BY id LIMIT ${BATCH}
    `)) as unknown as { id: string }[];
    if (rows.length === 0) break;
    await refreshContactSummary(db, rows.map((r) => r.id));
    total += rows.length;
    after = rows[rows.length - 1]!.id;
    if (rows.length < BATCH) break;
  }
  // Derived rows only: a summary whose customer was deleted or merged away.
  await db.execute(sql`
    DELETE FROM contact_summary s USING customer c
    WHERE c.id = s.customer_id
      AND (c.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM contact_alias a WHERE a.customer_id = c.id))
  `);
  return total;
}
