import { describe, expect, it } from "vitest";
import {
  conversationIdFromPath,
  shouldAlertForEvent,
  titleWithCount,
  applyEarlierPage,
  applyNewestPage,
  greetingContentType,
  greetingFileProblem,
  phoneConfirmMatches,
  sendProblem,
  timelineKey,
  backoffDelay,
  callOutcomeLabel,
  countTemplateParams,
  dayLabel,
  fillDays,
  formatSpan,
  fillTemplate,
  formatDuration,
  groupTimelineByDay,
  inboxTabsFor,
  lagosDayKey,
  lagosDaysAgo,
  listTime,
  mediaKind,
  messageTicks,
  parseLabels,
  rulesToWeek,
  sendTypeForMime,
  shouldSendTyping,
  templateBodyText,
  templateParamsComplete,
  validateMenu,
  validateWeek,
  weekToRules,
  windowText,
} from "./inbox-logic.js";
import type { TimelineItem, TimelinePage } from "./inbox-types.js";

describe("inboxTabsFor", () => {
  it("gives basic staff Mine, Unassigned and Closed only", () => {
    expect(inboxTabsFor(["inbox.view"], ["t1"]).map((t) => t.key)).toEqual(["mine", "unassigned", "closed"]);
  });
  it("adds Team and All open for supervisors in a team", () => {
    expect(inboxTabsFor(["inbox.view", "inbox.view_team"], ["t1"]).map((t) => t.key)).toEqual([
      "mine",
      "unassigned",
      "team",
      "all",
      "closed",
    ]);
  });
  it("hides Team when the person is in no team", () => {
    expect(inboxTabsFor(["inbox.view", "inbox.view_all"], []).map((t) => t.key)).toEqual([
      "mine",
      "unassigned",
      "all",
      "closed",
    ]);
  });
  it("maps Closed to status=closed across everything visible", () => {
    const closed = inboxTabsFor(["inbox.view"], []).find((t) => t.key === "closed")!;
    expect(closed).toMatchObject({ status: "closed", view: "all" });
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    const top = (): number => 1; // max jitter → full delay
    expect(backoffDelay(0, {}, top)).toBe(1000);
    expect(backoffDelay(1, {}, top)).toBe(2000);
    expect(backoffDelay(3, {}, top)).toBe(8000);
    expect(backoffDelay(10, {}, top)).toBe(30_000);
  });
  it("jitters down to half", () => {
    expect(backoffDelay(2, {}, () => 0)).toBe(2000);
  });
  it("respects custom base/max", () => {
    expect(backoffDelay(5, { baseMs: 100, maxMs: 1000 }, () => 1)).toBe(1000);
  });
});

