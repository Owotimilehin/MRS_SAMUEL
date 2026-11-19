/**
 * What goes to WhatsApp when staff send products from a chat (suite spec 08,
 * section 5.5, rules R19 to R22): one product, a product list, or the whole
 * menu. Only items the catalogue holds (state live or sent) can be sent, and
 * nothing here carries a price: WhatsApp shows the catalogue's own.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { catalogueItemSync, product, type DbClient } from "@ms/db";
import { buildCatalogueMessage, buildProductListMessage, buildProductMessage, getCatalogueLink, type OutboundContent } from "@ms/domain";
import { CATALOGUE_DEFAULT_BODY, PRODUCT_LIST_DEFAULT_BODY, PRODUCT_LIST_HEADER, PRODUCT_LIST_SECTIONS } from "@ms/shared";
import { BusinessError } from "./errors.js";

export type ProductSendBody =
  | { type: "product"; retailer_ids: string[]; text?: string | undefined }
  | { type: "catalogue"; text?: string | undefined };

type Interactive = Extract<OutboundContent, { type: "interactive" }>;

export async function productSendContent(db: DbClient, body: ProductSendBody): Promise<{ content: Interactive; retailerIds: string[] }> {
  const link = await getCatalogueLink(db);
  if (!link || !link.whatsappConnected) {
    throw new BusinessError("conflict", "The catalogue is not connected to WhatsApp yet.", 409, { reason: "catalogue_not_connected" });
  }
  const text = body.text?.trim() || undefined;

  if (body.type === "catalogue") {
    // The picture on the menu message: the first live juice in the shop's own order.
    const [first] = await db
      .select({ retailerId: catalogueItemSync.retailerId })
      .from(catalogueItemSync)
      .leftJoin(product, eq(product.id, catalogueItemSync.productId))
      .where(and(eq(catalogueItemSync.linkId, link.id), eq(catalogueItemSync.state, "live")))
      .orderBy(asc(product.displayOrder), asc(catalogueItemSync.title))
      .limit(1);
    const message = text ?? CATALOGUE_DEFAULT_BODY;
    return {
      content: { type: "interactive", interactive: buildCatalogueMessage(message, first?.retailerId), preview: `Our menu\n${message}` },
      retailerIds: [],
    };
  }

  const ids = [...new Set(body.retailer_ids)];
  const rows = await db
    .select({
      retailerId: catalogueItemSync.retailerId,
      title: catalogueItemSync.title,
      state: catalogueItemSync.state,
      desired: catalogueItemSync.desired,
      category: product.category,
      displayOrder: product.displayOrder,
    })
    .from(catalogueItemSync)
    .leftJoin(product, eq(product.id, catalogueItemSync.productId))
    .where(and(eq(catalogueItemSync.linkId, link.id), inArray(catalogueItemSync.retailerId, ids)));
  const sendable = rows.filter((r) => (r.state === "live" || r.state === "sent") && r.desired != null);
  const ok = new Set(sendable.map((r) => r.retailerId));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length > 0) {
    const titles = missing.map((id) => rows.find((r) => r.retailerId === id)?.title ?? id);
    throw new BusinessError("validation_failed", `That juice is no longer in the catalogue: ${titles.join(", ")}.`, 422, {
      reason: "item_not_in_catalogue",
      titles,
    });
  }
  sendable.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.title.localeCompare(b.title));

  if (sendable.length === 1) {
    const one = sendable[0]!;
    return {
      content: {
        type: "interactive",
        interactive: buildProductMessage(link.catalogId, one.retailerId, text),
        preview: `Product: ${one.title}${text ? `\n${text}` : ""}`,
      },
      retailerIds: [one.retailerId],
    };
  }

  // Rule R21: sections by the flavour's category, in a fixed order; empty ones are left out.
  const known = new Set<string>(PRODUCT_LIST_SECTIONS.map((s) => s.category));
  const sections = PRODUCT_LIST_SECTIONS.map((s, i) => ({
    title: s.title,
    retailerIds: sendable
      // A juice whose flavour we can no longer read goes under the first heading.
      .filter((r) => (r.category && known.has(r.category) ? r.category === s.category : i === 0))
      .map((r) => r.retailerId),
  }));
  const message = text ?? PRODUCT_LIST_DEFAULT_BODY;
  return {
    content: {
      type: "interactive",
      interactive: buildProductListMessage(link.catalogId, { header: PRODUCT_LIST_HEADER, body: message, sections }),
      preview: `Products (${sendable.length}): ${sendable.map((r) => r.title).join(", ")}\n${message}`,
    },
    retailerIds: sendable.map((r) => r.retailerId),
  };
}
