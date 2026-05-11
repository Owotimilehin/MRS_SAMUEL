import { eq, asc } from "drizzle-orm";
import { outboxEvent, type DbClient } from "@ms/db";
import { sendMessage, channels } from "./notifiers/telegram.js";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "outbox" } });
const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamueljuice.com";

interface FormattedMessage {
  chatIds: (string | undefined)[];
  text: string;
}

/**
 * Map an outbox event onto the channels that care and the message body to
 * send. Returns chatIds: [] when the event type is unknown (or noisy) so
 * the worker can mark it sent without dispatching anything.
 */
function format(event: { eventType: string; payload: Record<string, unknown> }): FormattedMessage {
  const p = event.payload as Record<string, string>;
  switch (event.eventType) {
    case "stock_transfer.dispatched":
      return {
        chatIds: [channels.branchAjao(), channels.owner()],
        text:
          `🚚 *Transfer dispatched*\n` +
          `${p["transfer_number"]}\n` +
          `Factory → Branch\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    case "stock_transfer.arrived":
      return {
        chatIds: [channels.factory()],
        text:
          `📦 *Transfer arrived*\n` +
          `${p["transfer_number"]}\n` +
          `Branch is unloading.\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    case "stock_transfer.variance_review":
      return {
        chatIds: [channels.owner()],
        text:
          `⚠️ *Variance for review*\n` +
          `${p["transfer_number"]}\n` +
          `Please review and approve/dispute.\n` +
          `👉 ${ADMIN_URL}/review`,
      };
    case "stock_transfer.rejected":
      return {
        chatIds: [channels.factory(), channels.owner()],
        text:
          `❌ *Transfer rejected*\n` +
          `${p["transfer_number"]}\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    default:
      return { chatIds: [], text: "" };
  }
}

/**
 * Process a batch of pending outbox rows. Each row is dispatched to all
 * subscribed channels; success marks it sent, failure increments retries
 * and records the error. Caller decides cadence (we just process whatever
 * is pending at call time).
 */
export async function drainOutbox(db: DbClient, batchSize = 50): Promise<number> {
  const pending = await db
    .select()
    .from(outboxEvent)
    .where(eq(outboxEvent.status, "pending"))
    .orderBy(asc(outboxEvent.createdAt))
    .limit(batchSize);

  let processed = 0;
  for (const ev of pending) {
    try {
      const { chatIds, text } = format(ev);
      if (text) {
        for (const chatId of chatIds) {
          if (chatId) await sendMessage(chatId, text);
        }
      }
      await db
        .update(outboxEvent)
        .set({ status: "sent", processedAt: new Date() })
        .where(eq(outboxEvent.id, ev.id));
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, eventId: ev.id, eventType: ev.eventType }, "outbox event failed");
      await db
        .update(outboxEvent)
        .set({
          retries: ev.retries + 1,
          lastError: message,
          status: ev.retries >= 9 ? "failed" : "pending",
        })
        .where(eq(outboxEvent.id, ev.id));
    }
  }
  return processed;
}
