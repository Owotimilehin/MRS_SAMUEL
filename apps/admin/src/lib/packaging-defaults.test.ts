import { describe, it, expect } from "vitest";
import { defaultStrawCount, defaultBagSize, pickBagMaterial } from "./packaging-defaults.js";

describe("packaging defaults", () => {
  it("straws = sum of bottle quantities (ignores non-sized lines)", () => {
    expect(defaultStrawCount([{ sizeMl: 330, quantity: 2 }, { sizeMl: 650, quantity: 1 }])).toBe(3);
    expect(defaultStrawCount([{ sizeMl: null, quantity: 5 }])).toBe(0);
    expect(defaultStrawCount([])).toBe(0);
  });

  it("bag size by bottle count with boundaries at 2/3 and 5/6", () => {
    expect(defaultBagSize(1)).toBe("Small");
    expect(defaultBagSize(2)).toBe("Small");
    expect(defaultBagSize(3)).toBe("Medium");
    expect(defaultBagSize(5)).toBe("Medium");
    expect(defaultBagSize(6)).toBe("Large");
    expect(defaultBagSize(20)).toBe("Large");
  });

  it("picks the bag whose name contains the size word, else the first bag, else null", () => {
    const bags = [
      { material_id: "s", name: "Small Bag" },
      { material_id: "m", name: "Medium Bag" },
      { material_id: "l", name: "Large Bag" },
    ];
    expect(pickBagMaterial(bags, "Medium")?.material_id).toBe("m");
    expect(pickBagMaterial([{ material_id: "x", name: "Generic Carrier" }], "Large")?.material_id).toBe("x");
    expect(pickBagMaterial([], "Small")).toBeNull();
  });
});
