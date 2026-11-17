/**
 * Tests for the pure inbox helpers. Most cases are COPIED from
 * apps/admin/src/lib/inbox-logic.test.ts (vitest there, jest here; same API).
 */
import {
  backoffDelay,
  callOutcomeLabel,
  composerMode,
  conversationIdFromPush,
  countTemplateParams,
  dayLabel,
  fillTemplate,
  formatDuration,
  groupTimelineByDay,
  inboxTabsFor,
  lagosDayKey,
  listTime,
  mediaKind,
  messageTicks,
  parseLabels,
  sendTypeForMime,
  shouldSendTyping,
  templateBodyText,
  templateParamsComplete,
  tokenRefreshDelayMs,
  waWindowRemainingMs,
  windowText,
} from "./inbox-logic";
import type { TimelineItem } from "./inbox-types";

describe("inboxTabsFor", () => {
  it("gives basic staff Mine and Unassigned only", () => {
    expect(inboxTabsFor(["inbox.view"], ["t1"]).map((t) => t.key)).toEqual(["mine", "unassigned"]);
  });
  it("adds Team and All for team viewers in a team", () => {
    expect(inboxTabsFor(["inbox.view", "inbox.view_team"], ["t1"]).map((t) => t.key)).toEqual([
      "mine",
      "unassigned",
      "team",
      "all",
    ]);
  });
  it("skips Team when the person is in no team", () => {
    expect(inboxTabsFor(["inbox.view", "inbox.view_all"], []).map((t) => t.key)).toEqual(["mine", "unassigned", "all"]);
  });
});

describe("24-hour window", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("matches packages/shared waWindowRemainingMs", () => {
    expect(waWindowRemainingMs("2026-11-17T11:00:00Z", now)).toBe(23 * 3600_000);
    expect(waWindowRemainingMs("2026-11-15T11:00:00Z", now)).toBe(0);
    expect(waWindowRemainingMs(null, now)).toBe(0);
    expect(waWindowRemainingMs("not a date", now)).toBe(0);
  });
});

describe("composerMode", () => {
  const base = { caps: ["inbox.reply", "inbox.templates"], canUseNumber: true, channels: "both" as const, windowRemainingMs: 1000 };
  it("allows text inside the window", () => {
    expect(composerMode(base).kind).toBe("text");
  });
  it("forces templates when the window is closed", () => {
    expect(composerMode({ ...base, windowRemainingMs: 0 }).kind).toBe("template_only");
  });
  it("disables when the window is closed and templates aren't allowed", () => {
    expect(composerMode({ ...base, caps: ["inbox.reply"], windowRemainingMs: 0 }).kind).toBe("disabled");
  });
  it("disables without reply rights, number access, or on a calls-only number", () => {
    expect(composerMode({ ...base, caps: [] }).kind).toBe("disabled");
    expect(composerMode({ ...base, canUseNumber: false }).kind).toBe("disabled");
    expect(composerMode({ ...base, channels: "voice" }).kind).toBe("disabled");
  });
});

describe("conversationIdFromPush", () => {
  it("reads a uuid conversationId", () => {
    const id = "6f1c2c1e-1d2b-4c3a-9f00-0123456789ab";
    expect(conversationIdFromPush({ conversationId: id })).toBe(id);
  });
  it("ignores junk", () => {
    expect(conversationIdFromPush(null)).toBeNull();
    expect(conversationIdFromPush({ conversationId: "../settings" })).toBeNull();
    expect(conversationIdFromPush({ conversationId: 42 })).toBeNull();
  });
});

describe("tokenRefreshDelayMs", () => {
  it("refreshes 5 minutes before expiry", () => {
    expect(tokenRefreshDelayMs(3600)).toBe(55 * 60_000);
  });
  it("never schedules sooner than 30 seconds", () => {
    expect(tokenRefreshDelayMs(60)).toBe(30_000);
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

