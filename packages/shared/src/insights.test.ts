import { describe, expect, it } from "vitest";
import {
  PAGE_RUNNING_TOTALS,
  addDays,
  breakdownKey,
  daysInRange,
  fillSeries,
  igMediaMetricsFor,
  isDayKey,
  isRunningTotalMetric,
  lagosDayBounds,
  lagosDayOf,
  lagosHourOf,
  pageDayFromEndTime,
  parseIgAccountInsights,
  parseIgMediaInsights,
  parsePageInsights,
  parsePostInsights,
  parseTemplateAnalytics,
  parseWaAnalytics,
  parseWaPricing,
  rangeChange,
  rangeDailyAverage,
  rangeTotal,
} from "./insights.js";

const unix = (iso: string): number => Date.parse(iso) / 1000;

describe("pageDayFromEndTime", () => {
  it("pageDayFromEndTime: 2020-03-10T07:00:00+0000 is 2020-03-09", () => {
    expect(pageDayFromEndTime("2020-03-10T07:00:00+0000")).toBe("2020-03-09");
  });
  it("pageDayFromEndTime: 2018-01-02T08:00:00+0000 is 2018-01-01", () => {
    expect(pageDayFromEndTime("2018-01-02T08:00:00+0000")).toBe("2018-01-01");
  });
  it("keeps the 23-hour and 25-hour days at the clock changes on their own dates", () => {
    // 8 Mar 2020 (clocks go forward): the day runs 08:00Z to 07:00Z the next day.
    expect(pageDayFromEndTime("2020-03-08T08:00:00+0000")).toBe("2020-03-07");
    expect(pageDayFromEndTime("2020-03-09T07:00:00+0000")).toBe("2020-03-08");
    // 1 Nov 2020 (clocks go back): the day runs 07:00Z to 08:00Z the next day.
    expect(pageDayFromEndTime("2020-11-01T07:00:00+0000")).toBe("2020-10-31");
    expect(pageDayFromEndTime("2020-11-02T08:00:00+0000")).toBe("2020-11-01");
  });
  it("gives an empty string for text that is not a time", () => {
    expect(pageDayFromEndTime("soon")).toBe("");
  });
});

describe("parsePageInsights", () => {
  const json = {
    data: [
      {
        name: "page_media_view",
        period: "day",
        values: [
          { value: 120, end_time: "2026-11-17T08:00:00+0000" },
          { value: 0, end_time: "2026-11-18T08:00:00+0000" },
          { value: null, end_time: "2026-11-19T08:00:00+0000" },
        ],
      },
      { name: "page_follows", period: "day", values: [{ value: 431, end_time: "2026-11-18T08:00:00+0000" }] },
    ],
  };

  it("parsePageInsights: numeric values become rows; page_follows is a running total", () => {
    const rows = parsePageInsights(json, { runningTotals: PAGE_RUNNING_TOTALS });
    expect(rows).toEqual([
      { metric: "page_media_view", day: "2026-11-16", dayZone: "America/Los_Angeles", breakdown: "", value: 120, isRunningTotal: false },
      // A real zero is kept; the null day gives no row at all.
      { metric: "page_media_view", day: "2026-11-17", dayZone: "America/Los_Angeles", breakdown: "", value: 0, isRunningTotal: false },
      { metric: "page_follows", day: "2026-11-17", dayZone: "America/Los_Angeles", breakdown: "", value: 431, isRunningTotal: true },
    ]);
  });

  it("parsePageInsights: object value becomes one row per key", () => {
    const rows = parsePageInsights(
      { data: [{ name: "page_some_by_type", values: [{ value: { like: 4, love: 1, odd: "x" }, end_time: "2026-11-18T08:00:00+0000" }] }] },
      { runningTotals: new Set() },
    );
    expect(rows.map((r) => [r.breakdown, r.value])).toEqual([
      ["type=like", 4],
      ["type=love", 1],
    ]);
    expect(rows.every((r) => r.day === "2026-11-17" && r.metric === "page_some_by_type")).toBe(true);
  });

  it("parsePageInsights: empty data gives no rows", () => {
    expect(parsePageInsights({ data: [] }, { runningTotals: PAGE_RUNNING_TOTALS })).toEqual([]);
    expect(parsePageInsights(null, { runningTotals: PAGE_RUNNING_TOTALS })).toEqual([]);
    expect(parsePageInsights({}, { runningTotals: PAGE_RUNNING_TOTALS })).toEqual([]);
  });
});

