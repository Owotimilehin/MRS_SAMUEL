import { describe, it, expect } from "vitest";
import { resolveCapabilities, CAPABILITIES } from "./permissions.js";

describe("finance.view capability", () => {
  it("is in the capability catalog", () => {
    expect(CAPABILITIES).toContain("finance.view");
  });
  it("is granted to owner by default", () => {
    expect(resolveCapabilities("owner")).toContain("finance.view");
  });
  it("is NOT granted to admin or manager by default", () => {
    expect(resolveCapabilities("admin")).not.toContain("finance.view");
    expect(resolveCapabilities("manager")).not.toContain("finance.view");
  });
  it("can be granted to a manager via overrides", () => {
    expect(
      resolveCapabilities("manager", { granted: ["finance.view"], revoked: [] }),
    ).toContain("finance.view");
  });
});

/**
 * finance.daily is the shallow split of finance.view: the day's takings, which
 * managers need because they fulfil the online orders that produce them. It must
 * never drag the deep financial views (P&L, cost structure, variance losses)
 * along with it.
 */
describe("finance.daily capability", () => {
  it("is in the capability catalog", () => {
    expect(CAPABILITIES).toContain("finance.daily");
  });

  it("is granted to owner and manager by default", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(resolveCapabilities(role)).toContain("finance.daily");
    }
  });

  it("does not leak finance.view to the manager who holds it", () => {
    const caps = resolveCapabilities("manager");
    expect(caps).toContain("finance.daily");
    expect(caps).not.toContain("finance.view");
  });

  it("is withheld from admin and branch staff", () => {
    // Admins keep catalog/config/content; daily takings belong to the branch
    // operations role that runs the close. Asserted server-side in
    // reports-daily.test.ts too.
    for (const role of ["admin", "branch_staff"] as const) {
      const caps = resolveCapabilities(role);
      expect(caps).not.toContain("finance.daily");
      expect(caps).not.toContain("finance.view");
    }
  });

  it("can be revoked from a manager via overrides", () => {
    expect(
      resolveCapabilities("manager", { granted: [], revoked: ["finance.daily"] }),
    ).not.toContain("finance.daily");
  });
});
