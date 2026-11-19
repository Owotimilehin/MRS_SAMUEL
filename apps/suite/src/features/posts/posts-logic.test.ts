import { describe, expect, it } from "vitest";
import {
  POST_STATUSES,
  calendarWeeks,
  captionRuns,
  captionStart,
  isoToLagosInput,
  lagosDay,
  lagosDayTime,
  lagosInputToIso,
  prepareImageSize,
  scheduleBounds,
  statusLabel,
  statusTone,
  targetLine,
  timeLine,
} from "./posts-logic.js";

describe("Lagos time", () => {
  it("lagosInputToIso / isoToLagosInput round-trip", () => {
    expect(lagosInputToIso("2026-11-24T09:00")).toBe("2026-11-24T08:00:00.000Z");
    expect(isoToLagosInput("2026-11-24T08:00:00.000Z")).toBe("2026-11-24T09:00");
    for (const input of ["2026-01-01T00:00", "2026-06-30T23:59", "2026-12-31T00:30", "2027-02-28T12:15"]) {
      expect(isoToLagosInput(lagosInputToIso(input))).toBe(input);
    }
    // Midnight in Lagos is still the day before in UTC.
    expect(lagosInputToIso("2026-11-24T00:30")).toBe("2026-11-23T23:30:00.000Z");
    expect(lagosDay("2026-11-23T23:30:00.000Z")).toBe("2026-11-24");
    expect(lagosInputToIso("")).toBe("");
    expect(lagosInputToIso("tomorrow")).toBe("");
  });

  it("writes times the way the screens show them", () => {
    expect(lagosDayTime("2026-11-24T08:00:00.000Z")).toBe("Tue 24 Nov, 9:00 am");
    expect(lagosDayTime("2026-11-24T08:00:00.000Z", true)).toBe("Tue 24 Nov 2026, 9:00 am");
    expect(lagosDayTime("2026-11-24T11:05:00.000Z")).toBe("Tue 24 Nov, 12:05 pm");
    expect(lagosDayTime("2026-11-23T23:10:00.000Z")).toBe("Tue 24 Nov, 12:10 am");
  });

  it("the schedule picker allows 10 minutes to 90 days ahead", () => {
    const b = scheduleBounds(new Date("2026-11-20T08:00:00.000Z"));
    expect(b.min).toBe("2026-11-20T09:10");
    expect(b.max).toBe("2027-02-18T09:00");
    // A moment past the minute rounds up, so the earliest choice is never under 10 minutes away.
    expect(scheduleBounds(new Date("2026-11-20T08:00:01.000Z")).min).toBe("2026-11-20T09:11");
  });
});

describe("calendar", () => {
  it("calendarWeeks: November 2026 starts on Monday 26 Oct and has 6 rows", () => {
    const weeks = calendarWeeks(2026, 11);
    expect(weeks).toHaveLength(6);
    expect(weeks[0]![0]).toBe("2026-10-26");
    expect(weeks[0]![6]).toBe("2026-11-01");
    expect(weeks[5]![0]).toBe("2026-11-30");
    expect(weeks[5]![6]).toBe("2026-12-06");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("calendarWeeks: a month that starts on a Monday has no padding row, and December rolls into January", () => {
    const june = calendarWeeks(2026, 6);
    expect(june[0]![0]).toBe("2026-06-01");
    expect(june).toHaveLength(5);
    const feb = calendarWeeks(2027, 2);
    expect(feb).toHaveLength(4);
    expect(feb[0]![0]).toBe("2027-02-01");
    const dec = calendarWeeks(2026, 12);
    expect(dec[0]![0]).toBe("2026-11-30");
    expect(dec[dec.length - 1]![6]).toBe("2027-01-03");
  });
});

describe("wording", () => {
  it("statusLabel covers every status", () => {
    expect(POST_STATUSES.map(statusLabel)).toEqual([
      "Draft",
      "Scheduled",
      "Going out now…",
      "Posted",
      "Posted to some, not all",
      "Did not post",
      "Please check",
      "Missed its time",
    ]);
    for (const s of POST_STATUSES) expect(["neutral", "info", "ok", "warn", "bad"]).toContain(statusTone(s));
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("published")).toBe("ok");
  });

  it("targetLine says what happened on one network", () => {
    const t = { network: "facebook" as const, status: "pending", external_id: null, error_message: null, published_at: null, removed_at: null, removed_by: null };
    expect(targetLine(t)).toBe("Going out…");
    expect(targetLine({ ...t, status: "published", external_id: "100200300_1", published_at: "2026-11-24T08:00:00.000Z" })).toBe("Posted Tue 24 Nov, 9:00 am");
    expect(targetLine({ ...t, status: "published" })).toBe("Posted (not linked to statistics)");
    expect(targetLine({ ...t, status: "failed", error_message: "Facebook is busy." })).toBe("Did not post: Facebook is busy.");
    expect(targetLine({ ...t, status: "unknown" })).toBe("We could not tell whether this posted. Please look at the Page before doing anything.");
    expect(targetLine({ ...t, network: "instagram", status: "unknown" })).toBe(
      "We could not tell whether this posted. Please look at the Instagram account before doing anything.",
    );
    expect(targetLine({ ...t, status: "removed", removed_at: "2026-11-24T08:00:00.000Z", removed_by: { name: "Ada" } })).toBe(
      "Taken down Tue 24 Nov, 9:00 am by Ada",
    );
  });

  it("timeLine and captionStart describe a list row", () => {
    const p = { status: "scheduled", scheduled_at: "2026-11-24T08:00:00.000Z", updated_at: "2026-11-20T10:00:00.000Z", targets: [{ published_at: null }] };
    expect(timeLine(p)).toBe("Goes out Tue 24 Nov, 9:00 am");
    expect(timeLine({ ...p, status: "draft", scheduled_at: null })).toBe("Edited Fri 20 Nov, 11:00 am");
    expect(timeLine({ ...p, status: "published", targets: [{ published_at: "2026-11-24T08:00:30.000Z" }] })).toBe("Posted Tue 24 Nov, 9:00 am");
    expect(captionStart("")).toBe("No text");
    expect(captionStart("  Fresh\n juice  ")).toBe("Fresh juice");
    expect(captionStart("a".repeat(100))).toBe(`${"a".repeat(90)}…`);
  });

  it("captionRuns marks hashtags and mentions, not emails", () => {
    expect(captionRuns("Try #fresh juice from @mrs_samuel at a@b.com")).toEqual([
      { text: "Try ", tag: false },
      { text: "#fresh", tag: true },
      { text: " juice from ", tag: false },
      { text: "@mrs_samuel", tag: true },
      { text: " at a@b.com", tag: false },
    ]);
  });
});

describe("pictures", () => {
  it("prepareImageSize keeps small pictures and scales wide ones to 1440", () => {
    expect(prepareImageSize(1080, 1350)).toEqual({ width: 1080, height: 1350 });
    expect(prepareImageSize(4000, 3000)).toEqual({ width: 1440, height: 1080 });
    expect(prepareImageSize(2880, 1000)).toEqual({ width: 1440, height: 500 });
    expect(prepareImageSize(0, 100)).toEqual({ width: 0, height: 0 });
  });
});
