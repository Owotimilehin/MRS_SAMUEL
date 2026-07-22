// apps/customer/src/lib/uuid.test.ts
// Guards the crash-safe UUID helper against browsers that lack
// crypto.randomUUID (older Safari/Android WebView, UC Browser, Opera Mini,
// in-app webviews) — the exact condition that made "Place order" do nothing.
import { describe, it, expect, afterEach, vi } from "vitest";
import { safeRandomUuid } from "@/lib/uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeRandomUuid", () => {
  it("returns a valid v4 UUID using native crypto.randomUUID when present", () => {
    expect(safeRandomUuid()).toMatch(V4);
  });

  it("does not throw and still returns a v4 UUID when crypto.randomUUID is missing", () => {
    // Simulate UC Browser / Opera Mini / old WebView: getRandomValues exists
    // but randomUUID does not. Previously the caller crashed here.
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i * 7 + 1;
        return arr;
      },
    });
    expect(() => safeRandomUuid()).not.toThrow();
    expect(safeRandomUuid()).toMatch(V4);
  });

  it("does not throw even when crypto.randomUUID throws (insecure context)", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new TypeError("crypto.randomUUID is not available");
      },
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 13 + 5) & 0xff;
        return arr;
      },
    });
    expect(() => safeRandomUuid()).not.toThrow();
    expect(safeRandomUuid()).toMatch(V4);
  });

  it("still returns a v4 UUID when crypto is entirely absent", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => safeRandomUuid()).not.toThrow();
    expect(safeRandomUuid()).toMatch(V4);
  });

  it("returns distinct values across calls", () => {
    const a = safeRandomUuid();
    const b = safeRandomUuid();
    expect(a).not.toEqual(b);
  });
});
