import { eq, asc } from "drizzle-orm";
import {
  outboxEvent,
  customer,
  payment,
  saleReturn,
  saleOrder,
  type DbClient,
} from "@ms/db";
import { sendMessage, channels } from "./notifiers/telegram.js";
import { sendEmail } from "./notifiers/email.js";
import { refundPayaza } from "./payments/payaza-refund.js";
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
    case "sale_return.pending_approval":
      return {
        chatIds: [channels.owner()],
        text:
          `↩️ *Return pending review*\n` +
          `${p["return_number"]} · ₦${p["refund_amount_ngn"]}\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/review`,
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

      // Card refund: hit Payaza, flip payment.status to refunded,
      // optionally email the customer the receipt.
      if (ev.eventType === "payment.refund_request") {
        const p = ev.payload as Record<string, string | number | null>;
        const processorReference = p["processor_reference"];
        const amountNgn = p["amount_ngn"];
        const paymentId = p["payment_id"];
        const saleReturnId = p["sale_return_id"];
        if (typeof processorReference === "string" && typeof amountNgn === "number" && typeof paymentId === "string") {
          const refund = await refundPayaza({
            processorReference,
            amountNgn,
          });
          await db
            .update(payment)
            .set({ status: "refunded", processorReference: refund.refund_reference })
            .where(eq(payment.id, paymentId));

          // Email the customer if we know who they are.
          if (typeof saleReturnId === "string") {
            const [ret] = await db.select().from(saleReturn).where(eq(saleReturn.id, saleReturnId));
            if (ret) {
              const [origOrder] = await db
                .select()
                .from(saleOrder)
                .where(eq(saleOrder.id, ret.originalSaleOrderId));
              if (origOrder?.customerId) {
                const [cust] = await db
                  .select()
                  .from(customer)
                  .where(eq(customer.id, origOrder.customerId));
                if (cust?.email) {
                  await sendEmail({
                    to: cust.email,
                    subject: `Refund processed for order ${origOrder.orderNumber}`,
                    text:
                      `Hi ${cust.name ?? "there"},\n\n` +
                      `Your refund of ₦${amountNgn.toLocaleString()} for return ` +
                      `${ret.returnNumber} has been sent to your card. It should ` +
                      `reflect in 1-3 working days.\n\n— Mrs. Samuel Fruit Juice`,
                  });
                }
              }
            }
          }
        }
      }

      // Customer-facing email for paid online orders
      if (ev.eventType === "sale.paid_online") {
        const p = ev.payload as Record<string, string | null>;
        const customerId = p["customer_id"];
        if (customerId) {
          const [cust] = await db.select().from(customer).where(eq(customer.id, customerId));
          if (cust?.email) {
            const trackUrl = `${(process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamueljuice.com").replace("admin.", "www.")}/order/${p["order_number"]}/track`;
            await sendEmail({
              to: cust.email,
              subject: `Order ${p["order_number"]} confirmed — Mrs. Samuel`,
              text:
                `Hi ${cust.name ?? "there"},\n\n` +
                `Thanks for your order. We've received your payment and we're prepping ` +
                `your bottles now.\n\n` +
                `Track your order: ${trackUrl}\n\n` +
                `— Mrs. Samuel Fruit Juice`,
            });
          }
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
