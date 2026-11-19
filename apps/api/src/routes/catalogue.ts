/**
 * Catalogue (suite spec 08, section 5.5): link one Meta catalogue, connect it to
 * WhatsApp, switch sync and the two owner switches, and see every item with the
 * reason Meta refused it in plain words. Mounted at /v1/catalogue.
 *
 * No route here sends an item to Meta: they only set flags that the worker's
 * catalogue jobs act on. The calls that do reach Meta from here (open the
 * catalogue, connect it to WhatsApp, the cart and menu-button settings) each
 * follow a person's click and write an audit row (foundation rule 7). The token
 * never leaves @ms/domain.
 *
 * The API's error codes are a fixed list, so the spec's own codes
 * (catalogue_unreachable, already_linked, owner_only, …) travel in
 * `error.details.reason`, as the other suite routes do.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, eq, ilike, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { catalogueItemSync, catalogueLink, inboxPhoneNumber, inboxTemplate, product, type DbClient } from "@ms/db";
import {
  MetaApiError,
  classifyCatalogueError,
  connectCatalogueToWaba,
  getCatalogue,
  getCatalogueLink,
  getCommerceSettings,
  listWabaCatalogues,
  metaConfigFromEnv,
  onlineBranch,
  plainProblem,
  priceNgnFromMetaPrice,
  requestCatalogueSync,
  setCommerceSettings,
  type MetaConfig,
} from "@ms/domain";
import { ORDER_TEMPLATE_NAMES } from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError, pgErrorCode } from "../lib/errors.js";
import { logger } from "../logger.js";

type LinkRow = typeof catalogueLink.$inferSelect;

const NOT_SET_UP = "WhatsApp is not connected on this server yet.";
const NOT_LINKED = "No catalogue is connected yet.";
const NO_WABA = "There is no WhatsApp number on this server to connect the catalogue to.";
const ITEM_STATES = ["rejected", "blocked", "pending", "sent", "live", "removed"] as const;

function metaCode(e: MetaApiError): string | null {
  if (!e.code) return null;
  return e.subcode ? `${e.code}/${e.subcode}` : e.code;
}

function linkJson(link: LinkRow) {
  return {
    catalog_id: link.catalogId,
    name: link.name,
    whatsapp_connected: link.whatsappConnected,
    is_cart_enabled: link.isCartEnabled,
    is_catalog_visible: link.isCatalogVisible,
    sync_enabled: link.syncEnabled,
    ask_fulfilment_auto: link.askFulfilmentAuto,
    order_updates_enabled: link.orderUpdatesEnabled,
    last_sync_at: link.lastSyncAt,
    last_reconcile_at: link.lastReconcileAt,
    problem: link.problemKind
      ? {
          kind: link.problemKind,
          code: link.problemCode,
          message: link.problemMessage,
          plain: plainProblem(link.problemMessage, null, { code: link.problemCode }),
          at: link.problemAt,
        }
      : null,
  };
}

async function audit(db: DbClient, c: Context, action: string, entityId: string, after?: unknown, before?: unknown) {
  await writeAudit(db, c, { action, entityType: "catalogue_link", entityId, after, before, notify: false });
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_SET_UP, 503, { reason: "not_configured" });
  return cfg;
}

async function needLink(db: DbClient): Promise<LinkRow> {
  const link = await getCatalogueLink(db);
  if (!link) throw new BusinessError("not_found", NOT_LINKED, 404, { reason: "not_linked" });
  return link;
}

/** The WhatsApp account the shop's numbers belong to: the first active phone line that has one. */
async function firstWabaId(db: DbClient): Promise<string | null> {
  const [row] = await db
    .select({ wabaId: inboxPhoneNumber.wabaId })
    .from(inboxPhoneNumber)
    .where(and(eq(inboxPhoneNumber.kind, "phone"), eq(inboxPhoneNumber.isActive, true), isNotNull(inboxPhoneNumber.wabaId)))
    .orderBy(asc(inboxPhoneNumber.createdAt))
    .limit(1);
  return row?.wabaId ?? null;
}

