import { describe, it, expect } from "vitest";
import { templateNeeds } from "@ms/shared";
import { buildSendPayload, buildTemplateComponents } from "./meta.js";
import { InboxSendError, prepareTemplateContent } from "./send.js";

const tpl = { type: "template" as const, name: "t", language: "en" };

describe("buildTemplateComponents", () => {
  it("sends no components when the template has nothing to fill", () => {
    expect(buildTemplateComponents(tpl)).toEqual([]);
    expect(buildSendPayload("2347000000000", tpl)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "2347000000000",
      type: "template",
      template: { name: "t", language: { code: "en" } },
    });
  });
  it("body blanks", () => {
    expect(buildTemplateComponents({ ...tpl, bodyParams: ["Ada", "juice"] })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "juice" }] },
    ]);
  });
  it("text heading blank comes before the body", () => {
    expect(buildTemplateComponents({ ...tpl, headerText: "A123", bodyParams: ["Ada"] })).toEqual([
      { type: "header", parameters: [{ type: "text", text: "A123" }] },
      { type: "body", parameters: [{ type: "text", text: "Ada" }] },
    ]);
  });
  it("picture, video and document headings are passed by link", () => {
    expect(buildTemplateComponents({ ...tpl, headerMedia: { type: "image", link: "https://files.example/p.jpg" } })).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://files.example/p.jpg" } }] },
    ]);
    expect(buildTemplateComponents({ ...tpl, headerMedia: { type: "video", link: "https://files.example/v.mp4", filename: "v.mp4" } })).toEqual([
      { type: "header", parameters: [{ type: "video", video: { link: "https://files.example/v.mp4" } }] },
    ]);
    expect(
      buildTemplateComponents({ ...tpl, headerMedia: { type: "document", link: "https://files.example/menu.pdf", filename: "menu.pdf" } }),
    ).toEqual([
      { type: "header", parameters: [{ type: "document", document: { link: "https://files.example/menu.pdf", filename: "menu.pdf" } }] },
    ]);
  });
  it("link buttons: sub_type url, the button's position as a string, in order", () => {
    expect(
      buildTemplateComponents({
        ...tpl,
        bodyParams: ["Ada"],
        buttonParams: [
          { index: 2, text: "abc" },
          { index: 0, text: "xyz" },
        ],
      }),
    ).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ada" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "xyz" }] },
      { type: "button", sub_type: "url", index: "2", parameters: [{ type: "text", text: "abc" }] },
    ]);
  });
});

describe("prepareTemplateContent", () => {
  const code = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return err instanceof InboxSendError ? `${err.code}: ${err.message}` : String(err);
    }
  };
  const imageCta = templateNeeds([
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Free delivery" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://www.jaspersmarket.com/" }] },
  ]);
  const full = templateNeeds([
    { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
    { type: "BODY", text: "Hi {{1}}, it's {{2}}" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", text: "Track", url: "https://x.example/t/{{1}}" }] },
  ]);

  it("refuses a template the inbox can't send", () => {
    const carousel = templateNeeds([{ type: "BODY", text: "x" }, { type: "CAROUSEL", cards: [] }]);
    expect(code(() => prepareTemplateContent(carousel, tpl))).toBe(
      "template_unsupported: This template has a carousel, which the inbox can't send yet",
    );
  });
  it("asks for the picture, and for the right kind of file", () => {
    expect(code(() => prepareTemplateContent(imageCta, tpl))).toBe("template_incomplete: This template needs a picture. Add one, then send");
    expect(code(() => prepareTemplateContent(imageCta, { ...tpl, headerMedia: { type: "document", link: "https://f/x.pdf" } }))).toBe(
      "template_incomplete: This template needs a picture, not a document",
    );
    expect(prepareTemplateContent(imageCta, { ...tpl, headerMedia: { type: "image", link: "https://f/x.jpg" } })).toEqual({
      ...tpl,
      headerMedia: { type: "image", link: "https://f/x.jpg" },
    });
  });
  it("asks for every blank: body, heading and link ending", () => {
    expect(code(() => prepareTemplateContent(full, { ...tpl, bodyParams: ["Ada"] }))).toContain("template_incomplete: Fill in every blank");
    expect(code(() => prepareTemplateContent(full, { ...tpl, bodyParams: ["Ada", " "] }))).toContain("template_incomplete: Fill in every blank");
    expect(code(() => prepareTemplateContent(full, { ...tpl, bodyParams: ["Ada", "ready"] }))).toContain("blank in the heading");
    expect(code(() => prepareTemplateContent(full, { ...tpl, bodyParams: ["Ada", "ready"], headerText: "A1" }))).toContain(
      'end of the link for the "Track" button',
    );
    expect(
      prepareTemplateContent(full, { ...tpl, bodyParams: ["Ada", "ready"], headerText: " A1 ", buttonParams: [{ index: 1, text: " abc " }] }),
    ).toEqual({ ...tpl, bodyParams: ["Ada", "ready"], headerText: "A1", buttonParams: [{ index: 1, text: "abc" }] });
  });
  it("drops extras the template has no place for", () => {
    const plain = templateNeeds([{ type: "BODY", text: "Hi {{1}}" }]);
    expect(
      prepareTemplateContent(plain, {
        ...tpl,
        bodyParams: ["Ada", "extra"],
        headerText: "nope",
        headerMedia: { type: "image", link: "https://f/x.jpg" },
        buttonParams: [{ index: 0, text: "nope" }],
      }),
    ).toEqual({ ...tpl, bodyParams: ["Ada"] });
  });
});
