import { describe, it, expect } from "vitest";
import { visibleTabs, type BranchTab } from "./branch-tabs.js";

const tabs: BranchTab[] = [
  { to: "/branch/online-orders", label: "Online", cap: "sales.view" },
  { to: "/branch/preorders", label: "Preorders", cap: "pos.preorder" },
  { to: "/branch/stock", label: "On hand" }, // no cap → always
];

describe("visibleTabs", () => {
  it("keeps only tabs the user can reach (cap present or no cap)", () => {
    expect(visibleTabs(tabs, ["pos.preorder"]).map((t) => t.label)).toEqual(["Preorders", "On hand"]);
  });
  it("an empty-capability user (owner sentinel) sees all tabs", () => {
    expect(visibleTabs(tabs, []).map((t) => t.label)).toEqual(["Online", "Preorders", "On hand"]);
  });
});
