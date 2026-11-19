import { describe, it, expect } from "vitest";
import { emptyWeek, type PageEditable, type PageWeek } from "@ms/shared";
import { beforeAfterRows, changedKeys, fieldLabel, hoursText, labelsOf, partlySavedText, wasCleared } from "./page-details-logic.js";

const week = (over: Partial<PageWeek> = {}): PageWeek => ({ ...emptyWeek(), ...over });
const live = (over: Partial<PageEditable> = {}): PageEditable => ({
  about: "Fresh juice",
  description: null,
  phone: "+2348012345678",
  website: "https://www.mrssamuel.com",
  emails: ["a@x.com", "b@x.com"],
  always_open: false,
  hours: week({ mon: [{ open: "08:00", close: "18:00" }] }),
  address: { street: "1 Allen Avenue", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "" },
  ...over,
});

describe("changedKeys", () => {
  it("changedKeys ignores formatting-only differences", () => {
    const l = live();
    const form = live({
      about: "  Fresh juice ",
      phone: "+234 801 234 5678",
      website: "https://www.mrssamuel.com/",
      emails: ["B@x.com", "a@x.com"],
      description: "",
      address: { street: " 1 Allen Avenue ", city: "Ikeja", state: "Lagos", country: "Nigeria", zip: "" },
    });
    expect(changedKeys(form, l)).toEqual([]);
    expect(changedKeys({ ...form, about: "Fresh juice daily" }, l)).toEqual(["about"]);
  });

  it("switching Always open off sends the hours with it; on leaves them out", () => {
    const alwaysOpenLive = live({ always_open: true, hours: null });
    expect(changedKeys(live({ always_open: false }), alwaysOpenLive)).toEqual(["always_open", "hours"]);
    expect(changedKeys(live({ always_open: true, hours: week() }), live())).toEqual(["always_open"]);
  });
});

describe("beforeAfterRows", () => {
  it('beforeAfterRows shows "Not set" for empty values', () => {
    const rows = beforeAfterRows(live(), live({ description: "We press to order", phone: "", emails: [] }));
    expect(rows.map((r) => r.key)).toEqual(["description", "phone", "emails"]);
    expect(rows[0]).toMatchObject({ label: "More about the business", now: ["Not set"], after: ["We press to order"] });
    expect(rows[1]).toMatchObject({ now: ["+2348012345678"], after: ["Not set"] });
    expect(rows[2]).toMatchObject({ now: ["a@x.com, b@x.com"], after: ["Not set"] });
  });

  it("shows hours and Always open as one row, and the address on one line", () => {
    const rows = beforeAfterRows(live(), live({ always_open: true, address: { street: "2 Ring Road", city: "Ikeja", state: "", country: "Nigeria", zip: "100271" } }));
    expect(rows.map((r) => r.key)).toEqual(["hours", "address"]);
    expect(rows[0]!.after).toEqual(["Always open"]);
    expect(rows[0]!.now[0]).toBe("Mon 8:00 am to 6:00 pm");
    expect(rows[1]!.after).toEqual(["2 Ring Road, Ikeja, Nigeria, 100271"]);
  });
});

describe("hoursText", () => {
  it("hoursText renders one range, two ranges, closed and always open", () => {
    const lines = hoursText(
      week({
        mon: [{ open: "08:00", close: "18:00" }],
        tue: [{ open: "08:00", close: "12:00" }, { open: "14:00", close: "18:00" }],
        wed: [{ open: "00:00", close: "24:00" }],
      }),
      false,
    );
    expect(lines[0]).toBe("Mon 8:00 am to 6:00 pm");
    expect(lines[1]).toBe("Tue 8:00 am to 12:00 pm, 2:00 pm to 6:00 pm");
    expect(lines[2]).toBe("Wed 12:00 am to 12:00 am");
    expect(lines[3]).toBe("Thu Closed");
    expect(lines).toHaveLength(7);
    expect(hoursText(week(), true)).toEqual(["Always open"]);
    expect(hoursText(null, false)).toEqual(["Not set"]);
  });
});

describe("labels and banners", () => {
  it("fieldLabel and labelsOf", () => {
    expect(fieldLabel("about")).toBe("Short description");
    expect(labelsOf(["hours", "always_open", "about"])).toEqual(["Short description", "Opening hours"]);
  });
  it("partlySavedText names both lists and adds the Facebook line only for a cleared field", () => {
    expect(partlySavedText(["phone"], ["address"], false)).toBe(
      "Saved: Phone. Not saved yet: Address. Facebook may be reviewing them, or did not accept them. The page shows what Facebook holds now.",
    );
    expect(partlySavedText([], ["emails"], true)).toMatch(/To remove it completely, do it on Facebook\.$/);
    expect(wasCleared(live({ emails: [] }), ["emails"])).toBe(true);
    expect(wasCleared(live({ about: "x" }), ["about"])).toBe(false);
  });
});
