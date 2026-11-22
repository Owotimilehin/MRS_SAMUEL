/**
 * Chat orders (suite spec 08, sections 5.5 and 5.6): the cart a customer sent
 * from WhatsApp, beside the chat. Mounted at /v1/inbox/chat-orders.
 *
 * A cart is only a request. A named staff member turns it into a normal shop
 * order with one click (POST /:id/place), after seeing the cart at the shop's
 * own prices and the exact message the customer will get; the click is written
 * to the audit log (foundation rule 7). The order is created by the same
 * placeOnlineOrder the storefront uses, so prices and stock follow the shop's
 * rules at that moment; nothing from Meta or the customer's cart is trusted
 * for money (rule R28).
 *
 * Never two orders from one cart: the cart row is locked, and its
 * idempotency_key is the order's (unique on both tables). Never two payment
 * links from one click: payment_link_sent_at is claimed before OPay is called
 * and released only when the message certainly did not go.
 *
 * Every route loads the cart, then the conversation through visibleConversation,
 * so the one visibility rule applies (404 otherwise).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { catalogueChatOrder, customer, inboxConversation, inboxPhoneNumber, saleOrder, type DbClient } from "@ms/db";
import {
  InboxSendError,
  askClaimAfter,
  askOutcomeOf,
  backfillChatCart,
  claimAsk,
  releaseAsk,
  buildPayButton,
  canUseNumber,
  cartTextLines,
  fulfilmentQuestionFor,
  metaConfigFromEnv,
  onlineBranch,
  orderTemplateApproved,
  orderTextLines,
  priceChatCart,
  publishInboxEvent,
  sellableVariant,
  sendFromConversation,
  signalFor,
  type OutboundContent,
  type PricedLine,
  type SentMessage,
} from "@ms/domain";
import {
  cartSubtotalNgn,
  greetingName,
  orderUpdateParams,
  paymentMessageBody,
  paymentMessagePreview,
  toE164,
  type ChatOrderFulfilment,
} from "@ms/shared";
import { requireAuth } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { placeOnlineOrder } from "../lib/online-order.js";
import { createCheckout, getActiveProvider } from "../payments/provider.js";
import { logger } from "../logger.js";
import { Sentry } from "../sentry.js";
import { need, visibleConversation, withViewer } from "./inbox.js";

type ChatOrderRow = typeof catalogueChatOrder.$inferSelect;
type OrderRow = typeof saleOrder.$inferSelect;
type ConversationRow = typeof inboxConversation.$inferSelect;

const NO_BRANCH = "No branch is set to take online orders. Ask the owner to choose one in the shop admin.";
const NO_PHONE = "This customer has no usable phone number.";
const NOT_SELLABLE = "One of these juices can no longer be ordered. Remove it and try again.";
const OPAY_WARNING = "The order was created but OPay did not give a payment link. Press “Send payment link” to try again.";
/** A second "Send payment link" inside this time is treated as a double click. */
const RESEND_GAP_MS = 30_000;

const PlaceBody = z
  .object({
    fulfilment: z.enum(["delivery", "pickup"]),
    address: z.string().trim().min(10).max(500).optional(),
    delivery_fee_ngn: z.number().int().min(0).max(100_000),
    items: z.array(z.object({ variant_id: z.string().uuid(), quantity: z.number().int().min(1).max(99) })).min(1).max(50),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.fulfilment === "delivery" && !b.address) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["address"], message: "Enter the full address: house number, street, area and city." });
    }
    if (b.fulfilment === "pickup" && b.delivery_fee_ngn !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery_fee_ngn"], message: "There is no delivery fee on a pickup order." });
    }
  });

function lineJson(l: PricedLine) {
  return {
    retailer_id: l.retailerId,
    variant_id: l.variantId,
    name: l.name,
    size_ml: l.sizeMl,
    quantity: l.quantity,
    shop_price_ngn: l.shopPriceNgn,
    line_total_ngn: l.lineTotalNgn,
    meta_price: l.metaPrice,
    price_differs: l.priceDiffers,
    sellable: l.sellable,
    in_stock: l.inStock,
  };
}