describe("parsePostInsights", () => {
  it("parsePostInsights: adds post_reactions_total as the sum of types", () => {
    const rows = parsePostInsights(
      {
        data: [
          { name: "post_media_view", period: "lifetime", values: [{ value: 900 }] },
          { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 7, love: 2, wow: 1 } }] },
          { name: "post_clicks", period: "lifetime", values: [{ value: 0 }] },
        ],
      },
      "2026-11-19",
    );
    expect(rows).toContainEqual({ metric: "post_media_view", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 900, isRunningTotal: true });
    expect(rows).toContainEqual({ metric: "post_reactions_by_type_total", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "type=love", value: 2, isRunningTotal: true });
    expect(rows).toContainEqual({ metric: "post_reactions_total", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 10, isRunningTotal: true });
    expect(rows).toContainEqual({ metric: "post_clicks", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 0, isRunningTotal: true });
    expect(rows).toHaveLength(6);
  });

  it("gives a total of zero for a post with no reactions, and no total when Meta left the metric out", () => {
    const none = parsePostInsights({ data: [{ name: "post_reactions_by_type_total", values: [{ value: {} }] }] }, "2026-11-19");
    expect(none).toEqual([{ metric: "post_reactions_total", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 0, isRunningTotal: true }]);
    const missing = parsePostInsights({ data: [{ name: "post_clicks", values: [{ value: 3 }] }] }, "2026-11-19");
    expect(missing.some((r) => r.metric === "post_reactions_total")).toBe(false);
  });
});

describe("parseIgAccountInsights", () => {
  it("parseIgAccountInsights: total_value without breakdown gives one row", () => {
    const rows = parseIgAccountInsights({ data: [{ name: "views", period: "day", total_value: { value: 310 } }] }, "2026-11-18");
    expect(rows).toEqual([{ metric: "views", day: "2026-11-18", dayZone: "Africa/Lagos", breakdown: "", value: 310, isRunningTotal: false }]);
  });

  it("parseIgAccountInsights: media_product_type breakdown gives one row per value", () => {
    const rows = parseIgAccountInsights(
      {
        data: [
          {
            name: "views",
            period: "day",
            total_value: {
              value: 310,
              breakdowns: [
                {
                  dimension_keys: ["media_product_type"],
                  results: [
                    { dimension_values: ["POST"], value: 200 },
                    { dimension_values: ["REEL"], value: 110 },
                  ],
                },
              ],
            },
          },
        ],
      },
      "2026-11-18",
    );
    expect(rows.map((r) => [r.metric, r.breakdown, r.value])).toEqual([
      ["views", "media_product_type=POST", 200],
      ["views", "media_product_type=REEL", 110],
    ]);
  });

  it("parseIgAccountInsights: metric missing from the response gives no row", () => {
    expect(parseIgAccountInsights({ data: [] }, "2026-11-18")).toEqual([]);
    // Asked with a breakdown and Meta sent no results: nothing is written, never a zero.
    expect(parseIgAccountInsights({ data: [{ name: "follows_and_unfollows", total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [] }] } }] }, "2026-11-18")).toEqual([]);
    expect(parseIgAccountInsights({ data: [{ name: "reach" }] }, "2026-11-18")).toEqual([]);
  });
});

describe("parseIgMediaInsights", () => {
  it("parseIgMediaInsights: reads total_value.value, falls back to values[0].value", () => {
    const rows = parseIgMediaInsights(
      {
        data: [
          { name: "views", period: "lifetime", total_value: { value: 50 } },
          { name: "reach", period: "lifetime", values: [{ value: 40 }] },
          { name: "likes", period: "lifetime" },
        ],
      },
      "2026-11-19",
    );
    expect(rows).toEqual([
      { metric: "views", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 50, isRunningTotal: true },
      { metric: "reach", day: "2026-11-19", dayZone: "Africa/Lagos", breakdown: "", value: 40, isRunningTotal: true },
    ]);
  });
});

