import { describe, it, expect } from "vitest";
import { pickCustomBannerMessage } from "./banner";

describe("pickCustomBannerMessage", () => {
  it("returns the trimmed message when enabled and non-empty", () => {
    expect(pickCustomBannerMessage({ enabled: true, message: "  hi  " })).toBe("hi");
  });
  it("returns null when disabled", () => {
    expect(pickCustomBannerMessage({ enabled: false, message: "hi" })).toBeNull();
  });
  it("returns null when message is blank", () => {
    expect(pickCustomBannerMessage({ enabled: true, message: "   " })).toBeNull();
  });
});
