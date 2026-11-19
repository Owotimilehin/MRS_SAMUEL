/**
 * Catalogue sync (suite spec 08): the shop's sizes copied to one Meta catalogue.
 *
 *   - pure helpers: ids, prices, hashing, batch requests, WhatsApp product
 *     message builders, plain-English problems, error classes
 *   - reads of the shop (computeDesiredItems) and the "something changed" flag
 *   - Graph calls (Catalog Batch API, catalogue and commerce settings)
 *   - the sync engine: syncCatalogue, checkOpenBatches, reconcileCatalogue
 *
 * Carts and chat orders live in catalogue-chat.ts.
 *
 * Nothing leaves the server unless catalogue_link.sync_enabled is true (rule
 * R13). Every create and update is an upsert and every removal a delete keyed
 * by id, so sending a batch twice is harmless (rule R15). The local batch row
 * is committed before Meta is called (foundation rule 9).
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  branch,
  catalogueBatch,
  catalogueItemSync,
  catalogueLink,
  outboxEvent,
  productVariant,
  type DbClient,
  type DbExecutor,
  type MetaItemData,
} from "@ms/db";
import { PAY_BUTTON_TEXT } from "@ms/shared";
import { availableVariantAtBranch } from "../availability.js";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";

export type { MetaItemData, ChatCartLine } from "@ms/db";
export { formatNaira } from "@ms/shared";

// ── Ids, money, hashing ──────────────────────────────────────────────────────

export const RETAILER_PREFIX = "v-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Meta item id for a size: "v-" + product_variant.id. Never changes. */
export function retailerIdForVariant(variantId: string): string {
  return RETAILER_PREFIX + variantId;
}

