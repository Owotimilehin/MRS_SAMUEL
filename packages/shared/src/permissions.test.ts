import { describe, it, expect } from "vitest";
import { resolveCapabilities, hasCapability, ROLE_DEFAULTS, CAPABILITIES } from "./permissions.js";

describe("resolveCapabilities", () => {
  it("owner gets every capability", () => {
    expect(resolveCapabilities("owner").sort()).toEqual([...CAPABILITIES].sort());
  });

  it("branch_staff gets only the pos/sales/receive defaults", () => {
    expect(resolveCapabilities("branch_staff").sort()).toEqual(
      ["pos.sell", "sales.view", "transfers.receive"].sort(),
    );
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
    const caps = resolveCapabilities("admin", { granted: [], revoked: ["pos.sell"] });
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
