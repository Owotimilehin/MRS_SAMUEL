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
import { dispatchDeliveryFromEvent } from "./jobs/dispatch-delivery.js";
import { getWorkerDeliveryProvider } from "./delivery-provider.js";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "outbox" } });
const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamueljuice.com";

interface FormattedMessage {
  chatIds: (string | undefined)[];
  text: string;
}

/**
 * Map an outbox event onto the channels that care and the message body to
 * send. The owner channel is wired into EVERY event so the owner sees
 * everything that happens in the app. Other channels (branch, factory) are
 * still included where they're directly relevant.
 *
 * Returns chatIds: [] only for events that are processed inline elsewhere
 * (refund requests, delivery requests, payment reminders) so the worker
 * marks them sent without double-dispatching.
 */
function format(event: { eventType: string; payload: Record<string, unknown> }): FormattedMessage {
  const p = event.payload as Record<string, string>;
  const owner = channels.owner();
  switch (event.eventType) {
    case "stock_transfer.dispatched":
      return {
        chatIds: [channels.branchAjao(), owner],
        text:
          `🚚 *Transfer dispatched*\n` +
          `${p["transfer_number"]}\n` +
          `Factory → Branch\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    case "stock_transfer.arrived":
      return {
        chatIds: [channels.factory(), owner],
        text:
          `📦 *Transfer arrived*\n` +
          `${p["transfer_number"]}\n` +
          `Branch is unloading.\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    case "stock_transfer.variance_review":
      return {
        chatIds: [owner],
        text:
          `⚠️ *Variance for review*\n` +
          `${p["transfer_number"]}\n` +
          `Please review and approve/dispute.\n` +
          `👉 ${ADMIN_URL}/review`,
      };
    case "stock_transfer.rejected":
      return {
        chatIds: [channels.factory(), owner],
        text:
          `❌ *Transfer rejected*\n` +
          `${p["transfer_number"]}\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    case "sale_return.pending_approval":
      return {
        chatIds: [owner],
        text:
          `↩️ *Return pending review*\n` +
          `${p["return_number"]} · ₦${p["refund_amount_ngn"]}\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/review`,
      };
    case "daily_close.late":
      return {
        chatIds: [owner, channels.branchAjao()],
        text:
          `⏰ *Daily close overdue*\n` +
          `${p["branch_name"]} hasn't filed for ${p["business_date"]}.\n` +
          `👉 ${ADMIN_URL}/branch/close`,
      };
    case "daily_close.submitted":
      return {
        chatIds: [owner],
        text:
          `📋 *Daily close filed*\n` +
          `${p["business_date"]}\n` +
          `Cash: ₦${p["cash_ngn"] ?? "?"} · Transfers: ₦${p["transfer_ngn"] ?? "?"} · Variance: ₦${p["variance_ngn"] ?? "0"}\n` +
          `👉 ${ADMIN_URL}/owner/closes`,
      };
    case "sale.online_placed":
      return {
        chatIds: [owner],
        text:
          `🆕 *New online order*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]}\n` +
          `${p["customer_name"]} · ${p["customer_phone"]}\n` +
          `Waiting on payment.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "sale.paid_online":
      return {
        chatIds: [owner],
        text:
          `💰 *Online order paid*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"] ?? "?"}\n` +
          `Stock decremented; delivery dispatch queued.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "sale.branch_sold":
      return {
        chatIds: [owner],
        text:
          `🛒 *Branch sale*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]} · ${p["channel"]}\n` +
          `👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
      };
    case "payment.refund_request":
      return {
        chatIds: [owner],
        text:
          `💸 *Refund initiated*\n` +
          `Return ${p["return_number"] ?? "?"} · ₦${p["amount_ngn"]}\n` +
          `Calling Payaza now.`,
      };
    case "sale.payment_reminder":
      // Email reminder handled inline; ping owner so they know one was sent.
      return {
        chatIds: [owner],
        text:
          `⏳ *Payment reminder sent*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]}\n` +
          `Customer hasn't paid yet; reservation will sweep if they don't.`,
      };
    case "delivery.request":
      // Handled inline below — calls Bolt + persists delivery_order.
      return { chatIds: [], text: "" };
    case "delivery.completed":
      return {
        chatIds: [owner],
        text:
          `✅ *Delivered*\n` +
          `${p["order_number"]} — customer received their order.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "delivery.failed":
      return {
        chatIds: [channels.branchAjao(), owner],
        text:
          `❌ *Delivery failed*\n` +
          `${p["order_number"]}\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
      };
    case "delivery.no_rider":
      return {
        chatIds: [channels.branchAjao(), owner],
        text:
          `⏰ *No Bolt rider found*\n` +
          `${p["order_number"]} — customer is waiting.\n` +
          `Dispatch manually via WhatsApp.\n` +
          `👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
      };
    case "sale.amount_mismatch":
      return {
        chatIds: [owner],
        text:
          `🚨 *Payment amount mismatch*\n` +
          `${p["order_number"]} expected ₦${p["expected_ngn"]} but Payaza reported ₦${p["reported_ngn"]}.\n` +
          `Order parked for reconciliation.\n` +
          `👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
      };
    case "production_run.completed":
      return {
        chatIds: [owner, channels.factory()],
        text:
          `🥤 *Production run complete*\n` +
          `${p["run_date"]} · ${p["bottle_count"] ?? "?"} bottles\n` +
          `👉 ${ADMIN_URL}/factory/production-runs/${p["production_run_id"]}`,
      };
    default:
      // Unknown event — tell the owner so we never silently drop something new.
      return {
        chatIds: [owner],
        text: `ℹ️ *${event.eventType}*\n${JSON.stringify(event.payload).slice(0, 240)}`,
      };
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

      // delivery.request: kick off a Bolt delivery for a freshly-paid online
      // order. The worker performs the HTTP call so the Payaza webhook stays
      // fast; if it fails the outbox retries with backoff.
      if (ev.eventType === "delivery.request") {
        await dispatchDeliveryFromEvent(
          db,
          getWorkerDeliveryProvider(),
          ev.payload as Record<string, unknown>,
        );
      }

      // Payment reminder for online orders that have been confirmed but
      // unpaid for ~15 minutes. Fire-and-forget email; reservation will
      // expire on its own if they still don't return.
      if (ev.eventType === "sale.payment_reminder") {
        const p = ev.payload as Record<string, string | number | null>;
        const email = p["customer_email"];
        if (typeof email === "string" && email.length > 0) {
          const name = typeof p["customer_name"] === "string" ? p["customer_name"] : "there";
          const total = typeof p["total_ngn"] === "number" ? p["total_ngn"] : 0;
          const orderNumber = p["order_number"];
          const trackUrl = `${(process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamueljuice.com").replace("admin.", "www.")}/order/${orderNumber}`;
          await sendEmail({
            to: email,
            subject: `Your Mrs. Samuel order ${orderNumber} is waiting on payment`,
            text:
              `Hi ${name},\n\n` +
              `We're still holding your bottles — your order of ₦${total.toLocaleString()} ` +
              `hasn't been paid yet. If you'd like to complete it, you can finish ` +
              `checkout via: ${trackUrl}\n\n` +
              `If you've changed your mind, no worries — your reservation will ` +
              `release on its own shortly.\n\n— Mrs. Samuel Fruit Juice`,
          });
        }
      }

      // Customer-facing email for paid online orders
      if (ev.eventType === "sale.paid_online") {
        const p = ev.payload as Record<string, string | null>;
        const customerId = p["customer_id"];
        if (customerId) {
          const [cust] = await db.select().from(customer).where(eq(customer.id, customerId));
          if (cust?.email) {
            const trackUrl = `${(process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamueljuice.com").replace("admin.", "www.")}/order/${p["order_number"]}`;
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
      const isFinalFailure = ev.retries >= 9;
      await db
        .update(outboxEvent)
        .set({
          retries: ev.retries + 1,
          lastError: message,
          status: isFinalFailure ? "failed" : "pending",
        })
        .where(eq(outboxEvent.id, ev.id));
      // Final-failure alert: surface to the owner so dead events don't rot
      // silently. Best-effort — if the Telegram channel itself is the thing
      // that's broken, the log line above is the breadcrumb.
      if (isFinalFailure) {
        try {
          const ownerChat = channels.owner();
          if (ownerChat) {
            await sendMessage(
              ownerChat,
              `☠️ *Outbox event dead-lettered*\n` +
                `Type: \`${ev.eventType}\`\n` +
                `Id: \`${ev.id}\`\n` +
                `Last error: ${message}`,
            );
          }
        } catch {
          /* swallow — already logged */
        }
      }
    }
  }
  return processed;
}
