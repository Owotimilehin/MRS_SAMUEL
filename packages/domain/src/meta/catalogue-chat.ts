/**
 * Selling in WhatsApp chat (suite spec 08): carts a customer sends, the shop's
 * own prices for them, and the messages around an order.
 *
 * A cart is only ever a request. Every price shown or charged comes from the
 * shop's product_price rows; Meta's item_price is kept for display and never
 * used in a sum (rule R28). The order itself is created by a person through
 * the API's placeOnlineOrder, never here.
 *
 * Two things here send without a person, each behind an owner switch on
 * catalogue_link that is off by default (foundation rule 7 and correction C6):
 *   - runChatOrderPrompts  (ask_fulfilment_auto)
 *   - runOrderUpdates      (order_updates_enabled)
 * Both claim the row before they send, so a crash or a second worker can never
 * send the same message twice (foundation rule 9); a send with no answer from
 * Meta is "unknown" and is not repeated.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import {
  catalogueChatOrder,
  catalogueItemSync,
  catalogueLink,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  product,
  productPrice,
  productVariant,
  saleOrder,
  saleOrderItem,
  type ChatCartLine,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  ADDRESS_QUESTION_TEXT,
  cartReceivedText,
  fulfilmentQuestionBody,
  greetingName,
  orderUpdateParams,
  orderUpdateTemplateFor,
  renderOrderTemplate,
  waWindowOpen,
  type CartTextLine,
  type ChatOrderFulfilment,
  type OrderTemplateName,
} from "@ms/shared";
import { availableVariantAtBranch } from "../availability.js";
import type { MetaConfig, OutboundContent } from "../inbox/meta.js";
import { InboxSendError, sendFromConversation, type SentMessage } from "../inbox/send.js";
import type { WaInboundMessage } from "../inbox/whatsapp-ingest.js";
import { buildFulfilmentButtons, onlineBranch, variantIdFromRetailerId } from "./catalogue.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** States in which a cart is still being worked on. */
export const CHAT_ORDER_OPEN_STATES = ["new", "asked", "awaiting_address", "ready"] as const;

type ChatOrderRow = typeof catalogueChatOrder.$inferSelect;

// ── Reading a cart ───────────────────────────────────────────────────────────

/** Whole units between 1 and 99 (WhatsApp's own limit per item); anything unreadable counts as 1. */
function cartQuantity(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 99);
}

/**
 * The cart inside a WhatsApp "order" message, or null when it is not one or
 * has no usable line. Tolerates a decimal item_price and missing fields.
 */
export function parseOrderMessage(
  m: WaInboundMessage,
): { catalogId: string | null; note: string | null; lines: ChatCartLine[] } | null {
  if (m.type !== "order" || !m.order) return null;
  const lines: ChatCartLine[] = [];
  for (const it of Array.isArray(m.order.product_items) ? m.order.product_items : []) {
    const retailerId = typeof it?.product_retailer_id === "string" ? it.product_retailer_id.trim() : "";
    if (!retailerId) continue;
    const price = it.item_price == null ? NaN : Number(it.item_price);
    lines.push({
      product_retailer_id: retailerId.slice(0, 100),
      quantity: cartQuantity(it.quantity),
      item_price: Number.isFinite(price) ? price : null,
      currency: typeof it.currency === "string" && it.currency ? it.currency.slice(0, 8) : null,
    });
  }
  if (lines.length === 0) return null;
  const note = typeof m.order.text === "string" ? m.order.text.trim() : "";
  return {
    catalogId: typeof m.order.catalog_id === "string" && m.order.catalog_id ? m.order.catalog_id : null,
    note: note ? note.slice(0, 1000) : null,
    lines,
  };
}

/**
 * Rule R23: one row per cart message (a replayed webhook creates nothing). A
 * new cart replaces any cart of the same conversation that is still open. No
 * Meta call; runs inside the ingest transaction.
 */
