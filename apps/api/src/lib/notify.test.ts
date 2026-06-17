import { describe, it, expect } from "vitest";
import { diffChanges, displayName } from "./notify.js";

describe("diffChanges", () => {
  it("reports changed scalar fields with friendly labels", () => {
    const out = diffChanges(
      { priceNgn: 1800, name: "Zobo" },
      { priceNgn: 2000, name: "Zobo" },
    );
    expect(out).toEqual([{ label: "Price", from: "₦1,800", to: "₦2,000" }]);
  });

  it("formats booleans as Yes/No", () => {
    const out = diffChanges({ isActive: true }, { isActive: false });
    expect(out).toEqual([{ label: "Active", from: "Yes", to: "No" }]);
  });

  it("skips noise fields and unchanged values", () => {
    const out = diffChanges(
      { updatedAt: "a", passwordHash: "x", role: "manager" },
      { updatedAt: "b", passwordHash: "y", role: "admin" },
    );
    expect(out).toEqual([{ label: "Role", from: "manager", to: "admin" }]);
  });

  it("returns [] when nothing comparable changed", () => {
    expect(diffChanges({ id: "1" }, { id: "1" })).toEqual([]);
  });
});

describe("displayName", () => {
  it("uses the name when present", () => {
    expect(displayName({ name: "Aisha Bello", email: "a@x.com" })).toBe("Aisha Bello");
  });
  it("falls back to the email handle", () => {
    expect(displayName({ name: null, email: "aisha@x.com" })).toBe("aisha");
    expect(displayName({ name: "   ", email: "deji@x.com" })).toBe("deji");
  });
});
