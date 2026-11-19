/**
 * Catalogue and selling in WhatsApp chat (suite spec 08): the wording of every
 * message a customer receives about a cart or an order, and the small rules
 * around it. Pure and browser-safe, so the server sends exactly the text the
 * staff member was shown before clicking (foundation rule 7).
 *
 * Money is whole naira everywhere in the shop; nothing here handles kobo.
 */

/** "₦4,500" */
export function formatNaira(n: number): string {
  return "₦" + n.toLocaleString("en-NG");
}

export const CHAT_ORDER_STATES = ["new", "asked", "awaiting_address", "ready", "placed", "cancelled"] as const;
export type ChatOrderState = (typeof CHAT_ORDER_STATES)[number];
export type ChatOrderFulfilment = "delivery" | "pickup";

/** A cart line as shown to a customer: always the shop's own name and price. */
export interface CartTextLine {
  name: string;
  sizeMl: number | null;
  quantity: number;
  /** quantity × the shop's price, or null when the size is no longer sold. */
  lineTotalNgn: number | null;
  sellable: boolean;
}

/** "Pineapple Ginger 330ml" */
export function cartLineTitle(l: { name: string; sizeMl: number | null }): string {
  return l.sizeMl ? `${l.name} ${l.sizeMl}ml` : l.name;
}

/** "2 × Pineapple Ginger 330ml — ₦3,000", or "Pineapple Ginger 330ml — no longer available". */
export function cartLineLabel(l: CartTextLine): string {
  if (!l.sellable || l.lineTotalNgn == null) return `${cartLineTitle(l)} — no longer available`;
  return `${l.quantity} × ${cartLineTitle(l)} — ${formatNaira(l.lineTotalNgn)}`;
}

/** At most this many lines are listed in a message; the rest become "…and n more". */
export const CART_TEXT_MAX_LINES = 12;

