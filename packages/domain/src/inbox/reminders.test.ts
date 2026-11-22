import { describe, expect, it } from "vitest";
import { canBeGivenReminder, canChangeReminder, canSeeReminder, isReminderDue, type ReminderFacts } from "./reminders.js";
import type { InboxViewer } from "./scope.js";

const me: InboxViewer = { userId: "U1", capabilities: ["inbox.view"], teamIds: ["T1"], numberIds: ["N1"] };
const chatInScope = { phoneNumberId: "N1", teamId: "T1", assigneeId: null };
const chatOutOfScope = { phoneNumberId: "N2", teamId: "T1", assigneeId: null };

const onChat = (conversation: ReminderFacts["conversation"], extra: Partial<ReminderFacts> = {}): ReminderFacts => ({
  conversation,
  assigneeId: "U1",
  createdBy: "U1",
  ...extra,
});

describe("who sees a reminder on a chat", () => {
  it("follows the chat-visibility rule and nothing else", () => {
    expect(canSeeReminder(me, onChat(chatInScope))).toBe(true);
    // Even my own reminder is hidden once the chat is out of my scope.
    expect(canSeeReminder(me, onChat(chatOutOfScope))).toBe(false);
    // Someone else's chat in my team: hidden without inbox.view_team.
    expect(canSeeReminder(me, onChat({ ...chatInScope, assigneeId: "U2" }, { assigneeId: "U2", createdBy: "U2" }))).toBe(false);
    const team: InboxViewer = { ...me, capabilities: ["inbox.view", "inbox.view_team"] };
    expect(canSeeReminder(team, onChat({ ...chatInScope, assigneeId: "U2" }, { assigneeId: "U2", createdBy: "U2" }))).toBe(true);
  });
  it("needs inbox.view at all", () => {
    expect(canSeeReminder({ ...me, capabilities: ["contacts.view"] }, onChat(null))).toBe(false);
  });
});

describe("who sees a reminder on a contact", () => {
  const contactOnly = (assigneeId: string, createdBy: string | null): ReminderFacts => ({ conversation: null, assigneeId, createdBy });
  it("its assignee and its creator", () => {
    expect(canSeeReminder(me, contactOnly("U1", "U2"))).toBe(true);
    expect(canSeeReminder(me, contactOnly("U2", "U1"))).toBe(true);
    expect(canSeeReminder(me, contactOnly("U2", "U3"))).toBe(false);
  });
  it("anyone who may see contacts", () => {
    expect(canSeeReminder({ ...me, capabilities: ["inbox.view", "contacts.view"] }, contactOnly("U2", "U3"))).toBe(true);
  });
});

describe("who may change a reminder", () => {
  it("the assignee, the creator, or someone who assigns work", () => {
    const team: InboxViewer = { ...me, capabilities: ["inbox.view", "inbox.view_team"] };
    const others = onChat(chatInScope, { assigneeId: "U2", createdBy: "U3" });
    expect(canSeeReminder(team, others)).toBe(true);
    expect(canChangeReminder(team, others)).toBe(false);
    expect(canChangeReminder({ ...team, capabilities: [...team.capabilities, "inbox.assign"] }, others)).toBe(true);
    expect(canChangeReminder(me, onChat(chatInScope, { assigneeId: "U2", createdBy: "U1" }))).toBe(true);
  });
  it("never someone who cannot see it", () => {
    const boss: InboxViewer = { ...me, capabilities: ["inbox.view", "inbox.assign"] };
    expect(canChangeReminder(boss, onChat(chatOutOfScope))).toBe(false);
  });
});

describe("who may be given a reminder", () => {
  it("only someone who will be able to see it", () => {
    const other: InboxViewer = { userId: "U2", capabilities: ["inbox.view"], teamIds: ["T1"], numberIds: ["N1"] };
    expect(canBeGivenReminder(other, { conversation: chatInScope })).toBe(true);
    expect(canBeGivenReminder(other, { conversation: chatOutOfScope })).toBe(false);
    expect(canBeGivenReminder(other, { conversation: null })).toBe(false);
    expect(canBeGivenReminder({ ...other, capabilities: ["inbox.view", "contacts.view"] }, { conversation: null })).toBe(true);
    expect(canBeGivenReminder(null, { conversation: chatInScope })).toBe(false);
  });
});

describe("due", () => {
  it("from its due time until done", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(isReminderDue({ dueAt: new Date("2026-11-20T09:59:00Z"), doneAt: null }, now)).toBe(true);
    expect(isReminderDue({ dueAt: now, doneAt: null }, now)).toBe(true);
    expect(isReminderDue({ dueAt: new Date("2026-11-20T10:01:00Z"), doneAt: null }, now)).toBe(false);
    expect(isReminderDue({ dueAt: new Date("2026-11-20T09:00:00Z"), doneAt: now }, now)).toBe(false);
  });
});
