import { describe, it, expect, vi } from "vitest";
import { isChunkLoadError, reloadOnceForStaleChunk, type ReloadEnv } from "./chunk-reload.js";

describe("isChunkLoadError", () => {
  it("matches the Chromium dynamic-import failure", () => {
    expect(
      isChunkLoadError(
        new Error(
          "Failed to fetch dynamically imported module: https://admin.mrssamuel.com/assets/users-wa5IBd2r.js",
        ),
      ),
    ).toBe(true);
  });

  it("matches Firefox and Safari variants", () => {
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
  });

  it("matches a plain string message", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module: /assets/x.js")).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
    expect(isChunkLoadError(new Error("forbidden: missing capability"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadOnceForStaleChunk", () => {
  function makeEnv(overrides: Partial<ReloadEnv> = {}): { env: ReloadEnv; reload: ReturnType<typeof vi.fn>; store: Map<string, string> } {
    const store = new Map<string, string>();
    const reload = vi.fn();
    const env: ReloadEnv = {
      now: () => 1_000_000,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      reload,
      ...overrides,
    };
    return { env, reload, store };
  }

  it("reloads and records the timestamp on first stale-chunk error", () => {
    const { env, reload } = makeEnv();
    expect(reloadOnceForStaleChunk(env)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does NOT reload again within the cooldown window (prevents loops)", () => {
    const store = new Map<string, string>();
    const reload = vi.fn();
    let t = 1_000_000;
    const env: ReloadEnv = {
      now: () => t,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      reload,
    };
    expect(reloadOnceForStaleChunk(env)).toBe(true); // first
    t += 3_000; // 3s later, still within cooldown
    expect(reloadOnceForStaleChunk(env)).toBe(false); // suppressed
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads again once the cooldown has elapsed", () => {
    const store = new Map<string, string>();
    const reload = vi.fn();
    let t = 1_000_000;
    const env: ReloadEnv = {
      now: () => t,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      reload,
    };
    expect(reloadOnceForStaleChunk(env)).toBe(true);
    t += 60_000; // well past cooldown
    expect(reloadOnceForStaleChunk(env)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