export async function recordChatCart(
  db: DbExecutor,
  a: { conversationId: string; customerId: string; waMessageId: string; parsed: NonNullable<ReturnType<typeof parseOrderMessage>> },
): Promise<{ id: string; created: boolean }> {
  const [link] = await db.select({ auto: catalogueLink.askFulfilmentAuto }).from(catalogueLink).limit(1);
  const [row] = await db
    .insert(catalogueChatOrder)
    .values({
      conversationId: a.conversationId,
      customerId: a.customerId,
      waMessageId: a.waMessageId,
      catalogId: a.parsed.catalogId,
      cart: a.parsed.lines,
      cartNote: a.parsed.note,
      state: "new",
      // The owner's switch, off by default: ask "delivery or pickup?" without a person.
      nextPrompt: link?.auto === true ? "fulfilment" : null,
    })
    .onConflictDoNothing({ target: catalogueChatOrder.waMessageId })
    .returning({ id: catalogueChatOrder.id });
  if (!row) {
    const [existing] = await db
      .select({ id: catalogueChatOrder.id })
      .from(catalogueChatOrder)
      .where(eq(catalogueChatOrder.waMessageId, a.waMessageId));
    return { id: existing?.id ?? "", created: false };
  }
  await db
    .update(catalogueChatOrder)
    .set({ state: "cancelled", nextPrompt: null, updatedAt: new Date() })
    .where(
      and(
        eq(catalogueChatOrder.conversationId, a.conversationId),
        ne(catalogueChatOrder.id, row.id),
        inArray(catalogueChatOrder.state, [...CHAT_ORDER_OPEN_STATES]),
      ),
    );
  return { id: row.id, created: true };
}

/** A shared location as one line of text (the same wording the timeline stores). */
function locationText(m: WaInboundMessage): string {
  const l = m.location ?? {};
  const where = [l.name, l.address].filter(Boolean).join(", ");
  return `${where ? `${where} ` : ""}(${l.latitude}, ${l.longitude})`;
}

/**
 * Rules R25 and R26: the customer's answer to "delivery or pickup?", and the
 * address typed after choosing delivery. Only ever touches a cart of THIS
 * conversation. No Meta call; runs inside the ingest transaction. Returns true
 * when it changed a row.
 *
 * The follow-up messages (the address question, the thank-you) are automatic,
 * so they are queued only while the owner's ask_fulfilment_auto switch is on.
 */
export async function applyChatOrderReply(db: DbExecutor, conversationId: string, m: WaInboundMessage): Promise<boolean> {
  const autoOn = async (): Promise<boolean> => {
    const [link] = await db.select({ auto: catalogueLink.askFulfilmentAuto }).from(catalogueLink).limit(1);
    return link?.auto === true;
  };
  const now = new Date();

  if (m.type === "interactive") {
    const replyId = m.interactive?.button_reply?.id;
    const match = typeof replyId === "string" ? /^co:([0-9a-f-]{36}):(delivery|pickup)$/.exec(replyId) : null;
    if (!match || !UUID.test(match[1]!)) return false;
    const choice = match[2] as ChatOrderFulfilment;
    const changed = await db
      .update(catalogueChatOrder)
      .set({
        fulfilment: choice,
        state: choice === "pickup" ? "ready" : "awaiting_address",
        nextPrompt: null,
        promptAttempts: 0,
        updatedAt: now,
      })
      .where(
        and(
          eq(catalogueChatOrder.id, match[1]!),
          eq(catalogueChatOrder.conversationId, conversationId),
          inArray(catalogueChatOrder.state, [...CHAT_ORDER_OPEN_STATES]),
        ),
      )
      .returning({ id: catalogueChatOrder.id });
    if (changed.length === 0) return false;
    if (await autoOn()) {
      await db
        .update(catalogueChatOrder)
        .set({ nextPrompt: choice === "pickup" ? "received" : "address" })
        .where(eq(catalogueChatOrder.id, changed[0]!.id));
    }
    return true;
  }

  let address: string | null = null;
  if (m.type === "text") address = (m.text?.body ?? "").trim();
  else if (m.type === "location") address = locationText(m).trim();
  if (!address || address.length < 10) return false;
  const changed = await db
    .update(catalogueChatOrder)
    .set({ address: address.slice(0, 500), state: "ready", nextPrompt: null, promptAttempts: 0, updatedAt: now })
    .where(
      and(
        eq(catalogueChatOrder.conversationId, conversationId),
        eq(catalogueChatOrder.state, "awaiting_address"),
        gt(catalogueChatOrder.updatedAt, new Date(now.getTime() - 24 * 3600_000)),
      ),
    )
    .returning({ id: catalogueChatOrder.id });
  if (changed.length === 0) return false;
  if (await autoOn()) {
    await db
      .update(catalogueChatOrder)
      .set({ nextPrompt: "received" })
      .where(
        inArray(
          catalogueChatOrder.id,
          changed.map((r) => r.id),
        ),
      );
  }
  return true;
}

