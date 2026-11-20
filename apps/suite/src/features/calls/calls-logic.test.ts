import { describe, expect, it } from "vitest";
import type { CallRow } from "./calls-api.js";
import {
  OUTCOME_OPTIONS,
  callerName,
  callsQuery,
  countLine,
  customerNumber,
  emptyText,
  filtersProblem,
  isFiltered,
  lagosWhen,
  outcomeLabel,
  outcomeTone,
  staffLine,
} from "./calls-logic.js";

const base: Pick<CallRow, "direction" | "from_e164" | "to_e164" | "customer_name" | "answered_by" | "started_by"> = {
  direction: "in",
  from_e164: "+2347011112222",
  to_e164: "+2348100000001",
  customer_name: null,
  answered_by: null,
  started_by: null,
};

describe("the list address", () => {
  it("leaves out empty filters and always asks for a page size", () => {
    expect(callsQuery({})).toBe("limit=50");
    expect(callsQuery({ from: "", number: "" })).toBe("limit=50");
  });

  it("sends every filter that is set, and the cursor for the next page", () => {
    const q = new URLSearchParams(
      callsQuery({ from: "2026-11-01", to: "2026-11-20", number: "n1", staff: "u1", outcome: "missed", direction: "in" }, "2026-11-10 09:00:00+00|abc", 20),
    );
    expect(Object.fromEntries(q)).toEqual({
      from: "2026-11-01",
      to: "2026-11-20",
      number: "n1",
      staff: "u1",
      outcome: "missed",
      direction: "in",
      limit: "20",
      before: "2026-11-10 09:00:00+00|abc",
    });
  });
});

describe("filters", () => {
  it("flags a start date after the end date", () => {
    expect(filtersProblem({ from: "2026-11-20", to: "2026-11-01" })).toBe("The start date is after the end date.");
    expect(filtersProblem({ from: "2026-11-01", to: "2026-11-01" })).toBeNull();
    expect(filtersProblem({ from: "2026-11-01" })).toBeNull();
  });

  it("knows when any filter is on", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ outcome: "voicemail" })).toBe(true);
    expect(isFiltered({ direction: "out" })).toBe(true);
  });

  it("offers every outcome the server stores, once", () => {
    const values = OUTCOME_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.sort()).toEqual(["after_hours", "answered", "failed", "in_progress", "information", "missed", "voicemail"]);
  });
});

describe("wording", () => {
  it("names outcomes to fit the direction", () => {
    expect(outcomeLabel("answered", "in")).toBe("Answered");
    expect(outcomeLabel("answered", "out")).toBe("Connected");
    expect(outcomeLabel("missed", "in")).toBe("Missed");
    expect(outcomeLabel("missed", "out")).toBe("No answer");
    expect(outcomeLabel("information", "in")).toBe("Heard a message");
    for (const o of OUTCOME_OPTIONS) expect(outcomeLabel(o.value, "in")).toBeTruthy();
  });

  it("colours a call nobody took red and an answered call green", () => {
    expect(outcomeTone("missed")).toBe("danger");
    expect(outcomeTone("after_hours")).toBe("danger");
    expect(outcomeTone("failed")).toBe("danger");
    expect(outcomeTone("answered")).toBe("success");
    expect(outcomeTone("voicemail")).toBe("warning");
    expect(outcomeTone("information")).toBe("ink");
  });

  it("shows the customer's number: who called in, or who we called", () => {
    expect(customerNumber(base)).toBe("+234 701 111 2222");
    expect(customerNumber({ ...base, direction: "out", to_e164: "+2347033334444" })).toBe("+234 703 333 4444");
  });

  it("uses the contact's name when there is one", () => {
    expect(callerName({ ...base, customer_name: " Ada " })).toBe("Ada");
    expect(callerName(base)).toBe("+234 701 111 2222");
  });

  it("says who took or made the call", () => {
    expect(staffLine(base)).toBeNull();
    expect(staffLine({ ...base, answered_by: "Tola" })).toBe("Answered by Tola");
    expect(staffLine({ ...base, answered_by: "tola@example.com" })).toBe("Answered by tola");
    expect(staffLine({ ...base, direction: "out", started_by: "Kemi" })).toBe("Made by Kemi");
    expect(staffLine({ ...base, direction: "out", answered_by: "Kemi" })).toBe("Made by Kemi");
  });

  it("shows times in Lagos time", () => {
    // 23:30 UTC is 00:30 the next day in Lagos.
    expect(lagosWhen("2026-11-11T23:30:00Z")).toBe("12 Nov 2026, 00:30");
    expect(lagosWhen("not a date")).toBe("");
  });

  it("explains an empty list plainly", () => {
    expect(emptyText({ configured: false, filtered: false })).toBe("No calls yet. Calling is not set up.");
    expect(emptyText({ configured: true, filtered: false })).toBe("No calls yet.");
    expect(emptyText({ configured: null, filtered: false })).toBe("No calls yet.");
    expect(emptyText({ configured: false, filtered: true })).toBe("No calls match these filters.");
  });

  it("counts calls", () => {
    expect(countLine(1, false)).toBe("1 call");
    expect(countLine(3, false)).toBe("3 calls");
    expect(countLine(50, true)).toBe("50+ calls");
  });
});
