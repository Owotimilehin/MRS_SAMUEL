import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  subscriptionPlan,
  customerSubscription,
  branch,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { rateLimit } from "../middleware/rate-limit.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { BusinessError } from "../lib/errors.js";
import { resolveCustomer } from "../lib/customers.js";
import { buildPayazaCheckoutConfig } from "../payments/payaza.js";
import { normalizeNigerianPhone } from "@ms/shared";
import { env } from "../env.js";

const SubscribeBody = z.object({
  plan_slug: z.string().min(1).max(80),
  branch_id: z.string().uuid().optional(),
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().min(7).max(40),
    email: z.string().email().optional(),
    address: z.string().max(300).optional(),
  }),
  turnstile_token: z.string().optional(),
});

/**
 * Public self-serve subscribe. Creates a `pending` customer_subscription and
 * returns the Payaza checkout SDK config for the first payment. The first
 * charge (via the popup, with save-card) yields the reusable token; the
 * /v1/webhooks/payaza handler activates the subscription on success. The worker
 * then bills that token each period. Replaces the old lead-capture flow.
 */
export function publicSubscriptionRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 10, durationSeconds: 60, keyPrefix: "public-subscriptions" }));

  r.post("/", async (c) => {
    const body = SubscribeBody.parse(await c.req.json());
    const human = await verifyTurnstileToken(
      env.TURNSTILE_SECRET,
      body.turnstile_token,
      c.req.header("cf-connecting-ip") ?? undefined,
    );
    if (!human) throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);

    const [plan] = await db
      .select()
      .from(subscriptionPlan)
      .where(and(eq(subscriptionPlan.slug, body.plan_slug), eq(subscriptionPlan.isActive, true)));
    if (!plan) throw new BusinessError("not_found", "subscription plan not found", 404);

    // Branch that fulfils each cycle's order (caller's choice or first branch).
    let branchId = body.branch_id ?? null;
    if (!branchId) {
      const [b] = await db
        .select({ id: branch.id })
        .from(branch)
        .where(isNull(branch.deletedAt))
        .limit(1);
      if (!b) throw new BusinessError("internal_error", "no branch available", 500);
      branchId = b.id;
    }
    const fulfilBranchId = branchId;

    const created = await db.transaction(async (tx) => {
      const phone = normalizeNigerianPhone(body.customer.phone);
      if (!phone) {
        throw new BusinessError("validation_failed", "phone must be a valid Nigerian number", 422);
      }
      const customerId = await resolveCustomer(tx, {
        name: body.customer.name,
        phone,
        email: body.customer.email ?? null,
        defaultAddress: body.customer.address ?? null,
        source: "online",
      });
      if (!customerId) throw new BusinessError("internal_error", "customer resolve failed", 500);

      const [sub] = await tx
        .insert(customerSubscription)
        .values({
          customerId,
          planId: plan.id,
          branchId: fulfilBranchId,
          priceNgn: plan.priceNgn,
          period: plan.period,
          status: "pending",
        })
        .returning();
      if (!sub) throw new BusinessError("internal_error", "subscription create failed", 500);

      await tx.insert(outboxEvent).values({
        eventType: "subscription.created",
        payload: {
          subscription_id: sub.id,
          plan_name: plan.name,
          plan_slug: plan.slug,
          customer_id: customerId,
          price_ngn: plan.priceNgn,
          period: plan.period,
        },
      });
      return { sub, email: body.customer.email ?? null };
    });

    // First payment via the checkout SDK; reference ties the payment back to the
    // subscription (SUB_<id>) for the webhook + Payaza transaction-query.
    const reference = `SUB_${created.sub.id}`;
    const payaza = buildPayazaCheckoutConfig({
      amountNgn: created.sub.priceNgn,
      email: created.email ?? "no-email@example.com",
      reference,
      customerName: body.customer.name,
      customerPhone: body.customer.phone,
    });

    return c.json(
      {
        data: {
          subscription_id: created.sub.id,
          payment: { provider: "payaza" as const, reference, payaza },
        },
      },
      201,
    );
  });

  return r;
}
