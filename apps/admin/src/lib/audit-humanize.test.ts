// apps/admin/src/lib/audit-humanize.test.ts
import { describe, it, expect } from "vitest";
import { humanizeAction, humanizeEntity, entityTypeLabel, actionFilterLabel, humanizeDiff, type AuditRow } from "./audit-humanize.js";

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

describe("inbox audit rows read as plain English", () => {
  it("describes a contact-list download, not 'Customer #export'", () => {
    const r = row({ action: "inbox.contacts_export", entityType: "customer", entityId: "export", afterJson: { rows: 3 } });
    expect(humanizeAction(r, [])).toBe("Downloaded the contact list (3 contacts)");
    expect(humanizeEntity(r)).toBe("All contacts");
  });
  it("describes notes and conversation changes", () => {
    const note = row({ action: "inbox.note_add", entityType: "inbox_note", afterJson: { conversation_id: "c1111111-0000" } });
    expect(humanizeAction(note, [])).toBe("Added an internal note to a conversation");
    expect(humanizeEntity(note)).toBe("In conversation ref c1111111");
    const closed = row({ action: "inbox.conversation_update", entityType: "inbox_conversation", entityId: "c1111111-0000", afterJson: { status: "closed" } });
    expect(humanizeAction(closed, [])).toBe("Closed a conversation");
    expect(humanizeEntity(closed)).toBe("Conversation ref c1111111");
    const assigned = row({ action: "inbox.conversation_update", entityType: "inbox_conversation", afterJson: { assignee_id: "u1" } });
    expect(humanizeAction(assigned, [])).toBe("Assigned a conversation");
  });
  it("leaves out a missing name instead of printing a dash", () => {
    const r = row({ action: "inbox.team_update", entityType: "inbox_team", afterJson: { is_active: false } });
    expect(humanizeAction(r, [])).toBe("Updated inbox team");
  });
  it("never shows a raw action key in the filter", () => {
    expect(actionFilterLabel("inbox.contacts_export")).toBe("Inbox: contact list downloads");
    expect(actionFilterLabel("inbox.some_new_thing")).toBe("Inbox: some new thing");
    expect(actionFilterLabel("inbox.some_new_thing")).not.toContain("_");
  });
  it("has a sentence for every inbox action the API writes", () => {
    const actions = [
      "message_send", "note_add", "conversation_update", "call_transfer", "recording_play", "recording_download",
      "recording_delete", "contact_update", "contact_merge", "contact_erase", "contacts_export", "quick_reply_create",
      "quick_reply_update", "quick_reply_delete", "templates_sync", "number_create", "number_update", "number_register",
      "number_access_set", "team_create", "team_update", "team_members_set", "hours_create", "hours_update",
      "holiday_create", "holiday_delete", "ivr_create", "ivr_update",
    ];
    for (const a of actions) {
      const text = humanizeAction(row({ action: `inbox.${a}`, entityType: "inbox_conversation" }), []);
      expect(text, a).not.toMatch(/^Inbox: /);
      expect(text, a).not.toContain("—");
      expect(actionFilterLabel(`inbox.${a}`), a).not.toContain("_");
    }
  });
});
