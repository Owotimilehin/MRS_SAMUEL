import { describe, expect, it } from "vitest";
import type { InboxViewer } from "@ms/domain";
import { STALE_REMINDER_MS, reminderPush, shouldAlertReminder, type DueReminder } from "./inbox-tasks.js";

const now = new Date("2026-11-20T10:00:00Z");
const assignee: InboxViewer = { userId: "U1", capabilities: ["inbox.view"], teamIds: ["T1"], numberIds: ["N1"] };
const onMyChat: DueReminder = {
  id: "R1",
  dueAt: new Date(now.getTime() - 60_000),
  facts: { conversation: { phoneNumberId: "N1", teamId: "T1", assigneeId: "U1" }, assigneeId: "U1", createdBy: "U1" },
};

describe("which due reminders alert", () => {
  it("alerts the assignee who can see it", () => {
    expect(shouldAlertReminder(onMyChat, assignee, "assigned", now)).toBe(true);
    // The message-alert level doesn't narrow reminders: they are always the person's own.
    expect(shouldAlertReminder(onMyChat, assignee, "all", now)).toBe(true);
  });
  it("stays quiet when alerts are off, the person is gone, or the chat left their scope", () => {
    expect(shouldAlertReminder(onMyChat, assignee, "none", now)).toBe(false);
    expect(shouldAlertReminder(onMyChat, undefined, "assigned", now)).toBe(false);
    const moved = { ...onMyChat, facts: { ...onMyChat.facts, conversation: { phoneNumberId: "N2", teamId: "T1", assigneeId: "U1" } } };
    expect(shouldAlertReminder(moved, assignee, "assigned", now)).toBe(false);
  });
  it("does not alert for reminders long overdue when first seen (worker was down)", () => {
    const old = { ...onMyChat, dueAt: new Date(now.getTime() - STALE_REMINDER_MS - 60_000) };
    expect(shouldAlertReminder(old, assignee, "assigned", now)).toBe(false);
  });
  it("alerts for a contact-only reminder assigned to them", () => {
    const contactOnly: DueReminder = { ...onMyChat, facts: { conversation: null, assigneeId: "U1", createdBy: "U2" } };
    expect(shouldAlertReminder(contactOnly, assignee, "assigned", now)).toBe(true);
  });
});

describe("reminder push wording", () => {
  it("names the customer and keeps the note short", () => {
    expect(reminderPush("Call back about the party order", "Ada")).toEqual({ title: "Reminder: Ada", body: "Call back about the party order" });
    expect(reminderPush("x".repeat(300), null).body).toHaveLength(120);
    expect(reminderPush("Hi", null).title).toBe("Reminder");
  });
});