describe("day grouping", () => {
  const now = new Date("2026-11-17T10:00:00Z"); // 11:00 Lagos

  it("keys by Lagos day, not UTC", () => {
    // 23:30 UTC on the 16th is 00:30 on the 17th in Lagos (UTC+1).
    expect(lagosDayKey("2026-11-16T23:30:00Z")).toBe("2026-11-17");
  });

  it("labels today / yesterday / older", () => {
    expect(dayLabel("2026-11-17", now)).toBe("Today");
    expect(dayLabel("2026-11-16", now)).toBe("Yesterday");
    expect(dayLabel("2026-11-03", now)).toBe("Tue 3 Nov");
    expect(dayLabel("2025-11-03", now)).toContain("2025");
  });

  it("groups and sorts items", () => {
    const note = (id: string, at: string): TimelineItem => ({
      kind: "note",
      at,
      data: { id, conversation_id: "c", body: id, author_name: null, created_at: at },
    });
    const days = groupTimelineByDay(
      [note("c", "2026-11-17T09:00:00Z"), note("a", "2026-11-16T08:00:00Z"), note("b", "2026-11-16T23:30:00Z")],
      now,
    );
    expect(days.map((d) => d.label)).toEqual(["Yesterday", "Today"]);
    expect(days[1]!.items.map((i) => (i.data as { id: string }).id)).toEqual(["b", "c"]);
  });

  it("list time shows clock for today and 'Yesterday' for yesterday", () => {
    expect(listTime("2026-11-17T08:05:00Z", now)).toBe("09:05");
    expect(listTime("2026-11-16T12:00:00Z", now)).toBe("Yesterday");
    expect(listTime("2026-10-01T12:00:00Z", now)).toBe("1 Oct");
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3720)).toBe("1h 02m");
  });
  it("describes the reply window", () => {
    expect(windowText(0).open).toBe(false);
    expect(windowText(5 * 3_600_000 + 12 * 60_000).text).toContain("5h 12m left");
    expect(windowText(20_000).text).toContain("1m left");
  });
  it("ticks", () => {
    expect(messageTicks("delivered")).toMatchObject({ marks: "✓✓", read: false });
    expect(messageTicks("read").read).toBe(true);
    expect(messageTicks("failed").label).toBe("Not sent");
  });
  it("call outcome wording depends on direction", () => {
    expect(callOutcomeLabel("missed", "in")).toBe("Missed call");
    expect(callOutcomeLabel("missed", "out")).toBe("No answer");
  });
  it("media kinds", () => {
    expect(mediaKind("image", null)).toBe("image");
    expect(mediaKind("document", "audio/ogg")).toBe("audio");
    expect(mediaKind("document", "application/pdf")).toBe("document");
    expect(sendTypeForMime("video/mp4")).toBe("video");
    expect(sendTypeForMime("application/pdf")).toBe("document");
  });
  it("parses labels like the server", () => {
    expect(parseLabels("VIP, delivery , vip,, ")).toEqual(["vip", "delivery"]);
  });
});

describe("templates", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hi" },
    { type: "BODY", text: "Hello {{1}}, your order {{2}} is ready. Thanks {{1}}!" },
  ];
  it("reads the body and counts variables", () => {
    expect(templateBodyText(components)).toContain("Hello {{1}}");
    expect(countTemplateParams(components)).toBe(2);
    expect(countTemplateParams([])).toBe(0);
  });
  it("fills variables and leaves blanks visible", () => {
    expect(fillTemplate("Hello {{1}}, order {{2}}", ["Ada"])).toBe("Hello Ada, order {{2}}");
    expect(fillTemplate("Hello {{1}}, order {{2}}", ["Ada", "MS-12"])).toBe("Hello Ada, order MS-12");
  });
  it("checks completeness", () => {
    expect(templateParamsComplete([], 0)).toBe(true);
    expect(templateParamsComplete(["Ada"], 2)).toBe(false);
    expect(templateParamsComplete(["Ada", "  "], 2)).toBe(false);
    expect(templateParamsComplete(["Ada", "MS-12"], 2)).toBe(true);
  });
});

describe("shouldSendTyping", () => {
  it("throttles to once per interval", () => {
    expect(shouldSendTyping(null, 1000)).toBe(true);
    expect(shouldSendTyping(1000, 2500)).toBe(false);
    expect(shouldSendTyping(1000, 4000)).toBe(true);
  });
});


describe("hours editor", () => {
  const rules = [
    { weekday: 1, openTime: "13:00", closeTime: "17:00" },
    { weekday: 1, openTime: "08:00", closeTime: "12:00" },
    { weekday: 6, openTime: "09:00", closeTime: "14:00" },
  ];
  it("round-trips rules through the week grid", () => {
    const week = rulesToWeek(rules);
    expect(week[0]).toEqual([]);
    expect(week[1]!.map((w) => w.open)).toEqual(["08:00", "13:00"]);
    expect(weekToRules(week)).toEqual([
      { weekday: 1, open_time: "08:00", close_time: "12:00" },
      { weekday: 1, open_time: "13:00", close_time: "17:00" },
      { weekday: 6, open_time: "09:00", close_time: "14:00" },
    ]);
  });
  it("catches bad times, reversed and overlapping slots", () => {
    expect(validateWeek(rulesToWeek(rules))).toBeNull();
    const week = rulesToWeek([]);
    week[2] = [{ open: "8:00", close: "12:00" }];
    expect(validateWeek(week)).toMatch(/Tuesday/);
    week[2] = [{ open: "12:00", close: "08:00" }];
    expect(validateWeek(week)).toMatch(/after opening/);
    week[2] = [
      { open: "08:00", close: "12:00" },
      { open: "11:00", close: "15:00" },
    ];
    expect(validateWeek(week)).toMatch(/overlap/);
    week[2] = [{ open: "18:00", close: "24:00" }];
    expect(validateWeek(week)).toBeNull();
  });
});