/**
 * What the WhatsApp ingest calls for every inbound message: record a cart, or
 * read the message as an answer about one. It runs under a savepoint and
 * swallows any failure, because it sits on the path of every customer message:
 * a fault here must cost at most the cart card, never the message. A cart whose
 * row is missing is recorded later by backfillChatCart.
 */
export async function noteChatOrderMessage(
  db: DbExecutor,
  a: { conversationId: string; customerId: string; message: WaInboundMessage },
): Promise<void> {
  const work = async (tx: DbExecutor): Promise<void> => {
    if (a.message.type === "order") {
      const parsed = parseOrderMessage(a.message);
      if (parsed) await recordChatCart(tx, { conversationId: a.conversationId, customerId: a.customerId, waMessageId: a.message.id, parsed });
    } else {
      await applyChatOrderReply(tx, a.conversationId, a.message);
    }
  };
  try {
    const nested = (db as unknown as { transaction?: (fn: (tx: DbExecutor) => Promise<void>) => Promise<void> }).transaction;
    if (typeof nested === "function") await nested.call(db, work);
    else await work(db);
  } catch {
    // Deliberately ignored; see above.
  }
}

/**
 * If the newest cart message of a conversation has no cart row (the ingest
 * step above failed for it) and no later cart exists, record it now. Called
 * when staff open the cart card. Older orphans are left alone: a newer cart
 * has replaced them. Returns true when a cart was recorded.
 */
export async function backfillChatCart(db: DbExecutor, conv: { id: string; customerId: string }): Promise<boolean> {
  const [latest] = await db
    .select({ waMessageId: inboxMessage.waMessageId, payload: inboxMessage.payload, createdAt: inboxMessage.createdAt })
    .from(inboxMessage)
    .where(and(eq(inboxMessage.conversationId, conv.id), eq(inboxMessage.direction, "in"), eq(inboxMessage.type, "order")))
    .orderBy(desc(inboxMessage.createdAt))
    .limit(1);
  if (!latest?.waMessageId) return false;
  const [known] = await db
    .select({ id: catalogueChatOrder.id })
    .from(catalogueChatOrder)
    .where(
      sql`${catalogueChatOrder.waMessageId} = ${latest.waMessageId} or (${catalogueChatOrder.conversationId} = ${conv.id} and ${catalogueChatOrder.createdAt} > ${latest.createdAt.toISOString()}::timestamptz)`,
    )
    .limit(1);
  if (known) return false;
  const parsed = parseOrderMessage((latest.payload ?? {}) as unknown as WaInboundMessage);
  if (!parsed) return false;
  return (await recordChatCart(db, { conversationId: conv.id, customerId: conv.customerId, waMessageId: latest.waMessageId, parsed })).created;
}

// ── The shop's prices for a cart ─────────────────────────────────────────────

export interface PricedLine {
  retailerId: string;
  variantId: string | null;
  name: string;
  sizeMl: number | null;
  quantity: number;
  /** The shop's current price for one, or null when the size is not sold. */
  shopPriceNgn: number | null;
  lineTotalNgn: number | null;
  /** What WhatsApp showed the customer. Display only. */
  metaPrice: number | null;
  priceDiffers: boolean;
  /** Rule R5: active flavour, active size, a positive open price. */
  sellable: boolean;
  /** Enough at the online branch right now for this quantity (else the order becomes a preorder). */
  inStock: boolean;
}

/**
 * Rule R5 for one size, as it stands now: its flavour and the size are active
 * and not deleted, and it has an open price above zero.
 */
