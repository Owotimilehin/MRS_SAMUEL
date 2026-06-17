import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  subscriptionPlan,
  bundle,
  subscriptionLead,
  contactMessage,
  customerSubscription,
  subscriptionCharge,
  customer,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const slug = z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case").max(60);

const CreatePlan = z.object({
  slug,
  name: z.string().min(1).max(120),
  price_ngn: z.number().int().nonnegative(),
  period: z.string().min(1).max(40),
  bottles_label: z.string().max(120).nullable().optional(),
  description: z.string().max(600).nullable().optional(),
  perks: z.array(z.string().max(120)).max(20).optional().default([]),
  popular: z.boolean().optional().default(false),
  display_order: z.number().int().optional().default(0),
  is_active: z.boolean().optional().default(true),
});
const PatchPlan = z.object({
  name: z.string().min(1).max(120).optional(),
  price_ngn: z.number().int().nonnegative().optional(),
  period: z.string().min(1).max(40).optional(),
  bottles_label: z.string().max(120).nullable().optional(),
  description: z.string().max(600).nullable().optional(),
  perks: z.array(z.string().max(120)).max(20).optional(),
  popular: z.boolean().optional(),
  display_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

const CreateBundle = z.object({
  slug,
  name: z.string().min(1).max(120),
  price_ngn: z.number().int().nonnegative(),
  description: z.string().max(600).nullable().optional(),
  contents_label: z.string().max(120).nullable().optional(),
  badge: z.string().max(60).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  display_order: z.number().int().optional().default(0),
  is_active: z.boolean().optional().default(true),
});
const PatchBundle = z.object({
  name: z.string().min(1).max(120).optional(),
  price_ngn: z.number().int().nonnegative().optional(),
  description: z.string().max(600).nullable().optional(),
  contents_label: z.string().max(120).nullable().optional(),
  badge: z.string().max(60).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  display_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

export function marketingRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("marketing.manage"));

  // ---------------- Subscription plans ----------------
  r.get("/subscription-plans", async (c) => {
    const rows = await db
      .select()
      .from(subscriptionPlan)
      .orderBy(asc(subscriptionPlan.displayOrder), asc(subscriptionPlan.createdAt));
    return c.json({ data: rows });
  });

  r.post("/subscription-plans", async (c) => {
    const body = CreatePlan.parse(await c.req.json());
    const existing = await db
      .select({ id: subscriptionPlan.id })
      .from(subscriptionPlan)
      .where(eq(subscriptionPlan.slug, body.slug))
      .limit(1);
    if (existing.length > 0) throw new BusinessError("conflict", "slug already in use", 409);

    const [row] = await db
      .insert(subscriptionPlan)
      .values({
        slug: body.slug,
        name: body.name,
        priceNgn: body.price_ngn,
        period: body.period,
        bottlesLabel: body.bottles_label ?? null,
        description: body.description ?? null,
        perks: body.perks ?? [],
        popular: body.popular ?? false,
        displayOrder: body.display_order ?? 0,
        isActive: body.is_active ?? true,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert failed", 500);
    await writeAudit(db, c, {
      action: "subscription_plan.create",
      entityType: "subscription_plan",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/subscription-plans/:id", async (c) => {
    const id = c.req.param("id");
    const body = PatchPlan.parse(await c.req.json());
    const [before] = await db.select().from(subscriptionPlan).where(eq(subscriptionPlan.id, id));
    if (!before) throw new BusinessError("not_found", "plan not found", 404);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.price_ngn !== undefined) patch["priceNgn"] = body.price_ngn;
    if (body.period !== undefined) patch["period"] = body.period;
    if (body.bottles_label !== undefined) patch["bottlesLabel"] = body.bottles_label;
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.perks !== undefined) patch["perks"] = body.perks;
    if (body.popular !== undefined) patch["popular"] = body.popular;
    if (body.display_order !== undefined) patch["displayOrder"] = body.display_order;
    if (body.is_active !== undefined) patch["isActive"] = body.is_active;

    const [row] = await db
      .update(subscriptionPlan)
      .set(patch)
      .where(eq(subscriptionPlan.id, id))
      .returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);
    await writeAudit(db, c, {
      action: "subscription_plan.update",
      entityType: "subscription_plan",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row });
  });

  r.delete("/subscription-plans/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .delete(subscriptionPlan)
      .where(eq(subscriptionPlan.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "plan not found", 404);
    await writeAudit(db, c, {
      action: "subscription_plan.delete",
      entityType: "subscription_plan",
      entityId: id,
      before: row,
    });
    return c.json({ data: { ok: true } });
  });

  // ---------------- Bundles ----------------
  r.get("/bundles", async (c) => {
    const rows = await db
      .select()
      .from(bundle)
      .orderBy(asc(bundle.displayOrder), asc(bundle.createdAt));
    return c.json({ data: rows });
  });

  r.post("/bundles", async (c) => {
    const body = CreateBundle.parse(await c.req.json());
    const existing = await db
      .select({ id: bundle.id })
      .from(bundle)
      .where(eq(bundle.slug, body.slug))
      .limit(1);
    if (existing.length > 0) throw new BusinessError("conflict", "slug already in use", 409);

    const [row] = await db
      .insert(bundle)
      .values({
        slug: body.slug,
        name: body.name,
        priceNgn: body.price_ngn,
        description: body.description ?? null,
        contentsLabel: body.contents_label ?? null,
        badge: body.badge ?? null,
        imageUrl: body.image_url ?? null,
        displayOrder: body.display_order ?? 0,
        isActive: body.is_active ?? true,
      })
      .returning();
    if (!row) throw new BusinessError("internal_error", "insert failed", 500);
    await writeAudit(db, c, {
      action: "bundle.create",
      entityType: "bundle",
      entityId: row.id,
      after: row,
    });
    return c.json({ data: row }, 201);
  });

  r.patch("/bundles/:id", async (c) => {
    const id = c.req.param("id");
    const body = PatchBundle.parse(await c.req.json());
    const [before] = await db.select().from(bundle).where(eq(bundle.id, id));
    if (!before) throw new BusinessError("not_found", "bundle not found", 404);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.price_ngn !== undefined) patch["priceNgn"] = body.price_ngn;
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.contents_label !== undefined) patch["contentsLabel"] = body.contents_label;
    if (body.badge !== undefined) patch["badge"] = body.badge;
    if (body.image_url !== undefined) patch["imageUrl"] = body.image_url;
    if (body.display_order !== undefined) patch["displayOrder"] = body.display_order;
    if (body.is_active !== undefined) patch["isActive"] = body.is_active;

    const [row] = await db.update(bundle).set(patch).where(eq(bundle.id, id)).returning();
    if (!row) throw new BusinessError("internal_error", "update failed", 500);
    await writeAudit(db, c, {
      action: "bundle.update",
      entityType: "bundle",
      entityId: id,
      before,
      after: row,
    });
    return c.json({ data: row });
  });

  r.delete("/bundles/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.delete(bundle).where(eq(bundle.id, id)).returning();
    if (!row) throw new BusinessError("not_found", "bundle not found", 404);
    await writeAudit(db, c, {
      action: "bundle.delete",
      entityType: "bundle",
      entityId: id,
      before: row,
    });
    return c.json({ data: { ok: true } });
  });

  // ---------------- Leads (read-only inbox) ----------------
  r.get("/leads/subscriptions", async (c) => {
    const rows = await db
      .select()
      .from(subscriptionLead)
      .orderBy(desc(subscriptionLead.createdAt))
      .limit(500);
    return c.json({ data: rows });
  });

  r.get("/leads/contact", async (c) => {
    const rows = await db
      .select()
      .from(contactMessage)
      .orderBy(desc(contactMessage.createdAt))
      .limit(500);
    return c.json({ data: rows });
  });

  // ---------------- Active subscriptions ----------------
  r.get("/subscriptions", async (c) => {
    const rows = await db
      .select({
        id: customerSubscription.id,
        status: customerSubscription.status,
        priceNgn: customerSubscription.priceNgn,
        period: customerSubscription.period,
        nextChargeAt: customerSubscription.nextChargeAt,
        lastChargeAt: customerSubscription.lastChargeAt,
        failedAttempts: customerSubscription.failedAttempts,
        createdAt: customerSubscription.createdAt,
        cancelledAt: customerSubscription.cancelledAt,
        planName: subscriptionPlan.name,
        customerName: customer.name,
        customerPhone: customer.phone,
      })
      .from(customerSubscription)
      .leftJoin(subscriptionPlan, eq(subscriptionPlan.id, customerSubscription.planId))
      .leftJoin(customer, eq(customer.id, customerSubscription.customerId))
      .orderBy(desc(customerSubscription.createdAt))
      .limit(500);
    return c.json({ data: rows });
  });

  r.get("/subscriptions/:id/charges", async (c) => {
    const id = c.req.param("id");
    const rows = await db
      .select()
      .from(subscriptionCharge)
      .where(eq(subscriptionCharge.subscriptionId, id))
      .orderBy(desc(subscriptionCharge.attemptedAt))
      .limit(200);
    return c.json({ data: rows });
  });

  // Cancel a subscription (admin). Stops future billing. (Payaza-side mandate
  // teardown is a no-op here — we self-manage charges by token, so simply not
  // charging stops it.)
  r.post("/subscriptions/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const [sub] = await db
      .select()
      .from(customerSubscription)
      .where(eq(customerSubscription.id, id));
    if (!sub) throw new BusinessError("not_found", "subscription not found", 404);
    if (sub.status === "cancelled") return c.json({ data: { ok: true } });
    const now = new Date();
    await db
      .update(customerSubscription)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(customerSubscription.id, id));
    await db.insert(outboxEvent).values({
      eventType: "subscription.cancelled",
      payload: { subscription_id: id, reason: "admin_cancelled" },
    });
    await writeAudit(db, c, {
      action: "subscription.cancel",
      entityType: "customer_subscription",
      entityId: id,
    });
    return c.json({ data: { ok: true } });
  });

  return r;
}
