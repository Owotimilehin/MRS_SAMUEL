import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { inboxRecording, type DbClient } from "@ms/db";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Fireflies.ai webhook: "the transcript (or summary) for a recording is ready".
 *
 *   URL      https://api.mrssamuel.com/v1/webhooks/fireflies
 *   Set in   Fireflies → Integrations → API → Webhook, events meeting.transcribed
 *            and meeting.summarized, with the signing secret FIREFLIES_WEBHOOK_SECRET.
 *   Signed   X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>.
 *            Unsigned or wrongly signed → 401, nothing stored.
 *
 * The body is only a wake-up: it names the recording (client_reference_id, our
 * inbox_recording id, set when the worker sent it) and Fireflies' meeting id.
 * We mark the recording ready and answer at once; the worker fetches the
 * transcript and summary from Fireflies itself (apps/worker/src/jobs/inbox-fireflies.ts).
 * Only recordings the worker actually sent can be marked, so a meeting recorded
 * in Fireflies for some other reason is ignored.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY_EVENTS = new Set([
  "meeting.transcribed",
  "meeting.summarized",
  "Transcription completed",
]);

export function verifyFirefliesSignature(
  raw: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(given.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

interface FirefliesWebhookBody {
  event?: string;
  meeting_id?: string;
  client_reference_id?: string;
  // Legacy (V1) payload names.
  eventType?: string;
  meetingId?: string;
  clientReferenceId?: string;
}

export function firefliesWebhookRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("payload too large", 413) }));

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const secret = env.FIREFLIES_WEBHOOK_SECRET;
    if (!secret || !verifyFirefliesSignature(raw, c.req.header("x-hub-signature"), secret)) {
      logger.warn("fireflies webhook: bad or missing signature");
      return c.json({ error: { code: "unauthorized", message: "invalid signature" } }, 401);
    }

    let body: FirefliesWebhookBody;
    try {
      body = JSON.parse(raw) as FirefliesWebhookBody;
    } catch {
      return c.json({ ok: true });
    }
    const event = body.event ?? body.eventType ?? "";
    const meetingId = body.meeting_id ?? body.meetingId;
    const ref = body.client_reference_id ?? body.clientReferenceId;

    if (!READY_EVENTS.has(event) || !meetingId || !ref || !UUID.test(ref)) {
      logger.info({ event, hasMeeting: !!meetingId, hasRef: !!ref }, "fireflies webhook: ignored");
      return c.json({ ok: true });
    }

    const updated = await db
      .update(inboxRecording)
      .set({ firefliesMeetingId: meetingId, firefliesReadyAt: new Date() })
      .where(and(eq(inboxRecording.id, ref), isNotNull(inboxRecording.firefliesSentAt)))
      .returning({ id: inboxRecording.id });
    if (updated.length === 0)
      logger.warn({ ref, event }, "fireflies webhook: no recording we sent has this reference");
    else logger.info({ recordingId: ref, event }, "fireflies webhook: result ready");
    return c.json({ ok: true });
  });

  return r;
}
