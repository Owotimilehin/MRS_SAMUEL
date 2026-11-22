import { describe, expect, it } from "vitest";
import { heatHours, heatLevel, hourLabel, outcomeText, percent, periodRange, shortDuration, waitingFor } from "./calls-logic.js";

describe("periodRange", () => {
  // 23:30 UTC on 21 Nov is 00:30 on 22 Nov in Lagos.
  const now = new Date("2026-11-21T23:30:00Z");
  it("uses the Lagos day", () => expect(periodRange("today", now)).toEqual({ from: "2026-11-22", to: "2026-11-22" }));
  it("counts today in a 7-day period", () => expect(periodRange("7", now)).toEqual({ from: "2026-11-16", to: "2026-11-22" }));
  it("crosses month ends", () => expect(periodRange("30", now).from).toBe("2026-10-24"));
});

describe("wording", () => {
  it("rounds a rate and guards against nothing to divide by", () => {
    expect(percent(2, 3)).toBe("67%");
    expect(percent(0, 0)).toBe("—");
  });
  it("says how long ago", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    expect(waitingFor("2026-11-22T11:59:40Z", now)).toBe("just now");
    expect(waitingFor("2026-11-22T11:48:00Z", now)).toBe("12 min ago");
    expect(waitingFor("2026-11-22T09:00:00Z", now)).toBe("3 h ago");
    expect(waitingFor("2026-11-21T10:00:00Z", now)).toBe("1 day ago");
    expect(waitingFor("2026-11-19T10:00:00Z", now)).toBe("3 days ago");
  });
  it("shortens durations", () => {
    expect(shortDuration(18)).toBe("18s");
    expect(shortDuration(250)).toBe("4 min");
    expect(shortDuration(7800)).toBe("2 h 10 min");
    expect(shortDuration(null)).toBe("—");
  });
  it("names outcomes by direction", () => {
    expect(outcomeText("missed", "in")).toEqual({ label: "Missed", tone: "danger" });
    expect(outcomeText("missed", "out")).toEqual({ label: "No answer", tone: "danger" });
    expect(outcomeText("information", "in").label).toBe("Heard a message");
  });
});

describe("busiest-times grid", () => {
  it("shows 7am–9pm, widened for early or late calls", () => {
    expect(heatHours([])).toHaveLength(15);
    expect(heatHours([{ hour: 6, calls: 2 }])[0]).toBe(6);
    expect(heatHours([{ hour: 23, calls: 0 }]).at(-1)).toBe(21);
  });
  it("never draws a busy cell invisibly faint", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 100)).toBe(0.12);
    expect(heatLevel(10, 10)).toBe(1);
  });
  it("labels hours", () => {
    expect(hourLabel(9)).toBe("9am");
    expect(hourLabel(12)).toBe("12pm");
    expect(hourLabel(15)).toBe("3pm");
  });
});
