import { describe, it, expect } from "vitest";
import {
  PAGE_DAYS,
  diffPage,
  emptyWeek,
  normalisePageChanges,
  pageHoursToWeek,
  samePageValue,
  validatePageChanges,
  weekToPageHours,
  type PageEditable,
  type PageWeek,
} from "./page-details.js";

const week = (over: Partial<PageWeek> = {}): PageWeek => ({ ...emptyWeek(), ...over });
const msgs = (c: Partial<PageEditable>) => validatePageChanges(c).map((p) => p.message);

describe("pageHoursToWeek", () => {
  it("pageHoursToWeek: reads mon_1 and mon_2 ranges; missing days are closed; null stays null", () => {
    const w = pageHoursToWeek({
      mon_1_open: "08:00",
      mon_1_close: "12:00",
      mon_2_open: "14:00",
      mon_2_close: "18:00",
      tue_1_open: "09:00",
      tue_1_close: "17:00",
    })!;
    expect(w.mon).toEqual([
      { open: "08:00", close: "12:00" },
      { open: "14:00", close: "18:00" },
    ]);
    expect(w.tue).toEqual([{ open: "09:00", close: "17:00" }]);
    expect(w.sun).toEqual([]);
    expect(pageHoursToWeek(null)).toBeNull();
    expect(pageHoursToWeek(undefined)).toBeNull();
    expect(pageHoursToWeek({})).toBeNull();
  });
});

describe("weekToPageHours", () => {
  it("weekToPageHours: writes {day}_{n}_{open|close} keys for one and two ranges", () => {
    expect(
      weekToPageHours(
        week({
          mon: [
            { open: "08:00", close: "12:00" },
            { open: "14:00", close: "18:00" },
          ],
          sat: [{ open: "10:00", close: "24:00" }],
        }),
      ),
    ).toEqual({
      mon_1_open: "08:00",
      mon_1_close: "12:00",
      mon_2_open: "14:00",
      mon_2_close: "18:00",
      sat_1_open: "10:00",
      sat_1_close: "24:00",
    });
  });
  it("weekToPageHours then pageHoursToWeek round-trips", () => {
    const w = week({
      mon: [{ open: "08:00", close: "12:00" }, { open: "14:00", close: "18:00" }],
      wed: [{ open: "20:00", close: "02:00" }],
      sun: [{ open: "00:00", close: "24:00" }],
    });
    expect(pageHoursToWeek(weekToPageHours(w))).toEqual(w);
    expect(Object.keys(pageHoursToWeek(weekToPageHours(w))!)).toEqual([...PAGE_DAYS]);
  });
});

