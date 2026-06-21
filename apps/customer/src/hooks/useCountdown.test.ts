// apps/customer/src/hooks/useCountdown.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { compute } from "./useCountdown";

afterEach(() => vi.useRealTimers());

describe("useCountdown / compute", () => {
  it("formats remaining time as M:SS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    const target = new Date("2026-06-21T00:01:05Z").toISOString();
    expect(compute(target)).toEqual({ mmss: "1:05", expired: false, totalMs: 65000 });
  });

  it("pads seconds below ten", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    const target = new Date("2026-06-21T00:00:09Z").toISOString();
    expect(compute(target).mmss).toBe("0:09");
  });

  it("is expired once the target has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00Z"));
    const past = new Date("2026-06-20T23:59:59Z").toISOString();
    expect(compute(past)).toEqual({ mmss: "0:00", expired: true, totalMs: 0 });
  });

  it("is expired for a null target", () => {
    expect(compute(null).expired).toBe(true);
  });

  it("is expired for an invalid date string", () => {
    expect(compute("not-a-date").expired).toBe(true);
  });
});