describe("validateMenu", () => {
  const base = { name: "Main", greeting_text: "Welcome", options: [] as Parameters<typeof validateMenu>[0]["options"] };
  it("accepts a valid menu", () => {
    expect(
      validateMenu({
        ...base,
        options: [
          { digit: "1", label: "Orders", action: "ring_team", team_id: "t", play_text: null },
          { digit: "2", label: "Hours", action: "play", team_id: null, play_text: "We open at 8" },
          { digit: "0", label: "Message", action: "voicemail", team_id: null, play_text: null },
        ],
      }),
    ).toBeNull();
  });
  it("flags duplicates and missing details", () => {
    const o = { label: "x", action: "voicemail" as const, team_id: null, play_text: null };
    expect(validateMenu({ ...base, options: [{ ...o, digit: "1" }, { ...o, digit: "1" }] })).toMatch(/twice/);
    expect(validateMenu({ ...base, options: [{ ...o, digit: "1", action: "ring_team" }] })).toMatch(/team/);
    expect(validateMenu({ ...base, options: [{ ...o, digit: "1", action: "play" }] })).toMatch(/message/);
    expect(validateMenu({ ...base, greeting_text: " " })).toMatch(/greeting/);
  });
});

describe("report helpers", () => {
  it("zero-fills missing days inclusively", () => {
    const rows = [{ day: "2026-11-02", inbound: 3, outbound: 1 }];
    expect(fillDays("2026-11-01", "2026-11-03", rows, ["inbound", "outbound"])).toEqual([
      { day: "2026-11-01", inbound: 0, outbound: 0 },
      { day: "2026-11-02", inbound: 3, outbound: 1 },
      { day: "2026-11-03", inbound: 0, outbound: 0 },
    ]);
    expect(fillDays("2026-11-03", "2026-11-01", rows, ["inbound"])).toEqual([]);
  });
  it("crosses month ends", () => {
    expect(fillDays("2026-02-27", "2026-03-01", [], ["n"]).map((r) => r.day)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
  });
  it("formats spans", () => {
    expect(formatSpan(null)).toBe("—");
    expect(formatSpan(30)).toBe("30s");
    expect(formatSpan(720)).toBe("12m");
    expect(formatSpan(12_000)).toBe("3h 20m");
    expect(formatSpan(187_200)).toBe("2d 4h");
  });
  it("counts days back on the Lagos calendar", () => {
    expect(lagosDaysAgo(1, new Date("2026-11-16T23:30:00Z"))).toBe("2026-11-16");
  });
});

// ── Timeline paging ──────────────────────────────────────────────────────────

/** A note at minute `n` of a fixed hour; `body` lets a test tell copies apart. */
function note(n: number, body = ""): TimelineItem {
  const at = `2026-11-10T10:${String(n).padStart(2, "0")}:00.000Z`;
  return { kind: "note", at, data: { id: `n${n}`, conversation_id: "c", body, author_name: null, created_at: at } };
}
const page = (ns: number[], has_more: boolean, next_before: string | null = null): TimelinePage => ({
  data: ns.map((n) => note(n)),
  has_more,
  next_before,
});
const ids = (items: TimelineItem[]): string[] => items.map((i) => i.data.id);

describe("applyNewestPage", () => {
  it("uses the page as-is on first load", () => {
    const t = applyNewestPage(undefined, page([3, 4, 5], true, "cur3"));
    expect(ids(t.items)).toEqual(["n3", "n4", "n5"]);
    expect(t).toMatchObject({ hasMore: true, nextBefore: "cur3" });
  });

  it("keeps earlier pages when a live refetch slides the newest window forward", () => {
    let t = applyNewestPage(undefined, page([3, 4, 5], true, "cur3"));
    t = applyEarlierPage(t, page([1, 2], false, null));
    t = applyNewestPage(t, page([4, 5, 6], true, "cur4"));
    expect(ids(t.items)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    // The cursor still describes the oldest loaded edge, not the refetched page.
    expect(t).toMatchObject({ hasMore: false, nextBefore: null });
  });

  it("never duplicates and prefers the fresh copy", () => {
    const first = applyNewestPage(undefined, page([1, 2, 3], true, "cur1"));
    const refetch: TimelinePage = { data: [note(2, "edited"), note(3), note(4)], has_more: true, next_before: "cur2" };
    const t = applyNewestPage(first, refetch);
    expect(ids(t.items)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(t.items[1]!.data).toMatchObject({ body: "edited" });
    expect(t.nextBefore).toBe("cur1");
  });

  it("drops items inside the page's stretch that the server no longer returns", () => {
    const first = applyNewestPage(undefined, page([1, 2, 3, 4], true, "cur1"));
    const t = applyNewestPage(first, page([2, 4, 5], true, "cur2"));
    expect(ids(t.items)).toEqual(["n1", "n2", "n4", "n5"]);
  });

  it("replaces everything when the page is the whole timeline", () => {
    const first = applyEarlierPage(applyNewestPage(undefined, page([3, 4], true, "cur3")), page([1, 2], false));
    const t = applyNewestPage(first, page([4], false, null));
    expect(ids(t.items)).toEqual(["n4"]);
    expect(t.hasMore).toBe(false);
  });

  it("starts again rather than leave a gap when the page no longer touches what was loaded", () => {
    const first = applyNewestPage(undefined, page([1, 2], true, "cur1"));
    const t = applyNewestPage(first, page([7, 8], true, "cur7"));
    expect(ids(t.items)).toEqual(["n7", "n8"]);
    expect(t).toMatchObject({ hasMore: true, nextBefore: "cur7" });
  });

  it("takes the page's cursor when nothing loaded is older than the page", () => {
    const first = applyNewestPage(undefined, page([3, 4], true, "cur3"));
    const t = applyNewestPage(first, page([2, 3, 4], true, "cur2"));
    expect(ids(t.items)).toEqual(["n2", "n3", "n4"]);
    expect(t.nextBefore).toBe("cur2");
  });

  it("sorts a page that arrives out of order and tells kinds apart", () => {
    const msgAt = "2026-11-10T10:01:30.000Z";
    const sameId: TimelineItem = { kind: "call", at: msgAt, data: { id: "n1" } as never };
    const t = applyNewestPage(undefined, { data: [note(2), sameId, note(1)], has_more: false, next_before: null });
    expect(t.items.map(timelineKey)).toEqual(["note:n1", "call:n1", "note:n2"]);
  });
});

describe("applyEarlierPage", () => {
  it("prepends, moves the cursor back and skips overlap", () => {
    const first = applyNewestPage(undefined, page([3, 4], true, "cur3"));
    const stale: TimelinePage = { data: [note(1), note(2), note(3, "stale")], has_more: true, next_before: "cur1" };
    const t = applyEarlierPage(first, stale);
    expect(ids(t.items)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(t.items[2]!.data).toMatchObject({ body: "" });
    expect(t).toMatchObject({ hasMore: true, nextBefore: "cur1" });
  });
});

describe("sendProblem", () => {
  it("separates a refused message from one WhatsApp never answered", () => {
    expect(sendProblem({ status: "failed" })).toBe("failed");
    expect(sendProblem({ status: "failed", unconfirmed: false })).toBe("failed");
    expect(sendProblem({ status: "failed", unconfirmed: true })).toBe("unconfirmed");
  });
  it("ignores the flag unless the message failed", () => {
    expect(sendProblem({ status: "delivered", unconfirmed: true })).toBeNull();
    expect(sendProblem({ status: "sent" })).toBeNull();
  });
});

describe("phoneConfirmMatches", () => {
  it("ignores spaces, dashes and the plus sign", () => {
    expect(phoneConfirmMatches("+234 803-123 4567", "+2348031234567")).toBe(true);
    expect(phoneConfirmMatches("2348031234567", "+2348031234567")).toBe(true);
  });
  it("rejects a different or partial number, and a customer with no number", () => {
    expect(phoneConfirmMatches("08031234567", "+2348031234567")).toBe(false);
    expect(phoneConfirmMatches("+234803123456", "+2348031234567")).toBe(false);
    expect(phoneConfirmMatches("", null)).toBe(false);
    expect(phoneConfirmMatches("", "")).toBe(false);
  });
});

describe("greeting recordings", () => {
  it("maps the types browsers report to the ones the server allows", () => {
    expect(greetingContentType("hi.mp3", "audio/mpeg")).toBe("audio/mpeg");
    expect(greetingContentType("hi.mp3", "audio/mp3")).toBe("audio/mpeg");
    expect(greetingContentType("hi.wav", "audio/wav")).toBe("audio/wav");
    expect(greetingContentType("hi.wav", "audio/wave")).toBe("audio/wav");
    expect(greetingContentType("hi.wav", "audio/x-wav")).toBe("audio/x-wav");
  });
  it("falls back to the extension only when the browser gives no type", () => {
    expect(greetingContentType("Greeting.MP3", "")).toBe("audio/mpeg");
    expect(greetingContentType("greeting.wav", "application/octet-stream")).toBe("audio/wav");
    expect(greetingContentType("voice.mp3", "audio/ogg")).toBeNull();
    expect(greetingContentType("notes.txt", "")).toBeNull();
  });
  it("explains what is wrong with a file", () => {
    expect(greetingFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 1000 })).toBeNull();
    expect(greetingFileProblem({ name: "a.ogg", type: "audio/ogg", size: 1000 })).toBe("Use an MP3 or WAV file.");
    expect(greetingFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 0 })).toBe("That file is empty.");
    expect(greetingFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 5 * 1024 * 1024 })).toBeNull();
    expect(greetingFileProblem({ name: "a.mp3", type: "audio/mpeg", size: 5 * 1024 * 1024 + 1 })).toMatch(/under 5 MB/);
  });
});

