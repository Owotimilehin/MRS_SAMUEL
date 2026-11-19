import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DbClient } from "@ms/db";
import {
  FlowDecryptError,
  SlotConversationGoneError,
  decryptFlowRequest,
  encryptFlowResponse,
  handleSlotFlow,
  loadFlowPrivateKey,
  readFlowToken,
  verifyMetaSignature,
  type FlowEncryptedBody,
} from "@ms/domain";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * The WhatsApp Flows data endpoint (suite spec 07, section 5.9; Phase B). WhatsApp calls this,
 * encrypted, while a customer has the delivery-time form open, and shows what we answer.
 *
 * It is the one Meta webhook that is NOT stored in inbox_webhook_event (foundation correction C5):
 * it is a live question and answer that must come back within Meta's 10 seconds and cannot be
 * replayed. It writes nothing to the database at all.
 *
 * Switched off unless the private key is set on the server (WA_FLOW_PRIVATE_KEY_B64): then 503.
 * What we answer with:
 *   503  the key is not configured (Phase B is off)
 *   432  the signature check failed
 *   421  the body cannot be decrypted (the client fetches our public key again and retries)
 *   427  the form's token is bad, expired or for another form; the JSON body's line is shown to the customer
 *   500  our own failure, or no answer inside the time budget
 *   200  the encrypted answer, as text/plain
 * Never logged: the decrypted body, the AES key, the IV, the token. Only action, screen and outcome.
 */

/** Our own limit, inside Meta's 10 seconds. Exported so a test can shorten it. */
export const flowEndpointTimings = { budgetMs: 8_000 };

const EXPIRED = { error_msg: "This form has expired. Please ask us to send it again." };

const empty = (status: number): Response => new Response(null, { status });

export function whatsappFlowsEndpointRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.text("payload too large", 413) }));

  r.post("/", async (c) => {
    // 1. The raw body; no key, no Phase B.
    const raw = await c.req.raw.clone().text();
    const key = loadFlowPrivateKey(process.env);
    if (!key) return empty(503);

    // 2. Meta signs the raw body with the app secret.
    const secret = env.META_APP_SECRET;
    if (!secret || !verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), secret)) {
      logger.warn("flow endpoint: bad signature");
      return empty(432);
    }

    // 3. The envelope, then the payload.
    let payload: Record<string, unknown>;
    let aesKey: Buffer;
    let iv: Buffer;
    try {
      const envelope = JSON.parse(raw) as FlowEncryptedBody;
      ({ payload, aesKey, iv } = decryptFlowRequest(envelope, key));
    } catch (err) {
      if (!(err instanceof FlowDecryptError) && !(err instanceof SyntaxError)) throw err;
      logger.warn("flow endpoint: could not decrypt");
      return empty(421);
    }
    const answer = (response: unknown): Response =>
      new Response(encryptFlowResponse(response, aesKey, iv), { status: 200, headers: { "content-type": "text/plain" } });

    const action = typeof payload.action === "string" ? payload.action : "";
    const screen = typeof payload.screen === "string" ? payload.screen : undefined;
    const data = typeof payload.data === "object" && payload.data !== null && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : undefined;

    // 4. Meta's health check: answered without touching the database (rule 17).
    if (action === "ping") return answer({ data: { status: "active" } });

    // 5. The client telling us about an error it hit.
    if (data && data.error !== undefined) {
      logger.warn({ screen: screen ?? null, error: String(data.error).slice(0, 100) }, "flow endpoint: client error notice");
      return answer({ data: { acknowledged: true } });
    }

    // 6. Our token says which form and which conversation this is.
    const now = new Date();
    const token = readFlowToken(env.JWT_SIGNING_KEY, payload.flow_token, now);
    if (!token.ok || token.key !== "delivery_slot") {
      logger.info({ action, outcome: token.ok ? "wrong_form" : token.reason }, "flow endpoint: token refused");
      return new Response(JSON.stringify(EXPIRED), { status: 427, headers: { "content-type": "application/json" } });
    }

    // 7 to 10. Work out the next screen inside the time budget; never log the payload.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = handleSlotFlow(db, { action, ...(screen ? { screen } : {}), ...(data ? { data } : {}), conversationId: token.conversationId, token: String(payload.flow_token) }, now);
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), flowEndpointTimings.budgetMs);
      });
      const out = await Promise.race([work, timeout]);
      if (out === "timeout") {
        work.catch(() => undefined);
        logger.error({ action, screen: screen ?? null }, "flow endpoint: no answer inside the time budget");
        return empty(500);
      }
      logger.info({ action, screen: screen ?? null, outcome: String(out.screen ?? "") }, "flow endpoint: answered");
      return answer(out);
    } catch (err) {
      if (err instanceof SlotConversationGoneError) {
        return new Response(JSON.stringify(EXPIRED), { status: 427, headers: { "content-type": "application/json" } });
      }
      logger.error({ action, screen: screen ?? null, error: err instanceof Error ? err.name : "error" }, "flow endpoint: failed");
      return empty(500);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  return r;
}
