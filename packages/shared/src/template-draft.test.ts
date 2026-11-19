import { describe, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  blanksIn,
  componentsToDraft,
  draftPreview,
  draftToComponents,
  editsLeft,
  nextEditAt,
  normaliseTemplateLanguage,
  validateDraft,
  validateTemplateName,
  type TemplateDraft,
} from "./template-draft.js";
import { STARTER_TEMPLATES } from "./template-starter.js";

const GOOD: TemplateDraft = {
  category: "UTILITY",
  header: null,
  body: { text: "Hello {{1}}, your order {{2}} has been received and we are packing it now.", examples: ["Ada", "MS-10482"] },
  footer: "",
  buttons: [],
};
const ctx = { name: "order_received", others: [] as { name: string; body: string; footer: string }[] };
const draft = (over: Partial<TemplateDraft>): TemplateDraft => ({ ...GOOD, ...over });
const codes = (d: TemplateDraft, c = ctx): string[] => validateDraft(d, c).map((p) => p.code);
const body = (text: string, examples: string[] = ["Ada", "MS-10482", "N5"]): Partial<TemplateDraft> => ({ body: { text, examples } });

describe("name", () => {
  it("accepts order_confirmed, refuses capitals, spaces and 61 characters", () => {
    expect(validateTemplateName("order_confirmed")).toBeNull();
    expect(validateTemplateName("Order_confirmed")).not.toBeNull();
    expect(validateTemplateName("order confirmed")).not.toBeNull();
    expect(validateTemplateName("a".repeat(60))).toBeNull();
    expect(validateTemplateName("a".repeat(61))).not.toBeNull();
    expect(validateTemplateName("")).not.toBeNull();
  });
});

describe("blanksIn", () => {
  it("finds numbers in order and ignores named blanks", () => {
    expect(blanksIn("Hi {{1}}, {{2}} and {{1}} {{first_name}} {{ 3 }}")).toEqual([1, 2, 1]);
    expect(blanksIn("none")).toEqual([]);
  });
});