describe("validateMenu with recordings", () => {
  const base = { name: "Main", greeting_text: "Hello" };
  it("accepts a play option that has a recording instead of text", () => {
    expect(
      validateMenu({ ...base, options: [{ digit: "1", label: "Hours", action: "play", team_id: null, play_text: "", audio_key: "k" }] }),
    ).toBeNull();
  });
  it("still wants one or the other", () => {
    expect(
      validateMenu({ ...base, options: [{ digit: "1", label: "Hours", action: "play", team_id: null, play_text: " ", audio_key: null }] }),
    ).toMatch(/upload a recording/);
  });
});

describe("display helpers", () => {
  it("formats phone numbers readably and leaves anything else alone", async () => {
    const { prettyPhone } = await import("./inbox-logic.js");
    expect(prettyPhone("+2349033330003")).toBe("+234 903 333 0003");
    expect(prettyPhone("08031234567")).toBe("0803 123 4567");
    expect(prettyPhone("2348031234567")).toBe("+234 803 123 4567");
    expect(prettyPhone("+14155550123")).toBe("+1 415 555 0123");
    expect(prettyPhone("Ngozi Eze")).toBe("Ngozi Eze");
    expect(prettyPhone(null)).toBe("");
  });
  it("shows the part before @ for staff who only have an email", async () => {
    const { staffLabel } = await import("./inbox-logic.js");
    expect(staffLabel("owner@preview.local")).toBe("owner");
    expect(staffLabel("Ada Obi")).toBe("Ada Obi");
    expect(staffLabel(null)).toBe("Staff");
  });
  it("turns raw values into wording staff can read", async () => {
    const m = await import("./inbox-logic.js");
    expect(m.humanTemplateName("missed_call_followup")).toBe("Missed call follow-up");
    expect(m.humanDay("2026-12-25")).toBe("25 Dec 2026");
    expect(m.sentenceCase("owner")).toBe("Owner");
    expect(m.messagingLimitLabel("TIER_1K")).toBe("Up to 1,000 new chats a day");
    expect(m.emptyListText("closed", false).title).toBe("No closed chats yet");
  });
  it("picks shared chart date marks that end on the last day", async () => {
    const { axisDays } = await import("./inbox-logic.js");
    const days = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const ticks = axisDays(days, 6);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks[ticks.length - 1]).toBe("d29");
  });
});