export async function sellableVariant(
  db: DbExecutor,
  variantId: string,
): Promise<{ sellable: boolean; name: string; sizeMl: number; productId: string; category: string; priceNgn: number | null } | null> {
  if (!UUID.test(variantId)) return null;
  const [v] = await db
    .select({
      sizeMl: productVariant.sizeMl,
      variantActive: productVariant.isActive,
      variantDeleted: productVariant.deletedAt,
      productId: product.id,
      name: product.name,
      category: product.category,
      productActive: product.isActive,
      productDeleted: product.deletedAt,
    })
    .from(productVariant)
    .innerJoin(product, eq(product.id, productVariant.productId))
    .where(eq(productVariant.id, variantId));
  if (!v) return null;
  const [p] = await db
    .select({ priceNgn: productPrice.priceNgn })
    .from(productPrice)
    .where(and(eq(productPrice.variantId, variantId), isNull(productPrice.validTo)))
    .orderBy(desc(productPrice.validFrom))
    .limit(1);
  const priceNgn = p && Number.isInteger(p.priceNgn) && p.priceNgn > 0 ? p.priceNgn : null;
  const visible = v.productActive && !v.productDeleted && v.variantActive && !v.variantDeleted;
  return { sellable: visible && priceNgn !== null, name: v.name, sizeMl: v.sizeMl, productId: v.productId, category: v.category, priceNgn };
}

/** Shop prices and names for a cart. Never uses Meta's prices. `branchId` is the online branch (null = none). */
export async function priceChatCart(db: DbExecutor, lines: ChatCartLine[], branchId: string | null): Promise<PricedLine[]> {
  const out: PricedLine[] = [];
  for (const line of lines) {
    const quantity = cartQuantity(line.quantity);
    const metaPrice = typeof line.item_price === "number" && Number.isFinite(line.item_price) ? line.item_price : null;
    const variantId = variantIdFromRetailerId(line.product_retailer_id);
    const v = variantId ? await sellableVariant(db, variantId) : null;
    if (!variantId || !v) {
      // Not one of ours (or gone): show what we last called it, if anything.
      const [known] = await db
        .select({ title: catalogueItemSync.title })
        .from(catalogueItemSync)
        .where(eq(catalogueItemSync.retailerId, line.product_retailer_id))
        .limit(1);
      out.push({
        retailerId: line.product_retailer_id,
        variantId: null,
        name: known?.title ?? "Unknown item",
        sizeMl: null,
        quantity,
        shopPriceNgn: null,
        lineTotalNgn: null,
        metaPrice,
        priceDiffers: false,
        sellable: false,
        inStock: false,
      });
      continue;
    }
    const shopPriceNgn = v.sellable ? v.priceNgn : null;
    const inStock =
      v.sellable && branchId !== null && quantity <= (await availableVariantAtBranch(db, { branchId, variantId }));
    out.push({
      retailerId: line.product_retailer_id,
      variantId,
      name: v.name,
      sizeMl: v.sizeMl,
      quantity,
      shopPriceNgn,
      lineTotalNgn: shopPriceNgn === null ? null : shopPriceNgn * quantity,
      metaPrice,
      priceDiffers: shopPriceNgn !== null && metaPrice !== null && Math.round(metaPrice) !== shopPriceNgn,
      sellable: v.sellable,
      inStock,
    });
  }
  return out;
}

/** Priced lines as the lines of a customer message. */
export function cartTextLines(lines: readonly PricedLine[]): CartTextLine[] {
  return lines.map((l) => ({ name: l.name, sizeMl: l.sizeMl, quantity: l.quantity, lineTotalNgn: l.lineTotalNgn, sellable: l.sellable }));
}

