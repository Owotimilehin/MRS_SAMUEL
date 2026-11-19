import { and, eq, gt, sql } from "drizzle-orm";
import { outboxEvent, type DbExecutor } from "@ms/db";

/**
 * Tell the owner once a day per account, not on every webhook or send (suite
 * spec 02, 5.4). Skips when an outbox_event of the same type with the same
 * payload.account exists from the last 24 hours. Each event type needs a case
 * in apps/worker/src/outbox.ts (ruling 9.2.10).
 *
 * The WhatsApp "unknown number" alert keeps its own copy of this pattern in
 * webhooks-whatsapp.ts (its payload key differs; WhatsApp behaviour is unchanged).
 */
export async function alertOnce(
  db: DbExecutor,
  eventType:
    | "inbox.unknown_channel_account"
    | "inbox.meta_config"
    | "inbox.meta_policy"
    | "channels.page_config"
    // Suite spec 13: Meta will not let us read leads. Raised by the worker through alertLeadFetchBlocked in @ms/domain.
    | "lead.fetch_blocked",
  payload: Record<string, unknown> & { account: string },
): Promise<boolean> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, eventType),
        gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
        sql`${outboxEvent.payload}->>'account' = ${payload.account}`,
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(outboxEvent).values({ eventType, payload });
  return true;
}
