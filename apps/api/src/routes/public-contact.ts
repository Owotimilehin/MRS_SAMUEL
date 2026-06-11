import { Hono } from "hono";
import { z } from "zod";
import { contactMessage, outboxEvent, type DbClient } from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { env } from "../env.js";

const ContactBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  subject: z.string().min(1).max(120),
  message: z.string().min(1).max(4000),
  turnstile_token: z.string().optional(),
});

/**
 * Public contact form. Stores the message and emits an outbox event so the
 * worker pings the owner on Telegram. Rate-limited + Turnstile-guarded (the
 * bot check fails open when TURNSTILE_SECRET is unset).
 */
export function publicContactRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-contact" }));

  r.post("/", async (c) => {
    const body = ContactBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(
      env.TURNSTILE_SECRET,
      body.turnstile_token,
      c.req.header("cf-connecting-ip") ?? undefined,
    );
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [row] = await db
      .insert(contactMessage)
      .values({
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        subject: body.subject,
        message: body.message,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "contact insert failed", 500);

    await db.insert(outboxEvent).values({
      eventType: "contact.message_received",
      payload: {
        contact_id: row.id,
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        subject: body.subject,
      },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
