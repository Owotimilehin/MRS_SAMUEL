import { describe, it, expect } from "vitest";
import { resolveCapabilities, hasCapability, ROLE_DEFAULTS, CAPABILITIES } from "./permissions.js";

describe("resolveCapabilities", () => {
  it("owner gets every capability", () => {
    expect(resolveCapabilities("owner").sort()).toEqual([...CAPABILITIES].sort());
  });

  it("branch_staff gets the pos/sales/receive defaults plus order follow-up", () => {
    expect(resolveCapabilities("branch_staff").sort()).toEqual(
      [
        "pos.sell",
        "pos.preorder",
        "shift_open.submit",
        "sales.view",
        "transfers.receive",
        "orders.view",
        "orders.manage",
        "expenses.branch_write",
      ].sort(),
    );
  });

  it("branch_staff can view and manage orders (re-check / record payment)", () => {
    const caps = resolveCapabilities("branch_staff");
    expect(caps).toContain("orders.view");
    expect(caps).toContain("orders.manage");
  });

  it("branch_staff still cannot force-accept a mismatched payment (owner-only)", () => {
    const caps = resolveCapabilities("branch_staff");
    expect(caps).not.toContain("orders.accept_payment");
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

describe("channels.manage", () => {
  it("is held by owner and admin, not manager or branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("channels.manage");
    expect(resolveCapabilities("admin")).toContain("channels.manage");
    expect(resolveCapabilities("manager")).not.toContain("channels.manage");
    expect(resolveCapabilities("branch_staff")).not.toContain("channels.manage");
  });
});

describe("templates.manage", () => {
  it("is held by owner and admin, not manager or branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("templates.manage");
    expect(resolveCapabilities("admin")).toContain("templates.manage");
    expect(resolveCapabilities("manager")).not.toContain("templates.manage");
    expect(resolveCapabilities("branch_staff")).not.toContain("templates.manage");
  });
});

describe("catalogue.manage", () => {
  it("is held by owner and admin, not by manager or branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("catalogue.manage");
    expect(resolveCapabilities("admin")).toContain("catalogue.manage");
    expect(resolveCapabilities("manager")).not.toContain("catalogue.manage");
    expect(resolveCapabilities("branch_staff")).not.toContain("catalogue.manage");
  });
});

describe("social.publish", () => {
  it("is held by owner and admin, not manager or branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("social.publish");
    expect(resolveCapabilities("admin")).toContain("social.publish");
    expect(resolveCapabilities("manager")).not.toContain("social.publish");
    expect(resolveCapabilities("branch_staff")).not.toContain("social.publish");
  });
});

describe("insights.view", () => {
  it("is held by owner, admin and manager, not branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("insights.view");
    expect(resolveCapabilities("admin")).toContain("insights.view");
    expect(resolveCapabilities("manager")).toContain("insights.view");
    expect(resolveCapabilities("branch_staff")).not.toContain("insights.view");
  });
});

describe("ads permissions (suite spec 12)", () => {
  it("ads.view is held by owner and admin, not manager or branch staff", () => {
    expect(resolveCapabilities("owner")).toContain("ads.view");
    expect(resolveCapabilities("admin")).toContain("ads.view");
    expect(resolveCapabilities("manager")).not.toContain("ads.view");
    expect(resolveCapabilities("branch_staff")).not.toContain("ads.view");
  });
  it("ads.manage is owner only by default (it spends money)", () => {
    expect(resolveCapabilities("owner")).toContain("ads.manage");
    for (const role of ["admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).not.toContain("ads.manage");
      expect(resolveCapabilities(role)).not.toContain("ads.manage");
    }
  });
});

describe("contacts.view and contacts.manage", () => {
  it("view is held by owner, admin and manager; manage by owner and admin only", () => {
    expect(resolveCapabilities("owner")).toContain("contacts.view");
    expect(resolveCapabilities("admin")).toContain("contacts.view");
    expect(resolveCapabilities("manager")).toContain("contacts.view");
    expect(resolveCapabilities("branch_staff")).not.toContain("contacts.view");
    expect(resolveCapabilities("owner")).toContain("contacts.manage");
    expect(resolveCapabilities("admin")).toContain("contacts.manage");
    expect(resolveCapabilities("manager")).not.toContain("contacts.manage");
    expect(resolveCapabilities("branch_staff")).not.toContain("contacts.manage");
  });
});

describe("broadcasts.send (suite spec 14, Phase B)", () => {
  it("broadcasts.send is owner only by default (it messages many customers at once)", () => {
    expect(resolveCapabilities("owner")).toContain("broadcasts.send");
    for (const role of ["admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).not.toContain("broadcasts.send");
      expect(resolveCapabilities(role)).not.toContain("broadcasts.send");
    }
  });
  it("broadcasts.send can be granted to a named person", () => {
    expect(resolveCapabilities("admin", { granted: ["broadcasts.send"], revoked: [] })).toContain("broadcasts.send");
  });
});

describe("expenses.branch_write (branch spending)", () => {
  it("is held by owner, manager and branch staff, not admin", () => {
    expect(resolveCapabilities("owner")).toContain("expenses.branch_write");
    expect(resolveCapabilities("manager")).toContain("expenses.branch_write");
    expect(resolveCapabilities("branch_staff")).toContain("expenses.branch_write");
    expect(resolveCapabilities("admin")).not.toContain("expenses.branch_write");
  });
  it("does not unlock Bookkeeping for branch staff or managers", () => {
    for (const role of ["manager", "branch_staff"] as const) {
      expect(resolveCapabilities(role)).not.toContain("expenses.write");
      expect(resolveCapabilities(role)).not.toContain("expenses.view");
    }
  });
  it("can be revoked from a named staff member", () => {
    expect(
      resolveCapabilities("branch_staff", { granted: [], revoked: ["expenses.branch_write"] }),
    ).not.toContain("expenses.branch_write");
  });
});
