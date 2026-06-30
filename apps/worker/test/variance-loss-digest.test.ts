import { describe, it, expect } from "vitest";
import { formatVarianceLossDigest } from "../src/jobs/variance-loss-digest.js";

describe("formatVarianceLossDigest", () => {
  it("summarises totals and by-source split", () => {
    const text = formatVarianceLossDigest("2026-06", {
      bottles: 12,
      valueNgn: 42000,
      bySource: { transfer: { bottles: 5, valueNgn: 17500 }, shift_close: { bottles: 7, valueNgn: 24500 } },
      top: [{ label: "Ginger Spark 650ml", valueNgn: 17500 }],
    });
    expect(text).toContain("2026-06");
    expect(text).toContain("₦42,000");
    expect(text).toContain("Transfers");
    expect(text).toContain("Shift close");
    expect(text).toContain("Ginger Spark 650ml");
  });

  it("says clean month when nothing lost", () => {
    const text = formatVarianceLossDigest("2026-06", { bottles: 0, valueNgn: 0, bySource: {}, top: [] });
    expect(text).toContain("No stock losses");
  });
});
