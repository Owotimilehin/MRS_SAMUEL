import { Hono } from "hono";
import { z } from "zod";
import { enquiryLead, outboxEvent, type DbClient } from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { env } from "../env.js";

/** The two business enquiries the site captures. */
export const ENQUIRY_TYPES = ["white_label", "bulk_order"] as const;

const EnquiryBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(40),
  enquiry_type: z.enum(ENQUIRY_TYPES),
  turnstile_token: z.string().optional(),
});

/**
 * White-label and bulk-order enquiries.
 *
 * The conversation itself happens on WhatsApp — the page hands the visitor
 * straight there. This endpoint records that they asked, so an enquiry cannot
 * be lost just because nobody saw the message. Deliberately fire-and-forget
 * from the client's point of view: the WhatsApp hand-off must never wait on,
 * or be blocked by, this call.
 *
 * Rate-limited and Turnstile-guarded, matching public-contact. Note the bot
 * check FAILS OPEN while TURNSTILE_SECRET is unset, which is the current
 * production state — the rate limit is the real protection today.
 */
export function publicEnquiryRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-enquiries" }));

  r.post("/", async (c) => {
    const body = EnquiryBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(
      env.TURNSTILE_SECRET,
      body.turnstile_token,
      c.req.header("cf-connecting-ip") ?? undefined,
    );
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [row] = await db
      .insert(enquiryLead)
      .values({
        name: body.name.trim(),
        phone: body.phone.replace(/[\s-]/g, ""),
        enquiryType: body.enquiry_type,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "enquiry insert failed", 500);

    await db.insert(outboxEvent).values({
      eventType: "enquiry.received",
      payload: {
        enquiry_id: row.id,
        name: row.name,
        phone: row.phone,
        enquiry_type: row.enquiryType,
      },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
