/**
 * Answers to WhatsApp forms (suite spec 07, section 5.6). A completed form arrives on the ordinary
 * messages webhook as an interactive message of type `nfm_reply`. It is stored once per WhatsApp
 * message (replays change nothing) beside the inbound message row, and drawn as a card.
 *
 * Nothing here sends anything to the customer or changes a customer record (rule 13).
 */
import { and, eq } from "drizzle-orm";
import { inboxMessage, outboxEvent, waFlow, waFlowResponse, type DbExecutor } from "@ms/db";
import { flowCardRows, flowDef } from "@ms/shared";
import type { WaInboundMessage } from "../inbox/whatsapp-ingest.js";
import { peekFlowToken } from "./flow-token.js";

export interface FlowReply {
  responseJson: Record<string, unknown>;
  flowToken: string | null;
}

/** null unless the message is a completed form. Never throws: an unreadable answer is kept as `_raw`. */
export function parseFlowReply(m: WaInboundMessage): FlowReply | null {
  if (m.type !== "interactive" || m.interactive?.type !== "nfm_reply") return null;
  const raw = m.interactive.nfm_reply?.response_json;
  const text = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { responseJson: { _raw: text.slice(0, 2000) }, flowToken: null };
  }
  const responseJson = parsed as Record<string, unknown>;
  return { responseJson, flowToken: typeof responseJson.flow_token === "string" ? responseJson.flow_token : null };
}

const MAX_KEYS = 40;
const MAX_VALUE = 2000;

/** What we keep of an answer: no token, no form key, at most 40 keys, each value cut to 2000 characters. */
export function flowResponseData(responseJson: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, value] of Object.entries(responseJson)) {
    if (key === "flow_token" || key === "flow_key") continue;
    if (n >= MAX_KEYS) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key.slice(0, 100)] = value.slice(0, MAX_VALUE);
    else if (typeof value === "number" || typeof value === "boolean") out[key.slice(0, 100)] = value;
    else {
      const text = JSON.stringify(value) ?? "";
      out[key.slice(0, 100)] = text.length > MAX_VALUE ? text.slice(0, MAX_VALUE) : value;
    }
    n++;
  }
  return out;
}

/**
 * Store one answer. The form is worked out in this order: (1) the form message the customer
 * answered (`context.id`), from what we kept on it when it was sent; (2) `flow_key` in the answer,
 * when it names a built-in form; (3) the form named in the token, when the token belongs to this
 * conversation; (4) "unknown". A complaint raises one owner alert, in the same transaction.
 */
export async function recordFlowResponse(
  db: DbExecutor,
  a: { messageId: string; conversationId: string; contextWaMessageId: string | null; reply: FlowReply },
): Promise<{ flowKey: string; title: string; label: string | null; responseId: string | null }> {
  let flowKey: string | null = null;
  let flowRowId: string | null = null;
  let requestMessageId: string | null = null;

  if (a.contextWaMessageId) {
    const [sent] = await db
      .select({ id: inboxMessage.id, payload: inboxMessage.payload })
      .from(inboxMessage)
      // wa_message_id is unique, and a reply can only point at a message in the same WhatsApp chat.
      .where(and(eq(inboxMessage.waMessageId, a.contextWaMessageId), eq(inboxMessage.direction, "out")));
    const flow = (sent?.payload as { flow?: { key?: unknown; flow_row_id?: unknown } } | null | undefined)?.flow;
    if (sent && flow && typeof flow.key === "string" && flowDef(flow.key)) {
      flowKey = flow.key;
      requestMessageId = sent.id;
      if (typeof flow.flow_row_id === "string" && /^[0-9a-f-]{36}$/i.test(flow.flow_row_id)) {
        const [row] = await db.select({ id: waFlow.id }).from(waFlow).where(eq(waFlow.id, flow.flow_row_id));
        flowRowId = row?.id ?? null;
      }
    }
  }
  if (!flowKey) {
    const named = a.reply.responseJson.flow_key;
    if (typeof named === "string" && flowDef(named)) flowKey = named;
  }
  if (!flowKey) {
    const peek = peekFlowToken(a.reply.flowToken);
    if (peek && peek.conversationId === a.conversationId.toLowerCase() && flowDef(peek.key)) flowKey = peek.key;
  }
  const def = flowKey ? flowDef(flowKey) : null;
  const key = def?.key ?? "unknown";

  const [row] = await db
    .insert(waFlowResponse)
    .values({
      messageId: a.messageId,
      conversationId: a.conversationId,
      requestMessageId,
      flowId: flowRowId,
      flowKey: key,
      flowToken: a.reply.flowToken ? a.reply.flowToken.slice(0, 300) : null,
      data: flowResponseData(a.reply.responseJson),
    })
    .onConflictDoNothing({ target: waFlowResponse.messageId })
    .returning({ id: waFlowResponse.id });

  if (row && key === "complaint") {
    // No customer details in the alert (rule 15): the owner opens the chat to read it.
    await db.insert(outboxEvent).values({
      eventType: "inbox.flow_complaint",
      payload: { account: `flow_complaint:${row.id}`, conversation_id: a.conversationId, response_id: row.id },
    });
  }
  return { flowKey: key, title: def?.title ?? "Form", label: def?.label ?? null, responseId: row?.id ?? null };
}

/** The card for an answer: a title and label/value rows (always plain text). */
export function flowResponseCard(flowKey: string, data: Record<string, unknown>): { title: string; rows: { label: string; value: string; kind: string }[] } {
  return flowCardRows(flowKey, data);
}
