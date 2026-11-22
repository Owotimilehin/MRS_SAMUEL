import { describe, expect, it } from "vitest";
import { STOP_REASONS } from "@ms/shared";
import {
  audienceHeadline,
  confirmCountOk,
  countsLine,
  estimateLine,
  isoToLagosInput,
  lagosInputToIso,
  ordersLine,
  reasonLines,
  resultTiles,
  reviewBlocker,
  statusPill,
  stopBanner,
  testLine,
  waitingBanner,
  type ReviewState,
} from "./broadcasts-logic.js";

const goodTest = { to: "+2347005550001", sent_at: "2026-11-20T10:00:00Z", status: "sent", matches: true, fresh: true };
const ready: ReviewState = {
  enabled: true,
  nameOk: true,
  listChosen: true,
  templateOk: true,
  blanksOk: true,
  pictureOk: true,
  audience: { counts: { list: 10, will_send: 8, skipped: { no_consent: 2 } }, estimate: { per_day: 200, days: 1, first_day: 8 } },
  test: goodTest,
  when: "now",
  scheduleProblem: null,
};

describe("review button (7.9)", () => {
  it("is enabled only when every section is complete", () => {
    expect(reviewBlocker(ready)).toBeNull();
  });
  it("gives the reason for each missing step", () => {
    expect(reviewBlocker({ ...ready, nameOk: false })).toBe("Give the broadcast a name.");
    expect(reviewBlocker({ ...ready, listChosen: false })).toBe("Pick a list.");
    expect(reviewBlocker({ ...ready, templateOk: false })).toBe("Pick a template that can be used.");
    expect(reviewBlocker({ ...ready, blanksOk: false })).toBe("Fill in every blank.");
    expect(reviewBlocker({ ...ready, pictureOk: false })).toBe("Add the picture.");
    expect(reviewBlocker({ ...ready, audience: { ...ready.audience!, counts: { list: 3, will_send: 0, skipped: { opted_out: 3 } } } })).toBe(
      "Nobody on this list can be sent this message.",
    );
    expect(reviewBlocker({ ...ready, audience: { ...ready.audience!, estimate: { per_day: 1, days: 20, first_day: 1 } } })).toBe(
      "This would take 20 days at your current WhatsApp limit. Choose a smaller list.",
    );
    expect(reviewBlocker({ ...ready, test: null })).toBe("Send a test first.");
    expect(reviewBlocker({ ...ready, test: { ...goodTest, matches: false } })).toBe("You changed the message after the test. Send a new test.");
    expect(reviewBlocker({ ...ready, test: { ...goodTest, fresh: false } })).toBe("Send a test first.");
    expect(reviewBlocker({ ...ready, test: { ...goodTest, status: "failed" } })).toBe("Send a test first.");
    expect(reviewBlocker({ ...ready, when: "scheduled", scheduleProblem: "Pick a time between 09:00 and 19:00." })).toBe("Pick a time between 09:00 and 19:00.");
    expect(reviewBlocker({ ...ready, enabled: false })).toBe("Broadcasts are switched off.");
  });
});

describe("audience panel (7.9)", () => {
  it("headline and reason lines, in the documented order, with the gap filled in", () => {
    expect(audienceHeadline({ counts: { list: 50, will_send: 12, skipped: {} } })).toBe("12 of 50 people will get this message.");
    expect(reasonLines({ recent: 3, no_consent: 38, opted_out: 1 }, 7)).toEqual([
      { reason: "opted_out", count: 1, text: "1 · Asked us to stop promotions" },
      { reason: "no_consent", count: 38, text: "38 · Has not agreed to promotions on WhatsApp" },
      { reason: "recent", count: 3, text: "3 · Got a broadcast in the last 7 days" },
    ]);
    expect(estimateLine(200, 1)).toBe("Your WhatsApp limit lets you start 200 new conversations a day. This will take about 1 day.");
    expect(estimateLine(2000, 3)).toContain("about 3 days.");
  });
});

