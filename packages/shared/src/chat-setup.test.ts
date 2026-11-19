import { describe, it, expect } from "vitest";
import { describeChatSetupPayload } from "./chat-setup.js";

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
