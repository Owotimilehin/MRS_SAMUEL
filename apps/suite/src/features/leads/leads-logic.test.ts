import { describe, expect, it } from "vitest";
import {
  advertLine,
  backfillLine,
  barHeights,
  emptyMessage,
  followUpBlockedText,
  formStatusLabel,
  initials,
  lagosDayAgo,
  leadName,
  minutesText,
  pendingIsSlow,
  receivedLabel,
  rowSubLine,
  statusChip,
  winRateText,
} from "./leads-logic.js";

// A fixed "now": nothing here reads the clock or the machine's time zone.
const NOW = new Date("2026-11-20T09:00:00.000Z"); // 10:00 in Lagos

describe("leads logic", () => {
  it("status chip label and colour for each status", () => {
    expect(statusChip("new")).toEqual({ label: "New", tone: "accent" });
    expect(statusChip("contacted")).toEqual({ label: "Contacted", tone: "warning" });
    expect(statusChip("won")).toEqual({ label: "Won", tone: "success" });
    expect(statusChip("lost")).toEqual({ label: "Lost", tone: "ink" });
  });

  it("follow-up blocked reason text for each code", () => {
    expect(followUpBlockedText("no_phone")).toBe("No phone number was given.");
    expect(followUpBlockedText("no_consent")).toBe(
      "This form did not ask permission to message on WhatsApp. Call or email instead, or ask the owner to update the form's settings.",
    );
    expect(followUpBlockedText("no_template")).toBe("The “lead_followup” template is not approved yet. See Templates.");
    expect(followUpBlockedText("no_line")).toBe("No WhatsApp number is set up.");
    expect(followUpBlockedText("no_permission")).toBe("You need permission to send templates.");
    // Already sent is not a block (the button reads "Send again"), and no code means no text.
    expect(followUpBlockedText("already_sent")).toBeNull();
    expect(followUpBlockedText(null)).toBeNull();
  });

  it("row sub-line says “Not from an advert” for organic leads", () => {
    expect(rowSubLine({ form_name: "Bulk orders", ad_name: null, is_organic: true })).toBe("Bulk orders · Not from an advert");
    expect(rowSubLine({ form_name: "Bulk orders", ad_name: "Juice advert", is_organic: false })).toBe("Bulk orders · from Juice advert");
    expect(rowSubLine({ form_name: "Bulk orders", ad_name: null, is_organic: null })).toBe("Bulk orders");
    expect(advertLine({ ad_name: "Juice advert", campaign_name: "November", is_organic: false })).toBe("Advert: Juice advert · November");
    expect(advertLine({ ad_name: null, campaign_name: null, is_organic: true })).toBe("Not from an advert");
    expect(advertLine({ ad_name: null, campaign_name: null, is_organic: null })).toBeNull();
  });

  it("win rate shows “–” when nothing is closed", () => {
    expect(winRateText(null)).toBe("–");
    expect(winRateText(undefined)).toBe("–");
    expect(winRateText(0.5)).toBe("50%");
    expect(winRateText(0)).toBe("0%");
    expect(winRateText(2 / 3)).toBe("67%");
  });

  it("names, times and owner initials", () => {
    expect(leadName({ full_name: null })).toBe("No name given");
    expect(leadName({ full_name: "  Test Person " })).toBe("Test Person");
    expect(receivedLabel("2026-11-20T08:05:00.000Z", NOW)).toBe("Today 09:05");
    expect(receivedLabel("2026-11-19T23:30:00.000Z", NOW)).toBe("Today 00:30"); // already the 20th in Lagos
    expect(receivedLabel("2026-11-19T10:00:00.000Z", NOW)).toBe("Yesterday 11:00");
    expect(initials("Test Person")).toBe("TP");
    expect(initials("rep@example.com")).toBe("R");
    expect(initials(null)).toBe("?");
    expect(minutesText(null)).toBe("–");
    expect(minutesText(12.4)).toBe("12 min");
    expect(minutesText(200)).toBe("3 h 20 min");
    expect(minutesText(120)).toBe("2 h");
    expect(minutesText(3 * 1440)).toBe("3 days");
  });

  it("the slow-fetch banner waits ten minutes", () => {
    expect(pendingIsSlow({ pending: 0, oldest_pending_at: null }, NOW)).toBe(false);
    expect(pendingIsSlow({ pending: 2, oldest_pending_at: "2026-11-20T08:55:00.000Z" }, NOW)).toBe(false);
    expect(pendingIsSlow({ pending: 2, oldest_pending_at: "2026-11-20T08:49:00.000Z" }, NOW)).toBe(true);
  });

  it("empty messages, form status and the back-fill line", () => {
    expect(emptyMessage({ forms: 0, filtered: false })).toContain("No lead forms found yet.");
    expect(emptyMessage({ forms: 2, filtered: false })).toContain("No leads yet.");
    expect(emptyMessage({ forms: 2, filtered: true })).toBe("Nothing matches these filters.");
    expect(formStatusLabel("ACTIVE")).toBe("Active");
    expect(formStatusLabel("ARCHIVED")).toBe("Archived");
    expect(formStatusLabel(null)).toBe("");
    expect(backfillLine({ requested_at: null, done_at: null, count: 0, stopped: false }, NOW)).toBeNull();
    expect(backfillLine({ requested_at: "2026-11-20T08:00:00.000Z", done_at: null, count: 40, stopped: false }, NOW)).toBe("Fetching… 40 so far.");
    expect(backfillLine({ requested_at: "2026-11-20T08:00:00.000Z", done_at: "2026-11-20T08:10:00.000Z", count: 120, stopped: false }, NOW)).toBe(
      "Fetched 120 earlier leads on 20 Nov.",
    );
    expect(backfillLine({ requested_at: "2026-11-20T08:00:00.000Z", done_at: "2026-11-20T08:10:00.000Z", count: 0, stopped: true }, NOW)).toBe(
      "Stopped: Meta would not let us read this form's leads.",
    );
  });

  it("report dates and bars", () => {
    expect(lagosDayAgo(0, NOW)).toBe("2026-11-20");
    expect(lagosDayAgo(29, NOW)).toBe("2026-10-22");
    expect(lagosDayAgo(0, new Date("2026-11-19T23:30:00.000Z"))).toBe("2026-11-20");
    expect(barHeights([{ day: "2026-11-19", leads: 2 }, { day: "2026-11-20", leads: 4 }])).toEqual([
      { day: "2026-11-19", leads: 2, pct: 50 },
      { day: "2026-11-20", leads: 4, pct: 100 },
    ]);
    expect(barHeights([{ day: "2026-11-20", leads: 0 }])[0]!.pct).toBe(0);
  });
});