describe("validateDraft", () => {
  it("passes a good draft with nothing at all", () => {
    expect(validateDraft(GOOD, ctx)).toEqual([]);
  });
  it("validateDraft flags name_format", () => {
    expect(codes(GOOD, { ...ctx, name: "Bad Name" })).toContain("name_format");
  });
  it("validateDraft flags body_empty", () => {
    expect(codes(draft(body("   ", [])))).toContain("body_empty");
  });
  it("validateDraft flags body_long", () => {
    expect(codes(draft(body("word ".repeat(250), [])))).toContain("body_long");
  });
  it("validateDraft flags blank_order", () => {
    expect(codes(draft(body("Hello {{1}}, your order {{3}} has been received and we are packing it.")))).toContain("blank_order");
    expect(codes(draft(body("Hello {{2}}, your order {{1}} has been received and we are packing it.")))).toContain("blank_order");
  });
  it("validateDraft flags blank_edge", () => {
    expect(codes(draft(body("{{1}} thank you for your order, we are packing it now for you.", ["Ada"])))).toContain("blank_edge");
    expect(codes(draft(body("Thank you for your order, we are packing it now for you, {{1}}", ["Ada"])))).toContain("blank_edge");
    expect(codes(draft(body("Thank you for your order, we are packing it now for you, {{1}}.", ["Ada"])))).toContain("blank_edge");
  });
  it("validateDraft flags blank_adjacent", () => {
    expect(codes(draft(body("Hello {{1}} {{2}} your order has been received and we are packing it.", ["Ada", "Bello"])))).toContain("blank_adjacent");
  });
  it("validateDraft flags blank_named", () => {
    expect(codes(draft(body("Hello {{first_name}}, your order has been received and we are packing it.", [])))).toContain("blank_named");
  });
  it("validateDraft flags brace_mismatch", () => {
    expect(codes(draft(body("Hello {{1}, your order has been received and we are packing it now.", ["Ada"])))).toContain("brace_mismatch");
    expect(codes(draft(body("Hello {1}, your order has been received and we are packing it now.", [])))).toContain("brace_mismatch");
  });
  it("validateDraft flags example_missing", () => {
    const p = validateDraft(draft({ body: { text: GOOD.body.text, examples: ["Ada", " "] } }), ctx);
    expect(p.find((x) => x.code === "example_missing")?.message).toBe(
      "Give an example for blank {{2}}. WhatsApp will not review the template without one.",
    );
  });
  it("validateDraft flags header_long", () => {
    expect(codes(draft({ header: { format: "TEXT", text: "x".repeat(61), example: "" } }))).toContain("header_long");
  });
  it("validateDraft flags header_blanks", () => {
    expect(codes(draft({ header: { format: "TEXT", text: "Order {{1}} and {{2}}", example: "a" } }))).toContain("header_blanks");
    expect(codes(draft({ header: { format: "TEXT", text: "Order {{2}}", example: "a" } }))).toContain("header_blanks");
    expect(codes(draft({ header: { format: "TEXT", text: "Order {{1}}", example: "" } }))).toContain("example_missing");
    expect(codes(draft({ header: { format: "TEXT", text: "Order {{1}}", example: "MS-1" } }))).not.toContain("header_blanks");
  });
  it("validateDraft flags header_sample", () => {
    expect(codes(draft({ header: { format: "IMAGE", sampleKey: "", sampleMime: "", sampleName: "" } }))).toContain("header_sample");
    expect(codes(draft({ header: { format: "IMAGE", sampleKey: "k", sampleMime: "image/png", sampleName: "a.png" } }))).not.toContain("header_sample");
  });
  it("validateDraft flags footer_long", () => {
    expect(codes(draft({ footer: "x".repeat(61) }))).toContain("footer_long");
  });
  it("validateDraft flags footer_blank", () => {
    expect(codes(draft({ footer: "For {{1}}" }))).toContain("footer_blank");
  });
  it("validateDraft flags button_text", () => {
    expect(codes(draft({ buttons: [{ type: "QUICK_REPLY", text: "" }] }))).toContain("button_text");
    expect(codes(draft({ buttons: [{ type: "QUICK_REPLY", text: "x".repeat(26) }] }))).toContain("button_text");
  });
  it("validateDraft flags button_counts", () => {
    const url = { type: "URL" as const, text: "Open", url: "https://www.mrssamuel.com/a", example: "" };
    expect(codes(draft({ buttons: [url, url, url] }))).toContain("button_counts");
    const ph = { type: "PHONE_NUMBER" as const, text: "Call", phone: "+2348012345678" };
    expect(codes(draft({ buttons: [ph, ph] }))).toContain("button_counts");
    const qr = { type: "QUICK_REPLY" as const, text: "Yes" };
    expect(codes(draft({ buttons: Array.from({ length: 11 }, () => qr) }))).toContain("button_counts");
    expect(codes(draft({ buttons: Array.from({ length: 10 }, () => qr) }))).not.toContain("button_counts");
  });
  it("validateDraft flags button_group", () => {
    const qr = { type: "QUICK_REPLY" as const, text: "Yes" };
    const url = { type: "URL" as const, text: "Open", url: "https://www.mrssamuel.com/a", example: "" };
    expect(codes(draft({ buttons: [qr, url, qr] }))).toContain("button_group");
    expect(codes(draft({ buttons: [qr, qr, url] }))).not.toContain("button_group");
    expect(codes(draft({ buttons: [url, qr, qr] }))).not.toContain("button_group");
  });
  it("validateDraft flags url_format", () => {
    const u = (url: string) => draft({ buttons: [{ type: "URL", text: "Open", url, example: "x" }] });
    expect(codes(u("http://www.mrssamuel.com/a"))).toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/{{1}}/more"))).toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/{{1}}{{1}}"))).toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/{{2}}"))).toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/a/" + "x".repeat(2000)))).toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/order/{{1}}"))).not.toContain("url_format");
    expect(codes(u("https://www.mrssamuel.com/order"))).not.toContain("url_format");
  });
  it("validateDraft flags phone_format", () => {
    expect(codes(draft({ buttons: [{ type: "PHONE_NUMBER", text: "Call", phone: "08012345678" }] }))).toContain("phone_format");
    expect(codes(draft({ buttons: [{ type: "PHONE_NUMBER", text: "Call", phone: "+2348012345678" }] }))).not.toContain("phone_format");
  });
  it("validateDraft flags button_label_chars", () => {
    const p = validateDraft(draft({ buttons: [{ type: "QUICK_REPLY", text: "Yes!" }] }), ctx);
    expect(p.find((x) => x.code === "button_label_chars")?.level).toBe("warning");
  });
  it("validateDraft flags blank_ratio", () => {
    const p = validateDraft(draft(body("Hi {{1}} order {{2}} total {{3}} ok", ["a", "b", "c"])), ctx);
    expect(p.find((x) => x.code === "blank_ratio")?.level).toBe("warning");
  });
  it("validateDraft flags blank_symbols", () => {
    expect(codes(draft({ body: { text: GOOD.body.text, examples: ["Ada", "line\nbreak"] } }))).toContain("blank_symbols");
    expect(codes(draft({ body: { text: GOOD.body.text, examples: ["Ada", "a    b"] } }))).toContain("blank_symbols");
  });
  it("validateDraft flags newlines", () => {
    expect(codes(draft(body("Hello {{1}}, your order has been received.\n\n\nWe are packing it now for you.", ["Ada"])))).toContain("newlines");
    expect(codes(draft(body("Hello {{1}}, your order has been received.\n\nWe are packing it now for you.", ["Ada"])))).not.toContain("newlines");
  });
  it("validateDraft flags utility_promo", () => {
    const promo = draft(body("Hello {{1}}, enjoy 50% off all juices this week and order now to get them quickly.", ["Ada"]));
    expect(codes(promo)).toContain("utility_promo");
    expect(codes({ ...promo, category: "MARKETING" })).not.toContain("utility_promo");
    // Whole words only: "wholesale" does not contain the word "sale".
    expect(codes(draft(body("Hello {{1}}, your wholesale order has been received and we are packing it now.", ["Ada"])))).not.toContain("utility_promo");
    expect(codes(draft({ ...body("Hello {{1}}, your order has been received and we are packing it now.", ["Ada"]), footer: "Don’t miss out" }))).toContain("utility_promo");
  });
  it("validateDraft flags duplicate", () => {
    const others = [{ name: "order_copy", body: ` ${GOOD.body.text} `, footer: "" }];
    const p = validateDraft(GOOD, { ...ctx, others });
    expect(p.find((x) => x.code === "duplicate")?.message).toBe(
      "This says the same as “order_copy”. WhatsApp refuses copies. Change the wording or use that one.",
    );
    expect(codes(GOOD, { ...ctx, others: [{ name: "x", body: GOOD.body.text, footer: "Other footer" }] })).not.toContain("duplicate");
  });
  it("validateDraft flags shortener", () => {
    const p = validateDraft(draft({ buttons: [{ type: "URL", text: "Open", url: "https://bit.ly/abc", example: "" }] }), ctx);
    expect(p.find((x) => x.code === "shortener")?.level).toBe("warning");
  });
  it("validateDraft: every starter template has no errors and no warnings", () => {
    for (const s of STARTER_TEMPLATES) {
      const others = STARTER_TEMPLATES.filter((o) => o.key !== s.key).map((o) => ({ name: o.name, body: o.draft.body.text, footer: o.draft.footer }));
      expect(validateDraft(s.draft, { name: s.name, others }), s.key).toEqual([]);
    }
  });
});

