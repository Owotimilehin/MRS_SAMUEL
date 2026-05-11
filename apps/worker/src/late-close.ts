import { sql } from "drizzle-orm";
import { outboxEvent, type DbClient } from "@ms/db";

const LAGOS_TZ_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos = UTC+1, no DST

function lagosNow(): Date {
  return new Date(Date.now() + LAGOS_TZ_OFFSET_MS);
}

/**
 * For each active branch, if there is no daily_close row for today's
 * Africa/Lagos business date, emit a daily_close.late outbox event.
 * The worker is responsible for deduplicating; we use a UNIQUE-ish payload
 * by emitting only when no event for the same branch+date already exists.
 */
export async function checkLateCloses(db: DbClient): Promise<number> {
  const today = lagosNow().toISOString().slice(0, 10);
  const rows = await db.execute<{ branch_id: string; name: string }>(sql`
    SELECT b.id AS branch_id, b.name FROM branch b
    LEFT JOIN daily_close dc ON dc.branch_id = b.id AND dc.business_date = ${today}
    WHERE b.is_active = TRUE AND b.deleted_at IS NULL AND dc.id IS NULL
  `);
  let emitted = 0;
  for (const b of rows) {
    // Dedupe per branch+date by checking the outbox.
    const existing = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM outbox_event
      WHERE event_type = 'daily_close.late'
        AND payload ->> 'branch_id' = ${b.branch_id}
        AND payload ->> 'business_date' = ${today}
    `);
    if (Number(existing[0]?.count ?? 0) > 0) continue;
    await db.insert(outboxEvent).values({
      eventType: "daily_close.late",
      payload: { branch_id: b.branch_id, branch_name: b.name, business_date: today },
    });
    emitted++;
  }
  return emitted;
}

/**
 * Whether the current Africa/Lagos local time falls inside the late-close
 * alert window (23:00–02:00). Outside that window the job is a no-op.
 */
export function isLateCloseWindow(): boolean {
  const h = lagosNow().getUTCHours();
  return h >= 23 || h < 2;
}
