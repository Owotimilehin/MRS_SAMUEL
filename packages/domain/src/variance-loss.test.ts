import { describe, it, expect } from "vitest";
import { computeLossValue } from "./variance-loss.js";

describe("computeLossValue", () => {
  it("values loss at quantity * retail price", () => {
    expect(computeLossValue(5, 3500)).toBe(17500);
  });
  it("is zero when nothing lost", () => {
    expect(computeLossValue(0, 3500)).toBe(0);
  });
});
