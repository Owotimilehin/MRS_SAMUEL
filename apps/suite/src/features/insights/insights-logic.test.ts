import { describe, expect, it } from "vitest";
import {
  ZONE_NOTES,
  categoryLabel,
  chartTicks,
  deltaBadge,
  deltaText,
  formatFigure,
  lastUpdatedText,
  partLabel,
  postTitle,
  presetRange,
  pricingTypeLabel,
  rateText,
  sortPosts,
  tileText,
  validRange,
  zoneNote,
} from "./insights-logic.js";
import type { PostRow, Tile } from "./insights-api.js";

describe("insights wording", () => {
  it("deltaText: +12% / −5% / empty when previous is 0 or null", () => {
    expect(deltaText(112, 100, 30)).toBe("+12% on the 30 days before");
    expect(deltaText(95, 100, 30)).toBe("−5% on the 30 days before");
    expect(deltaText(100, 100, 7)).toBe("+0% on the 7 days before");
    expect(deltaText(5, 4, 1)).toBe("+25% on the day before");
    expect(deltaText(50, 0, 30)).toBe("");
    expect(deltaText(50, null, 30)).toBe("");
    expect(deltaText(null, 50, 30)).toBe("");
    expect(deltaBadge(95, 100)).toBe("-5%");
    expect(deltaBadge(0, 100)).toBe("-100%");
  });

  it('formatFigure: 12345 → "12,345"; null → "—"', () => {
    expect(formatFigure(12345)).toBe("12,345");
    expect(formatFigure(null)).toBe("—");
    expect(formatFigure(undefined)).toBe("—");
    // A real zero is shown as zero, not as a missing figure.
    expect(formatFigure(0)).toBe("0");
    expect(formatFigure(49.6)).toBe("50");
    expect(formatFigure(1234.5, { money: true, currency: "USD" })).toBe("1,234.50 USD");
    expect(formatFigure(0.75, { money: true, currency: null })).toBe("0.75 in your WhatsApp account's currency");
    expect(formatFigure(null, { money: true, currency: "USD" })).toBe("—");
  });

  it("zoneNote: returns the fixed wording for each zone", () => {
    expect(zoneNote("America/Los_Angeles")).toBe(
      "Facebook counts each day on United States Pacific time, which is 8 or 9 hours behind Lagos. A day here runs from about 8 or 9 in the morning Lagos time to the same time the next day.",
    );
    expect(zoneNote("Africa/Lagos")).toBe("Days are Lagos days. Instagram can take up to two days to finish counting, so the last two days may still rise.");
    expect(zoneNote("UTC")).toBe("WhatsApp counts each day from 1 am to 1 am Lagos time.");
    expect(Object.keys(ZONE_NOTES)).toHaveLength(3);
    expect(zoneNote("Asia/Tokyo")).toContain("Asia/Tokyo");
  });

  it("tileText: a missing figure is a dash with a hint, never a zero", () => {
    const tile = (over: Partial<Tile>): Tile => ({ key: "fb_views", label: "Facebook views", value: 150, previous: 100, how: "sum", note: null, ...over });
    expect(tileText(tile({}), { days: 30, currency: null })).toEqual({ value: "150", delta: "+50%", hint: "on the 30 days before" });
    expect(tileText(tile({ value: null }), { days: 30, currency: null })).toEqual({ value: "—", hint: "No figure yet" });
    expect(tileText(tile({ previous: null }), { days: 30, currency: null })).toEqual({ value: "150", hint: "" });
    expect(tileText(tile({ previous: 0 }), { days: 30, currency: null })).toEqual({ value: "150", hint: "" });
    expect(tileText(tile({ value: 0, previous: 10 }), { days: 7, currency: null })).toEqual({ value: "0", delta: "-100%", hint: "on the 7 days before" });
    expect(tileText(tile({ key: "wa_cost", value: 0.75, previous: null }), { days: 30, currency: "USD" }).value).toBe("0.75 USD");
    expect(tileText(tile({ key: "ig_reach", value: 49.6, previous: null, note: "This is the average for a day." }), { days: 30, currency: null })).toEqual({
      value: "50",
      hint: "This is the average for a day.",
    });
  });

  it("chartTicks: at most six date marks, ending on the last day", () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const ticks = chartTicks(days);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks[ticks.length - 1]).toBe("2026-11-30");
    expect(chartTicks(["2026-11-01", "2026-11-02"])).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("presetRange: N days ending yesterday in Lagos, from a fixed now", () => {
    // 23:30 UTC on the 18th is already the 19th in Lagos, so yesterday is the 18th.
    expect(presetRange(30, new Date("2026-11-18T23:30:00Z"))).toEqual({ from: "2026-10-20", to: "2026-11-18" });
    expect(presetRange(7, new Date("2026-11-19T12:00:00Z"))).toEqual({ from: "2026-11-12", to: "2026-11-18" });
    expect(validRange("2026-11-12", "2026-11-18")).toBe(true);
    expect(validRange("2026-11-19", "2026-11-18")).toBe(false);
    expect(validRange("2025-01-01", "2026-11-18")).toBe(false);
    expect(validRange("", "2026-11-18")).toBe(false);
  });

  it("lastUpdatedText: Lagos time whatever the machine's zone", () => {
    expect(lastUpdatedText("2026-11-19T09:04:00.000Z")).toBe("Thu 19 Nov, 10:04 am");
    expect(lastUpdatedText("2026-11-19T23:30:00.000Z")).toBe("Fri 20 Nov, 12:30 am");
    expect(lastUpdatedText(null)).toBe("Not collected yet");
  });

  it("names WhatsApp charges and content types in plain words", () => {
    expect(categoryLabel("UTILITY")).toBe("Order and account updates");
    expect(categoryLabel("AUTHENTICATION_INTERNATIONAL")).toBe("Sign-in codes");
    expect(categoryLabel("SOMETHING_NEW")).toBe("Something new");
    expect(pricingTypeLabel("FREE_CUSTOMER_SERVICE")).toBe("Free (customer wrote first)");
    expect(partLabel("media_product_type=REEL")).toBe("Reels");
    expect(rateText(0.5)).toBe("50%");
    expect(rateText(null)).toBe("—");
  });

  it("sortPosts: largest first, posts with no figure last; postTitle trims to 80 characters", () => {
    const post = (id: string, views: number | null, at: string): PostRow => ({
      network: "facebook",
      subject_id: id,
      kind: "post",
      title: null,
      permalink: null,
      published_at: at,
      from_suite: false,
      removed: false,
      views,
      reach: null,
      interactions: null,
      comments: null,
      clicks: null,
    });
    const rows = [post("a", 5, "2026-11-10T09:00:00.000Z"), post("b", null, "2026-11-12T09:00:00.000Z"), post("c", 9, "2026-11-11T09:00:00.000Z")];
    expect(sortPosts(rows, "views").map((p) => p.subject_id)).toEqual(["c", "a", "b"]);
    expect(sortPosts(rows, "views", false).map((p) => p.subject_id)).toEqual(["a", "c", "b"]);
    expect(sortPosts(rows, "date").map((p) => p.subject_id)).toEqual(["b", "c", "a"]);
    expect(postTitle({ title: "x".repeat(100), kind: "post", network: "facebook" })).toBe(`${"x".repeat(80)}…`);
    expect(postTitle({ title: null, kind: "story", network: "instagram" })).toBe("Story with no caption");
  });
});