describe("new-message alerts", () => {
  const ctx = { userId: "me", level: "assigned" as const, openConversationId: null, tabActive: true };
  const incoming = { event: "message.created", direction: "in" as const, conversationId: "c1", assigneeId: null };

  it("alerts for a customer's message in a chat nobody has picked up", () => {
    expect(shouldAlertForEvent(incoming, ctx)).toBe(true);
  });
  it("alerts for a customer's message in my own chat", () => {
    expect(shouldAlertForEvent({ ...incoming, assigneeId: "me" }, ctx)).toBe(true);
  });
  it("stays quiet for a colleague's chat unless I asked for every chat", () => {
    const theirs = { ...incoming, assigneeId: "someone-else" };
    expect(shouldAlertForEvent(theirs, ctx)).toBe(false);
    expect(shouldAlertForEvent(theirs, { ...ctx, level: "all" })).toBe(true);
  });
  it("stays quiet when notifications are off", () => {
    expect(shouldAlertForEvent(incoming, { ...ctx, level: "none" })).toBe(false);
  });
  it("never alerts for a message staff sent, a status tick, or an event with no direction", () => {
    expect(shouldAlertForEvent({ ...incoming, direction: "out" }, ctx)).toBe(false);
    expect(shouldAlertForEvent({ event: "message.created", conversationId: "c1" }, ctx)).toBe(false);
    expect(shouldAlertForEvent({ ...incoming, event: "message.status" }, ctx)).toBe(false);
    expect(shouldAlertForEvent({ ...incoming, event: "conversation.updated" }, ctx)).toBe(false);
  });
  it("stays quiet for the chat I am reading, but not when the tab is in the background", () => {
    expect(shouldAlertForEvent(incoming, { ...ctx, openConversationId: "c1" })).toBe(false);
    expect(shouldAlertForEvent(incoming, { ...ctx, openConversationId: "c1", tabActive: false })).toBe(true);
    expect(shouldAlertForEvent(incoming, { ...ctx, openConversationId: "c2" })).toBe(true);
  });

  it("puts the number waiting at the front of the tab title and takes it off again", () => {
    expect(titleWithCount("Inbox", 2)).toBe("(2) Inbox");
    expect(titleWithCount("(2) Inbox", 3)).toBe("(3) Inbox");
    expect(titleWithCount("(3) Inbox", 0)).toBe("Inbox");
    expect(titleWithCount("Inbox", 250)).toBe("(99+) Inbox");
    expect(titleWithCount("(99+) Inbox", 0)).toBe("Inbox");
  });

  it("reads the open conversation from the address", () => {
    expect(conversationIdFromPath("/inbox/abc-123")).toBe("abc-123");
    expect(conversationIdFromPath("/inbox")).toBeNull();
    expect(conversationIdFromPath("/inbox/reports")).toBeNull();
    expect(conversationIdFromPath("/inbox/settings")).toBeNull();
    expect(conversationIdFromPath("/owner/orders/abc")).toBeNull();
  });
});
