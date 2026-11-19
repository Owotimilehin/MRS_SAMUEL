import { describe, expect, it } from "vitest";
import { templateNeeds } from "@ms/shared";
import {
  flowAddressPreview,
  flowCardActions,
  flowHandledText,
  formatFlowValue,
  replyState,
  textUsage,
  WHATSAPP_ACCEPT,
  contactName,
  eraseConfirmMatches,
  eraseConfirmTarget,
  firstIdentityHandle,
  identityLine,
  conversationIdFromPath,
  shouldAlertForEvent,
  titleWithCount,
  addHeaderFileLabel,
  afterHoursHelp,
  autoMessageLabel,
  fillButtonUrl,
  headerFileProblem,
  headerFileRule,
  templateBlankCount,
  templateDraftProblem,
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

describe("template extras", () => {
  const imageCta = templateNeeds([
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Free delivery for all online orders" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://www.jaspersmarket.com/" }] },
  ]);
  const full = templateNeeds([
    { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
    { type: "BODY", text: "Hi {{1}}" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url: "https://shop.example/t/{{1}}" }] },
  ]);
  const empty = { params: [], headerParam: "", buttonParams: {}, hasFile: false };

  it("keeps Send off until the picture is added", () => {
    expect(templateDraftProblem(imageCta, empty)).toBe("Add a picture to send this template.");
    expect(templateDraftProblem(imageCta, { ...empty, hasFile: true })).toBeNull();
  });
  it("asks for each blank in turn: heading, message, link", () => {
    expect(templateDraftProblem(full, empty)).toBe("Fill in the blank in the heading.");
    expect(templateDraftProblem(full, { ...empty, headerParam: "A1" })).toBe("Fill in every blank in the message.");
    expect(templateDraftProblem(full, { ...empty, headerParam: "A1", params: ["Ada"] })).toBe(
      'Fill in the end of the link for the "Track" button.',
    );
    expect(templateDraftProblem(full, { headerParam: "A1", params: ["Ada"], buttonParams: { 0: "abc" }, hasFile: false })).toBeNull();
    expect(templateBlankCount(full)).toBe(3);
  });
  it("never lets a template the inbox can't send through", () => {
    const carousel = templateNeeds([{ type: "BODY", text: "x" }, { type: "CAROUSEL", cards: [] }]);
    expect(templateDraftProblem(carousel, { ...empty, hasFile: true })).toBe("This template has a carousel, which the inbox can't send yet");
  });
  it("checks the file is the right kind and size", () => {
    expect(headerFileProblem("image", { type: "image/jpeg", size: 200_000 })).toBeNull();
    expect(headerFileProblem("image", { type: "application/pdf", size: 200_000 })).toBe("This template needs a picture (JPG or PNG, up to 5 MB).");
    expect(headerFileProblem("image", { type: "image/png", size: 6 * 1024 * 1024 })).toBe("That file is too large. Use a picture of 5 MB or less.");
    expect(headerFileProblem("video", { type: "video/mp4", size: 1000 })).toBeNull();
    expect(headerFileProblem("document", { type: "image/png", size: 1000 })).toContain("needs a document");
    expect(headerFileRule("image").accept).toBe("image/jpeg,image/png");
    expect(addHeaderFileLabel("image")).toBe("Add picture");
    expect(addHeaderFileLabel("video")).toBe("Add video");
  });
  it("shows where a link button will go", () => {
    expect(fillButtonUrl("https://shop.example/t/{{1}}", "abc")).toBe("https://shop.example/t/abc");
    expect(fillButtonUrl("https://shop.example/t/{{1}}", "")).toBe("https://shop.example/t/…");
  });
});