/** The bulleted list of lines used in the messages below. */
export function cartLinesText(lines: readonly CartTextLine[], max = CART_TEXT_MAX_LINES): string {
  const shown = lines.slice(0, max).map((l) => `• ${cartLineLabel(l)}`);
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`);
  return shown.join("\n");
}

/** Sum of the lines that can still be sold, at shop prices. */
export function cartSubtotalNgn(lines: readonly CartTextLine[]): number {
  return lines.reduce((sum, l) => sum + (l.sellable && l.lineTotalNgn != null ? l.lineTotalNgn : 0), 0);
}

/** Rule R24: the "delivery or pickup?" question (sent with two reply buttons). */
export function fulfilmentQuestionBody(lines: readonly CartTextLine[]): string {
  return `Thank you! We have your cart:\n${cartLinesText(lines)}\nSubtotal: ${formatNaira(cartSubtotalNgn(lines))}\n\nHow would you like to get your order?`;
}

/** Rule R25: asked after the customer taps Delivery. */
export const ADDRESS_QUESTION_TEXT =
  "Please type your full delivery address in one message: house number, street, area and city.";

/** Rule R26: sent once we have what we need from the customer. */
export function cartReceivedText(
  fulfilment: ChatOrderFulfilment,
  branch: { name: string; address: string | null } | null,
): string {
  const tail = "A member of our team will confirm your order and send your payment link shortly.";
  if (fulfilment === "pickup" && branch) {
    const where = [branch.name, branch.address].filter((v) => v && v.trim()).join(", ");
    return `Thank you. You can collect from ${where}. ${tail}`;
  }
  return `Thank you. ${tail}`;
}

export const PAY_BUTTON_TEXT = "Pay now";

/** Rule R27: the payment message body (sent with a "Pay now" link button). */
export function paymentMessageBody(o: {
  orderNumber: string;
  lines: readonly CartTextLine[];
  fulfilment: ChatOrderFulfilment;
  deliveryFeeNgn: number;
  branchName: string | null;
  totalNgn: number;
}): string {
  const how =
    o.fulfilment === "delivery"
      ? `Delivery: ${formatNaira(o.deliveryFeeNgn)}`
      : `Pickup at ${o.branchName?.trim() || "our shop"}`;
  return (
    `Your order ${o.orderNumber} is ready.\n${cartLinesText(o.lines)}\n${how}\nTotal: ${formatNaira(o.totalNgn)}\n\n` +
    "Tap Pay now to pay safely with OPay. The link works for 30 minutes. If it stops working, tell us and we will send a new one."
  );
}

/** What the staff timeline shows for the payment message. */
export function paymentMessagePreview(orderNumber: string, totalNgn: number): string {
  return `Sent payment link for ${orderNumber} (${formatNaira(totalNgn)})`;
}

// ── Product messages (rules R20 to R22) ──────────────────────────────────────

export const PRODUCT_LIST_HEADER = "Mrs. Samuel Fruit Juice";
export const PRODUCT_LIST_DEFAULT_BODY = "Here are the juices we talked about. Tap one to see it or add it to your cart.";
export const CATALOGUE_DEFAULT_BODY = "Tap below to see our full menu and order right here in WhatsApp.";
/** Section order and titles of a product list, by product.category. */
export const PRODUCT_LIST_SECTIONS = [
  { category: "regular", title: "Juices" },
  { category: "special", title: "Specials" },
  { category: "punch", title: "Punch" },
] as const;
/** WhatsApp allows at most 30 products in one product list. */
export const MAX_PRODUCTS_PER_MESSAGE = 30;

// ── Order updates (rules R29 and R30) ────────────────────────────────────────

export const ORDER_TEMPLATE_NAMES = ["order_confirmed", "order_paid", "order_out_for_delivery", "order_delivered"] as const;
export type OrderTemplateName = (typeof ORDER_TEMPLATE_NAMES)[number];

/** The template wording (category UTILITY). Also sent as plain text when the template is not approved but the 24-hour window is open. */
export const ORDER_TEMPLATE_TEXT: Record<OrderTemplateName, string> = {
  order_confirmed: "Hello {{1}}, your Mrs. Samuel order {{2}} for {{3}} is ready. Pay here to confirm it: {{4}}",
  order_paid: "Thank you {{1}}. We have received your payment of {{3}} for order {{2}}. We are preparing it now.",
  order_out_for_delivery: "Hello {{1}}, your Mrs. Samuel order {{2}} is on its way to you.",
  order_delivered: "Hello {{1}}, your Mrs. Samuel order {{2}} has been delivered. Enjoy! Reply here if anything is not right.",
};

/** The wording with its blanks filled, in order. */
export function renderOrderTemplate(name: OrderTemplateName, params: readonly string[]): string {
  return ORDER_TEMPLATE_TEXT[name].replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
}

/**
 * Which message, if any, a customer gets when their order reaches a status
 * (rule R29). `order_confirmed` is not here: it is only the fallback for the
 * payment message at the moment a person places the order.
 */
export function orderUpdateTemplateFor(status: string): Exclude<OrderTemplateName, "order_confirmed"> | null {
  switch (status) {
    case "paid":
      return "order_paid";
    case "out_for_delivery":
      return "order_out_for_delivery";
    case "delivered":
      return "order_delivered";
    default:
      return null;
  }
}

/** The body variables for an order-update template, in order (rule R29). */
export function orderUpdateParams(
  name: OrderTemplateName,
  o: { firstName: string; orderNumber: string; totalNgn: number; paymentLink?: string },
): string[] {
  switch (name) {
    case "order_confirmed":
      return [o.firstName, o.orderNumber, formatNaira(o.totalNgn), o.paymentLink ?? ""];
    case "order_paid":
      return [o.firstName, o.orderNumber, formatNaira(o.totalNgn)];
    default:
      return [o.firstName, o.orderNumber];
  }
}

/** The customer's first name for a greeting, or "there". */
export function greetingName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  // A phone number or a placeholder is not a name.
  return first && !/\d/.test(first) ? first : "there";
}
