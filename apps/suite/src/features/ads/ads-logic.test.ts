import { describe, expect, it } from "vitest";
import {
  actorLabel,
  capLine,
  dayZoneCaption,
  destinationLabel,
  isoToLagosLocal,
  lagosLocalToIso,
  outcomeLabel,
  parseTyped,
  reportedLabel,
  ruleSentence,
  sourceLine,
  statusLabel,
  tabsFor,
} from "./ads-logic.js";

describe("statusLabel", () => {
  it("covers every state in 7.4", () => {
    expect(statusLabel("ACTIVE")).toBe("Running");
    expect(statusLabel("PAUSED")).toBe("Paused");
    expect(statusLabel("CAMPAIGN_PAUSED")).toBe("Paused");
    expect(statusLabel("ADSET_PAUSED")).toBe("Paused");
    expect(statusLabel("PENDING_REVIEW")).toBe("Being checked by Meta");
    expect(statusLabel("IN_PROCESS")).toBe("Being checked by Meta");
    expect(statusLabel("DISAPPROVED")).toBe("Rejected by Meta");
    expect(statusLabel("WITH_ISSUES")).toBe("Has a problem");
    expect(statusLabel("ARCHIVED")).toBe("Ended");
    expect(statusLabel("DELETED")).toBe("Ended");
    // Anything else: the raw value in lower case.
    expect(statusLabel("PREAPPROVED")).toBe("preapproved");
    expect(statusLabel("PENDING_BILLING_INFO")).toBe("pending billing info");
    expect(statusLabel(null)).toBe("Not known");
  });
});

describe("parseTyped", () => {
  it("\"₦35,000\" and \" 35 000 \" both give \"35000\"", () => {
    expect(parseTyped("₦35,000")).toBe("35000");
    expect(parseTyped(" 35 000 ")).toBe("35000");
    expect(parseTyped("35000")).toBe("35000");
    expect(parseTyped("35001")).not.toBe("35000");
    expect(parseTyped("")).toBe("");
  });
});

describe("reportedLabel", () => {
  it("covers every capi_status", () => {
    expect(reportedLabel("none", null, true)).toBe("Waiting");
    expect(reportedLabel("queued", null, true)).toBe("Waiting");
    expect(reportedLabel("sending", null, true)).toBe("Waiting");
    expect(reportedLabel("sent", null, true)).toBe("Yes");
    expect(reportedLabel("skipped", "A staff member chose not to report this customer.", true)).toBe("No — A staff member chose not to report this customer.");
    expect(reportedLabel("failed", "Meta has not given the suite permission to report purchases.", true)).toBe(
      "Failed — Meta has not given the suite permission to report purchases.",
    );
    expect(reportedLabel("unknown", null, true)).toBe("Not sure — Meta did not answer");
  });
  it("is blank while reporting is off, but still says what already happened", () => {
    expect(reportedLabel("none", null, false)).toBe("");
    expect(reportedLabel("queued", null, false)).toBe("");
    expect(reportedLabel(null, null, false)).toBe("");
    expect(reportedLabel("sent", null, false)).toBe("Yes");
  });
});

describe("the activity log", () => {
  it("outcome tags", () => {
    expect(outcomeLabel("ok", null)).toBe("Done");
    expect(outcomeLabel("refused", "Invalid parameter")).toBe("Refused by Meta — Invalid parameter");
    expect(outcomeLabel("blocked", null)).toBe("Blocked by the cap");
    expect(outcomeLabel("unknown", null)).toBe("No answer from Meta");
    expect(outcomeLabel("pending", null)).toBe("In progress");
  });
  it("who did it", () => {
    expect(actorLabel("person", "Ngozi")).toBe("Ngozi");
    expect(actorLabel("rule", "Too dear")).toBe("Rule: Too dear");
    expect(actorLabel("safety", "Safety stop")).toBe("Safety stop");
    expect(actorLabel("system", null)).toBe("The suite");
  });
});

describe("wording", () => {
  it("destinations", () => {
    expect(destinationLabel("whatsapp")).toBe("WhatsApp");
    expect(destinationLabel("messenger")).toBe("Messenger");
    expect(destinationLabel("instagram")).toBe("Instagram");
    expect(destinationLabel("other")).toBe("Other");
  });
  it("the cap line", () => {
    expect(capLine({ cap: 5000, already_committed: 2000 }, "NGN")).toBe("Your daily cap is ₦5,000; ₦2,000 is already running.");
  });
  it("a rule in words", () => {
    const r = { threshold: 800, lookback_days: 3, min_spend: 1000, currency: "NGN", scope_campaign_external_id: null };
    expect(ruleSentence(r, null)).toBe(
      "Pause if a chat costs more than ₦800 over the last 3 days, once at least ₦1,000 has been spent — all adverts made in the suite",
    );
    expect(ruleSentence({ ...r, lookback_days: 1, scope_campaign_external_id: "1" }, "November juice")).toContain("over the last 1 day, once");
    expect(ruleSentence({ ...r, scope_campaign_external_id: "1" }, "November juice")).toContain("— November juice");
  });
  it("the inbox line", () => {
    expect(sourceLine({ headline: "Fresh juice, delivered today", touched_at: "2026-11-19T10:00:00Z" })).toBe(
      'Came from an advert: "Fresh juice, delivered today" · Thu 19 Nov',
    );
    expect(sourceLine({ headline: null, touched_at: "2026-11-19T23:30:00Z" })).toBe("Came from an advert · Fri 20 Nov");
  });
  it("the day caption says when the ad account is not on Lagos time", () => {
    expect(dayZoneCaption("Africa/Lagos")).toBe("Days follow the ad account's clock (Africa/Lagos).");
    expect(dayZoneCaption("America/Los_Angeles")).toBe(
      "Days follow the ad account's clock (America/Los_Angeles). That is not Lagos time, so a day here does not line up exactly with a shop day.",
    );
  });
});

describe("tabs", () => {
  const ids = (who: { canManage: boolean; isOwner: boolean }) => tabsFor(who).map((t) => t.id);
  it("Rules only with the manage-ads permission; Settings only for the owner", () => {
    expect(ids({ canManage: false, isOwner: false })).toEqual(["overview", "adverts", "chats", "log"]);
    expect(ids({ canManage: true, isOwner: false })).toEqual(["overview", "adverts", "chats", "rules", "log"]);
    expect(ids({ canManage: true, isOwner: true })).toEqual(["overview", "adverts", "chats", "rules", "log", "settings"]);
  });
});

describe("start and end times are Lagos times", () => {
  it("round trip", () => {
    expect(lagosLocalToIso("2026-11-23T09:00")).toBe("2026-11-23T08:00:00.000Z");
    expect(isoToLagosLocal("2026-11-23T08:00:00.000Z")).toBe("2026-11-23T09:00");
    expect(lagosLocalToIso("nonsense")).toBeNull();
  });
});
