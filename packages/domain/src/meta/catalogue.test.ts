import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RETAILER_PREFIX,
  buildBatchRequests,
  buildCatalogueMessage,
  buildFulfilmentButtons,
  buildPayButton,
  buildProductListMessage,
  buildProductMessage,
  catalogueBackoffMs,
  checkBatch,
  classifyCatalogueError,
  formatNaira,
  hashItem,
  itemDescription,
  itemPictureUrl,
  metaPrice,
  plainProblem,
  priceNgnFromMetaPrice,
  retailerIdForVariant,
  sendItemsBatch,
  setCommerceSettings,
  variantIdFromRetailerId,
  type MetaItemData,
} from "./catalogue.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test that calls out stubs fetch. The token below is obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const VARIANT = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

const item = (over: Partial<MetaItemData> = {}): MetaItemData => ({
  id: `v-${VARIANT}`,
  title: "Pineapple Ginger 330ml",
  description: "Fresh pineapple with a ginger kick.",
  availability: "in stock",
  condition: "new",
  price: "1500.00 NGN",
  link: "https://www.example.com/juices/pineapple-ginger",
  image: [{ url: "https://www.example.com/media/bottles/pineapple.png" }],
  brand: "Mrs. Samuel",
  item_group_id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  size: "330 ml",
  google_product_category: "Food, Beverages & Tobacco > Beverages > Juice",
  ...over,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
type Call = { url: string; method: string; body: unknown };
function stub(handler: (c: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      return handler(call, calls.length - 1);
    }),
  );
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ids and money", () => {
  it("metaPrice formats whole naira with two decimals and NGN", () => {
    expect(metaPrice(1500)).toBe("1500.00 NGN");
    expect(metaPrice(1)).toBe("1.00 NGN");
    expect(() => metaPrice(0)).toThrow();
    expect(() => metaPrice(-5)).toThrow();
    expect(() => metaPrice(1500.5)).toThrow();
    expect(priceNgnFromMetaPrice("1500.00 NGN")).toBe(1500);
    expect(priceNgnFromMetaPrice("9.99 USD")).toBeNull();
    expect(priceNgnFromMetaPrice(null)).toBeNull();
  });

  it("formatNaira groups thousands", () => {
    expect(formatNaira(4500)).toBe("₦4,500");
    expect(formatNaira(0)).toBe("₦0");
  });

  it("retailerIdForVariant and variantIdFromRetailerId round-trip; foreign ids give null", () => {
    expect(RETAILER_PREFIX).toBe("v-");
    const rid = retailerIdForVariant(VARIANT);
    expect(rid).toBe(`v-${VARIANT}`);
    expect(variantIdFromRetailerId(rid)).toBe(VARIANT);
    expect(variantIdFromRetailerId("SKU-123")).toBeNull();
    expect(variantIdFromRetailerId("v-not-a-uuid")).toBeNull();
    expect(variantIdFromRetailerId(`b-${VARIANT}`)).toBeNull();
    expect(variantIdFromRetailerId("")).toBeNull();
  });

  it("hashItem is stable and changes when price or availability changes", () => {
    const a = item();
    // Same content, keys in another order: the same hash.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as MetaItemData;
    expect(hashItem(a)).toBe(hashItem(reordered));
    expect(hashItem(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashItem(item({ price: "1600.00 NGN" }))).not.toBe(hashItem(a));
    expect(hashItem(item({ availability: "out of stock" }))).not.toBe(hashItem(a));
    expect(hashItem(null)).toBe("");
  });
});

describe("item wording and picture", () => {
  it("description takes the story, strips tags and links, and never stays all capitals", () => {
    const p = { name: "Zobo", story: "<p>Deep red   hibiscus.</p> See https://example.com/zobo now", tagline: "Tag", ingredients: ["hibiscus"] };
    expect(itemDescription(p, 330)).toBe("Deep red hibiscus. See now");
    expect(itemDescription({ ...p, story: " ", tagline: "BOLD AND FRESH" }, 330)).toBe("Bold and fresh");
    expect(itemDescription({ ...p, story: null, tagline: null }, 330)).toBe("Made with hibiscus.");
    expect(itemDescription({ name: "Zobo", story: null, tagline: null, ingredients: [] }, 650)).toBe("Zobo fruit juice, 650ml.");
    expect(itemDescription({ ...p, story: "a".repeat(6000) }, 330)).toHaveLength(5000);
  });

  it("picture is the flavour's own, else the bottle; a path gets the storefront in front; anything else is no picture", () => {
    const base = "https://www.example.com/";
    expect(itemPictureUrl("https://cdn.example.com/a.png", "/media/bottles/b.png", base)).toBe("https://cdn.example.com/a.png");
    expect(itemPictureUrl(null, "/media/bottles/b.png", base)).toBe("https://www.example.com/media/bottles/b.png");
    expect(itemPictureUrl("", null, base)).toBeNull();
    expect(itemPictureUrl("data:image/png;base64,AAAA", null, base)).toBeNull();
  });
});

