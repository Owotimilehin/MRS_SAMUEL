import { describe, it, expect } from "vitest";
import { allocateFifo } from "../../src/lib/packaging-cost.js";

describe("allocateFifo", () => {
  it("returns zero cost when no units consumed on the day", () => {
    expect(allocateFifo([{ quantity: 100, unitCostNgn: 50 }], 0, 0, 50)).toEqual({
      costNgn: 0,
      unitsFromLayers: 0,
      unitsFallback: 0,
    });
  });

  it("costs all day-units from a single layer", () => {
    // 10 sold today, all from the 50-naira layer
    expect(allocateFifo([{ quantity: 100, unitCostNgn: 50 }], 0, 10, 50)).toEqual({
      costNgn: 500,
      unitsFromLayers: 10,
      unitsFallback: 0,
    });
  });

  it("spans two layers when the first is partially pre-consumed (the owner's '20 left' rule)", () => {
    // layer A: 20 @ 40, layer B: 100 @ 60. 5 already consumed (prior).
    // 30 sold today -> 15 remaining in A @40 + 15 from B @60 = 600 + 900 = 1500
    expect(
      allocateFifo(
        [{ quantity: 20, unitCostNgn: 40 }, { quantity: 100, unitCostNgn: 60 }],
        5,
        30,
        60,
      ),
    ).toEqual({ costNgn: 1500, unitsFromLayers: 30, unitsFallback: 0 });
  });

  it("skips fully-consumed leading layers via priorUnits", () => {
    // layer A: 20 @ 40 fully consumed (prior=20). 10 sold today all from B @60 = 600
    expect(
      allocateFifo(
        [{ quantity: 20, unitCostNgn: 40 }, { quantity: 100, unitCostNgn: 60 }],
        20,
        10,
        60,
      ),
    ).toEqual({ costNgn: 600, unitsFromLayers: 10, unitsFallback: 0 });
  });

  it("falls back to the latest price when layers are exhausted", () => {
    // layer A: 20 @ 40 (total stock 20). prior=15, sell 10 today:
    // 5 from A @40 = 200, 5 beyond stock @ fallback 55 = 275 -> 475
    expect(
      allocateFifo([{ quantity: 20, unitCostNgn: 40 }], 15, 10, 55),
    ).toEqual({ costNgn: 475, unitsFromLayers: 5, unitsFallback: 5 });
  });

  it("uses fallback for every unit when there are no layers at all", () => {
    expect(allocateFifo([], 0, 8, 70)).toEqual({
      costNgn: 560,
      unitsFromLayers: 0,
      unitsFallback: 8,
    });
  });
});
