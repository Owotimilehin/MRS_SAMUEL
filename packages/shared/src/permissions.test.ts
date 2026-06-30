import { describe, it, expect } from "vitest";
import { resolveCapabilities, hasCapability, ROLE_DEFAULTS, CAPABILITIES } from "./permissions.js";

describe("resolveCapabilities", () => {
  it("owner gets every capability", () => {
    expect(resolveCapabilities("owner").sort()).toEqual([...CAPABILITIES].sort());
  });

  it("branch_staff gets only the pos/sales/receive defaults", () => {
    expect(resolveCapabilities("branch_staff").sort()).toEqual(
      ["pos.sell", "pos.preorder", "shift_open.submit", "sales.view", "transfers.receive"].sort(),
    );
  });

  it("variance.settle is owner-only", () => {
    expect(resolveCapabilities("owner")).toContain("variance.settle");
    expect(resolveCapabilities("admin")).not.toContain("variance.settle");
    expect(resolveCapabilities("manager")).not.toContain("variance.settle");
    expect(resolveCapabilities("branch_staff")).not.toContain("variance.settle");
  });

  it("admin can oversee a till (preorders + branch flow, not stock-consuming sales)", () => {
    const caps = resolveCapabilities("admin");
    for (const cap of [
      "pos.preorder",
      "shift_open.submit",
      "sales.view",
      "daily_close.submit",
      "returns.create",
      "stock.adjust",
      "orders.manage",
    ] as const) {
      expect(caps).toContain(cap);
    }
  });

  it("a granted override adds a capability on top of the role", () => {
    const caps = resolveCapabilities("branch_staff", { granted: ["daily_close.submit"], revoked: [] });
    expect(caps).toContain("daily_close.submit");
  });

  it("a revoked override removes a default capability", () => {
    const caps = resolveCapabilities("manager", { granted: [], revoked: ["returns.create"] });
    expect(caps).not.toContain("returns.create");
  });

  it("revoke wins when a capability is both granted and revoked", () => {
    const caps = resolveCapabilities("branch_staff", {
      granted: ["stock.adjust"],
      revoked: ["stock.adjust"],
    });
    expect(caps).not.toContain("stock.adjust");
  });

  it("revoking a capability the role never had is a no-op", () => {
    const caps = resolveCapabilities("admin", { granted: [], revoked: ["users.manage"] });
    expect(caps.sort()).toEqual([...ROLE_DEFAULTS.admin].sort());
  });

  it("tolerates a malformed overrides object without throwing", () => {
    // simulate a corrupted/partial jsonb row
    const caps = resolveCapabilities("admin", {} as never);
    expect(caps.sort()).toEqual([...ROLE_DEFAULTS.admin].sort());
  });
});

describe("hasCapability", () => {
  it("hasCapability returns true/false correctly", () => {
    const caps = resolveCapabilities("branch_staff");
    expect(hasCapability(caps, "pos.sell")).toBe(true);
    expect(hasCapability(caps, "users.manage")).toBe(false);
  });
});

describe("till sell-policy capability split", () => {
  it("pos.sell (stock-consuming) is owner + branch_staff only", () => {
    expect(ROLE_DEFAULTS.owner).toContain("pos.sell");
    expect(ROLE_DEFAULTS.branch_staff).toContain("pos.sell");
    expect(ROLE_DEFAULTS.admin).not.toContain("pos.sell");
    expect(ROLE_DEFAULTS.manager).not.toContain("pos.sell");
  });

  it("pos.preorder is granted to all four roles", () => {
    for (const role of ["owner", "admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).toContain("pos.preorder");
    }
  });

  it("shift_open.submit is granted to the roles that can file counts", () => {
    for (const role of ["owner", "admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).toContain("shift_open.submit");
    }
  });
});