describe("the confirm box", () => {
  it("accepts only the exact number", () => {
    expect(confirmCountOk("120", 120)).toBe(true);
    expect(confirmCountOk("1,200", 1200)).toBe(true);
    expect(confirmCountOk(" 120 ", 120)).toBe(true);
    expect(confirmCountOk("121", 120)).toBe(false);
    expect(confirmCountOk("12O", 120)).toBe(false);
    expect(confirmCountOk("", 120)).toBe(false);
    expect(confirmCountOk("120.0", 120)).toBe(false);
    expect(confirmCountOk("0", 0)).toBe(false);
  });
});

describe("status pills and banners (7.8, 7.10)", () => {
  it("has wording for each status", () => {
    expect(statusPill("draft", null)).toEqual({ label: "Draft", tone: "ink" });
    expect(statusPill("scheduled", "2026-11-21T09:00:00Z").label).toMatch(/^Scheduled for Sat 21 Nov/);
    expect(statusPill("sending", null).label).toBe("Sending");
    expect(statusPill("paused", null).label).toBe("Paused");
    expect(statusPill("stopped", null)).toEqual({ label: "Stopped", tone: "danger" });
    expect(statusPill("done", null).label).toBe("Finished");
    expect(statusPill("cancelled", null).label).toBe("Cancelled");
  });
  it("has a stop banner with what to do for every stop reason", () => {
    for (const r of STOP_REASONS) {
      const b = stopBanner(r, null);
      expect(b.title.startsWith("Stopped: ")).toBe(true);
      expect(b.title).not.toContain("The broadcast was stopped.");
      expect(b.todo.length).toBeGreaterThan(10);
    }
  });
  it("has a waiting banner for each wait", () => {
    expect(waitingBanner("hours", "09:00")).toBe("Waiting for 09:00. Broadcasts only go out in the daytime.");
    expect(waitingBanner("limit", "09:00")).toBe("Today's WhatsApp limit is used. It continues tomorrow.");
    expect(waitingBanner("warmup", "09:00")).toBe("Sent the first 20. Checking how they land before sending the rest (about 10 minutes).");
    expect(waitingBanner(null, "09:00")).toBeNull();
  });
  it("counts line and orders line", () => {
    expect(countsLine({ sent: 1200, delivered: 1100, read: 600, failed: 12 })).toBe("1,200 sent · 1,100 delivered · 600 read · 12 failed");
    expect(ordersLine({ days: 7, people: 4, orders: 5, total_ngn: 32500 })).toBe("4 of the people who got this ordered within 7 days: 5 orders, ₦32,500.");
  });
  it("tiles show a share of Sent, and Left out a share of the list", () => {
    const t = resultTiles({ list: 100, waiting: 0, sent: 80, delivered: 60, read: 40, replied: 4, failed: 10, unknown: 2, skipped: 8, opted_out: 1 });
    expect(t.find((x) => x.key === "read")!.share).toBe("50%");
    expect(t.find((x) => x.key === "skipped")!.share).toBe("8%");
    expect(t.find((x) => x.key === "unknown")!.help).toContain("We do not send again.");
  });
});

describe("test send wording and times", () => {
  it("says what happened to the test", () => {
    expect(testLine(null)).toBeNull();
    expect(testLine(goodTest)!.text).toBe("Test sent to +2347005550001. Check your phone, then come back.");
    expect(testLine({ ...goodTest, status: "delivered" })!.text).toBe("Test delivered.");
    expect(testLine({ ...goodTest, matches: false })!.text).toBe("You changed the message after the test. Send a new test.");
    expect(testLine({ ...goodTest, status: "failed" })!.tone).toBe("danger");
  });
  it("turns a Lagos time typed in the box into an exact time and back", () => {
    expect(lagosInputToIso("2026-11-21T10:00")).toBe("2026-11-21T09:00:00.000Z");
    expect(isoToLagosInput("2026-11-21T09:00:00.000Z")).toBe("2026-11-21T10:00");
    expect(lagosInputToIso("tomorrow")).toBeNull();
  });
});
