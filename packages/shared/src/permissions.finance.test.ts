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