/** The lines of a placed order, at the prices stored on it, for the payment message. */
export async function orderTextLines(db: DbExecutor, saleOrderId: string): Promise<CartTextLine[]> {
  const rows = await db
    .select({
      name: product.name,
      sizeMl: productVariant.sizeMl,
      quantity: saleOrderItem.quantity,
      lineTotalNgn: saleOrderItem.lineTotalNgn,
    })
    .from(saleOrderItem)
    .leftJoin(product, eq(product.id, saleOrderItem.productId))
    .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
    .where(eq(saleOrderItem.saleOrderId, saleOrderId))
    .orderBy(asc(product.name), asc(productVariant.sizeMl));
  return rows.map((r) => ({ name: r.name ?? "Item", sizeMl: r.sizeMl ?? null, quantity: r.quantity, lineTotalNgn: r.lineTotalNgn, sellable: true }));
}

/** The "delivery or pickup?" message for a cart, at shop prices (rule R24). */
export async function fulfilmentQuestionFor(
  db: DbExecutor,
  row: { id: string; cart: ChatCartLine[] },
): Promise<Extract<OutboundContent, { type: "interactive" }>> {
  const branch = await onlineBranch(db);
  const lines = await priceChatCart(db, row.cart, branch?.id ?? null);
  const body = fulfilmentQuestionBody(cartTextLines(lines));
  return { type: "interactive", interactive: buildFulfilmentButtons(row.id, body), preview: body };
}

// ── Automatic messages (each behind an owner switch, off by default) ─────────

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** True when a failed send may still have reached the customer (no answer from Meta). */
function unconfirmed(msg: Pick<SentMessage, "payload">): boolean {
  return (msg.payload as { unconfirmed?: boolean } | null)?.unconfirmed === true;
}

// ── "Delivery or pickup?" is asked once (review fix, migration 0085) ─────────

/**
 * How a try at sending "delivery or pickup?" ended:
 *   sent       WhatsApp took it.
 *   refused    WhatsApp answered and certainly did not send it.
 *   no_answer  no answer from WhatsApp: it may have reached the customer.
 *   not_sent   refused here before anything went out (an InboxSendError: window closed and the rest).
 *   error      anything else; we cannot tell whether it went.
 */
export type AskOutcome = "sent" | "refused" | "no_answer" | "not_sent" | "error";

/** The outcome of a send that returned a message (rather than throwing). */
export function askOutcomeOf(msg: Pick<SentMessage, "status" | "payload">): AskOutcome {
  if (msg.status !== "failed") return "sent";
  return unconfirmed(msg) ? "no_answer" : "refused";
}

/**
 * Whether the ask claim (catalogue_chat_order.ask_claimed_at) is kept after a
 * try. It is given back only when the question certainly did not reach the
 * customer, so a later "Ask" or the worker's retry may send it; in every other
 * case it is kept, so the customer gets the question at most once.
 */
export function askClaimAfter(outcome: AskOutcome): "keep" | "release" {
  return outcome === "refused" || outcome === "not_sent" ? "release" : "keep";
}

/**
 * Take the one ask claim for a cart, atomically: only one of "Ask" and the
 * worker gets it, even at the same moment. Returns the claim's time (needed to
 * give it back), or null when the question was already claimed or the cart is
 * past the question.
 */
export async function claimAsk(db: DbExecutor, chatOrderId: string, now: Date = new Date()): Promise<Date | null> {
  const [row] = await db
    .update(catalogueChatOrder)
    .set({ askClaimedAt: now })
    .where(
      and(
        eq(catalogueChatOrder.id, chatOrderId),
        isNull(catalogueChatOrder.askClaimedAt),
        inArray(catalogueChatOrder.state, ["new", "asked"]),
      ),
    )
    .returning({ at: catalogueChatOrder.askClaimedAt });
  return row?.at ?? null;
}

/** Give back a claim taken by claimAsk (only that same claim). */
export async function releaseAsk(db: DbExecutor, chatOrderId: string, claimedAt: Date): Promise<void> {
  await db
    .update(catalogueChatOrder)
    .set({ askClaimedAt: null })
    .where(and(eq(catalogueChatOrder.id, chatOrderId), eq(catalogueChatOrder.askClaimedAt, claimedAt)));
}

// ── Order updates never announce a status from before the switch-on ──────────

/**
 * The baseline taken in the same transaction as switching order updates on:
 * every placed cart is marked as already told about its order's current
 * status, so runOrderUpdates only announces a status reached after the
 * switch-on moment (order_updates_enabled_at). No message is sent. Returns how
 * many carts were marked.
 */
