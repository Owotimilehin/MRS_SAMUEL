/**
 * Broadcast results that a customer's own message sets (suite spec 14, rules R60, R61).
 * A leaf module (database only) so the consent code and WhatsApp ingest can both call it
 * without importing the broadcast engine.
 */
import { eq, sql } from "drizzle-orm";
import { contactAlias, type DbExecutor } from "@ms/db";

/** A reply or a STOP counts for a broadcast message sent this recently. */
export const BROADCAST_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function contactIdsFor(db: DbExecutor, customerId: string): Promise<string[]> {
  const [alias] = await db.select({ into: contactAlias.intoCustomerId }).from(contactAlias).where(eq(contactAlias.customerId, customerId));
  return alias?.into && alias.into !== customerId ? [customerId, alias.into] : [customerId];
}

function idList(ids: string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}

/**
 * R60: an inbound WhatsApp message from a customer sets `replied_at` on their newest
 * broadcast row sent in the last 7 days that has no reply yet. The message itself is
 * an ordinary inbound message; nothing else changes.
 */
export async function markBroadcastReply(db: DbExecutor, customerId: string, at: Date): Promise<void> {
  const ids = await contactIdsFor(db, customerId);
  const since = new Date(at.getTime() - BROADCAST_REPLY_WINDOW_MS);
  await db.execute(sql`
    UPDATE broadcast_recipient SET replied_at = ${at.toISOString()}::timestamptz
    WHERE id = (
      SELECT r.id FROM broadcast_recipient r
      WHERE r.customer_id = ANY(${idList(ids)}) AND r.sent_at IS NOT NULL
        AND r.sent_at >= ${since.toISOString()}::timestamptz AND r.sent_at <= ${at.toISOString()}::timestamptz
        AND r.replied_at IS NULL
      ORDER BY r.sent_at DESC LIMIT 1
    )`);
}

/**
 * R61: a withdrawal (a STOP, or "stop" in WhatsApp's own settings) sets `opted_out_at`
 * on the newest broadcast row sent to them in the last 7 days, so the results page can
 * say how many asked to stop after a broadcast.
 */
export async function markBroadcastOptOut(db: DbExecutor, customerId: string, at: Date): Promise<void> {
  const ids = await contactIdsFor(db, customerId);
  const since = new Date(at.getTime() - BROADCAST_REPLY_WINDOW_MS);
  await db.execute(sql`
    UPDATE broadcast_recipient SET opted_out_at = ${at.toISOString()}::timestamptz
    WHERE id = (
      SELECT r.id FROM broadcast_recipient r
      WHERE r.customer_id = ANY(${idList(ids)}) AND r.sent_at IS NOT NULL
        AND r.sent_at >= ${since.toISOString()}::timestamptz AND r.sent_at <= ${at.toISOString()}::timestamptz
        AND r.opted_out_at IS NULL
      ORDER BY r.sent_at DESC LIMIT 1
    )`);
}
