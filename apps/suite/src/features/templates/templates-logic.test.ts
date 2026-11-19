import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT } from "@ms/shared";
import {
  buttonMenu,
  insertBlank,
  moveButton,
  newButton,
  nextBlank,
  sameDraft,
  sampleProblem,
  syncExamples,
  tidyTemplateName,
  withHeaderKind,
} from "./templates-logic.js";

describe("blanks", () => {
  it("numbers the next blank and puts it at the cursor", () => {
    expect(nextBlank("Hello")).toBe(1);
    expect(nextBlank("Hello {{1}} and {{2}}")).toBe(3);
    expect(insertBlank("Hello , bye", 6)).toEqual({ text: "Hello {{1}}, bye", cursor: 11 });
    expect(insertBlank("Hi {{1}}", null)).toEqual({ text: "Hi {{1}}{{2}}", cursor: 13 });
    expect(insertBlank("Hi", 99).text).toBe("Hi{{1}}");
  });
  it("keeps one example per blank and keeps what was typed", () => {
    expect(syncExamples("Hi {{1}} {{2}}", ["Ada"])).toEqual(["Ada", ""]);
    expect(syncExamples("Hi {{1}}", ["Ada", "MS-1"])).toEqual(["Ada"]);
    expect(syncExamples("Hi", ["Ada"])).toEqual([]);
  });
});

describe("buttons", () => {
  it("greys out a kind that has reached its limit and says why", () => {
    const url = newButton("URL");
    const phone = newButton("PHONE_NUMBER");
    const menu = (b: Parameters<typeof buttonMenu>[0]) => Object.fromEntries(buttonMenu(b).map((m) => [m.kind, m.disabled]));
    expect(menu([])).toEqual({ QUICK_REPLY: null, URL: null, PHONE_NUMBER: null });
    expect(menu([url, url])).toMatchObject({ URL: "Two links at most", QUICK_REPLY: null });
    expect(menu([phone])).toMatchObject({ PHONE_NUMBER: "One phone number at most", URL: null });
    const ten = Array.from({ length: 10 }, () => newButton("QUICK_REPLY"));
    expect(menu(ten)).toEqual({ QUICK_REPLY: "Ten buttons at most", URL: "Ten buttons at most", PHONE_NUMBER: "Ten buttons at most" });
  });
  it("moves a button and ignores a move off the end", () => {
    expect(moveButton(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveButton(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveButton(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveButton(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("names and samples", () => {
  it("lowercases, turns spaces into underscores and drops the rest as you type", () => {
    expect(tidyTemplateName("Order Confirmed")).toBe("order_confirmed");
    expect(tidyTemplateName("Order-ready!")).toBe("order_ready");
  });
  it("checks a sample file by heading kind", () => {
    expect(sampleProblem({ type: "image/png", size: 1000 }, "IMAGE")).toBeNull();
    expect(sampleProblem({ type: "image/gif", size: 1000 }, "IMAGE")).toBe("Choose a JPG or PNG picture up to 5 MB.");
    expect(sampleProblem({ type: "image/png", size: 6 * 1024 * 1024 }, "IMAGE")).toMatch(/^That file is too big/);
    expect(sampleProblem({ type: "video/mp4", size: 15 * 1024 * 1024 }, "VIDEO")).toBeNull();
    expect(sampleProblem({ type: "application/pdf", size: 17 * 1024 * 1024 }, "DOCUMENT")).toMatch(/too big/);
    expect(sampleProblem({ type: "application/pdf", size: 0 }, "DOCUMENT")).toBe("That file is empty.");
  });
});

describe("heading kind", () => {
  it("keeps the text when switching to Text again, and starts a media heading without a sample", () => {
    const withText = withHeaderKind(EMPTY_DRAFT, "TEXT");
    expect(withText.header).toEqual({ format: "TEXT", text: "", example: "" });
    expect(withHeaderKind(withText, "TEXT")).toBe(withText);
    expect(withHeaderKind(withText, "IMAGE").header).toEqual({ format: "IMAGE", sampleKey: "", sampleMime: "", sampleName: "" });
    expect(withHeaderKind(withText, "NONE").header).toBeNull();
    expect(sameDraft(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(true);
    expect(sameDraft(EMPTY_DRAFT, withText)).toBe(false);
  });
});