export async function baselineOrderUpdates(db: DbExecutor): Promise<number> {
  const rows = await db
    .update(catalogueChatOrder)
    .set({ lastNotifiedStatus: sql`${saleOrder.status}::text`, notifyAttempts: 0 })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.id, catalogueChatOrder.saleOrderId),
        eq(catalogueChatOrder.state, "placed"),
        sql`${saleOrder.status}::text is distinct from ${catalogueChatOrder.lastNotifiedStatus}`,
      ),
    )
    .returning({ id: catalogueChatOrder.id });
  return rows.length;
}

/**
 * Switch order updates on, atomically: the switch, its moment
 * (order_updates_enabled_at, the database's clock) and the baseline above, in
 * one transaction. Only off → on does this; when they are already on nothing
 * changes (a second baseline would swallow updates still due), and switching
 * off keeps the stamp. Returns true when it switched them on.
 */
export async function switchOrderUpdatesOn(db: DbClient, linkId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [turned] = await tx
      .update(catalogueLink)
      .set({ orderUpdatesEnabled: true, orderUpdatesEnabledAt: sql`clock_timestamp()`, updatedAt: new Date() })
      .where(and(eq(catalogueLink.id, linkId), eq(catalogueLink.orderUpdatesEnabled, false)))
      .returning({ id: catalogueLink.id });
    if (!turned) return false;
    await baselineOrderUpdates(tx);
    return true;
  });
}

/**
 * Section 6.4: send the queued questions (rules R24 to R26). Does nothing
 * unless the owner has switched ask_fulfilment_auto on. Returns how many were sent.
 */
export async function runChatOrderPrompts(
  db: DbClient,
  cfg: MetaConfig | null,
  log: Log,
  opts: { now?: Date } = {},
): Promise<number> {
  if (!cfg) return 0;
  const [link] = await db.select({ auto: catalogueLink.askFulfilmentAuto }).from(catalogueLink).limit(1);
  if (link?.auto !== true) return 0;
  const now = opts.now ?? new Date();
  const due = await db
    .select()
    .from(catalogueChatOrder)
    .where(
      and(
        isNotNull(catalogueChatOrder.nextPrompt),
        lt(catalogueChatOrder.promptAttempts, 3),
        gt(catalogueChatOrder.updatedAt, new Date(now.getTime() - 23 * 3600_000)),
        inArray(catalogueChatOrder.state, [...CHAT_ORDER_OPEN_STATES]),
      ),
    )
    .orderBy(asc(catalogueChatOrder.updatedAt))
    .limit(10);

  let sent = 0;
  for (const row of due) {
    const prompt = row.nextPrompt as "fulfilment" | "address" | "received";
    // Claim it first: whatever happens next, this prompt is not sent by anyone else.
    const [claimed] = await db
      .update(catalogueChatOrder)
      .set({ nextPrompt: null })
      .where(and(eq(catalogueChatOrder.id, row.id), eq(catalogueChatOrder.nextPrompt, prompt)))
      .returning({ id: catalogueChatOrder.id });
    if (!claimed) continue;
    // "Delivery or pickup?" also takes the one ask claim, shared with the inbox's "Ask" button.
    let askClaim: Date | null = null;
    const giveBackAsk = async (outcome: AskOutcome) => {
      if (askClaim && askClaimAfter(outcome) === "release") await releaseAsk(db, row.id, askClaim);
    };
    try {
      let content: OutboundContent;
      if (prompt === "fulfilment") {
        content = await fulfilmentQuestionFor(db, row);
        askClaim = await claimAsk(db, row.id, now);
        // A person (or another worker) already asked, or the customer moved on: nothing to send.
        if (!askClaim) continue;
      } else if (prompt === "address") {
        content = { type: "text", body: ADDRESS_QUESTION_TEXT };
      } else {
        const fulfilment: ChatOrderFulfilment = row.fulfilment === "pickup" ? "pickup" : "delivery";
        content = { type: "text", body: cartReceivedText(fulfilment, fulfilment === "pickup" ? await onlineBranch(db) : null) };
      }
      const msg = await sendFromConversation(db, cfg, { conversationId: row.conversationId, userId: null, content }, now);
      if (msg.status === "failed") {
        if (unconfirmed(msg)) {
          // No answer from Meta: it may have arrived. Never send it again by itself.
          await db
            .update(catalogueChatOrder)
            .set({ problem: "No answer from WhatsApp. The question may have been sent: check the chat." })
            .where(eq(catalogueChatOrder.id, row.id));
        } else {
          // Certainly not sent: try again next time, up to three times.
          await giveBackAsk(askOutcomeOf(msg));
          await db
            .update(catalogueChatOrder)
            .set({
              nextPrompt: prompt,
              promptAttempts: sql`${catalogueChatOrder.promptAttempts} + 1`,
              problem: (msg.errorMessage ?? "WhatsApp refused the message").slice(0, 500),
            })
            .where(and(eq(catalogueChatOrder.id, row.id), isNull(catalogueChatOrder.nextPrompt)));
        }
        continue;
      }
      await db
        .update(catalogueChatOrder)
        .set({ problem: null, ...(prompt === "fulfilment" && row.state === "new" ? { state: "asked" } : {}) })
        .where(
          and(
            eq(catalogueChatOrder.id, row.id),
            // A customer's answer may already have moved it on; never move it back.
            ...(prompt === "fulfilment" ? [eq(catalogueChatOrder.state, row.state)] : []),
          ),
        );
      sent++;
    } catch (err) {
      const text = err instanceof InboxSendError ? err.message : "The message could not be sent.";
      // An InboxSendError is raised before anything is sent, so a person may still press "Ask".
      await giveBackAsk(err instanceof InboxSendError ? "not_sent" : "error");
      await db.update(catalogueChatOrder).set({ problem: text.slice(0, 500) }).where(eq(catalogueChatOrder.id, row.id));
      if (!(err instanceof InboxSendError)) log.error({ err, chatOrderId: row.id }, "catalogue: chat order prompt failed");
    }
  }
  return sent;
}

