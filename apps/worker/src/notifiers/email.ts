import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "email" } });

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM ?? "Mrs. Samuel <orders@mrssamueljuice.com>";

if (!API_KEY) {
  logger.warn("RESEND_API_KEY not set — emails will be skipped");
}

/**
 * Send a transactional email via Resend. Best-effort: a failed send throws
 * so the outbox marks the event failed and retries with backoff.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  if (!API_KEY) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend failed: ${res.status} ${await res.text()}`);
  }
}
