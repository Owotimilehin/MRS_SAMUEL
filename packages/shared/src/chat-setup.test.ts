import { describe, it, expect } from "vitest";
import { describeChatSetupPayload, normaliseChatSetup, validateChatSetup, EMPTY_CHAT_SETUP, type ChatSetupConfig } from "./chat-setup.js";

describe("describeChatSetupPayload", () => {
  it("describeChatSetupPayload: start, ice 1-4, menu 1-20; rejects ice:5, menu:0, other strings, null", () => {
    expect(describeChatSetupPayload("ms:v1:start")).toEqual({ source: "get_started", index: null, caption: "Tapped Get started", fallbackTitle: "Get started" });
    for (let n = 1; n <= 4; n++) {
      expect(describeChatSetupPayload(`ms:v1:ice:${n}`)).toEqual({ source: "ice_breaker", index: n, caption: "Tapped a starter question", fallbackTitle: `Starter question ${n}` });
    }
    for (let n = 1; n <= 20; n++) {
      expect(describeChatSetupPayload(`ms:v1:menu:${n}`)).toMatchObject({ source: "menu", index: n, caption: "Tapped a menu button", fallbackTitle: `Menu button ${n}` });
    }
    for (const bad of ["ms:v1:ice:5", "ms:v1:menu:0", "ms:v1:menu:21", "GET_STARTED", "ms:v2:start", "", null, undefined]) {
      expect(describeChatSetupPayload(bad)).toBeNull();
    }
  });
});

const base = (over: Partial<ChatSetupConfig> = {}): ChatSetupConfig => ({ ...EMPTY_CHAT_SETUP, ...over });

describe("validateChatSetup", () => {
  it("validateChatSetup: greeting over 160; unknown token; 5 questions; duplicate questions; 6 menu buttons; title over 30; http link refused", () => {
    const v = (c: ChatSetupConfig, k: "messenger" | "instagram" = "messenger") => validateChatSetup(c, k).map((p) => p.message);
    expect(v(base())).toEqual([]);
    expect(v(base({ greeting: "Hi {{user_first_name}}" }))).toEqual([]);
    expect(v(base({ greeting: "x".repeat(161) }))).toContain("The welcome text is too long. Keep it to 160 characters.");
    expect(v(base({ greeting: "x".repeat(160) }))).toEqual([]);
    expect(v(base({ greeting: "Hi {{user_full_name}}" }))).toContain("Only {{user_first_name}} can be used to insert the customer's name.");
    expect(v(base({ iceBreakers: ["a", "b", "c", "d", "e"] }))).toContain("You can have up to 4 starter questions.");
    expect(v(base({ iceBreakers: ["x".repeat(81)] }))).toContain("Starter question 1 is too long. Keep it to 80 characters.");
    expect(v(base({ iceBreakers: ["Hello?", "hello?"] }))).toContain("Starter questions 1 and 2 are the same.");
    const six = Array.from({ length: 6 }, (_, i) => ({ type: "postback" as const, title: `B${i}` }));
    expect(v(base({ menu: six }))).toContain("The menu can have up to 5 buttons.");
    expect(v(base({ menu: [{ type: "postback", title: "x".repeat(31) }] }))).toContain("Menu button 1 needs a name of 1 to 30 characters.");
    expect(v(base({ menu: [{ type: "postback", title: " " }] }))).toContain("Menu button 1 needs a name of 1 to 30 characters.");
    expect(v(base({ menu: [{ type: "web_url", title: "Shop", url: "http://www.mrssamuel.com" }] }))).toContain(
      "Menu button 1 needs a link that starts with https://",
    );
    expect(v(base({ menu: [{ type: "web_url", title: "Shop", url: "https://www.mrssamuel.com" }] }))).toEqual([]);
    expect(v(base({ menu: [{ type: "web_url", title: "Shop", url: `https://a.co/${"x".repeat(500)}` }] })).length).toBe(1);
  });
});

describe("normaliseChatSetup", () => {
  it("normaliseChatSetup: trims, drops empty questions, forces getStarted with a menu on messenger, clears greeting and getStarted on instagram", () => {
    const messy = base({
      greeting: "  Hello  ",
      iceBreakers: ["  What juices?  ", "   ", ""],
      menu: [
        { type: "postback", title: " Talk to us ", url: "https://ignored.example" },
        { type: "web_url", title: " Shop ", url: " https://www.mrssamuel.com " },
      ],
    });
    expect(normaliseChatSetup(messy, "messenger")).toEqual({
      greeting: "Hello",
      getStarted: true,
      iceBreakers: ["What juices?"],
      menu: [
        { type: "postback", title: "Talk to us" },
        { type: "web_url", title: "Shop", url: "https://www.mrssamuel.com" },
      ],
    });
    expect(normaliseChatSetup(base({ greeting: "   " }), "messenger")).toEqual(EMPTY_CHAT_SETUP);
    expect(normaliseChatSetup({ ...messy, getStarted: true }, "instagram")).toEqual({
      greeting: null,
      getStarted: false,
      iceBreakers: ["What juices?"],
      menu: [
        { type: "postback", title: "Talk to us" },
        { type: "web_url", title: "Shop", url: "https://www.mrssamuel.com" },
      ],
    });
  });
});
