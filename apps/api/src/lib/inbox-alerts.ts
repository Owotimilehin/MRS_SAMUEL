import { and, eq, gt, sql } from "drizzle-orm";
import { outboxEvent, type DbExecutor } from "@ms/db";

/**
 * Tell the owner once a day per account, not on every webhook or send (suite
 * spec 02, 5.4). Skips when an outbox_event of the same type with the same
 * payload.account exists from the last 24 hours. Each event type needs a case
 * in apps/worker/src/outbox.ts (ruling 9.2.10).
 *
 * "inbox.template_alert" (suite spec 06) is written by packages/domain (it is raised inside the webhook
 * transaction and by the worker) with payload.account = "<template id>:<kind>", so it dedupes the same way.
 *
 * "inbox.flow_complaint" (suite spec 07) is written by packages/domain inside the webhook transaction, once
 * per completed complaint form, with payload.account = "flow_complaint:<response id>".
 *
 * "inbox.flow_health" (suite spec 07) is written by packages/domain inside the webhook transaction, with
 * payload.account = "<Meta flow id>:<kind>", so it dedupes the same way.
 *
 * "social.comments_config" (suite spec 03) is written by raiseCommentsConfigAlert in packages/domain (the worker
 * raises it too) with payload.account = the account row ID, so it dedupes the same way.
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
    | "inbox.template_alert"
    | "inbox.flow_complaint"
    | "inbox.flow_health"
    | "social.comments_config"
    // Raised by the catalogue sync in the worker (raiseCatalogueAlert in @ms/domain) with the same once-a-day rule.
    | "catalogue.sync_blocked",
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