/** Is this template approved for the WhatsApp account, in this language? */
export async function orderTemplateApproved(
  db: DbExecutor,
  wabaId: string | null,
  name: OrderTemplateName,
  language: string,
): Promise<boolean> {
  const [tpl] = await db
    .select({ status: inboxTemplate.status })
    .from(inboxTemplate)
    .where(
      and(eq(inboxTemplate.name, name), eq(inboxTemplate.language, language), ...(wabaId ? [eq(inboxTemplate.wabaId, wabaId)] : [])),
    );
  return !!tpl && tpl.status.toUpperCase() === "APPROVED";
}

/**
 * Rule R30: what to send for an order message. The approved template if there
 * is one (works inside and outside the 24-hour window); else the same wording
 * as plain text while the window is open; else nothing.
 */
export async function orderMessageContent(
  db: DbExecutor,
  a: { wabaId: string | null; lastInboundAt: Date | null; name: OrderTemplateName; params: string[]; language: string; now?: Date },
): Promise<OutboundContent | null> {
  if (await orderTemplateApproved(db, a.wabaId, a.name, a.language)) {
    return { type: "template", name: a.name, language: a.language, bodyParams: a.params };
  }
  if (waWindowOpen(a.lastInboundAt, a.now ?? new Date())) return { type: "text", body: renderOrderTemplate(a.name, a.params) };
  return null;
}

/**
 * Section 6.4: tell customers when their chat order is paid, on its way and
 * delivered (rule R29). Does nothing unless the owner has switched
 * order_updates_enabled on. The trigger is sale_order.status differing from
 * what the customer was last told, so no shop code is touched. Returns how many
 * messages were sent.
 */