describe("batch requests", () => {
  it("buildBatchRequests uses UPDATE for data and DELETE with only id for null", () => {
    const a = item();
    const out = buildBatchRequests([
      { retailerId: a.id, data: a },
      { retailerId: "v-gone", data: null },
    ]);
    expect(out).toEqual([
      { method: "UPDATE", data: a },
      { method: "DELETE", data: { id: "v-gone" } },
    ]);
    expect(out.some((r) => (r.method as string) === "CREATE")).toBe(false);
  });

  it("sendItemsBatch posts item_type and requests, and reads the handle and validation errors", async () => {
    const calls = stub(() =>
      json({ handles: ["h1"], validation_status: [{ retailer_id: "v-1", errors: [{ message: "Bad image" }], warnings: [] }] }),
    );
    const out = await sendItemsBatch(cfg, "123456", [{ method: "DELETE", data: { id: "v-1" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/123456/items_batch");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ item_type: "PRODUCT_ITEM", requests: [{ method: "DELETE", data: { id: "v-1" } }] });
    expect(out).toEqual({ handle: "h1", validation: [{ retailer_id: "v-1", errors: [{ message: "Bad image" }], warnings: [] }] });
  });

  it("sendItemsBatch sends requests as a JSON string when Meta answers 100 to the array form", async () => {
    const calls = stub((_c, n) =>
      n === 0 ? json({ error: { message: "(#100) Param requests must be a JSON string", code: 100 } }, 400) : json({ handles: [], validation_status: [] }),
    );
    const out = await sendItemsBatch(cfg, "123456", [{ method: "DELETE", data: { id: "v-1" } }]);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { requests: unknown }).requests).toBe(JSON.stringify([{ method: "DELETE", data: { id: "v-1" } }]));
    expect(out.handle).toBeNull();
  });

  it("checkBatch reads data[0], its errors and the invalid ids", async () => {
    const calls = stub(() =>
      json({
        data: [{ handle: "h 1", status: "finished", errors_total_count: 1, errors: [{ line: 0, id: "v-1", message: "No price" }], ids_of_invalid_requests: ["v-2"] }],
      }),
    );
    const out = await checkBatch(cfg, "123456", "h 1");
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v23.0/123456/check_batch_request_status?handle=h%201&load_ids_of_invalid_requests=true",
    );
    expect(out).toEqual({ status: "finished", errorsTotal: 1, errors: [{ id: "v-1", message: "No price" }], invalidIds: ["v-2"] });
  });

  it("setCommerceSettings puts the booleans in the query string", async () => {
    const calls = stub(() => json({ success: true }));
    await setCommerceSettings(cfg, "1098765432", { isCartEnabled: true, isCatalogVisible: false });
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v23.0/1098765432/whatsapp_commerce_settings?is_cart_enabled=true&is_catalog_visible=false",
    );
    expect(calls[0]!.method).toBe("POST");
  });

  it("backs off 30 s × 2^n, at most 15 minutes", () => {
    expect(catalogueBackoffMs(0)).toBe(0);
    expect(catalogueBackoffMs(1)).toBe(60_000);
    expect(catalogueBackoffMs(2)).toBe(120_000);
    expect(catalogueBackoffMs(9)).toBe(15 * 60_000);
  });
});