describe("validatePageChanges", () => {
  it("validatePageChanges: about over 100; bad phone; website without a dot; 4 emails; duplicate email; bad email", () => {
    expect(msgs({ about: "x".repeat(100) })).toEqual([]);
    expect(msgs({ about: "x".repeat(101) })).toEqual(["Keep the short description to 100 characters."]);
    expect(msgs({ description: "x".repeat(1001) })).toEqual(["Keep the longer description to 1,000 characters."]);
    expect(msgs({ phone: "abc" })).toEqual([
      "That phone number doesn't look right. Include the country code, for example +234 801 234 5678.",
    ]);
    expect(msgs({ phone: "+234 801 234 5678" })).toEqual([]);
    expect(msgs({ phone: null })).toEqual([]);
    expect(msgs({ website: "https://localhost" })).toEqual(["Enter a web address such as https://www.mrssamuel.com"]);
    expect(msgs({ website: "mrssamuel.com" })).toEqual(["Enter a web address such as https://www.mrssamuel.com"]);
    expect(msgs({ website: "https://www.mrssamuel.com" })).toEqual([]);
    expect(msgs({ emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"] })).toEqual(["You can list up to 3 emails."]);
    expect(msgs({ emails: ["a@x.com", "A@x.com"] })).toEqual(["The same email is listed twice."]);
    expect(msgs({ emails: ["nope"] })).toEqual(["“nope” is not an email address."]);
    expect(msgs({ emails: [] })).toEqual([]);
  });

  it("validatePageChanges: hours overlap; close before open; overnight close at 02:00 allowed; overnight close at 07:00 refused; empty week refused", () => {
    const one = (open: string, close: string) => week({ mon: [{ open, close }] });
    expect(
      msgs({
        hours: week({
          mon: [
            { open: "08:00", close: "13:00" },
            { open: "12:00", close: "18:00" },
          ],
        }),
      }),
    ).toEqual(["Monday: the two opening times overlap."]);
    expect(msgs({ hours: one("08:00", "12:00") })).toEqual([]);
    expect(msgs({ hours: one("18:00", "08:00") })).toEqual([
      "Monday: closing time must be after opening time (or by 6:00 am the next morning).",
    ]);
    expect(msgs({ hours: one("20:00", "02:00") })).toEqual([]);
    expect(msgs({ hours: one("20:00", "06:00") })).toEqual([]);
    expect(msgs({ hours: one("20:00", "07:00") })).toEqual([
      "Monday: closing time must be after opening time (or by 6:00 am the next morning).",
    ]);
    expect(msgs({ hours: one("09:00", "09:00") })).toHaveLength(1);
    expect(msgs({ hours: one("00:00", "24:00") })).toEqual([]);
    expect(msgs({ hours: one("08:03", "12:00") })).toEqual(["Monday: times must be like 08:00, in 5-minute steps."]);
    expect(msgs({ hours: emptyWeek() })).toEqual(["Add at least one opening time, or choose Always open."]);
    expect(msgs({ hours: null })).toEqual(["Add at least one opening time, or choose Always open."]);
    // Switching Always open off needs hours in the same save; on needs none.
    expect(msgs({ always_open: false })).toEqual(["Add at least one opening time, or choose Always open."]);
    expect(msgs({ always_open: true, hours: emptyWeek() })).toEqual([]);
    expect(msgs({ always_open: true })).toEqual([]);
  });

  it("validatePageChanges: address needs street, city and country together", () => {
    const a = { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "" };
    expect(msgs({ address: a })).toEqual([]);
    expect(msgs({ address: { ...a, city: "" } })).toEqual(["Fill in the street, the city and the country."]);
    expect(msgs({ address: { street: "", city: "", state: "", country: "", zip: "" } })).toEqual([]);
    expect(msgs({ address: null })).toEqual([]);
  });
});

describe("normalisePageChanges", () => {
  it('normalisePageChanges: adds https://, lower-cases emails, formats the phone, turns "" into null', () => {
    const n = normalisePageChanges({
      about: "  Fresh juice ",
      description: "",
      phone: "0801 234 5678",
      website: "www.mrssamuel.com",
      emails: [" Shop@MrsSamuel.com ", ""],
      address: { street: " ", city: "", state: "", country: "", zip: "" },
    });
    expect(n).toEqual({
      about: "Fresh juice",
      description: null,
      phone: "+2348012345678",
      website: "https://www.mrssamuel.com",
      emails: ["shop@mrssamuel.com"],
      address: null,
    });
    expect(normalisePageChanges({ website: "http://x.com" }).website).toBe("http://x.com");
    expect(normalisePageChanges({ phone: "" }).phone).toBeNull();
    expect(Object.keys(normalisePageChanges({ about: "a" }))).toEqual(["about"]);
  });
});

describe("samePageValue", () => {
  it("samePageValue: phone compared by digits; website ignores a trailing slash; emails ignore order", () => {
    expect(samePageValue("phone", "+234 801 234 5678", "+2348012345678")).toBe(true);
    expect(samePageValue("phone", "08012345678", "+2348012345678")).toBe(true);
    expect(samePageValue("phone", "+2348012345678", "+2348012345679")).toBe(false);
    expect(samePageValue("phone", null, "")).toBe(true);
    expect(samePageValue("website", "https://x.com/", "https://x.com")).toBe(true);
    expect(samePageValue("website", "https://x.com", "https://y.com")).toBe(false);
    expect(samePageValue("emails", ["b@x.com", "A@x.com"], ["a@x.com", "b@x.com"])).toBe(true);
    expect(samePageValue("emails", ["a@x.com"], [])).toBe(false);
    expect(samePageValue("about", null, " ")).toBe(true);
    expect(samePageValue("always_open", false, undefined)).toBe(true);
    expect(samePageValue("hours", null, emptyWeek())).toBe(true);
    expect(
      samePageValue(
        "hours",
        week({ mon: [{ open: "14:00", close: "18:00" }, { open: "08:00", close: "12:00" }] }),
        week({ mon: [{ open: "08:00", close: "12:00" }, { open: "14:00", close: "18:00" }] }),
      ),
    ).toBe(true);
    const a = { street: "1 A", city: "B", state: "", country: "NG", zip: "" };
    expect(samePageValue("address", a, { ...a, street: " 1 A " })).toBe(true);
    expect(samePageValue("address", a, { ...a, city: "C" })).toBe(false);
    expect(samePageValue("address", null, { street: "", city: "", state: "", country: "", zip: "" })).toBe(true);
  });

  it("diffPage: lists only the keys that differ", () => {
    const before: PageEditable = {
      about: "a",
      description: null,
      phone: "+2348012345678",
      website: null,
      emails: [],
      always_open: false,
      hours: null,
      address: null,
    };
    expect(diffPage(before, { about: "a", phone: "+234 801 234 5678", website: "https://x.com" })).toEqual(["website"]);
  });
});
