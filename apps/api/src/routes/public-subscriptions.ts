import { Hono } from "hono";
import { z } from "zod";
import { subscriptionLead, outboxEvent, type DbClient } from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { env } from "../env.js";

const LeadBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(40),
  plan_slug: z.string().min(1).max(80),
  turnstile_token: z.string().optional(),
});

/**
 * Public subscription lead capture. Stores the enquiry and emits an outbox
 * event so the worker pings the owner. Rate-limited + Turnstile-guarded.
 */
export function publicSubscriptionRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-subscriptions" }));

  r.post("/", async (c) => {
    const body = LeadBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(
      env.TURNSTILE_SECRET,
      body.turnstile_token,
      c.req.header("cf-connecting-ip") ?? undefined,
    );
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [row] = await db
      .insert(subscriptionLead)
      .values({ name: body.name, phone: body.phone, planSlug: body.plan_slug })
      .returning();
    if (!row) throw new BusinessError("internal_error", "lead insert failed", 500);

    await db.insert(outboxEvent).values({
      eventType: "subscription.requested",
      payload: { lead_id: row.id, name: body.name, phone: body.phone, plan_slug: body.plan_slug },
    });
    return c.json({ data: { ok: true } }, 201);
  });

  return r;
}