function adminUrl(orderId: string): string {
  return `${(process.env.PUBLIC_ADMIN_URL ?? "").replace(/\/+$/, "")}/owner/orders/${orderId}`;
}

/** Turn a refused send into the same answers the message route gives (409 window_closed and the rest). */
function sendRefusal(err: InboxSendError): BusinessError {
  const status = err.code === "not_configured" ? 503 : 409;
  return new BusinessError(status === 503 ? "service_unavailable" : "conflict", err.message, status, { reason: err.code });
}

export function chatOrderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", withViewer(db));

  /** The cart and its conversation, or 404: for an unknown id and for a chat the viewer may not see alike. */
  async function load(c: Context, id: string): Promise<{ row: ChatOrderRow; conv: ConversationRow }> {
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "cart not found", 404);
    const [row] = await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, id));
    if (!row) throw new BusinessError("not_found", "cart not found", 404);
    const conv = await visibleConversation(db, c, row.conversationId);
    return { row, conv };
  }

  function needNumber(c: Context, conv: ConversationRow): void {
    if (!canUseNumber(c.get("inboxViewer"), conv.phoneNumberId)) {
      throw new BusinessError("forbidden", "You can't reply from this number", 403);
    }
  }

  async function audit(c: Context, action: string, row: ChatOrderRow, after?: unknown): Promise<void> {
    await writeAudit(db, c, { action, entityType: "catalogue_chat_order", entityId: row.id, after, notify: false });
  }

  r.get("/", async (c) => {
    need(c, "inbox.view");
    const conv = await visibleConversation(db, c, c.req.query("conversation_id") ?? "");
    // A cart whose row was not written when the message arrived is recorded now.
    await backfillChatCart(db, conv).catch((err: unknown) => logger.warn({ err, conversationId: conv.id }, "chat orders: backfill failed"));
    const rows = await db
      .select()
      .from(catalogueChatOrder)
      .where(eq(catalogueChatOrder.conversationId, conv.id))
      .orderBy(desc(catalogueChatOrder.createdAt))
      .limit(10);
    const branch = await onlineBranch(db);
    const [cust] = await db.select({ address: customer.defaultAddress }).from(customer).where(eq(customer.id, conv.customerId));
    const data = [];
    for (const row of rows) {
      const lines = await priceChatCart(db, row.cart, branch?.id ?? null);
      const [order] = row.saleOrderId ? await db.select().from(saleOrder).where(eq(saleOrder.id, row.saleOrderId)) : [];
      data.push({
        id: row.id,
        state: row.state,
        created_at: row.createdAt,
        cart_note: row.cartNote,
        fulfilment: row.fulfilment,
        address: row.address,
        problem: row.problem,
        payment_link_sent_at: row.paymentLinkSentAt,
        lines: lines.map(lineJson),
        subtotal_ngn: cartSubtotalNgn(cartTextLines(lines)),
        order: order
          ? {
              id: order.id,
              order_number: order.orderNumber,
              status: order.status,
              payment_status: order.paymentStatus,
              total_ngn: order.totalNgn,
              delivery_fee_ngn: order.deliveryFeeNgn,
              is_preorder: order.isPreorder,
              admin_url: adminUrl(order.id),
            }
          : null,
      });
    }
    return c.json({
      data,
      online_branch: branch ? { id: branch.id, name: branch.name } : null,
      default_address: cust?.address ?? null,
    });
  });

  /**
   * Ask "delivery or pickup?" with two reply buttons (rule R24). A person clicks; the question is sent once.
   * It takes the same ask claim (ask_claimed_at) as the worker's automatic question, so the customer gets
   * it at most once per cart even when both happen at the same moment. The claim is given back only when
   * the question certainly did not go.
   */
  r.post("/:id/ask", async (c) => {
    need(c, "inbox.reply");
    const { row, conv } = await load(c, c.req.param("id"));
    needNumber(c, conv);
    if (row.state !== "new" && row.state !== "asked") {
      throw new BusinessError("conflict", "This cart is past the delivery-or-pickup question.", 409, { reason: "wrong_state" });
    }
    const content = await fulfilmentQuestionFor(db, row);
    const claimedAt = await claimAsk(db, row.id);
    if (!claimedAt) {
      throw new BusinessError("conflict", "The delivery-or-pickup question has already been sent for this cart.", 409, {
        reason: "already_asked",
      });
    }
    let msg: SentMessage;
    try {
      msg = await sendFromConversation(db, metaConfigFromEnv(), {
        conversationId: conv.id,
        userId: c.get("inboxViewer").userId,
        content,
      });
    } catch (err) {
      // An InboxSendError is raised before anything is sent; anything else may have gone, so the claim stays.
      if (err instanceof InboxSendError) {
        if (askClaimAfter("not_sent") === "release") await releaseAsk(db, row.id, claimedAt);
        throw sendRefusal(err);
      }
      throw err;
    }
    if (askClaimAfter(askOutcomeOf(msg)) === "release") await releaseAsk(db, row.id, claimedAt);
    if (msg.status !== "failed") {
      await db
        .update(catalogueChatOrder)
        .set({ state: "asked", nextPrompt: null, problem: null, updatedAt: new Date() })
        // The customer may already have tapped a button; never move the cart back.
        .where(and(eq(catalogueChatOrder.id, row.id), or(eq(catalogueChatOrder.state, "new"), eq(catalogueChatOrder.state, "asked"))));
      await publishInboxEvent(db, signalFor("conversation.updated", conv));
    }
    await audit(c, "chat_order.ask", row, { conversation_id: conv.id, message_id: msg.id, status: msg.status });
    return c.json({ data: { message_id: msg.id, status: msg.status, error: msg.errorMessage } }, msg.status === "failed" ? 502 : 200);
  });

  /**
   * Send the payment message for an order (rule R27), at most once per claim.
   * `payment_link_sent_at` is taken first; it is given back only when the link
   * could not be made or the message certainly did not go.
   */
  async function deliverPaymentLink(
    c: Context,
    a: {
      row: ChatOrderRow;
      order: OrderRow;
      conv: ConversationRow;
      cust: { name: string | null; email: string | null };
      phone: string;
      branchName: string | null;
      /** Refuse a claim made less than this long ago (a double click). 0 = only when never sent. */
      minGapMs: number;
    },
  ): Promise<{ claimed: boolean; link: string | null; warning: string | null; messageId: string | null }> {
    const [claimed] = await db
      .update(catalogueChatOrder)
      .set({ paymentLinkSentAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(catalogueChatOrder.id, a.row.id),
          a.minGapMs > 0
            ? or(isNull(catalogueChatOrder.paymentLinkSentAt), lt(catalogueChatOrder.paymentLinkSentAt, new Date(Date.now() - a.minGapMs)))
            : isNull(catalogueChatOrder.paymentLinkSentAt),
        ),
      )
      .returning({ id: catalogueChatOrder.id });
    if (!claimed) return { claimed: false, link: null, warning: null, messageId: null };
    const release = async (problem: string): Promise<void> => {
      await db
        .update(catalogueChatOrder)
        .set({ paymentLinkSentAt: a.row.paymentLinkSentAt, problem: problem.slice(0, 500) })
        .where(eq(catalogueChatOrder.id, a.row.id));
    };

    // The same call, with the same placeholder email, the storefront makes.
    let link: string;
    try {
      const handoff = await createCheckout(db, {
        provider: "opay",
        amountNgn: a.order.totalNgn,
        reference: a.order.orderNumber,
        email: a.cust.email ?? "no-email@example.com",
        customerName: a.cust.name ?? "WhatsApp customer",
        customerPhone: a.phone,
      });
      link = handoff.redirectUrl;
    } catch (err) {
      logger.error({ err, orderNumber: a.order.orderNumber }, "chat order: opay session could not be created; order kept without a payment link");
      Sentry.captureException(err, { extra: { orderNumber: a.order.orderNumber } });
      await release(OPAY_WARNING);
      return { claimed: true, link: null, warning: OPAY_WARNING, messageId: null };
    }

    const fulfilment: ChatOrderFulfilment = a.row.fulfilment === "pickup" ? "pickup" : "delivery";
    const body = paymentMessageBody({
      orderNumber: a.order.orderNumber,
      lines: await orderTextLines(db, a.order.id),
      fulfilment,
      deliveryFeeNgn: a.order.deliveryFeeNgn,
      branchName: a.branchName,
      totalNgn: a.order.totalNgn,
    });
    const cfg = metaConfigFromEnv();
    const userId = c.get("inboxViewer").userId;
    const notSent = (reason: string): string => `The order was created but the message could not be sent: ${reason.replace(/\.+$/, "")}.`;
    let msg: SentMessage;
    try {
      const content: OutboundContent = {
        type: "interactive",
        interactive: buildPayButton(body, link),
        preview: paymentMessagePreview(a.order.orderNumber, a.order.totalNgn),
      };
      msg = await sendFromConversation(db, cfg, { conversationId: a.conv.id, userId, content });
    } catch (err) {
      if (!(err instanceof InboxSendError)) {
        await release("The payment message could not be sent.");
        throw err;
      }
      // Outside the 24-hour window only an approved template may go (rule R30).
      const language = process.env.INBOX_TEMPLATE_LANGUAGE || "en";
      const [line] = await db.select({ wabaId: inboxPhoneNumber.wabaId }).from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, a.conv.phoneNumberId));
      if (err.code !== "window_closed" || !(await orderTemplateApproved(db, line?.wabaId ?? null, "order_confirmed", language))) {
        await release(err.message);
        return { claimed: true, link, warning: notSent(err.message), messageId: null };
      }
      try {
        msg = await sendFromConversation(db, cfg, {
          conversationId: a.conv.id,
          userId,
          content: {
            type: "template",
            name: "order_confirmed",
            language,
            bodyParams: orderUpdateParams("order_confirmed", {
              firstName: greetingName(a.cust.name),
              orderNumber: a.order.orderNumber,
              totalNgn: a.order.totalNgn,
              paymentLink: link,
            }),
          },
        });
      } catch (err2) {
        if (!(err2 instanceof InboxSendError)) {
          await release("The payment message could not be sent.");
          throw err2;
        }
        await release(err2.message);
        return { claimed: true, link, warning: notSent(err2.message), messageId: null };
      }
    }
    if (msg.status === "failed") {
      const reason = msg.errorMessage ?? "WhatsApp refused it";
      if ((msg.payload as { unconfirmed?: boolean } | null)?.unconfirmed === true) {
        // No answer from Meta: it may have arrived. The claim stays, so it is not sent again by a retry.
        const text = "WhatsApp did not answer, so the payment message may or may not have been sent. Check the chat before sending the link again.";
        await db.update(catalogueChatOrder).set({ problem: text }).where(eq(catalogueChatOrder.id, a.row.id));
        return { claimed: true, link, warning: text, messageId: msg.id };
      }
      await release(reason);
      return { claimed: true, link, warning: notSent(reason), messageId: msg.id };
    }
    await db.update(catalogueChatOrder).set({ problem: null }).where(eq(catalogueChatOrder.id, a.row.id));
    return { claimed: true, link, warning: null, messageId: msg.id };
  }

  /** Section 5.6: one click turns the cart into a normal shop order and sends the OPay link. */
  r.post("/:id/place", async (c) => {
    need(c, "inbox.reply");
    need(c, "orders.manage");
    // 1. The cart, and the conversation by the one visibility rule.
    const { row, conv } = await load(c, c.req.param("id"));
    needNumber(c, conv);
    const body = PlaceBody.parse(await c.req.json());
    const v = c.get("inboxViewer");

    // 2. The branch that takes online orders.
    const branch = await onlineBranch(db);
    if (!branch) throw new BusinessError("conflict", NO_BRANCH, 409, { reason: "no_online_branch" });

    // 3. The customer the cart belongs to, and a phone number the shop can use.
    const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId));
    const phone = toE164(cust?.phone);
    if (!cust || !phone) throw new BusinessError("conflict", NO_PHONE, 409, { reason: "no_phone" });

    // 4. Resolved once, outside the transaction, exactly as the storefront does.
    const provider = await getActiveProvider(db);
    const address = body.fulfilment === "delivery" ? (body.address ?? null) : null;

    // 5. One transaction. The cart row is locked, so two clicks can never make two orders.
    const placed = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, row.id)).for("update");
      if (!locked) throw new BusinessError("not_found", "cart not found", 404);
      if (locked.saleOrderId) {
        // A double click or a retry: the same order, never a second one.
        const [existing] = await tx.select().from(saleOrder).where(eq(saleOrder.id, locked.saleOrderId));
        if (!existing) throw new BusinessError("internal_error", "order not found", 500);
        return { order: existing, created: false };
      }
      if (locked.state === "cancelled") {
        throw new BusinessError("conflict", "This cart was dismissed. Ask the customer to send it again.", 409, { reason: "cart_cancelled" });
      }
      // Only what the shop sells today (rule R5). The storefront's own code below prices every line.
      for (const it of body.items) {
        const size = await sellableVariant(tx, it.variant_id);
        if (!size?.sellable) throw new BusinessError("validation_failed", NOT_SELLABLE, 422, { reason: "item_not_sellable", variant_id: it.variant_id });
      }
      const { order } = await placeOnlineOrder(tx, {
        branchId: branch.id,
        idempotencyKey: locked.idempotencyKey,
        customerId: locked.customerId,
        customer: { name: cust.name ?? "WhatsApp customer", phone, email: cust.email, address, altPhone: null },
        items: body.items,
        deliveryFeeNgn: body.fulfilment === "delivery" ? body.delivery_fee_ngn : 0,
        deliveryQuoteRef: null,
        deliveryAddressCode: null,
        deliveryAddressFormatted: address,
        deliveryState: null,
        scheduledDeliveryAt: null,
        deliveryWindow: null,
        notes: ["Ordered in WhatsApp chat", body.notes].filter(Boolean).join(". "),
        paymentProvider: provider,
      });
      // The customer's saved address is filled only when it is empty; never overwritten.
      if (address) {
        await tx
          .update(customer)
          .set({ defaultAddress: address, updatedAt: new Date() })
          .where(and(eq(customer.id, locked.customerId), sql`coalesce(${customer.defaultAddress}, '') = ''`));
      }
      await tx
        .update(catalogueChatOrder)
        .set({
          state: "placed",
          saleOrderId: order.id,
          fulfilment: body.fulfilment,
          address,
          placedBy: v.userId,
          lastNotifiedStatus: "confirmed",
          nextPrompt: null,
          problem: null,
          updatedAt: new Date(),
        })
        .where(eq(catalogueChatOrder.id, locked.id));
      const [labelled] = await tx
        .update(inboxConversation)
        .set({ labels: sql`array_append(${inboxConversation.labels}, 'order')` })
        .where(and(eq(inboxConversation.id, conv.id), sql`not ('order' = any(${inboxConversation.labels}))`))
        .returning();
      await publishInboxEvent(tx, signalFor("conversation.updated", labelled ?? conv));
      return { order, created: true };
    });

    // 6 and 7. Outside the transaction: the OPay link, then the message. The order exists and
    // holds stock, so nothing from here on may turn this into an error.
    const fresh = (await db.select().from(catalogueChatOrder).where(eq(catalogueChatOrder.id, row.id)))[0] ?? row;
    const sent = await deliverPaymentLink(c, { row: fresh, order: placed.order, conv, cust, phone, branchName: branch.name, minGapMs: 0 });

    if (placed.created) {
      await audit(c, "chat_order.place", row, {
        conversation_id: conv.id,
        order_number: placed.order.orderNumber,
        total_ngn: placed.order.totalNgn,
        fulfilment: body.fulfilment,
        delivery_fee_ngn: placed.order.deliveryFeeNgn,
        is_preorder: placed.order.isPreorder,
        payment_link_sent: sent.claimed && sent.warning === null,
      });
    }
    // 8.
    return c.json(
      {
        data: {
          order_number: placed.order.orderNumber,
          total_ngn: placed.order.totalNgn,
          is_preorder: placed.order.isPreorder,
          payment_link: sent.link,
          ...(sent.warning ? { warning: sent.warning } : {}),
        },
      },
      201,
    );
  });

  /** "Send payment link again": a fresh OPay session for an order still waiting for payment. */
  r.post("/:id/payment-link", async (c) => {
    need(c, "inbox.reply");
    const { row, conv } = await load(c, c.req.param("id"));
    needNumber(c, conv);
    const [order] = row.saleOrderId ? await db.select().from(saleOrder).where(eq(saleOrder.id, row.saleOrderId)) : [];
    if (!order || (order.status !== "confirmed" && order.status !== "reconcile_needed")) {
      throw new BusinessError("conflict", "This order is not waiting for payment.", 409, { reason: "not_awaiting_payment" });
    }
    const [cust] = await db.select().from(customer).where(eq(customer.id, row.customerId));
    const phone = toE164(cust?.phone);
    if (!cust || !phone) throw new BusinessError("conflict", NO_PHONE, 409, { reason: "no_phone" });
    const branch = await onlineBranch(db);
    const sent = await deliverPaymentLink(c, { row, order, conv, cust, phone, branchName: branch?.name ?? null, minGapMs: RESEND_GAP_MS });
    if (!sent.claimed) {
      throw new BusinessError("conflict", "A payment link was sent a moment ago. Wait a little before sending another.", 409, { reason: "just_sent" });
    }
    await audit(c, "chat_order.payment_link", row, {
      conversation_id: conv.id,
      order_number: order.orderNumber,
      total_ngn: order.totalNgn,
      sent: sent.warning === null,
    });
    await publishInboxEvent(db, signalFor("conversation.updated", conv));
    return c.json({
      data: { order_number: order.orderNumber, payment_link: sent.link, ...(sent.warning ? { warning: sent.warning } : {}) },
    });
  });

  /** Dismiss a cart. The customer is not told. */
  r.post("/:id/cancel", async (c) => {
    need(c, "inbox.reply");
    const { row, conv } = await load(c, c.req.param("id"));
    const [updated] = await db
      .update(catalogueChatOrder)
      .set({ state: "cancelled", nextPrompt: null, updatedAt: new Date() })
      .where(and(eq(catalogueChatOrder.id, row.id), sql`${catalogueChatOrder.state} <> 'placed'`, isNull(catalogueChatOrder.saleOrderId)))
      .returning({ id: catalogueChatOrder.id });
    if (!updated) {
      throw new BusinessError("conflict", "This cart is already an order. Cancel the order in the shop admin instead.", 409, { reason: "already_placed" });
    }
    await publishInboxEvent(db, signalFor("conversation.updated", conv));
    await audit(c, "chat_order.cancel", row, { conversation_id: conv.id });
    return c.json({ data: { ok: true } });
  });

  return r;
}