export async function runOrderUpdates(
  db: DbClient,
  cfg: MetaConfig | null,
  log: Log,
  opts: { now?: Date; language?: string } = {},
): Promise<number> {
  if (!cfg) return 0;
  const [link] = await db.select({ on: catalogueLink.orderUpdatesEnabled }).from(catalogueLink).limit(1);
  if (link?.on !== true) return 0;
  const now = opts.now ?? new Date();
  const language = opts.language || "en";

  const due = await db
    .select({
      id: catalogueChatOrder.id,
      conversationId: catalogueChatOrder.conversationId,
      lastNotified: catalogueChatOrder.lastNotifiedStatus,
      attempts: catalogueChatOrder.notifyAttempts,
      status: saleOrder.status,
      orderNumber: saleOrder.orderNumber,
      totalNgn: saleOrder.totalNgn,
      customerName: customer.name,
      lastInboundAt: inboxConversation.lastInboundWaAt,
      wabaId: inboxPhoneNumber.wabaId,
    })
    .from(catalogueChatOrder)
    .innerJoin(saleOrder, eq(saleOrder.id, catalogueChatOrder.saleOrderId))
    .innerJoin(inboxConversation, eq(inboxConversation.id, catalogueChatOrder.conversationId))
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, inboxConversation.phoneNumberId))
    .innerJoin(customer, eq(customer.id, catalogueChatOrder.customerId))
    .where(
      and(
        eq(catalogueChatOrder.state, "placed"),
        sql`${saleOrder.status}::text is distinct from ${catalogueChatOrder.lastNotifiedStatus}`,
        lt(catalogueChatOrder.notifyAttempts, 3),
        gt(saleOrder.createdAt, new Date(now.getTime() - 14 * 24 * 3600_000)),
      ),
    )
    .orderBy(asc(catalogueChatOrder.updatedAt))
    .limit(20);

  let sent = 0;
  for (const row of due) {
    const status = String(row.status);
    // Claim the status first: from here on, nobody else tells the customer about it.
    const [claimed] = await db
      .update(catalogueChatOrder)
      .set({ lastNotifiedStatus: status, updatedAt: now })
      .where(
        and(
          eq(catalogueChatOrder.id, row.id),
          sql`${catalogueChatOrder.lastNotifiedStatus} is not distinct from ${row.lastNotified}`,
        ),
      )
      .returning({ id: catalogueChatOrder.id });
    if (!claimed) continue;
    const settle = (set: Partial<typeof catalogueChatOrder.$inferInsert>) =>
      db.update(catalogueChatOrder).set(set).where(eq(catalogueChatOrder.id, row.id));

    const name = orderUpdateTemplateFor(status);
    if (!name) {
      // Nothing is said for this status; it is only recorded.
      await settle({ notifyAttempts: 0 });
      continue;
    }
    try {
      const params = orderUpdateParams(name, {
        firstName: greetingName(row.customerName),
        orderNumber: row.orderNumber,
        totalNgn: row.totalNgn,
      });
      const content = await orderMessageContent(db, { wabaId: row.wabaId, lastInboundAt: row.lastInboundAt, name, params, language, now });
      if (!content) {
        await settle({ notifyAttempts: 0, problem: `Template ${name} is not approved` });
        continue;
      }
      const msg = await sendFromConversation(db, cfg, { conversationId: row.conversationId, userId: null, content }, now);
      if (msg.status !== "failed") {
        await settle({ notifyAttempts: 0, problem: null });
        sent++;
      } else if (unconfirmed(msg)) {
        await settle({ notifyAttempts: 0, problem: "No answer from WhatsApp. The order update may have been sent." });
      } else if (row.attempts + 1 >= 3) {
        // Give up on this status; later statuses still go out.
        await settle({ notifyAttempts: 0, problem: (msg.errorMessage ?? "WhatsApp refused the order update").slice(0, 500) });
      } else {
        // Certainly not sent: put the status back so the next run tries again.
        await settle({
          lastNotifiedStatus: row.lastNotified,
          notifyAttempts: row.attempts + 1,
          problem: (msg.errorMessage ?? "WhatsApp refused the order update").slice(0, 500),
        });
      }
    } catch (err) {
      const text = err instanceof InboxSendError ? err.message : "The order update could not be sent.";
      await settle({ notifyAttempts: 0, problem: text.slice(0, 500) });
      if (!(err instanceof InboxSendError)) log.error({ err, chatOrderId: row.id }, "catalogue: order update failed");
    }
  }
  return sent;
}

export type { ChatOrderRow };
