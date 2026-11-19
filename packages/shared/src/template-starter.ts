/**
 * The starter set of WhatsApp templates for Mrs. Samuel Fruit Juice (suite spec 06, 7.8).
 * They are only ever added as DRAFTS: a person reads each one and sends it for approval.
 * Each follows Meta's rules (no blank at the start or end, words between blanks, an example
 * for every blank, nothing promotional) so `validateDraft` finds nothing to warn about.
 */
import type { DraftCategory, TemplateDraft } from "./template-draft.js";

export interface StarterTemplate {
  /** Also the template's name at WhatsApp. */
  key: string;
  name: string;
  title: string;
  language: "en";
  category: DraftCategory;
  draft: TemplateDraft;
}

const SHOP = "Mrs. Samuel Fruit Juice";
const ORDER_LINK = "https://www.mrssamuel.com/order/{{1}}";

function starter(key: string, title: string, draft: Omit<TemplateDraft, "category">): StarterTemplate {
  return { key, name: key, title, language: "en", category: "UTILITY", draft: { category: "UTILITY", ...draft } };
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  starter("conversation_reopen", "Re-open a chat", {
    header: null,
    body: {
      text: "Hello {{1}}, this is Mrs. Samuel Fruit Juice. We are following up on your recent message to us. Please reply here so we can continue helping you.",
      examples: ["Ada"],
    },
    footer: "",
    buttons: [{ type: "QUICK_REPLY", text: "Continue chat" }],
  }),
  starter("order_confirmed", "Order confirmed", {
    header: null,
    body: {
      text: "Hello {{1}}, thank you for your order. We have received order {{2}} and the total is {{3}}. We will message you again when it is on its way.",
      examples: ["Ada", "MS-10482", "N12,500"],
    },
    footer: SHOP,
    buttons: [{ type: "URL", text: "View order", url: ORDER_LINK, example: "MS-10482" }],
  }),
  starter("order_out_for_delivery", "Out for delivery", {
    header: null,
    body: {
      text: "Hello {{1}}, your order {{2}} has left our shop and is on its way to you. Our rider will call you when they arrive, so please keep your phone close.",
      examples: ["Ada", "MS-10482"],
    },
    footer: SHOP,
    buttons: [{ type: "URL", text: "View order", url: ORDER_LINK, example: "MS-10482" }],
  }),
  starter("order_delivered", "Delivered", {
    header: null,
    body: {
      text: "Hello {{1}}, your order {{2}} has been delivered. Thank you for choosing Mrs. Samuel Fruit Juice. If anything is not right with this order, reply to this message and we will sort it out.",
      examples: ["Ada", "MS-10482"],
    },
    footer: "",
    buttons: [{ type: "QUICK_REPLY", text: "There is a problem" }],
  }),
  // Exactly one blank: sendMissedCallFollowups (apps/worker/src/jobs/inbox-voice.ts) sends one value.
  starter("missed_call_followup", "Missed call", {
    header: null,
    body: {
      text: "Hello {{1}}, we are sorry we missed your call to Mrs. Samuel Fruit Juice. Please reply here to tell us how we can help, or tell us a good time to call you back.",
      examples: ["Ada"],
    },
    footer: "",
    buttons: [{ type: "QUICK_REPLY", text: "Call me back" }],
  }),
  starter("payment_reminder", "Payment reminder", {
    header: null,
    body: {
      text: "Hello {{1}}, this is a reminder about order {{2}}. We have not yet received the payment of {{3}}. Please pay with the link we sent you, or reply here if you need help. We will hold the order until {{4}}, then release it.",
      examples: ["Ada", "MS-10482", "N12,500", "6pm today"],
    },
    footer: SHOP,
    buttons: [],
  }),
  starter("preorder_ready", "Pre-order ready", {
    header: null,
    body: {
      text: "Hello {{1}}, your pre-order {{2}} is ready. You can collect it at {{3}} during our opening hours. Please reply here if you would like us to deliver it instead.",
      examples: ["Ada", "PO-2291", "our Lekki shop"],
    },
    footer: "",
    buttons: [{ type: "QUICK_REPLY", text: "Deliver it instead" }],
  }),
];