describe("WhatsApp parsers", () => {
  it("parseWaAnalytics: one sent and one delivered row per data point, day is the UTC date of start", () => {
    const rows = parseWaAnalytics(
      {
        analytics: {
          granularity: "DAY",
          data_points: [
            { start: unix("2026-11-17T00:00:00Z"), end: unix("2026-11-18T00:00:00Z"), sent: 12, delivered: 11 },
            { start: unix("2026-11-18T00:00:00Z"), end: unix("2026-11-19T00:00:00Z"), sent: 0, delivered: 0 },
          ],
        },
        id: "104857600123456",
      },
      "type=template",
    );
    expect(rows).toEqual([
      { metric: "wa_sent", day: "2026-11-17", dayZone: "UTC", breakdown: "type=template", value: 12, isRunningTotal: false },
      { metric: "wa_delivered", day: "2026-11-17", dayZone: "UTC", breakdown: "type=template", value: 11, isRunningTotal: false },
      { metric: "wa_sent", day: "2026-11-18", dayZone: "UTC", breakdown: "type=template", value: 0, isRunningTotal: false },
      { metric: "wa_delivered", day: "2026-11-18", dayZone: "UTC", breakdown: "type=template", value: 0, isRunningTotal: false },
    ]);
    expect(parseWaAnalytics({ id: "1" }, "")).toEqual([]);
  });

  it("parseWaPricing: breakdown is category=…;type=…", () => {
    const point = (category: string, type: string, volume: number, cost: number) => ({
      start: unix("2026-11-17T00:00:00Z"),
      end: unix("2026-11-18T00:00:00Z"),
      pricing_category: category,
      pricing_type: type,
      volume,
      cost,
    });
    const rows = parseWaPricing({ pricing_analytics: { data: [{ data_points: [point("MARKETING", "REGULAR", 5, 0.25), point("SERVICE", "FREE_CUSTOMER_SERVICE", 9, 0)] }] } });
    expect(rows).toEqual([
      { metric: "wa_billable", day: "2026-11-17", dayZone: "UTC", breakdown: "category=MARKETING;type=REGULAR", value: 5, isRunningTotal: false },
      { metric: "wa_cost", day: "2026-11-17", dayZone: "UTC", breakdown: "category=MARKETING;type=REGULAR", value: 0.25, isRunningTotal: false },
      { metric: "wa_billable", day: "2026-11-17", dayZone: "UTC", breakdown: "category=SERVICE;type=FREE_CUSTOMER_SERVICE", value: 9, isRunningTotal: false },
      { metric: "wa_cost", day: "2026-11-17", dayZone: "UTC", breakdown: "category=SERVICE;type=FREE_CUSTOMER_SERVICE", value: 0, isRunningTotal: false },
    ]);
    // The flat shape (data_points directly under pricing_analytics) reads the same; two points for one key are added up.
    const flat = parseWaPricing({ pricing_analytics: { data_points: [point("UTILITY", "REGULAR", 1, 0.5), point("UTILITY", "REGULAR", 2, 1)] } });
    expect(flat.map((r) => [r.metric, r.value])).toEqual([
      ["wa_billable", 3],
      ["wa_cost", 1.5],
    ]);
  });

  it("parseTemplateAnalytics: tmpl_clicked sums button counts", () => {
    const out = parseTemplateAnalytics({
      data: [
        {
          granularity: "DAILY",
          data_points: [
            {
              template_id: "1924084211297547",
              start: unix("2026-11-17T00:00:00Z"),
              end: unix("2026-11-18T00:00:00Z"),
              sent: 20,
              delivered: 19,
              read: 12,
              clicked: [
                { type: "quick_reply_button", button_content: "Yes", count: 3 },
                { type: "url_button", button_content: "Order", count: 4 },
              ],
            },
            { template_id: "954638012257287", start: unix("2026-11-17T00:00:00Z"), end: unix("2026-11-18T00:00:00Z"), sent: 2, delivered: 2, read: 0 },
          ],
        },
      ],
    });
    expect(out).toHaveLength(2);
    const first = out.find((t) => t.templateId === "1924084211297547")!;
    expect(first.rows.map((r) => [r.metric, r.value, r.day, r.dayZone])).toEqual([
      ["tmpl_sent", 20, "2026-11-17", "UTC"],
      ["tmpl_delivered", 19, "2026-11-17", "UTC"],
      ["tmpl_read", 12, "2026-11-17", "UTC"],
      ["tmpl_clicked", 7, "2026-11-17", "UTC"],
    ]);
    // No click list from Meta: no click figure, not a zero.
    const second = out.find((t) => t.templateId === "954638012257287")!;
    expect(second.rows.map((r) => r.metric)).toEqual(["tmpl_sent", "tmpl_delivered", "tmpl_read"]);
  });
});