describe("automatic messages and the after-hours help text", () => {
  it("labels messages no person sent", () => {
    expect(autoMessageLabel("after_hours")).toBe("Automatic reply");
    expect(autoMessageLabel("system")).toBe("Automatic message");
    expect(autoMessageLabel(null)).toBeNull();
    expect(autoMessageLabel(undefined)).toBeNull();
  });
  it("says exactly what the after-hours message does for the number's channels", () => {
    expect(afterHoursHelp("both")).toBe(
      "Sent automatically on WhatsApp to a customer who writes when you're closed (once per closed period), and read out to callers who ring when you're closed.",
    );
    expect(afterHoursHelp("whatsapp")).toBe("Sent automatically on WhatsApp to a customer who writes when you're closed (once per closed period).");
    expect(afterHoursHelp("voice")).toBe("Read out to callers who ring when you're closed.");
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

describe("customer identities (suite spec 01)", () => {
  it("contactName falls back to the identity name before \"Unknown customer\"", () => {
    expect(contactName("Ada", "+2348031234567", "@ada")).toBe("Ada");
    expect(contactName(null, "+2348031234567", "@ada")).toBe("+234 803 123 4567");
    expect(contactName("  ", null, "@ada")).toBe("@ada");
    expect(contactName(null, null, "Funmi on Facebook")).toBe("Funmi on Facebook");
    expect(contactName(null, null, " ")).toBe("Unknown customer");
    expect(contactName(null, null)).toBe("Unknown customer");
  });

  it("eraseConfirmTarget picks phone, then username, then name, then the word DELETE", () => {
    expect(eraseConfirmTarget({ name: "Ada", phone: "+2348031234567" }, [{ username: "ada" }])).toEqual({
      kind: "phone",
      show: "+234 803 123 4567",
    });
    expect(eraseConfirmTarget({ name: "Ada", phone: null }, [{ username: null }, { username: "@ada_ig" }])).toEqual({
      kind: "username",
      show: "@ada_ig",
    });
    expect(eraseConfirmTarget({ name: " Ada ", phone: "" }, [{ username: null }])).toEqual({ kind: "name", show: "Ada" });
    expect(eraseConfirmTarget({ name: null, phone: null }, [])).toEqual({ kind: "word", show: "DELETE" });
  });

  it("eraseConfirmMatches follows the target", () => {
    expect(eraseConfirmMatches("+234 803 123 4567", { kind: "phone", show: "+234 803 123 4567" }, "+2348031234567")).toBe(true);
    expect(eraseConfirmMatches("DELETE", { kind: "phone", show: "+234 803 123 4567" }, "+2348031234567")).toBe(false);
    expect(eraseConfirmMatches(" ADA_IG ", { kind: "username", show: "@ada_ig" })).toBe(true);
    expect(eraseConfirmMatches("@ada_ig", { kind: "username", show: "@ada_ig" })).toBe(true);
    expect(eraseConfirmMatches("ada", { kind: "username", show: "@ada_ig" })).toBe(false);
    expect(eraseConfirmMatches("ada", { kind: "name", show: "Ada" })).toBe(true);
    expect(eraseConfirmMatches("delete", { kind: "word", show: "DELETE" })).toBe(false);
    expect(eraseConfirmMatches("DELETE", { kind: "word", show: "DELETE" })).toBe(true);
  });

  it("describes each way a customer reaches us", () => {
    const base = { display_name: null, username: null, phone: null, account_label: "WhatsApp" };
    expect(identityLine({ ...base, channel: "whatsapp", phone: "+2348031234567" })).toBe("+234 803 123 4567");
    expect(identityLine({ ...base, channel: "whatsapp" })).toBe("WhatsApp (number hidden)");
    expect(identityLine({ ...base, channel: "whatsapp", username: "ada" })).toBe("WhatsApp (number hidden) · @ada");
    expect(identityLine({ ...base, channel: "messenger", account_label: "Facebook Page" })).toBe("Facebook user · Facebook Page");
    expect(identityLine({ ...base, channel: "messenger", display_name: "Ada O", account_label: "Facebook Page" })).toBe(
      "Ada O · Facebook Page",
    );
    expect(identityLine({ ...base, channel: "instagram", username: "ada", account_label: "Instagram" })).toBe("@ada · Instagram");
    expect(identityLine({ ...base, channel: "instagram", account_label: "Instagram" })).toBe("Instagram user · Instagram");
    expect(firstIdentityHandle([{ ...base, channel: "whatsapp" }, { ...base, channel: "instagram", username: "ada" }])).toBe("@ada");
    expect(firstIdentityHandle([])).toBeNull();
  });
});

describe("replyState (suite spec 02, table 7.3)", () => {
  const H = 3_600_000;
  const fb = { label: "Facebook Page", channels: "whatsapp" as const, kind: "messenger" as const, is_active: true, problem_text: null };
  const ig = { ...fb, label: "Instagram", kind: "instagram" as const };
  const phone = { label: "Main line", channels: "both" as const, kind: "phone" as const };

  it("any channel, window open: the existing window line", () => {
    for (const [channel, number] of [["whatsapp", phone], ["messenger", fb], ["instagram", ig]] as const) {
      const s = replyState({ channel, number, window_remaining_ms: 5 * H + 30 * 60_000 });
      expect(s.mode).toBe("open");
      expect(s.statusText).toBe("Reply window open — 5h 30m left");
    }
  });
  it("Messenger / Instagram: no template button, no caption, channel's own files", () => {
    const s = replyState({ channel: "instagram", number: ig, window_remaining_ms: H });
    expect(s).toMatchObject({ canTemplate: false, canCaption: false, tabLabel: "Instagram reply" });
    expect(s.accept).toBe("image/jpeg,image/png,audio/aac,audio/mp4,audio/wav,audio/x-wav,video/mp4,video/quicktime,video/webm,application/pdf");
    expect(replyState({ channel: "messenger", number: fb, window_remaining_ms: H }).accept).toContain("image/gif");
  });
  it("text limit: Instagram counts bytes, Messenger 1999 characters", () => {
    expect(replyState({ channel: "instagram", number: ig, window_remaining_ms: H }).textLimit).toEqual({ max: 1000, unit: "bytes" });
    expect(replyState({ channel: "messenger", number: fb, window_remaining_ms: H }).textLimit).toEqual({ max: 1999, unit: "characters" });
    expect(textUsage("é".repeat(500), { max: 1000, unit: "bytes" })).toEqual({ used: 1000, over: false });
    expect(textUsage("é".repeat(501), { max: 1000, unit: "bytes" })).toEqual({ used: 1002, over: true });
  });
  it("Messenger / Instagram, window closed, Human Agent off", () => {
    const s = replyState({ channel: "messenger", number: fb, window_remaining_ms: 0, human_agent_remaining_ms: 0, human_agent_enabled: false });
    expect(s).toMatchObject({ mode: "closed", statusText: "Reply window closed", closedWindow: "24 hours" });
  });
  it("Messenger / Instagram, 24 h to 7 days, Human Agent on", () => {
    const s = replyState({ channel: "instagram", number: ig, window_remaining_ms: 0, human_agent_remaining_ms: 2.5 * 24 * H, human_agent_enabled: true });
    expect(s.mode).toBe("human_agent");
    expect(s.statusText).toBe("More than 24 hours since they wrote. You can still reply for 3 more days, by hand only.");
    const last = replyState({ channel: "instagram", number: ig, window_remaining_ms: 0, human_agent_remaining_ms: H, human_agent_enabled: true });
    expect(last.statusText).toContain("for 1 more day,");
  });
  it("Human Agent on, over 7 days: closed, saying 7 days", () => {
    const s = replyState({ channel: "messenger", number: fb, window_remaining_ms: 0, human_agent_remaining_ms: 0, human_agent_enabled: true });
    expect(s).toMatchObject({ mode: "closed", closedWindow: "7 days" });
  });
  it("line switched off", () => {
    const s = replyState({ channel: "messenger", number: { ...fb, is_active: false }, window_remaining_ms: H });
    expect(s).toMatchObject({ mode: "off", statusText: "Facebook Page is switched off, so replies can't be sent. Switch it on under Channels." });
  });
  it("line has a problem: a banner, the box stays usable", () => {
    const s = replyState({ channel: "instagram", number: { ...ig, problem_text: "Message access is switched off in the Instagram app." }, window_remaining_ms: H });
    expect(s.mode).toBe("open");
    expect(s.banner).toBe("Messages on Instagram are not going out: Message access is switched off in the Instagram app.");
  });
  it("WhatsApp: exactly as today", () => {
    expect(replyState({ number: phone, window_remaining_ms: H })).toMatchObject({
      channel: "whatsapp",
      mode: "open",
      canTemplate: true,
      canCaption: true,
      accept: WHATSAPP_ACCEPT,
      tabLabel: "WhatsApp reply",
      banner: null,
    });
    expect(replyState({ channel: "whatsapp", number: phone, window_remaining_ms: 0 })).toMatchObject({
      mode: "closed",
      statusText: "The 24-hour reply window is closed. Send a template to restart the chat.",
    });
    expect(replyState({ channel: "whatsapp", number: { ...phone, channels: "voice" }, window_remaining_ms: H }).mode).toBe("calls_only");
  });
  it("Instagram ticks have no delivered state", () => {
    expect(messageTicks("delivered", "instagram")).toEqual({ marks: "✓", read: false, label: "Sent" });
    expect(messageTicks("read", "instagram")).toEqual({ marks: "✓✓", read: true, label: "Read" });
    expect(messageTicks("delivered", "messenger").marks).toBe("✓✓");
    expect(messageTicks("delivered").label).toBe("Delivered");
  });
});

describe("WhatsApp forms (spec 07)", () => {
  const fresh = { status: "new", flow_key: "complaint" };
  it("flowCardActions: nothing without inbox.reply", () => {
    expect(flowCardActions(fresh, false)).toEqual([]);
    expect(flowCardActions({ status: "new", flow_key: "delivery_address" }, false, true)).toEqual([]);
  });
  it("flowCardActions: handled or reopen by status, then notes", () => {
    expect(flowCardActions(fresh, true)).toEqual(["handled", "add_note"]);
    expect(flowCardActions({ status: "handled", flow_key: "complaint" }, true)).toEqual(["reopen", "add_note"]);
    expect(flowCardActions({ status: "archived", flow_key: "unknown" }, true)).toEqual(["add_note"]);
  });
  it("flowCardActions: notes need inbox.notes", () => {
    expect(flowCardActions(fresh, true, false)).toEqual(["handled"]);
  });
  it("flowCardActions: save_address only for a delivery address, last", () => {
    expect(flowCardActions({ status: "new", flow_key: "delivery_address" }, true)).toEqual(["handled", "add_note", "save_address"]);
    expect(flowCardActions({ status: "handled", flow_key: "delivery_address" }, true, false)).toEqual(["reopen", "save_address"]);
    expect(flowCardActions({ status: "new", flow_key: "bulk_order" }, true)).not.toContain("save_address");
  });
  it("formatFlowValue: plain text by kind", () => {
    expect(formatFlowValue("text", "  12 Bode Thomas  ")).toBe("12 Bode Thomas");
    expect(formatFlowValue("date", "2026-11-20")).toBe("Fri 20 Nov 2026");
    expect(formatFlowValue("date", "Fri 20 Nov 2026")).toBe("Fri 20 Nov 2026");
    expect(formatFlowValue("multi", ["a", "", "b"])).toBe("a, b");
    expect(formatFlowValue("longtext", "line one\nline two")).toBe("line one\nline two");
    expect(formatFlowValue("choice", "Lekki")).toBe("Lekki");
    expect(formatFlowValue("text", null)).toBe("");
    expect(formatFlowValue("text", 3)).toBe("3");
  });
  it("formatFlowValue: an unknown kind is shown as it came, and markup stays text", () => {
    expect(formatFlowValue("mystery", " <b>hi</b> ")).toBe("<b>hi</b>");
    expect(formatFlowValue("other", { a: 1 })).toBe('{"a":1}');
  });
  it("flowHandledText: name and Lagos time", () => {
    const now = new Date("2026-11-17T10:00:00Z");
    expect(flowHandledText({ handled_by_name: "Ada", handled_at: "2026-11-17T08:05:00Z" }, now)).toBe("Handled by Ada, 09:05");
    expect(flowHandledText({ handled_by_name: "ada@example.com", handled_at: "2026-11-16T12:00:00Z" }, now)).toBe("Handled by ada, Yesterday");
    expect(flowHandledText({ handled_by_name: null, handled_at: "2026-10-01T12:00:00Z" }, now)).toBe("Handled, 1 Oct");
    expect(flowHandledText({ handled_by_name: "Ada", handled_at: null }, now)).toBe("Handled by Ada");
  });
  it("flowAddressPreview: street, area and the landmark only when given", () => {
    const rows = [
      { label: "Receiver", value: "Ada" },
      { label: "House and street", value: "12 Bode Thomas" },
      { label: "Area", value: "Surulere" },
    ];
    expect(flowAddressPreview(rows)).toBe("12 Bode Thomas, Surulere.");
    expect(flowAddressPreview([...rows, { label: "Landmark", value: "Opposite the bank" }])).toBe(
      "12 Bode Thomas, Surulere. Landmark: Opposite the bank",
    );
    expect(flowAddressPreview([{ label: "Landmark", value: "By the gate" }])).toBe("Landmark: By the gate");
    expect(flowAddressPreview([])).toBe("");
  });
});