const FULL: TemplateDraft = {
  category: "MARKETING",
  header: { format: "TEXT", text: "Order {{1}}", example: "MS-10482" },
  body: { text: "Hello {{1}}, your order {{2}} is ready and waiting for you at the shop.", examples: ["Ada", "MS-10482"] },
  footer: "Mrs. Samuel Fruit Juice",
  buttons: [
    { type: "QUICK_REPLY", text: "Call me back" },
    { type: "URL", text: "View order", url: "https://www.mrssamuel.com/order/{{1}}", example: "MS-10482" },
    { type: "PHONE_NUMBER", text: "Call us", phone: "+2348000000000" },
  ],
};

describe("draftToComponents", () => {
  it("text heading with a blank, media heading with a handle, body examples nested, footer, buttons in order", () => {
    const c = draftToComponents(FULL, null);
    expect(c.map((x) => x.type)).toEqual(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
    expect(c[0]).toEqual({ type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["MS-10482"] } });
    expect(c[1]).toEqual({ type: "BODY", text: FULL.body.text, example: { body_text: [["Ada", "MS-10482"]] } });
    expect(c[2]).toEqual({ type: "FOOTER", text: "Mrs. Samuel Fruit Juice" });
    expect((c[3] as { buttons: { type: string }[] }).buttons.map((b) => b.type)).toEqual(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
    const media = draftToComponents({ ...FULL, header: { format: "IMAGE", sampleKey: "k", sampleMime: "image/png", sampleName: "a.png" } }, "4::aW1hZ2U");
    expect(media[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2U"] } });
    const flat = draftToComponents(FULL, null, { flatBodyExamples: true });
    expect((flat[1] as { example: unknown }).example).toEqual({ body_text: ["Ada", "MS-10482"] });
  });
  it("draftToComponents leaves out example when there is no blank and builds the full link example", () => {
    const d: TemplateDraft = {
      ...EMPTY_DRAFT,
      body: { text: "Your juice is ready for collection at the shop today.", examples: [] },
      buttons: [
        { type: "URL", text: "Menu", url: "https://www.mrssamuel.com/menu", example: "" },
        { type: "URL", text: "View order", url: "https://www.mrssamuel.com/order/{{1}}", example: "MS-1" },
      ],
    };
    const c = draftToComponents(d, null);
    expect(c[0]).toEqual({ type: "BODY", text: d.body.text });
    const buttons = (c[1] as { buttons: Record<string, unknown>[] }).buttons;
    expect(buttons[0]).toEqual({ type: "URL", text: "Menu", url: "https://www.mrssamuel.com/menu" });
    expect(buttons[1]!.example).toEqual(["https://www.mrssamuel.com/order/MS-1"]);
  });
});

describe("componentsToDraft", () => {
  it("round-trips what draftToComponents made", () => {
    expect(componentsToDraft(draftToComponents(FULL, null), "MARKETING")).toEqual(FULL);
    for (const s of STARTER_TEMPLATES) {
      expect(componentsToDraft(draftToComponents(s.draft, null), "UTILITY"), s.key).toEqual(s.draft);
    }
  });
  it("reads the flat body example shape too, and gives a media heading an empty sample", () => {
    const d = componentsToDraft(
      [
        { type: "HEADER", format: "VIDEO", example: { header_handle: ["h"] } },
        { type: "BODY", text: "Hello {{1}}, your order has been received.", example: { body_text: ["Ada"] } },
      ],
      "utility",
    );
    expect(d?.body.examples).toEqual(["Ada"]);
    expect(d?.header).toEqual({ format: "VIDEO", sampleKey: "", sampleMime: "", sampleName: "" });
  });
  it("componentsToDraft returns null for a carousel, a named blank and an authentication template", () => {
    expect(componentsToDraft([{ type: "BODY", text: "Hi" }, { type: "CAROUSEL", cards: [] }], "MARKETING")).toBeNull();
    expect(componentsToDraft([{ type: "BODY", text: "Hi {{first_name}}" }], "UTILITY")).toBeNull();
    expect(componentsToDraft([{ type: "BODY", text: "Your code is {{1}}" }], "AUTHENTICATION")).toBeNull();
    expect(componentsToDraft([{ type: "FOOTER", text: "no body" }], "UTILITY")).toBeNull();
    expect(componentsToDraft([{ type: "BODY", text: "Hi" }], null)).toBeNull();
  });
});

describe("draftPreview", () => {
  it("fills blanks with the examples and leaves a missing one as {{n}}", () => {
    const p = draftPreview({ ...FULL, body: { text: FULL.body.text, examples: ["Ada", ""] } });
    expect(p.header).toBe("Order MS-10482");
    expect(p.body).toBe("Hello Ada, your order {{2}} is ready and waiting for you at the shop.");
    expect(p.footer).toBe("Mrs. Samuel Fruit Juice");
    expect(p.buttons).toEqual(["Call me back", "View order", "Call us"]);
    expect(p.headerMedia).toBeNull();
  });
});

describe("editsLeft", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  it("none used, one today, ten in the month, drops entries older than 30 days", () => {
    expect(editsLeft([], now)).toEqual({ today: 1, month: 10 });
    expect(editsLeft([ago(2)], now)).toEqual({ today: 0, month: 9 });
    expect(editsLeft([ago(25)], now)).toEqual({ today: 1, month: 9 });
    expect(editsLeft(Array.from({ length: 10 }, (_, i) => ago(30 + i)), now)).toEqual({ today: 1, month: 0 });
    expect(editsLeft([ago(24 * 31), ago(24 * 40)], now)).toEqual({ today: 1, month: 10 });
    expect(editsLeft(["not a date"], now)).toEqual({ today: 1, month: 10 });
  });
  it("nextEditAt says when the day and month limits lift", () => {
    expect(nextEditAt([], now)).toEqual({ day: null, month: null });
    expect(nextEditAt([ago(2)], now).day?.toISOString()).toBe("2026-11-21T10:00:00.000Z");
    const ten = Array.from({ length: 10 }, (_, i) => ago(48 + i));
    expect(nextEditAt(ten, now).month?.toISOString()).toBe(new Date(now.getTime() - 57 * 3600_000 + 30 * 24 * 3600_000).toISOString());
  });
});

describe("normaliseTemplateLanguage", () => {
  it("turns en-US into en_US", () => {
    expect(normaliseTemplateLanguage("en-US")).toBe("en_US");
    expect(normaliseTemplateLanguage("en")).toBe("en");
    expect(normaliseTemplateLanguage("en_GB")).toBe("en_GB");
  });
});