describe("days and series", () => {
  it("lagosDayBounds: 2026-11-19 starts at 2026-11-18T23:00:00Z", () => {
    const b = lagosDayBounds("2026-11-19");
    expect(new Date(b.since * 1000).toISOString()).toBe("2026-11-18T23:00:00.000Z");
    expect(new Date(b.until * 1000).toISOString()).toBe("2026-11-19T23:00:00.000Z");
  });

  it("fillSeries: missing days are null, zero stays zero", () => {
    expect(
      fillSeries("2026-11-16", "2026-11-19", [
        { day: "2026-11-16", value: 5 },
        { day: "2026-11-18", value: 0 },
      ]),
    ).toEqual([
      { day: "2026-11-16", value: 5 },
      { day: "2026-11-17", value: null },
      { day: "2026-11-18", value: 0 },
      { day: "2026-11-19", value: null },
    ]);
    expect(fillSeries("2026-11-19", "2026-11-16", [])).toEqual([]);
    expect(fillSeries("nope", "2026-11-16", [])).toEqual([]);
  });

  it("rangeTotal: sums flows, takes the last value for running totals, null when all null", () => {
    const points = [{ value: 5 }, { value: null }, { value: 7 }, { value: null }];
    expect(rangeTotal(points, false)).toBe(12);
    expect(rangeTotal(points, true)).toBe(7);
    expect(rangeTotal([{ value: null }, { value: null }], false)).toBeNull();
    expect(rangeTotal([], true)).toBeNull();
    expect(rangeTotal([{ value: 0 }], false)).toBe(0);
  });

  it("rangeChange: last minus first non-null", () => {
    expect(rangeChange([{ value: null }, { value: 100 }, { value: 104 }, { value: null }, { value: 110 }])).toBe(10);
    expect(rangeChange([{ value: 100 }])).toBeNull();
    expect(rangeChange([{ value: null }])).toBeNull();
  });

  it("rangeDailyAverage: averages only the days that have a figure", () => {
    expect(rangeDailyAverage([{ value: 10 }, { value: null }, { value: 20 }])).toBe(15);
    expect(rangeDailyAverage([{ value: null }])).toBeNull();
  });

  it("day helpers do not depend on the machine's clock or zone", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysInRange("2026-11-01", "2026-11-30")).toBe(30);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-02-28")).toBe(true);
    expect(lagosDayOf(new Date("2026-11-18T23:30:00Z"))).toBe("2026-11-19");
    expect(lagosHourOf(new Date("2026-11-18T23:30:00Z"))).toBe(0);
    expect(lagosHourOf(new Date("2026-11-19T09:00:00Z"))).toBe(10);
  });

  it("breakdownKey sorts its keys; metric helpers know running totals and product types", () => {
    expect(breakdownKey({ type: "REGULAR", category: "MARKETING" })).toBe("category=MARKETING;type=REGULAR");
    expect(breakdownKey({})).toBe("");
    expect(isRunningTotalMetric("facebook_page", "page_follows")).toBe(true);
    expect(isRunningTotalMetric("facebook_page", "page_media_view")).toBe(false);
    expect(isRunningTotalMetric("instagram_account", "followers_count")).toBe(true);
    expect(isRunningTotalMetric("instagram_media", "views")).toBe(true);
    expect(igMediaMetricsFor("STORY")).toEqual(["reach", "views", "replies", "shares", "total_interactions"]);
    expect(igMediaMetricsFor("REELS")).toContain("ig_reels_avg_watch_time");
    expect(igMediaMetricsFor("FEED")).toEqual(["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"]);
    for (const banned of ["navigation", "follows", "profile_visits", "ig_reels_video_view_total_time", "impressions", "plays"]) {
      for (const t of ["FEED", "REELS", "STORY"]) expect(igMediaMetricsFor(t)).not.toContain(banned);
    }
  });
});
