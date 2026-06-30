import { describe, it, expect } from "vitest";
import {
  parentVisible,
  isParentActive,
  activeParent,
  BRANCH_NAV,
  type BranchNavItem,
} from "./branch-nav.js";

const orders: BranchNavItem = {
  to: "/branch/online-orders",
  label: "Orders",
  icon: "🛒",
  caps: ["sales.view", "pos.preorder"],
  group: ["/branch/online-orders", "/branch/preorders"],
};

describe("parentVisible", () => {
  it("shows when the user has ANY of the parent's caps", () => {
    expect(parentVisible(orders, ["pos.preorder"])).toBe(true);
  });
  it("hides when the user has none of them", () => {
    expect(parentVisible(orders, ["returns.create"])).toBe(false);
  });
  it("empty caps (owner) always shows", () => {
    expect(parentVisible(orders, [])).toBe(true);
  });
});

describe("isParentActive", () => {
  it("is active on any route in the group (incl. detail children)", () => {
    expect(isParentActive(orders, "/branch/preorders")).toBe(true);
    expect(isParentActive(orders, "/branch/online-orders/abc-123")).toBe(true);
    expect(isParentActive(orders, "/branch/stock")).toBe(false);
  });
});

describe("activeParent (most specific wins)", () => {
  it("/branch/sell → Sell, not Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch/sell")?.label).toBe("Sell");
  });
  it("/branch/sales → Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch/sales")?.label).toBe("Today");
  });
  it("/branch (home) → Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch")?.label).toBe("Today");
  });
  it("/branch/preorders → Orders", () => {
    expect(activeParent(BRANCH_NAV, "/branch/preorders")?.label).toBe("Orders");
  });
});
