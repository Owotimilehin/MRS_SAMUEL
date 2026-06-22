// apps/admin/src/lib/audit-humanize.test.ts
import { describe, it, expect } from "vitest";
import { humanizeEntity, entityTypeLabel, humanizeDiff, type AuditRow } from "./audit-humanize.js";

function row(partial: Partial<AuditRow>): AuditRow {
  return {
    id: "1", actorUserId: null, actorRole: null, actorBranchId: null,
    action: "thing.did", entityType: "thing", entityId: "a1b2c3d4e5f6",
    beforeJson: null, afterJson: null, ipAddress: null, userAgent: null,
    occurredAt: new Date().toISOString(), ...partial,
  };
}

describe("entityTypeLabel", () => {
  it("tidies and title-cases an unmapped type instead of returning a raw token", () => {
    expect(entityTypeLabel("some_new_thing")).toBe("Some new thing");
  });
});

describe("humanizeEntity", () => {
  it("prefers a human name field over the UUID", () => {
    expect(humanizeEntity(row({ entityType: "thing", afterJson: { name: "Mango Crush" } }))).toBe("Mango Crush");
  });
  it("falls back to a labeled reference, not a bare hex slice", () => {
    const out = humanizeEntity(row({ entityType: "some_new_thing", afterJson: {} }));
    expect(out).not.toBe("a1b2c3d4");
    expect(out.toLowerCase()).toContain("some new thing");
  });
});

describe("humanizeDiff generic fallback", () => {
  it("diffs primitive fields for an entity type with no field-label map", () => {
    const lines = humanizeDiff({ note: "old", weirdInternalId: "x" }, { note: "new", weirdInternalId: "y" }, "vendor");
    const noteLine = lines.find((l) => l.label.toLowerCase() === "note");
    expect(noteLine).toBeDefined();
    expect(noteLine?.before).toBe("old");
    expect(noteLine?.after).toBe("new");
  });
  it("hides noise fields (ids, timestamps) from the generic diff", () => {
    const lines = humanizeDiff({ id: "1", createdAt: "t", note: "a" }, { id: "1", createdAt: "t2", note: "b" }, "vendor");
    expect(lines.some((l) => l.field === "id" || l.field === "createdAt")).toBe(false);
  });
});
