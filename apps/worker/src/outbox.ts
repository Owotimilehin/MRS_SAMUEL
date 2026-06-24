import { eq, asc } from "drizzle-orm";
import {
  outboxEvent,
  customer,
  payment,
  saleReturn,
  saleOrder,
  type DbClient,
} from "@ms/db";
import { isOutsideLagos } from "@ms/shared";
import { sendMessage, channels } from "./notifiers/telegram.js";
import { sendEmail } from "./notifiers/email.js";
import { refundPayaza } from "./payments/payaza-refund.js";
import { dispatchDeliveryFromEvent } from "./jobs/dispatch-delivery.js";
import { getWorkerDeliveryProvider } from "./delivery-provider.js";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "outbox" } });
const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamuel.com";

/** Human-friendly delivery time in Lagos, e.g. "Tue 3 Jun, 2:00 PM". */
function lagosTime(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "the scheduled time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the scheduled time";
  return d.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function roleLabel(role: string): string {
  return role.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function varianceLines(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const lines = (raw as Array<{ label?: string; variance?: number; reason?: string | null }>)
    .map((v) => {
      const n = Number(v.variance ?? 0);
      const sign = n > 0 ? "+" : "";
      const reason = v.reason ? ` — ${v.reason}` : "";
      return `• ${v.label ?? "?"}: ${sign}${n}${reason}`;
    })
    .join("\n");
  return `\n${lines}`;
}

function itemLines(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload["items"])
    ? (payload["items"] as Array<Record<string, unknown>>) : [];
  if (!items.length) return "";
  const lines = items.slice(0, 8).map((it) => {
    const qty = Number(it["qty"] ?? 0);
    const name = String(it["name"] ?? "?");
    const size = it["size"] ? ` ${String(it["size"])}` : "";
    const lt = it["line_total_ngn"] != null ? ` — ₦${Number(it["line_total_ngn"]).toLocaleString()}` : "";
    return `• ${qty}× ${name}${size}${lt}`;
  });
  const more = items.length > 8 ? `\n…and ${items.length - 8} more` : "";
  return `\n${lines.join("\n")}${more}`;
}

/**
 * Append the uniform "who · when" footer to a message body. Degrades to the
 * bare body when the event carries no actor (webhook/system events).
 */
export function appendFooter(
  text: string,
  payload: Record<string, unknown>,
  createdAt?: Date | string,
): string {
  if (!text) return text;
  const lines: string[] = [];
  const who: string[] = [];
  if (payload["actor_name"]) who.push(String(payload["actor_name"]));
  if (payload["actor_role"]) who.push(roleLabel(String(payload["actor_role"])));
  if (payload["actor_branch_name"]) who.push(String(payload["actor_branch_name"]));
  if (who.length) lines.push(`👤 ${who.join(" · ")}`);
  if (createdAt) lines.push(`🕒 ${lagosTime(typeof createdAt === "string" ? createdAt : createdAt.toISOString())}`);
  return lines.length ? `${text}\n${lines.join("\n")}` : text;
}

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
export function format(event: { eventType: string; payload: Record<string, unknown> }): FormattedMessage {
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
    case "stock_transfer.count_corrected": {
      // Adjusting "sent" moves the factory ledger; "received" moves the
      // branch ledger. Loop the side that moved into the alert so the
      // people whose count just changed see it too.
      const side = p["side"];
      const sideChannel = side === "sent" ? channels.factory() : channels.branchAjao();
      const delta = Number(p["delta"]);
      const sign = delta > 0 ? "+" : "";
      return {
        chatIds: [owner, sideChannel],
        text:
          `🔧 *Count corrected*\n` +
          `${p["transfer_number"]} · ${side} ${p["old_quantity"]} → ${p["new_quantity"]} (${sign}${delta})\n` +
          `Reason: ${p["reason"]}\n` +
          `👉 ${ADMIN_URL}/transfers/${p["transfer_id"]}`,
      };
    }
    case "stock_adjustment.recorded": {
      // Owner-initiated inventory adjustment. Group of one-or-more product
      // balance corrections. Owner always sees it; factory channel sees it
      // for factory adjustments; branch channel sees it for branch adjustments.
      const items = Array.isArray(event.payload["items"])
        ? (event.payload["items"] as Array<Record<string, unknown>>)
        : [];
      const lines = items
        .slice(0, 5)
        .map((it) => {
          const name = String(it["product_name"] ?? it["product_id"] ?? "?");
          const oldQ = Number(it["old_quantity"] ?? 0);
          const newQ = Number(it["new_quantity"] ?? 0);
          const d = Number(it["delta"] ?? 0);
          const sign = d > 0 ? "+" : "";
          return ` • ${name}  ${oldQ} → ${newQ} (${sign}${d})`;
        })
        .join("\n");
      const more = items.length > 5 ? `\n…and ${items.length - 5} more` : "";
      const note = p["reason_note"] ? `\n_${String(p["reason_note"])}_` : "";
      const sideChannel =
        p["location_type"] === "factory" ? channels.factory() : channels.branchAjao();
      return {
        chatIds: [owner, sideChannel],
        text:
          `📒 *Inventory adjustment*\n` +
          `${p["location_type"]} · ${p["reason_code"]}\n` +
          `${lines}${more}${note}\n` +
          `👉 ${ADMIN_URL}/owner/inventory`,
      };
    }
    case "packaging.purchase_recorded": {
      // Owner records a packaging-material purchase. The factory who needs
      // bottles is the audience along with the owner.
      const lines = [
        `🧴 *Packaging purchase*`,
        p["supplier_name"]
          ? `${p["supplier_name"]} · ₦${Number(p["total_cost_ngn"]).toLocaleString()}`
          : `₦${Number(p["total_cost_ngn"]).toLocaleString()}`,
        `${Number(p["quantity"]).toLocaleString()} × ${p["material_name"]}`,
        `👉 ${ADMIN_URL}/owner/packaging`,
      ];
      return {
        chatIds: [owner],
        text: lines.filter(Boolean).join("\n"),
      };
    }
    case "packaging.stock_adjusted": {
      // Owner manually corrected a packaging on-hand count. Owner always sees
      // it; the side channel for the location that moved sees it too.
      const delta = Number(p["delta"]);
      const sign = delta > 0 ? "+" : "";
      const sideChannel =
        p["location_type"] === "factory" ? channels.factory() : channels.branchAjao();
      const note = p["note"] ? `\n_${String(p["note"])}_` : "";
      return {
        chatIds: [owner, sideChannel],
        text:
          `🔧 *Packaging count corrected*\n` +
          `${p["material_name"]}  ${p["old_count"]} → ${p["new_count"]} (${sign}${delta})\n` +
          `Reason: ${p["reason"]}${note}\n` +
          `👉 ${ADMIN_URL}/owner/packaging`,
      };
    }
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
          `⏰ *Shift-end report overdue*\n` +
          `${p["branch_name"]} hasn't filed for ${p["business_date"]}.\n` +
          `👉 ${ADMIN_URL}/branch/close`,
      };
    case "daily_close.submitted":
      return {
        chatIds: [owner],
        text:
          `📋 *Shift-end report filed*\n` +
          `${p["business_date"]}${p["filed_by"] ? ` · by ${p["filed_by"]}` : ""}\n` +
          `Transfers: ₦${p["transfer_ngn"] ?? "?"} · Variance: ₦${p["variance_ngn"] ?? "0"}` +
          varianceLines(event.payload["variances"]) +
          `\n👉 ${ADMIN_URL}/owner/closes`,
      };
    case "shift_open.submitted":
      return {
        chatIds: [owner],
        text:
          `🌅 *Shift start — opening count filed*\n` +
          `${p["business_date"]}${p["opened_by"] ? ` · by ${p["opened_by"]}` : ""}\n` +
          `Opening variances: ${p["variance_count"] ?? 0}` +
          varianceLines(event.payload["variances"]) +
          `\n👉 ${ADMIN_URL}/branch/shift-start`,
      };
    case "sale.online_placed":
      return {
        chatIds: [owner],
        text:
          `🆕 *New online order*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]}\n` +
          `${p["customer_name"]} · ${p["customer_phone"]}` +
          itemLines(event.payload) +
          `\nWaiting on payment.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "sale.paid_online": {
      const scheduled = p["scheduled_delivery_at"];
      const state = p["delivery_state"];
      const outsideLagos = isOutsideLagos(state);
      if (scheduled || outsideLagos) {
        const reasons: string[] = [];
        if (scheduled) reasons.push(`📅 Scheduled: *${lagosTime(scheduled)}*`);
        if (outsideLagos) reasons.push(`🚚 Outside Lagos: *${state}* (delivery ₦0)`);
        return {
          chatIds: [owner],
          text:
            `💰 *Online order paid — MANUAL FULFILMENT*\n` +
            `${p["order_number"]} · ₦${p["total_ngn"] ?? "?"}\n` +
            `${reasons.join("\n")}\n` +
            `Bolt NOT dispatched — arrange delivery yourself, then mark delivered.\n` +
            `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
        };
      }
      return {
        chatIds: [owner],
        text:
          `💰 *Online order paid*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"] ?? "?"}\n` +
          `Stock decremented; delivery dispatch queued.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    }
    case "sale.branch_sold":
      return {
        chatIds: [owner],
        text:
          `🛒 *Branch sale*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]} · ${p["channel"]}` +
          itemLines(event.payload) +
          `\n👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
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
    case "sale.refund_owed":
      return {
        chatIds: [owner],
        text:
          `💸 *Refund owed*\n` +
          `${p["order_number"]} — ₦${p["refund_owed_ngn"]} to refund in the Payaza dashboard.\n` +
          `Mark it refunded once done.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "production_run.completed":
      return {
        chatIds: [owner, channels.factory()],
        text:
          `🥤 *Production run complete*\n` +
          `${p["run_date"]} · ${p["bottle_count"] ?? "?"} bottles\n` +
          `👉 ${ADMIN_URL}/factory/production-runs/${p["production_run_id"]}`,
      };
    case "contact.message_received":
      return {
        chatIds: [owner],
        text:
          `✉️ *New contact message*\n` +
          `${p["name"]} · ${p["subject"]}\n` +
          `${p["email"]}${p["phone"] ? ` · ${p["phone"]}` : ""}`,
      };
    case "subscription.requested":
      return {
        chatIds: [owner],
        text:
          `🔔 *Subscription enquiry*\n` +
          `${p["name"]} · ${p["phone"]}\n` +
          `Plan: ${p["plan_slug"]}`,
      };
    case "subscription.created":
      return {
        chatIds: [owner],
        text:
          `🆕 *New subscription started*\n` +
          `${p["plan_name"]} · ₦${p["price_ngn"]}/${p["period"]}\n` +
          `Awaiting first payment.`,
      };
    case "subscription.activated":
      return {
        chatIds: [owner],
        text:
          `✅ *Subscription active*\n` +
          `First payment ₦${p["amount_ngn"]} received.\n` +
          `Cycle order queued for fulfilment.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "subscription.charged":
      return {
        chatIds: [owner],
        text:
          `🔁 *Subscription renewed*\n` +
          `₦${p["amount_ngn"]} charged · cycle order queued.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "subscription.payment_failed":
      return {
        chatIds: [owner],
        text:
          `⚠️ *Subscription charge failed*\n` +
          `₦${p["amount_ngn"]} · attempt ${p["attempt"]}\n` +
          `Reason: ${p["reason"] ?? "unknown"} — now past due.`,
      };
    case "subscription.cancelled":
      return {
        chatIds: [owner],
        text:
          `🚫 *Subscription cancelled*\n` +
          `Reason: ${p["reason"] ?? "manual"}.`,
      };
    case "sale.preorder_fulfilled":
      return {
        chatIds: [owner],
        text:
          `🎁 *Preorder fulfilled*\n` +
          `${p["order_number"]} · ${p["channel"] ?? ""}` +
          itemLines(event.payload) +
          `\n👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "sale.preorder_paid":
      return {
        chatIds: [owner],
        text:
          `💰 *Preorder paid*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"] ?? "?"}\n` +
          `Customer has paid; ready to fulfil.\n` +
          `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
      };
    case "audit.logged": {
      // Generic mirror of any audited action that doesn't have a richer,
      // purpose-built event of its own. Renders "<Noun> <verb> — <identifier>
      // (by <Role>)" so the owner sees every change in plain language.
      const VERB: Record<string, string> = {
        create: "created",
        create_draft: "drafted",
        update: "updated",
        update_item: "item edited",
        append_items: "items added",
        delete: "deleted",
        delete_item: "item removed",
        publish: "published",
        invite: "invited",
        reset_password: "password reset",
        approve: "approved",
        confirm: "confirmed",
        hand_over: "handed over",
        mark_delivered: "delivered",
        cancel: "cancelled",
        fulfil: "fulfilled",
      };
      const noun = String(p["entity_noun"] ?? p["entity_type"] ?? "Record");
      const verbKey = String(p["action"] ?? "").split(".")[1] ?? "";
      const verb = VERB[verbKey] ?? verbKey.replace(/_/g, " ") ?? "changed";
      const identifier = p["identifier"] ? ` — ${p["identifier"]}` : "";
      const changes = Array.isArray(event.payload["changes"]) ? (event.payload["changes"] as Array<{ label: string; from: string; to: string }>) : [];
      const changeLines = changes.slice(0, 6).map((c) => `• ${c.label}: ${c.from} → ${c.to}`).join("\n");
      const more = changes.length > 6 ? `\n…and ${changes.length - 6} more` : "";
      const body = `📝 *${noun} ${verb}*${identifier}`
        + (changeLines ? `\n${changeLines}${more}` : "")
        + `\n👉 ${ADMIN_URL}/owner/audit-log`;
      return { chatIds: [owner], text: body };
    }
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
      const { chatIds, text: body } = format(ev);
      const text = appendFooter(body, ev.payload as Record<string, unknown>, ev.createdAt);
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

      // delivery.request: kick off a delivery for a freshly-paid online order.
      // The worker performs the HTTP call so the Payaza webhook stays fast; if
      // it fails the outbox retries with backoff.
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
          const trackUrl = `${(process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamuel.com").replace("admin.", "www.")}/order/${orderNumber}`;
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
            const trackUrl = `${(process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamuel.com").replace("admin.", "www.")}/order/${p["order_number"]}`;
            const scheduled = p["scheduled_delivery_at"];
            const state = p["delivery_state"];
            const outsideLagos = isOutsideLagos(state);
            let middle: string;
            if (outsideLagos) {
              middle =
                `We've received your payment. Since you're in ${state} (outside Lagos), ` +
                `we'll arrange delivery to you and confirm the logistics and any ` +
                `delivery cost separately — we'll be in touch shortly.`;
            } else if (scheduled) {
              middle =
                `We've received your payment. You asked us to deliver around ` +
                `${lagosTime(scheduled)}, so we'll prepare your bottles fresh and ` +
                `bring them to you then.`;
            } else {
              middle =
                `We've received your payment and we're prepping your bottles now.`;
            }
            await sendEmail({
              to: cust.email,
              subject: `Order ${p["order_number"]} confirmed — Mrs. Samuel`,
              text:
                `Hi ${cust.name ?? "there"},\n\n` +
                `Thanks for your order. ${middle}\n\n` +
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