/** Meta's phone number IDs of the active WhatsApp lines on an account. */
async function waNumbersOn(db: DbClient, wabaId: string): Promise<string[]> {
  const rows = await db
    .select({ id: inboxPhoneNumber.waPhoneNumberId })
    .from(inboxPhoneNumber)
    .where(
      and(
        eq(inboxPhoneNumber.kind, "phone"),
        eq(inboxPhoneNumber.isActive, true),
        eq(inboxPhoneNumber.wabaId, wabaId),
        isNotNull(inboxPhoneNumber.waPhoneNumberId),
      ),
    )
    .orderBy(asc(inboxPhoneNumber.createdAt));
  return rows.map((r) => r.id!).filter(Boolean);
}

/** A Meta refusal as a 422 the screen can show: plain words first, Meta's own beside them. */
function metaRefusal(err: unknown, reason: string, lead: string): BusinessError {
  if (!(err instanceof MetaApiError)) throw err;
  const code = metaCode(err);
  const cls = classifyCatalogueError(err);
  const plain =
    cls === "config"
      ? plainProblem(err.message, null, { code })
      : cls === "temporary"
        ? "Meta is busy or did not answer. Wait a minute and try again."
        : `Meta said: ${err.message}`;
  return new BusinessError("validation_failed", `${lead} ${plain}`, 422, {
    reason,
    meta_code: code,
    meta_message: err.message,
  });
}