describe("WhatsApp message builders", () => {
  it("buildProductMessage has no header and carries catalog_id and product_retailer_id", () => {
    const m = buildProductMessage("123456", "v-1", "Try this one");
    expect(m).toEqual({ type: "product", body: { text: "Try this one" }, action: { catalog_id: "123456", product_retailer_id: "v-1" } });
    expect("header" in m).toBe(false);
    expect("body" in buildProductMessage("123456", "v-1")).toBe(false);
  });

  it("buildProductListMessage requires a text header and keeps section titles within 24 characters", () => {
    const m = buildProductListMessage("123456", {
      header: "Mrs. Samuel Fruit Juice",
      body: "Here are the juices.",
      sections: [
        { title: "A very long section title that goes on", retailerIds: ["v-1", "v-2"] },
        { title: "Empty", retailerIds: [] },
      ],
    }) as { header: { type: string; text: string }; action: { catalog_id: string; sections: { title: string; product_items: unknown[] }[] } };
    expect(m.header).toEqual({ type: "text", text: "Mrs. Samuel Fruit Juice" });
    expect(m.action.catalog_id).toBe("123456");
    expect(m.action.sections).toHaveLength(1);
    expect(m.action.sections[0]!.title.length).toBeLessThanOrEqual(24);
    expect(m.action.sections[0]!.product_items).toEqual([{ product_retailer_id: "v-1" }, { product_retailer_id: "v-2" }]);
    expect(() => buildProductListMessage("123456", { header: " ", body: "x", sections: [{ title: "Juices", retailerIds: ["v-1"] }] })).toThrow();
  });

  it("buildCatalogueMessage omits parameters when no thumbnail is given", () => {
    expect(buildCatalogueMessage("See our menu")).toEqual({
      type: "catalog_message",
      body: { text: "See our menu" },
      action: { name: "catalog_message" },
    });
    expect(buildCatalogueMessage("See our menu", "v-1")).toEqual({
      type: "catalog_message",
      body: { text: "See our menu" },
      action: { name: "catalog_message", parameters: { thumbnail_product_retailer_id: "v-1" } },
    });
  });

  it("buildFulfilmentButtons has two buttons with ids co:<id>:delivery and co:<id>:pickup and titles within 20 characters", () => {
    const m = buildFulfilmentButtons(VARIANT, "How would you like it?") as {
      type: string;
      action: { buttons: { type: string; reply: { id: string; title: string } }[] };
    };
    expect(m.type).toBe("button");
    expect(m.action.buttons.map((b) => b.reply.id)).toEqual([`co:${VARIANT}:delivery`, `co:${VARIANT}:pickup`]);
    for (const b of m.action.buttons) {
      expect(b.type).toBe("reply");
      expect(b.reply.title.length).toBeLessThanOrEqual(20);
    }
  });

  it('buildPayButton display_text is "Pay now"', () => {
    const m = buildPayButton("Your order is ready.", "https://pay.example.com/abc") as {
      type: string;
      action: { name: string; parameters: { display_text: string; url: string } };
    };
    expect(m.type).toBe("cta_url");
    expect(m.action).toEqual({ name: "cta_url", parameters: { display_text: "Pay now", url: "https://pay.example.com/abc" } });
  });
});

describe("plain words and error classes", () => {
  it("plainProblem maps picture, price, link, policy and unknown messages", () => {
    expect(plainProblem(null, "rejected")).toMatch(/review turned this item down/);
    expect(plainProblem("Violates Commerce Policy")).toMatch(/review turned this item down/);
    expect(plainProblem("This is not allowed")).toMatch(/review turned this item down/);
    expect(plainProblem("Image could not be downloaded")).toMatch(/could not use this picture/);
    expect(plainProblem("Invalid price format")).toMatch(/did not accept the price/);
    expect(plainProblem("Unsupported currency")).toMatch(/did not accept the price/);
    expect(plainProblem("The link is not on your domain")).toMatch(/did not accept the web address/);
    expect(plainProblem("Title is too long")).toMatch(/did not accept the name/);
    expect(plainProblem("Description contains HTML")).toMatch(/did not accept the description/);
    expect(plainProblem(null, null, { blockedReason: "no_picture" })).toBe("This juice has no picture. Add one in the shop admin.");
    expect(plainProblem(null, null, { blockedReason: "no_price" })).toBe("This size has no price. Set one in the shop admin.");
    expect(plainProblem("Error validating access token", null, { code: "190" })).toBe("Our connection to Meta has expired.");
    for (const code of ["10", "200", "299", "200/1234"]) {
      expect(plainProblem("(#200) Permissions error", null, { code })).toMatch(/do not have permission to manage this catalogue/);
    }
    expect(plainProblem("Something odd happened")).toBe("Meta refused this item. Its message was: “Something odd happened”");
  });

  it("classifyCatalogueError: 190/10/200/299 config; 4/17/32/613/80007/80008/80009/80014/429/5xx temporary; others refusal", () => {
    const err = (code: string | null, status = 400) => new MetaApiError("x", status, code, false);
    for (const c of ["190", "10", "200", "299"]) expect(classifyCatalogueError(err(c))).toBe("config");
    for (const c of ["4", "17", "32", "613", "80007", "80008", "80009", "80014"]) expect(classifyCatalogueError(err(c))).toBe("temporary");
    expect(classifyCatalogueError(err(null, 429))).toBe("temporary");
    expect(classifyCatalogueError(err(null, 500))).toBe("temporary");
    expect(classifyCatalogueError(err(null, 503))).toBe("temporary");
    expect(classifyCatalogueError(err("100"))).toBe("refusal");
    expect(classifyCatalogueError(err("368"))).toBe("refusal");
    expect(classifyCatalogueError(new Error("boom"))).toBe("refusal");
  });
});