/** The size behind a Meta item id; null unless it is "v-" + a uuid (ours). */
export function variantIdFromRetailerId(retailerId: string): string | null {
  if (typeof retailerId !== "string" || !retailerId.startsWith(RETAILER_PREFIX)) return null;
  const id = retailerId.slice(RETAILER_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Whole naira as Meta wants a price: "1500.00 NGN". The shop stores no kobo. */
export function metaPrice(priceNgn: number): string {
  if (!Number.isInteger(priceNgn) || priceNgn <= 0) throw new Error(`metaPrice: not a positive whole-naira amount: ${priceNgn}`);
  return `${priceNgn}.00 NGN`;
}

/** The naira amount in a price we built with metaPrice, or null. */
export function priceNgnFromMetaPrice(price: string | null | undefined): number | null {
  const m = /^(\d+)\.00 NGN$/.exec(price ?? "");
  return m ? Number(m[1]) : null;
}

/** sha256 hex of the item with its keys in the order of MetaItemData. "" for null. */
export function hashItem(data: MetaItemData | null): string {
  if (!data) return "";
  const ordered: MetaItemData = {
    id: data.id,
    title: data.title,
    description: data.description,
    availability: data.availability,
    condition: data.condition,
    price: data.price,
    link: data.link,
    image: data.image.map((i) => ({ url: i.url })),
    brand: data.brand,
    item_group_id: data.item_group_id,
    size: data.size,
    google_product_category: data.google_product_category,
  };
  return crypto.createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

// ── What the shop says Meta should hold ──────────────────────────────────────

export const CATALOGUE_BRAND = "Mrs. Samuel";
export const CATALOGUE_CATEGORY = "Food, Beverages & Tobacco > Beverages > Juice";

export interface DesiredItem {
  retailerId: string;
  variantId: string;
  productId: string;
  title: string;
  /** null = must not exist at Meta. */
  data: MetaItemData | null;
  blockedReason: "no_picture" | "no_price" | null;
}

/** Rule R3: plain text, no HTML, no links, not all capitals, at most 5000 characters. */
export function itemDescription(p: { name: string; story: string | null; tagline: string | null; ingredients: string[] | null }, sizeMl: number): string {
  const clean = (v: string | null | undefined): string =>
    (v ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  const ingredients = (p.ingredients ?? []).map((i) => clean(i)).filter(Boolean);
  const candidates = [
    clean(p.story),
    clean(p.tagline),
    ingredients.length ? `Made with ${ingredients.join(", ")}.` : "",
    `${clean(p.name)} fruit juice, ${sizeMl}ml.`,
  ];
  let text = candidates.find((c) => c.length > 0) ?? "";
  // "Not all capitals": with no lower-case letter at all, use sentence case.
  if (text && !/[a-z]/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  return text.slice(0, 5000);
}

/** Rule R4: the flavour's picture as an absolute http(s) address, or null. */
export function itemPictureUrl(imageUrl: string | null, bottleUrl: string | null, storefrontBase: string): string | null {
  const raw = (imageUrl ?? "").trim() || (bottleUrl ?? "").trim();
  if (!raw) return null;
  const abs = raw.startsWith("/") ? `${storefrontBase.replace(/\/+$/, "")}${raw}` : raw;
  return /^https?:\/\/\S+$/i.test(abs) ? abs : null;
}

/** The branch that takes online orders: is_online_default, active and not deleted. Null when there is none. */
export async function onlineBranch(db: DbExecutor): Promise<{ id: string; name: string; address: string | null } | null> {
  const [row] = await db
    .select({ id: branch.id, name: branch.name, address: branch.address })
    .from(branch)
    .where(and(eq(branch.isOnlineDefault, true), eq(branch.isActive, true), sql`${branch.deletedAt} is null`))
    .limit(1);
  return row ?? null;
}

type ShopVariantRow = {
  variant_id: string;
  product_id: string;
  size_ml: number;
  variant_active: boolean;
  variant_deleted: boolean;
  preorder_only: boolean;
  name: string;
  slug: string;
  story: string | null;
  tagline: string | null;
  ingredients: string[] | null;
  image_url: string | null;
  product_active: boolean;
  product_deleted: boolean;
  bottle_url: string | null;
  price_ngn: number | null;
  [key: string]: unknown;
};

/**
 * Read the shop and say what Meta should hold: one entry per size (rule R1),
 * including retired and deleted sizes (data null), so their items are removed.
 * Pure SQL reads; no Meta call.
 */
export async function computeDesiredItems(db: DbExecutor, opts: { storefrontBase: string }): Promise<DesiredItem[]> {
  const base = opts.storefrontBase.replace(/\/+$/, "");
  const rows = await db.execute<ShopVariantRow>(sql`
    SELECT pv.id AS variant_id, pv.product_id, pv.size_ml,
           pv.is_active AS variant_active, (pv.deleted_at IS NOT NULL) AS variant_deleted, pv.preorder_only,
           p.name, p.slug, p.story, p.tagline, p.ingredients, p.image_url,
           p.is_active AS product_active, (p.deleted_at IS NOT NULL) AS product_deleted,
           bot.url AS bottle_url,
           (SELECT pp.price_ngn FROM product_price pp
             WHERE pp.variant_id = pv.id AND pp.valid_to IS NULL
             ORDER BY pp.valid_from DESC LIMIT 1) AS price_ngn
    FROM product_variant pv
    JOIN product p ON p.id = pv.product_id
    LEFT JOIN media_asset bot ON bot.id = p.bottle_asset_id
    ORDER BY p.display_order ASC, p.name ASC, pv.size_ml ASC
  `);
  const online = await onlineBranch(db);
  const out: DesiredItem[] = [];
  for (const r of rows) {
    const retailerId = retailerIdForVariant(r.variant_id);
    const title = `${r.name} ${r.size_ml}ml`.slice(0, 100);
    const item: DesiredItem = { retailerId, variantId: r.variant_id, productId: r.product_id, title, data: null, blockedReason: null };
    out.push(item);
    // Rule R5: hidden, retired and deleted sizes must not exist at Meta.
    const visible = r.product_active && !r.product_deleted && r.variant_active && !r.variant_deleted;
    if (!visible) continue;
    const price = r.price_ngn == null ? null : Number(r.price_ngn);
    if (price == null || !Number.isInteger(price) || price <= 0) {
      item.blockedReason = "no_price";
      continue;
    }
    const picture = itemPictureUrl(r.image_url, r.bottle_url, base);
    if (!picture) {
      item.blockedReason = "no_picture";
      continue;
    }
    // Rule R6: stock by the shop's own rule, at the online branch, right now. No numbers are sent.
    let inStock = false;
    if (online && !r.preorder_only) {
      inStock = (await availableVariantAtBranch(db, { branchId: online.id, variantId: r.variant_id })) > 0;
    }
    item.data = {
      id: retailerId,
      title,
      description: itemDescription(r, r.size_ml),
      availability: inStock ? "in stock" : "out of stock",
      condition: "new",
      price: metaPrice(price),
      link: `${base}/juices/${r.slug}`,
      image: [{ url: picture }],
      brand: CATALOGUE_BRAND,
      item_group_id: r.product_id,
      size: `${r.size_ml} ml`,
      google_product_category: CATALOGUE_CATEGORY,
    };
  }
  return out;
}

/**
 * Mark that the shop changed. One UPDATE on catalogue_link; a no-op when no
 * row exists. Safe inside any transaction; never calls Meta.
 */
export async function requestCatalogueSync(db: DbExecutor, reason: string): Promise<void> {
  await db
    .update(catalogueLink)
    .set({ syncRequestedAt: sql`clock_timestamp()`, syncRequestReason: reason.slice(0, 80) });
}

// ── Graph calls (system-user token) ──────────────────────────────────────────

export type BatchRequest = { method: "UPDATE" | "DELETE"; data: MetaItemData | { id: string } };

/** Rule R8: UPDATE (an upsert) for an item that should exist, DELETE with only its id otherwise. CREATE is never used. */
export function buildBatchRequests(rows: { retailerId: string; data: MetaItemData | null }[]): BatchRequest[] {
  return rows.map((r) => (r.data ? { method: "UPDATE", data: r.data } : { method: "DELETE", data: { id: r.retailerId } }));
}

export interface BatchValidation {
  retailer_id: string;
  errors: { message: string }[];
  warnings: { message: string }[];
}

type BatchResponse = { handles?: unknown; validation_status?: unknown };

function readBatchResponse(res: BatchResponse | null): { handle: string | null; validation: BatchValidation[] } {
  const handles = Array.isArray(res?.handles) ? res.handles : [];
  const handle = typeof handles[0] === "string" && handles[0] ? handles[0] : null;
  const messages = (v: unknown): { message: string }[] =>
    (Array.isArray(v) ? v : [])
      .map((e) => ({ message: String((e as { message?: unknown } | null)?.message ?? "").trim() }))
      .filter((e) => e.message);
  const validation = (Array.isArray(res?.validation_status) ? res.validation_status : [])
    .map((v) => {
      const row = (v ?? {}) as { retailer_id?: unknown; errors?: unknown; warnings?: unknown };
      return { retailer_id: String(row.retailer_id ?? ""), errors: messages(row.errors), warnings: messages(row.warnings) };
    })
    .filter((v) => v.retailer_id);
  return { handle, validation };
}

/**
 * POST /{catalog-id}/items_batch. `requests` is sent as a JSON array; if Meta
 * answers code 100 (invalid parameter) it is sent once more as a JSON string,
 * the form Meta's older examples use ([unverified] which one it wants).
 */
export async function sendItemsBatch(
  cfg: MetaConfig,
  catalogId: string,
  requests: unknown[],
): Promise<{ handle: string | null; validation: BatchValidation[] }> {
  const path = `${catalogId}/items_batch`;
  try {
    return readBatchResponse(await graph<BatchResponse>(cfg, "POST", path, { item_type: "PRODUCT_ITEM", requests }));
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.code !== "100" || err.delivery !== "not_sent") throw err;
    return readBatchResponse(
      await graph<BatchResponse>(cfg, "POST", path, { item_type: "PRODUCT_ITEM", requests: JSON.stringify(requests) }),
    );
  }
}

/** GET /{catalog-id}/check_batch_request_status for one handle. */
export async function checkBatch(
  cfg: MetaConfig,
  catalogId: string,
  handle: string,
): Promise<{ status: string; errorsTotal: number; errors: { id: string; message: string }[]; invalidIds: string[] }> {
  const res = await graph<{ data?: unknown[] }>(
    cfg,
    "GET",
    `${catalogId}/check_batch_request_status?handle=${encodeURIComponent(handle)}&load_ids_of_invalid_requests=true`,
  );
  const d = ((res?.data ?? [])[0] ?? {}) as {
    status?: unknown;
    errors_total_count?: unknown;
    errors?: unknown;
    ids_of_invalid_requests?: unknown;
  };
  const errors = (Array.isArray(d.errors) ? d.errors : [])
    .map((e) => {
      const row = (e ?? {}) as { id?: unknown; message?: unknown };
      return { id: String(row.id ?? ""), message: String(row.message ?? "").trim() };
    })
    .filter((e) => e.id);
  return {
    status: String(d.status ?? ""),
    errorsTotal: Number(d.errors_total_count ?? 0) || 0,
    errors,
    invalidIds: (Array.isArray(d.ids_of_invalid_requests) ? d.ids_of_invalid_requests : []).map((v) => String(v)).filter(Boolean),
  };
}

export interface MetaListedItem {
  retailerId: string;
  availability: string | null;
  reviewStatus: string | null;
  problem: string | null;
}

/** Every item in the catalogue as Meta holds it (follows paging, at most 50 pages of 200). */
export async function listMetaItems(cfg: MetaConfig, catalogId: string): Promise<MetaListedItem[]> {
  const out: MetaListedItem[] = [];
  let next: string | null =
    `${catalogId}/products?fields=id,retailer_id,availability,price,review_status,review_rejection_reasons,errors&limit=200`;
  for (let page = 0; next && page < 50; page++) {
    const res: { data?: unknown[]; paging?: { next?: string } } = await graph(cfg, "GET", next);
    for (const raw of res?.data ?? []) {
      const it = (raw ?? {}) as {
        retailer_id?: unknown;
        availability?: unknown;
        review_status?: unknown;
        review_rejection_reasons?: unknown;
        errors?: unknown;
      };
      const retailerId = String(it.retailer_id ?? "");
      if (!retailerId) continue;
      const parts: string[] = [];
      for (const e of Array.isArray(it.errors) ? it.errors : []) {
        const row = (e ?? {}) as { title?: unknown; description?: unknown; message?: unknown };
        const text = [row.title, row.description ?? row.message].filter((v) => typeof v === "string" && v.trim()).join(": ");
        if (text) parts.push(text);
      }
      for (const r of Array.isArray(it.review_rejection_reasons) ? it.review_rejection_reasons : []) {
        if (typeof r === "string" && r.trim()) parts.push(r.trim());
      }
      out.push({
        retailerId,
        availability: typeof it.availability === "string" ? it.availability : null,
        reviewStatus: typeof it.review_status === "string" && it.review_status ? it.review_status : null,
        problem: parts.length ? parts.join("; ") : null,
      });
    }
    next = res?.paging?.next ?? null;
  }
  return out;
}

export async function getCatalogue(cfg: MetaConfig, catalogId: string): Promise<{ id: string; name: string | null }> {
  const res = await graph<{ id?: string; name?: string }>(cfg, "GET", `${catalogId}?fields=id,name,product_count,vertical`);
  return { id: String(res?.id ?? catalogId), name: typeof res?.name === "string" && res.name ? res.name : null };
}

export async function listWabaCatalogues(cfg: MetaConfig, wabaId: string): Promise<{ id: string; name?: string }[]> {
  const res = await graph<{ data?: { id?: string; name?: string }[] }>(cfg, "GET", `${wabaId}/product_catalogs`);
  return (res?.data ?? [])
    .filter((c) => c && c.id != null)
    .map((c) => ({ id: String(c.id), ...(typeof c.name === "string" ? { name: c.name } : {}) }));
}

export async function connectCatalogueToWaba(cfg: MetaConfig, wabaId: string, catalogId: string): Promise<void> {
  const res = await graph<{ success?: boolean }>(cfg, "POST", `${wabaId}/product_catalogs`, { catalog_id: catalogId });
  if (res?.success !== true) throw new MetaApiError("Meta did not confirm the catalogue was connected", 502, null, false);
}

export async function getCommerceSettings(
  cfg: MetaConfig,
  waPhoneNumberId: string,
): Promise<{ isCartEnabled: boolean; isCatalogVisible: boolean } | null> {
  const res = await graph<{ data?: { is_cart_enabled?: boolean; is_catalog_visible?: boolean }[] }>(
    cfg,
    "GET",
    `${waPhoneNumberId}/whatsapp_commerce_settings`,
  );
  const d = res?.data?.[0];
  if (!d) return null;
  return { isCartEnabled: d.is_cart_enabled === true, isCatalogVisible: d.is_catalog_visible === true };
}

export async function setCommerceSettings(
  cfg: MetaConfig,
  waPhoneNumberId: string,
  s: { isCartEnabled?: boolean; isCatalogVisible?: boolean },
): Promise<void> {
  const q: string[] = [];
  if (s.isCartEnabled !== undefined) q.push(`is_cart_enabled=${s.isCartEnabled ? "true" : "false"}`);
  if (s.isCatalogVisible !== undefined) q.push(`is_catalog_visible=${s.isCatalogVisible ? "true" : "false"}`);
  if (q.length === 0) return;
  const res = await graph<{ success?: boolean }>(cfg, "POST", `${waPhoneNumberId}/whatsapp_commerce_settings?${q.join("&")}`);
  if (res?.success !== true) throw new MetaApiError("Meta did not confirm the change", 502, null, false);
}

// ── Errors and plain words ───────────────────────────────────────────────────

const CATALOGUE_CONFIG_CODES = new Set(["190", "10", "200", "299", "283"]);
const CATALOGUE_TEMPORARY_CODES = new Set([
  "4", "17", "32", "613",
  // Foundation C3 and spec 3.6: Meta's rate limits (catalogue 80014, batch status 80009, WhatsApp account 80008, …).
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014",
]);

/**
 * Foundation D10 with section 3.6, for the catalogue and commerce calls.
 * Named for its API (foundation ruling 9.2.5); the spec's working name was classifyMetaError.
 */
export function classifyCatalogueError(err: unknown): "config" | "temporary" | "refusal" {
  if (!(err instanceof MetaApiError)) return "refusal";
  const code = err.code ?? "";
  if (CATALOGUE_CONFIG_CODES.has(code)) return "config";
  if (CATALOGUE_TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500) return "temporary";
  // Never connected, or no answer at all: nothing was refused.
  if (err.status === 0) return "temporary";
  return "refusal";
}

export const BLOCKED_PLAIN: Record<"no_picture" | "no_price", string> = {
  no_picture: "This juice has no picture. Add one in the shop admin.",
  no_price: "This size has no price. Set one in the shop admin.",
};

/**
 * Meta's words turned into shop English (rule R12). `extra.blockedReason` is
 * our own reason for not sending an item; `extra.code` is the Meta error code
 * of an account-level failure. Both are checked before the wording of `raw`,
 * because an access error's message can contain any of the item keywords.
 */
export function plainProblem(
  raw: string | null,
  reviewStatus?: string | null,
  extra: { blockedReason?: string | null; code?: string | null } = {},
): string {
  if (extra.blockedReason === "no_picture" || extra.blockedReason === "no_price") return BLOCKED_PLAIN[extra.blockedReason];
  const code = (extra.code ?? "").split("/")[0] ?? "";
  if (code === "190") return "Our connection to Meta has expired.";
  if (code === "10" || code === "200" || code === "299" || code === "283") {
    return "Meta says we do not have permission to manage this catalogue. Check the system user still has full control of it.";
  }
  const text = (raw ?? "").trim();
  const has = (...words: string[]) => words.some((w) => text.toLowerCase().includes(w));
  if ((reviewStatus ?? "").toLowerCase() === "rejected" || has("policy", "commerce", "not allowed")) {
    return "Meta's review turned this item down under its selling rules. Open Commerce Manager to see why or to ask for another review.";
  }
  if (has("image", "photo", "picture")) {
    return "Meta could not use this picture. It must be a JPG or PNG, at least 500 by 500 pixels and under 8 MB, at a web address anyone can open.";
  }
  if (has("price", "currency")) return "Meta did not accept the price. Check the price in the shop admin.";
  if (has("link", "url", "domain")) {
    return "Meta did not accept the web address for this juice. Check the juice's page opens on the website.";
  }
  if (has("title", "name")) return "Meta did not accept the name. Keep it under 100 characters and avoid ALL CAPITALS.";
  if (has("description")) return "Meta did not accept the description. Use plain sentences with no web links.";
  return text ? `Meta refused this item. Its message was: “${text}”` : "Meta refused this item.";
}

// ── WhatsApp message builders (pure). Each returns the `interactive` object. ──

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** One product. A product message cannot have a header; the body is optional. */
export function buildProductMessage(catalogId: string, retailerId: string, text?: string): Record<string, unknown> {
  const body = text?.trim();
  return {
    type: "product",
    ...(body ? { body: { text: cut(body, 1024) } } : {}),
    action: { catalog_id: catalogId, product_retailer_id: retailerId },
  };
}

/** Two to thirty products. A text header is required; section titles are cut to 24 characters; empty sections are left out. */
export function buildProductListMessage(
  catalogId: string,
  o: { header: string; body: string; sections: { title: string; retailerIds: string[] }[] },
): Record<string, unknown> {
  const header = o.header.trim();
  const body = o.body.trim();
  if (!header) throw new Error("buildProductListMessage: a product list needs a text header");
  if (!body) throw new Error("buildProductListMessage: a product list needs a body");
  const sections = o.sections
    .filter((s) => s.retailerIds.length > 0)
    .map((s) => ({
      title: cut(s.title.trim(), 24),
      product_items: s.retailerIds.map((id) => ({ product_retailer_id: id })),
    }));
  if (sections.length === 0) throw new Error("buildProductListMessage: no products");
  return {
    type: "product_list",
    header: { type: "text", text: cut(header, 60) },
    body: { text: cut(body, 1024) },
    action: { catalog_id: catalogId, sections },
  };
}

/** The whole menu. `parameters` is left out when no thumbnail is given. */
export function buildCatalogueMessage(body: string, thumbnailRetailerId?: string): Record<string, unknown> {
  return {
    type: "catalog_message",
    body: { text: cut(body.trim(), 1024) },
    action: {
      name: "catalog_message",
      ...(thumbnailRetailerId ? { parameters: { thumbnail_product_retailer_id: thumbnailRetailerId } } : {}),
    },
  };
}

/** Rule R24: "Delivery" and "Pickup" reply buttons whose ids carry the chat order. */
export function buildFulfilmentButtons(chatOrderId: string, body: string): Record<string, unknown> {
  return {
    type: "button",
    body: { text: cut(body, 1024) },
    action: {
      buttons: [
        { type: "reply", reply: { id: `co:${chatOrderId}:delivery`, title: "Delivery" } },
        { type: "reply", reply: { id: `co:${chatOrderId}:pickup`, title: "Pickup" } },
      ],
    },
  };
}

/** Rule R27: the payment message, a link button reading "Pay now". */
export function buildPayButton(body: string, url: string): Record<string, unknown> {
  return {
    type: "cta_url",
    body: { text: cut(body, 1024) },
    action: { name: "cta_url", parameters: { display_text: PAY_BUTTON_TEXT, url } },
  };
}

// ── The sync engine ──────────────────────────────────────────────────────────

type LinkRow = typeof catalogueLink.$inferSelect;
type ItemRow = typeof catalogueItemSync.$inferSelect;

export const CATALOGUE_BATCH_MAX = 500;
/** A batch still "queued" after this long was never sent (the process died between the commit and the call). */
const QUEUED_STALE_MS = 2 * 60_000;
/** After this many status checks (about 20 minutes) a batch is given up as lost and its items are sent again. */
export const CATALOGUE_MAX_CHECKS = 60;
/** Stands in for "Meta holds something we did not send": never equals a real hash, so the row is pushed again. */
const UNKNOWN_AT_META = "unknown";

export async function getCatalogueLink(db: DbExecutor): Promise<LinkRow | null> {
  const [row] = await db.select().from(catalogueLink).limit(1);
  return row ?? null;
}

/** Section 6.1: is a sync pass due? (Whether one may run at all is decided inside syncCatalogue.) */
export function catalogueSyncDue(link: LinkRow, now: Date = new Date()): boolean {
  if (!link.syncEnabled || link.problemKind === "config") return false;
  if (link.fullSyncRequestedAt) return true;
  if (!link.lastSyncAt) return true;
  if (link.syncRequestedAt && link.syncRequestedAt.getTime() > link.lastSyncAt.getTime()) return true;
  return now.getTime() - link.lastSyncAt.getTime() >= 60_000;
}

/** Section 6.3: the nightly reconcile runs in the 02:00 hour, Lagos time, at most once every 20 hours. */
export function catalogueReconcileDue(link: LinkRow, now: Date = new Date()): boolean {
  if (!link.syncEnabled || link.problemKind === "config") return false;
  const lagosHour = new Date(now.getTime() + 3_600_000).getUTCHours(); // Africa/Lagos is UTC+1, no DST
  if (lagosHour !== 2) return false;
  return !link.lastReconcileAt || now.getTime() - link.lastReconcileAt.getTime() > 20 * 3_600_000;
}

/** How long to wait after `failures` failed batches in a row: 30 s × 2^n, at most 15 minutes. */
export function catalogueBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(30_000 * 2 ** Math.min(failures, 10), 15 * 60_000);
}

/**
 * Section 6.5: tell the owner, at most once in 24 hours, that Meta has stopped
 * accepting our updates. The same check as alertOnce in the API (payload.account).
 * The worker's outbox has the matching case (ruling 9.2.10).
 */
export async function raiseCatalogueAlert(db: DbExecutor, catalogId: string, code: string | null, message: string): Promise<boolean> {
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, "catalogue.sync_blocked"),
        sql`${outboxEvent.createdAt} > now() - interval '24 hours'`,
        sql`${outboxEvent.payload}->>'account' = ${catalogId}`,
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(outboxEvent).values({
    eventType: "catalogue.sync_blocked",
    payload: { account: catalogId, code: code ?? "", message: message.slice(0, 500) },
  });
  return true;
}

/** Record an account-level failure for the banner; a configuration problem also alerts the owner. */
async function recordLinkProblem(db: DbExecutor, link: LinkRow, kind: "config" | "temporary", err: unknown): Promise<void> {
  const e = err instanceof MetaApiError ? err : null;
  const code = e?.code ? (e.subcode ? `${e.code}/${e.subcode}` : e.code) : null;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  await db
    .update(catalogueLink)
    .set({ problemKind: kind, problemCode: code, problemMessage: message, problemAt: new Date(), updatedAt: new Date() })
    .where(eq(catalogueLink.id, link.id));
  if (kind === "config") await raiseCatalogueAlert(db, link.catalogId, code, message);
}

async function clearLinkProblem(db: DbExecutor, link: LinkRow): Promise<void> {
  if (link.problemKind === null && link.problemCode === null && link.problemMessage === null) return;
  await db
    .update(catalogueLink)
    .set({ problemKind: null, problemCode: null, problemMessage: null, problemAt: null, updatedAt: new Date() })
    .where(eq(catalogueLink.id, link.id));
}

/** Put a batch's items that are still "sent" back to "pending". */
async function releaseBatchItems(db: DbExecutor, batchId: string, countAttempt: boolean): Promise<void> {
  await db
    .update(catalogueItemSync)
    .set({
      state: "pending",
      ...(countAttempt ? { attempts: sql`${catalogueItemSync.attempts} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(catalogueItemSync.batchId, batchId), eq(catalogueItemSync.state, "sent")));
}

const NOTHING = { pushed: 0, removed: 0, blocked: 0 };

/**
 * One pass of the sync engine (section 6.1). Makes no Meta call when there is
 * no link, sync is switched off, a configuration problem is set, a batch is
 * still in flight, or we are waiting after failed batches.
 */
export async function syncCatalogue(
  db: DbClient,
  cfg: MetaConfig,
  opts: { storefrontBase: string; force?: boolean; kind?: "changes" | "full" | "reconcile" },
): Promise<{ pushed: number; removed: number; blocked: number }> {
  const link = await getCatalogueLink(db);
  if (!link || !link.syncEnabled || link.problemKind === "config") return { ...NOTHING };
  const kind = opts.kind ?? (opts.force ? "full" : "changes");
  const now = new Date();

  // A batch we queued but never sent (the process stopped in between): nothing reached Meta, so send its items again.
  const stale = await db
    .update(catalogueBatch)
    .set({ state: "lost", errorMessage: "Never sent: the server stopped before the call to Meta.", finishedAt: now })
    .where(
      and(
        eq(catalogueBatch.linkId, link.id),
        eq(catalogueBatch.state, "queued"),
        lt(catalogueBatch.createdAt, new Date(now.getTime() - QUEUED_STALE_MS)),
      ),
    )
    .returning({ id: catalogueBatch.id });
  for (const b of stale) await releaseBatchItems(db, b.id, false);

  // Rule R9: one batch in flight at a time.
  const [inFlight] = await db
    .select({ id: catalogueBatch.id })
    .from(catalogueBatch)
    .where(and(eq(catalogueBatch.linkId, link.id), inArray(catalogueBatch.state, ["queued", "open"])))
    .limit(1);
  if (inFlight) return { ...NOTHING };

  // Wait after failed batches: 30 s × 2^n, at most 15 minutes.
  const recent = await db
    .select({ state: catalogueBatch.state, createdAt: catalogueBatch.createdAt })
    .from(catalogueBatch)
    .where(eq(catalogueBatch.linkId, link.id))
    .orderBy(desc(catalogueBatch.createdAt))
    .limit(12);
  let failures = 0;
  for (const b of recent) {
    if (b.state !== "failed" && b.state !== "lost") break;
    failures++;
  }
  if (failures > 0 && now.getTime() - recent[0]!.createdAt.getTime() < catalogueBackoffMs(failures)) return { ...NOTHING };

  // The database's clock at the start of the pass. A change flagged while the pass runs is later
  // than this, so it gets its own pass straight after.
  const clock = await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`);
  const startedAt = sql`${(clock as unknown as { t: string }[])[0]!.t}::timestamptz`;

  // 1. What the shop says.
  const desired = await computeDesiredItems(db, { storefrontBase: opts.storefrontBase });

  // 2 to 5. One transaction: bring our rows up to date, pick the batch, save it.
  const prepared = await db.transaction(async (tx) => {
    const existing = await tx.select().from(catalogueItemSync).where(eq(catalogueItemSync.linkId, link.id));
    const byRetailer = new Map(existing.map((r) => [r.retailerId, r] as const));
    const seen = new Set<string>();
    let blocked = 0;

    const nextState = (row: ItemRow | undefined, d: { data: MetaItemData | null; blockedReason: string | null }, hash: string): string => {
      if (d.blockedReason) return "blocked";
      const pushed = row?.pushedHash ?? null;
      // 3. Never pushed and not wanted: nothing to remove.
      if (d.data === null && pushed === null) return "removed";
      if (pushed !== null && pushed === hash) {
        // Meta already holds exactly this. Leave the state alone, except a row that was only blocked.
        if (!row || row.state === "blocked") return d.data ? "live" : "removed";
        return row.state;
      }
      // Rule R11: a refused item waits for a change or for a person.
      if (row?.state === "rejected" && (row.desiredHash ?? "") === hash) return "rejected";
      return "pending";
    };

    for (const d of desired) {
      seen.add(d.retailerId);
      const row = byRetailer.get(d.retailerId);
      const hash = hashItem(d.data);
      const state = nextState(row, d, hash);
      if (state === "blocked") blocked++;
      if (!row) {
        await tx
          .insert(catalogueItemSync)
          .values({
            linkId: link.id,
            retailerId: d.retailerId,
            variantId: d.variantId,
            productId: d.productId,
            title: d.title,
            desired: d.data,
            desiredHash: hash,
            blockedReason: d.blockedReason,
            state,
          })
          .onConflictDoNothing({ target: [catalogueItemSync.linkId, catalogueItemSync.retailerId] });
        continue;
      }
      const unchanged =
        row.state === state &&
        (row.desiredHash ?? "") === hash &&
        row.title === d.title &&
        row.blockedReason === d.blockedReason &&
        row.variantId === d.variantId &&
        row.productId === d.productId;
      if (unchanged) continue;
      await tx
        .update(catalogueItemSync)
        .set({
          variantId: d.variantId,
          productId: d.productId,
          title: d.title,
          desired: d.data,
          desiredHash: hash,
          blockedReason: d.blockedReason,
          state,
          // A changed item starts again with a clean record.
          ...(state === "pending" && row.state === "rejected" ? { problemCode: null, problemMessage: null, reviewStatus: null } : {}),
          updatedAt: now,
        })
        .where(eq(catalogueItemSync.id, row.id));
    }
    // Rows whose size is no longer in the shop at all: must not exist at Meta.
    for (const row of existing) {
      if (seen.has(row.retailerId)) continue;
      const state = nextState(row, { data: null, blockedReason: null }, "");
      if (row.state === state && row.desired === null && (row.desiredHash ?? "") === "" && row.blockedReason === null) continue;
      await tx
        .update(catalogueItemSync)
        .set({ desired: null, desiredHash: "", blockedReason: null, state, updatedAt: now })
        .where(eq(catalogueItemSync.id, row.id));
    }

    // "Send everything again": every item Meta may hold goes out again. Items a person has not
    // asked about stay refused on the unattended nightly pass (rule R11).
    if (opts.force) {
      await tx
        .update(catalogueItemSync)
        .set({ state: "pending", updatedAt: now })
        .where(
          and(
            eq(catalogueItemSync.linkId, link.id),
            inArray(catalogueItemSync.state, kind === "full" ? ["live", "sent", "rejected"] : ["live", "sent"]),
          ),
        );
    }

    // 4. The batch: pending rows, oldest change first, at most 500.
    const batchRows = await tx
      .select()
      .from(catalogueItemSync)
      .where(and(eq(catalogueItemSync.linkId, link.id), eq(catalogueItemSync.state, "pending")))
      .orderBy(asc(catalogueItemSync.updatedAt), asc(catalogueItemSync.retailerId))
      .limit(CATALOGUE_BATCH_MAX);
    if (batchRows.length === 0) {
      await tx
        .update(catalogueLink)
        .set({ lastSyncAt: startedAt, fullSyncRequestedAt: null, updatedAt: now })
        .where(eq(catalogueLink.id, link.id));
      return { batch: null, rows: [] as ItemRow[], blocked };
    }
    // 5. The local row first (foundation rule 9); it is committed before Meta is called.
    const [batch] = await tx
      .insert(catalogueBatch)
      .values({ linkId: link.id, kind, itemCount: batchRows.length, state: "queued" })
      .returning();
    await tx
      .update(catalogueItemSync)
      .set({ state: "sent", batchId: batch!.id, updatedAt: now })
      .where(
        inArray(
          catalogueItemSync.id,
          batchRows.map((r) => r.id),
        ),
      );
    return { batch: batch!, rows: batchRows, blocked };
  });

  if (!prepared.batch) return { pushed: 0, removed: 0, blocked: prepared.blocked };
  const batch = prepared.batch;
  const rows = prepared.rows;
  const pushed = rows.filter((r) => r.desired !== null).length;
  const removed = rows.length - pushed;
  const requests = buildBatchRequests(rows.map((r) => ({ retailerId: r.retailerId, data: r.desired })));

  const finishLink = async (): Promise<void> => {
    // 7. The pass is over. "Send everything again" is done once its batch has been handed over.
    await db
      .update(catalogueLink)
      .set({ lastSyncAt: startedAt, ...(kind === "full" ? { fullSyncRequestedAt: null } : {}), updatedAt: new Date() })
      .where(eq(catalogueLink.id, link.id));
  };
  const rejectItems = async (retailerIds: string[], messageFor: (id: string) => string, code: string | null = null): Promise<void> => {
    for (const id of retailerIds) {
      await db
        .update(catalogueItemSync)
        .set({ state: "rejected", problemCode: code, problemMessage: messageFor(id).slice(0, 2000), checkedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(catalogueItemSync.batchId, batch.id), eq(catalogueItemSync.retailerId, id), eq(catalogueItemSync.state, "sent")));
    }
  };

  // 6. Call Meta.
  let result: { handle: string | null; validation: BatchValidation[] };
  try {
    result = await sendItemsBatch(cfg, link.catalogId, requests);
  } catch (err) {
    const e = err instanceof MetaApiError ? err : null;
    const code = e?.code ? (e.subcode ? `${e.code}/${e.subcode}` : e.code) : null;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    if (e && e.delivery === "unknown") {
      // A timeout is "unknown", not "failed" (rule R15): send the same upserts and deletes again.
      await db.update(catalogueBatch).set({ state: "lost", errorCode: code, errorMessage: message, finishedAt: new Date() }).where(eq(catalogueBatch.id, batch.id));
      await releaseBatchItems(db, batch.id, false);
      await finishLink();
      return { pushed: 0, removed: 0, blocked: prepared.blocked };
    }
    await db.update(catalogueBatch).set({ state: "failed", errorCode: code, errorMessage: message, finishedAt: new Date() }).where(eq(catalogueBatch.id, batch.id));
    const cls = e ? classifyCatalogueError(e) : "temporary";
    if (cls === "refusal") {
      // Meta refused the batch itself: show its words on every item in it.
      await rejectItems(rows.map((r) => r.retailerId), () => message, code);
    } else {
      await releaseBatchItems(db, batch.id, false);
      await recordLinkProblem(db, link, cls, err);
    }
    await finishLink();
    // Something of ours went wrong (not Meta): the items are back to pending; let the job log it.
    if (!e) throw err;
    return { pushed: 0, removed: 0, blocked: prepared.blocked };
  }

  const refused = result.validation.filter((v) => v.errors.length > 0);
  const refusedMessage = new Map(refused.map((v) => [v.retailer_id, v.errors.map((e) => e.message).join("; ")] as const));
  if (result.handle) {
    await db
      .update(catalogueBatch)
      .set({ state: "open", handle: result.handle, sentAt: new Date(), result: { validation_status: result.validation } })
      .where(eq(catalogueBatch.id, batch.id));
    await rejectItems([...refusedMessage.keys()], (id) => refusedMessage.get(id) ?? "Meta refused this item");
    await clearLinkProblem(db, link);
    await finishLink();
    return { pushed, removed, blocked: prepared.blocked };
  }
  // No handle: "nothing has been ingested".
  await db
    .update(catalogueBatch)
    .set({
      state: "failed",
      sentAt: new Date(),
      finishedAt: new Date(),
      errorMessage: "Meta took nothing from this batch.",
      result: { validation_status: result.validation },
    })
    .where(eq(catalogueBatch.id, batch.id));
  await rejectItems([...refusedMessage.keys()], (id) => refusedMessage.get(id) ?? "Meta refused this item");
  await releaseBatchItems(db, batch.id, true);
  await finishLink();
  return { pushed: 0, removed: 0, blocked: prepared.blocked };
}

/**
 * Section 6.2: ask Meta about each open batch. Returns how many finished.
 * Makes no call when sync is switched off or a configuration problem is set.
 */
export async function checkOpenBatches(db: DbClient, cfg: MetaConfig): Promise<number> {
  const link = await getCatalogueLink(db);
  if (!link || !link.syncEnabled || link.problemKind === "config") return 0;
  const open = await db
    .select()
    .from(catalogueBatch)
    .where(and(eq(catalogueBatch.linkId, link.id), eq(catalogueBatch.state, "open")))
    .orderBy(asc(catalogueBatch.createdAt));
  let finished = 0;
  for (const batch of open) {
    if (!batch.handle) continue;
    const countCheck = async (): Promise<void> => {
      const checks = batch.checks + 1;
      if (checks >= CATALOGUE_MAX_CHECKS) {
        await db
          .update(catalogueBatch)
          .set({ state: "lost", checks, errorMessage: "Meta never said this batch was finished.", finishedAt: new Date() })
          .where(eq(catalogueBatch.id, batch.id));
        await releaseBatchItems(db, batch.id, true);
      } else {
        await db.update(catalogueBatch).set({ checks }).where(eq(catalogueBatch.id, batch.id));
      }
    };
    let status: Awaited<ReturnType<typeof checkBatch>>;
    try {
      status = await checkBatch(cfg, link.catalogId, batch.handle);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      if (classifyCatalogueError(err) === "config") {
        await recordLinkProblem(db, link, "config", err);
        return finished;
      }
      // Temporary trouble, a timeout or an odd refusal: it counts as a check.
      await countCheck();
      continue;
    }
    if (status.status !== "finished") {
      await countCheck();
      continue;
    }
    const messages = new Map<string, string>();
    for (const id of status.invalidIds) messages.set(id, "Meta refused this item");
    for (const e of status.errors) messages.set(e.id, e.message || "Meta refused this item");
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [retailerId, message] of messages) {
        await tx
          .update(catalogueItemSync)
          .set({ state: "rejected", problemCode: null, problemMessage: message.slice(0, 2000), checkedAt: now, updatedAt: now })
          .where(and(eq(catalogueItemSync.batchId, batch.id), eq(catalogueItemSync.retailerId, retailerId), eq(catalogueItemSync.state, "sent")));
      }
      await tx
        .update(catalogueItemSync)
        .set({
          state: sql`case when ${catalogueItemSync.desired} is null or jsonb_typeof(${catalogueItemSync.desired}) = 'null' then 'removed' else 'live' end`,
          pushedHash: sql`coalesce(${catalogueItemSync.desiredHash}, '')`,
          pushedAt: now,
          checkedAt: now,
          problemCode: null,
          problemMessage: null,
          reviewStatus: null,
          updatedAt: now,
        })
        .where(and(eq(catalogueItemSync.batchId, batch.id), eq(catalogueItemSync.state, "sent")));
      await tx
        .update(catalogueBatch)
        .set({
          state: "finished",
          checks: batch.checks + 1,
          errorsTotal: Math.max(status.errorsTotal, messages.size),
          result: { status: status.status, errors: status.errors, invalid_ids: status.invalidIds },
          finishedAt: now,
        })
        .where(eq(catalogueBatch.id, batch.id));
    });
    finished++;
  }
  return finished;
}

/**
 * Section 6.3: compare what Meta holds with what we think it holds, then send
 * what differs. Items without our "v-" prefix are never touched (rule R10).
 * The caller decides when (catalogueReconcileDue).
 */
export async function reconcileCatalogue(
  db: DbClient,
  cfg: MetaConfig,
  opts: { storefrontBase: string },
): Promise<{ missing: number; extra: number; unmanaged: number }> {
  const counts = { missing: 0, extra: 0, unmanaged: 0 };
  const link = await getCatalogueLink(db);
  if (!link || !link.syncEnabled || link.problemKind === "config") return counts;

  let listed: MetaListedItem[];
  try {
    listed = await listMetaItems(cfg, link.catalogId);
  } catch (err) {
    if (err instanceof MetaApiError) {
      const cls = classifyCatalogueError(err);
      if (cls !== "refusal") await recordLinkProblem(db, link, cls, err);
    }
    throw err;
  }
  const atMeta = new Map(listed.map((i) => [i.retailerId, i] as const));
  const now = new Date();

  await db.transaction(async (tx) => {
    const ours = await tx.select().from(catalogueItemSync).where(eq(catalogueItemSync.linkId, link.id));
    const byRetailer = new Map(ours.map((r) => [r.retailerId, r] as const));

    for (const row of ours) {
      const meta = atMeta.get(row.retailerId);
      if (!meta) {
        // We think it is live; Meta has lost it. Send it again.
        if (row.state === "live") {
          counts.missing++;
          await tx.update(catalogueItemSync).set({ state: "pending", pushedHash: null, updatedAt: now }).where(eq(catalogueItemSync.id, row.id));
        }
        continue;
      }
      const review = (meta.reviewStatus ?? "").toLowerCase();
      if (review === "rejected" && (row.state === "live" || row.state === "sent" || row.state === "pending" || row.state === "rejected")) {
        await tx
          .update(catalogueItemSync)
          .set({
            state: "rejected",
            reviewStatus: "rejected",
            problemMessage: (meta.problem ?? "Meta's review turned this item down.").slice(0, 2000),
            checkedAt: now,
            updatedAt: now,
          })
          .where(eq(catalogueItemSync.id, row.id));
      } else if (review === "approved" && row.state === "rejected" && row.reviewStatus === "rejected") {
        await tx
          .update(catalogueItemSync)
          .set({ state: "live", reviewStatus: "approved", problemCode: null, problemMessage: null, checkedAt: now, updatedAt: now })
          .where(eq(catalogueItemSync.id, row.id));
      } else if (row.state === "removed") {
        // Meta still lists something we believe is gone: queue a DELETE.
        counts.extra++;
        await tx
          .update(catalogueItemSync)
          .set({ state: "pending", desired: null, desiredHash: "", pushedHash: UNKNOWN_AT_META, updatedAt: now })
          .where(eq(catalogueItemSync.id, row.id));
      }
    }

    for (const meta of listed) {
      if (byRetailer.has(meta.retailerId)) continue;
      if (!meta.retailerId.startsWith(RETAILER_PREFIX)) {
        counts.unmanaged++; // someone else's item: left alone
        continue;
      }
      // Ours by prefix, but we hold no row: queue a DELETE (the next pass re-creates it if the shop still sells it).
      counts.extra++;
      const variantId = variantIdFromRetailerId(meta.retailerId);
      const [variant] = variantId
        ? await tx.select({ id: productVariant.id, productId: productVariant.productId }).from(productVariant).where(eq(productVariant.id, variantId))
        : [];
      await tx
        .insert(catalogueItemSync)
        .values({
          linkId: link.id,
          retailerId: meta.retailerId,
          variantId: variant?.id ?? null,
          productId: variant?.productId ?? null,
          title: meta.retailerId,
          desired: null,
          desiredHash: "",
          pushedHash: UNKNOWN_AT_META,
          state: "pending",
        })
        .onConflictDoNothing({ target: [catalogueItemSync.linkId, catalogueItemSync.retailerId] });
    }
    await tx.update(catalogueLink).set({ lastReconcileAt: now, updatedAt: now }).where(eq(catalogueLink.id, link.id));
  });

  await syncCatalogue(db, cfg, { storefrontBase: opts.storefrontBase, force: true, kind: "reconcile" });
  return counts;
}
