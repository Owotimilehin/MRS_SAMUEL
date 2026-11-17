import { describe, expect, it } from "vitest";
import {
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
import type { TimelineItem } from "./inbox-types.js";

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