export function catalogueRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/status", requireCapability("catalogue.manage"), async (c) => {
    const cfg = metaConfigFromEnv();
    let link = await getCatalogueLink(db);

    // Rule R17: a configuration problem clears the next time we can reach the catalogue again.
    if (link && link.problemKind === "config" && cfg) {
      try {
        await getCatalogue(cfg, link.catalogId);
        await db
          .update(catalogueLink)
          .set({ problemKind: null, problemCode: null, problemMessage: null, problemAt: null, updatedAt: new Date() })
          .where(eq(catalogueLink.id, link.id));
        await requestCatalogueSync(db, "problem_cleared");
        link = await getCatalogueLink(db);
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        // Still refused: the banner stays.
      }
    }

    const counts: Record<(typeof ITEM_STATES)[number], number> = { live: 0, pending: 0, sent: 0, rejected: 0, blocked: 0, removed: 0 };
    if (link) {
      const rows = await db
        .select({ state: catalogueItemSync.state, n: sql<number>`count(*)::int` })
        .from(catalogueItemSync)
        .where(eq(catalogueItemSync.linkId, link.id))
        .groupBy(catalogueItemSync.state);
      for (const row of rows) if (row.state in counts) counts[row.state as keyof typeof counts] = Number(row.n);
    }

    const wabaId = link?.wabaId ?? (await firstWabaId(db));
    const language = process.env.INBOX_TEMPLATE_LANGUAGE || "en";
    const found = wabaId
      ? await db
          .select({ name: inboxTemplate.name, status: inboxTemplate.status })
          .from(inboxTemplate)
          .where(
            and(eq(inboxTemplate.wabaId, wabaId), eq(inboxTemplate.language, language), inArray(inboxTemplate.name, [...ORDER_TEMPLATE_NAMES])),
          )
      : [];
    const templates = Object.fromEntries(
      ORDER_TEMPLATE_NAMES.map((name) => [name, found.find((t) => t.name === name)?.status.toUpperCase() ?? "missing"]),
    );

    const branch = await onlineBranch(db);
    return c.json({
      data: {
        configured: cfg !== null,
        link: link ? linkJson(link) : null,
        online_branch: branch ? { id: branch.id, name: branch.name } : null,
        counts,
        templates,
      },
    });
  });

  r.post("/link", requireCapability("catalogue.manage"), async (c) => {
    const parsed = z.object({ catalog_id: z.string().trim().regex(/^\d{5,30}$/) }).safeParse(await c.req.json());
    if (!parsed.success) {
      throw new BusinessError("validation_failed", "That doesn't look like a catalogue ID. It should be numbers only.", 400, { reason: "bad_catalog_id" });
    }
    const catalogId = parsed.data.catalog_id;
    if (await getCatalogueLink(db)) {
      throw new BusinessError("conflict", "A catalogue is already connected. Disconnect it first.", 409, { reason: "already_linked" });
    }
    const cfg = needConfig();

    let name: string | null;
    try {
      name = (await getCatalogue(cfg, catalogId)).name;
    } catch (err) {
      throw metaRefusal(err, "catalogue_unreachable", "Meta wouldn't let us open that catalogue. Check the ID, and check the system user has full control of it.");
    }

    // Is it already connected to our WhatsApp account (done in WhatsApp Manager)? Best effort.
    const wabaId = await firstWabaId(db);
    let connected = false;
    let commerce: { isCartEnabled: boolean; isCatalogVisible: boolean } | null = null;
    if (wabaId) {
      try {
        connected = (await listWabaCatalogues(cfg, wabaId)).some((x) => x.id === catalogId);
        const [first] = connected ? await waNumbersOn(db, wabaId) : [];
        if (first) commerce = await getCommerceSettings(cfg, first);
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
        logger.warn({ code: err.code }, "catalogue link: could not read the WhatsApp connection");
      }
    }

    let link: LinkRow | undefined;
    try {
      [link] = await db
        .insert(catalogueLink)
        .values({
          catalogId,
          name,
          wabaId,
          whatsappConnected: connected,
          isCartEnabled: commerce?.isCartEnabled ?? null,
          isCatalogVisible: commerce?.isCatalogVisible ?? null,
          createdBy: c.get("auth").userId,
        })
        .returning();
    } catch (err) {
      // Two people pressed Connect at once: the single-row index refused the second.
      if (pgErrorCode(err) === "23505") {
        throw new BusinessError("conflict", "A catalogue is already connected. Disconnect it first.", 409, { reason: "already_linked" });
      }
      throw err;
    }
    await audit(db, c, "catalogue.link", link!.id, { catalog_id: catalogId, name, whatsapp_connected: connected });
    return c.json({ data: linkJson(link!) }, 201);
  });

  r.delete("/link", requireCapability("catalogue.manage"), async (c) => {
    const link = await needLink(db);
    // Item and batch rows go with it (ON DELETE CASCADE). Nothing is deleted at Meta.
    await db.delete(catalogueLink).where(eq(catalogueLink.id, link.id));
    await audit(db, c, "catalogue.unlink", link.id, null, { catalog_id: link.catalogId, name: link.name });
    return c.json({ data: { ok: true } });
  });

  r.post("/connect-whatsapp", requireCapability("catalogue.manage"), async (c) => {
    z.object({ confirm: z.literal(true) }).parse(await c.req.json());
    const link = await needLink(db);
    const cfg = needConfig();
    const wabaId = link.wabaId ?? (await firstWabaId(db));
    if (!wabaId) throw new BusinessError("conflict", NO_WABA, 409, { reason: "no_whatsapp_account" });

    try {
      await connectCatalogueToWaba(cfg, wabaId, link.catalogId);
    } catch (err) {
      throw metaRefusal(err, "connect_refused", "WhatsApp would not connect this catalogue.");
    }

    // Connected. Now the cart and the menu button on every active number of the account.
    let commerce: { isCartEnabled: boolean; isCatalogVisible: boolean } | null = null;
    let warning: string | null = null;
    const numbers = await waNumbersOn(db, wabaId);
    try {
      for (const pnid of numbers) await setCommerceSettings(cfg, pnid, { isCartEnabled: true, isCatalogVisible: true });
      if (numbers[0]) commerce = await getCommerceSettings(cfg, numbers[0]);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      warning = `The catalogue is connected, but WhatsApp would not switch on the cart and the menu button. Try the two switches below. (Meta said: ${err.message})`;
    }
    const [updated] = await db
      .update(catalogueLink)
      .set({
        wabaId,
        whatsappConnected: true,
        ...(commerce ? { isCartEnabled: commerce.isCartEnabled, isCatalogVisible: commerce.isCatalogVisible } : {}),
        updatedAt: new Date(),
      })
      .where(eq(catalogueLink.id, link.id))
      .returning();
    await audit(db, c, "catalogue.connect_whatsapp", link.id, {
      catalog_id: link.catalogId,
      waba_id: wabaId,
      numbers: numbers.length,
      is_cart_enabled: commerce?.isCartEnabled ?? null,
      is_catalog_visible: commerce?.isCatalogVisible ?? null,
      ...(warning ? { warning } : {}),
    });
    return c.json({ data: { ...linkJson(updated!), ...(warning ? { warning } : {}) } });
  });

  const SettingsBody = z
    .object({
      sync_enabled: z.boolean().optional(),
      ask_fulfilment_auto: z.boolean().optional(),
      order_updates_enabled: z.boolean().optional(),
      is_cart_enabled: z.boolean().optional(),
      is_catalog_visible: z.boolean().optional(),
    })
    .strict()
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to change" });

  r.patch("/settings", requireCapability("catalogue.manage"), async (c) => {
    const body = SettingsBody.parse(await c.req.json());
    const link = await needLink(db);
    // The two switches that send messages without a person belong to the owner alone (foundation C6).
    if ((body.order_updates_enabled !== undefined || body.ask_fulfilment_auto !== undefined) && c.get("auth").role !== "owner") {
      throw new BusinessError("forbidden", "Only the owner can change this.", 403, { reason: "owner_only" });
    }

    const patch: Partial<typeof catalogueLink.$inferInsert> = {};
    if (body.sync_enabled !== undefined) patch.syncEnabled = body.sync_enabled;
    if (body.ask_fulfilment_auto !== undefined) patch.askFulfilmentAuto = body.ask_fulfilment_auto;
    if (body.order_updates_enabled !== undefined) patch.orderUpdatesEnabled = body.order_updates_enabled;

    // The cart and menu-button switches live at Meta: sent there first; a refusal changes nothing here.
    if (body.is_cart_enabled !== undefined || body.is_catalog_visible !== undefined) {
      const cfg = needConfig();
      if (!link.whatsappConnected || !link.wabaId) {
        throw new BusinessError("conflict", "The catalogue is not connected to WhatsApp yet.", 409, { reason: "catalogue_not_connected" });
      }
      const numbers = await waNumbersOn(db, link.wabaId);
      if (numbers.length === 0) throw new BusinessError("conflict", NO_WABA, 409, { reason: "no_whatsapp_account" });
      const change = {
        ...(body.is_cart_enabled !== undefined ? { isCartEnabled: body.is_cart_enabled } : {}),
        ...(body.is_catalog_visible !== undefined ? { isCatalogVisible: body.is_catalog_visible } : {}),
      };
      try {
        for (const pnid of numbers) await setCommerceSettings(cfg, pnid, change);
      } catch (err) {
        throw metaRefusal(err, "commerce_settings_refused", "WhatsApp would not make this change.");
      }
      if (body.is_cart_enabled !== undefined) patch.isCartEnabled = body.is_cart_enabled;
      if (body.is_catalog_visible !== undefined) patch.isCatalogVisible = body.is_catalog_visible;
    }

    const [updated] = await db
      .update(catalogueLink)
      .set({
        ...patch,
        // Switching sync on starts a pass straight away.
        ...(body.sync_enabled === true && !link.syncEnabled ? { syncRequestedAt: sql`clock_timestamp()`, syncRequestReason: "sync_enabled" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(catalogueLink.id, link.id))
      .returning();
    const keys = Object.keys(body) as (keyof typeof body)[];
    const before = linkJson(link);
    const after = linkJson(updated!);
    await audit(
      db,
      c,
      "catalogue.settings",
      link.id,
      Object.fromEntries(keys.map((k) => [k, after[k]])),
      Object.fromEntries(keys.map((k) => [k, before[k]])),
    );
    return c.json({ data: after });
  });

  r.post("/sync", requireCapability("catalogue.manage"), async (c) => {
    const { mode } = z.object({ mode: z.enum(["changes", "full"]) }).parse(await c.req.json());
    const link = await needLink(db);
    await db
      .update(catalogueLink)
      .set({
        syncRequestedAt: sql`clock_timestamp()`,
        syncRequestReason: mode === "full" ? "full_sync" : "sync_now",
        ...(mode === "full" ? { fullSyncRequestedAt: sql`clock_timestamp()` } : {}),
      })
      .where(eq(catalogueLink.id, link.id));
    await audit(db, c, "catalogue.sync_requested", link.id, { mode });
    return c.json({ data: { queued: true } }, 202);
  });

  function itemJson(row: typeof catalogueItemSync.$inferSelect) {
    const problemPlain =
      row.state === "blocked"
        ? plainProblem(null, null, { blockedReason: row.blockedReason })
        : row.state === "rejected"
          ? plainProblem(row.problemMessage, row.reviewStatus, { code: row.problemCode })
          : null;
    return {
      id: row.id,
      retailer_id: row.retailerId,
      title: row.title,
      state: row.state,
      price_ngn: priceNgnFromMetaPrice(row.desired?.price),
      availability: row.desired?.availability ?? null,
      picture_url: row.desired?.image?.[0]?.url ?? null,
      problem_plain: problemPlain,
      problem_raw: row.state === "rejected" ? row.problemMessage : null,
      review_status: row.reviewStatus,
      pushed_at: row.pushedAt,
      checked_at: row.checkedAt,
    };
  }

  r.get("/items", requireCapability("catalogue.manage"), async (c) => {
    const q = z
      .object({
        state: z.enum(ITEM_STATES).optional(),
        q: z.string().trim().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const link = await getCatalogueLink(db);
    if (!link) return c.json({ data: { items: [], total: 0 } });
    const where: SQL[] = [eq(catalogueItemSync.linkId, link.id)];
    if (q.state) where.push(eq(catalogueItemSync.state, q.state));
    if (q.q) where.push(ilike(catalogueItemSync.title, `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
    const rank = sql`case ${catalogueItemSync.state} when 'rejected' then 0 when 'blocked' then 1 when 'pending' then 2 when 'sent' then 3 when 'live' then 4 else 5 end`;
    const rows = await db
      .select()
      .from(catalogueItemSync)
      .where(and(...where))
      .orderBy(rank, asc(catalogueItemSync.title), asc(catalogueItemSync.retailerId))
      .limit(q.limit)
      .offset(q.offset);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(catalogueItemSync)
      .where(and(...where));
    return c.json({ data: { items: rows.map(itemJson), total: Number(n) } });
  });

  r.post("/items/:id/retry", requireCapability("catalogue.manage"), async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) throw new BusinessError("not_found", "item not found", 404);
    const [row] = await db
      .update(catalogueItemSync)
      .set({ state: "pending", pushedHash: null, problemCode: null, problemMessage: null, reviewStatus: null, updatedAt: new Date() })
      .where(eq(catalogueItemSync.id, id))
      .returning();
    if (!row) throw new BusinessError("not_found", "item not found", 404);
    await requestCatalogueSync(db, "retry");
    await writeAudit(db, c, { action: "catalogue.item_retry", entityType: "catalogue_item_sync", entityId: row.id, after: { retailer_id: row.retailerId, title: row.title }, notify: false });
    return c.json({ data: itemJson(row) });
  });

  /** What staff may send in a chat: items Meta holds (or is about to), for the product picker. */
  r.get("/sendable", requireCapability("inbox.reply"), async (c) => {
    const q = z.object({ q: z.string().trim().max(100).optional() }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const link = await getCatalogueLink(db);
    if (!link || !link.whatsappConnected) return c.json({ data: { catalog_id: null, items: [] } });
    const where: SQL[] = [
      eq(catalogueItemSync.linkId, link.id),
      inArray(catalogueItemSync.state, ["live", "sent"]),
      sql`${catalogueItemSync.desired} is not null and jsonb_typeof(${catalogueItemSync.desired}) = 'object'`,
    ];
    if (q.q) where.push(ilike(catalogueItemSync.title, `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
    const rows = await db
      .select({ item: catalogueItemSync, category: product.category })
      .from(catalogueItemSync)
      .leftJoin(product, eq(product.id, catalogueItemSync.productId))
      .where(and(...where))
      .orderBy(asc(product.displayOrder), asc(catalogueItemSync.title))
      .limit(500);
    return c.json({
      data: {
        catalog_id: link.catalogId,
        items: rows.map(({ item, category }) => ({
          retailer_id: item.retailerId,
          title: item.title,
          price_ngn: priceNgnFromMetaPrice(item.desired?.price),
          availability: item.desired?.availability ?? null,
          picture_url: item.desired?.image?.[0]?.url ?? null,
          category: category ?? null,
        })),
      },
    });
  });

  return r;
}
