import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: each ads alert has its own wording, never raw text.
describe("owner alerts for ads (suite spec 12)", () => {
  it("the suite cannot read the ad account", () => {
    const m = format({ eventType: "ads.config_error", payload: { account: "act_1234500001", name: "Test Ads", code: "190", message: "Invalid OAuth access token", area: "sync" } });
    expect(m.text).toContain("*Ads: the suite cannot read the ad account*");
    expect(m.text).toContain("Meta refused our access to Test Ads (code 190): Invalid OAuth access token");
    expect(m.text).toContain("/ads");
    expect(m.text).not.toContain("ads.config_error");
  });
  it("a refused purchase report", () => {
    const m = format({ eventType: "ads.config_error", payload: { account: "100200300400500", code: "200", message: "Requires permission", area: "purchases" } });
    expect(m.text).toContain("Meta has not given the suite permission to report purchases (code 200): Requires permission");
  });
  it("a rule paused an advert", () => {
    const m = format({ eventType: "ads.rule_fired", payload: { account: "act_1", rule: "Too dear", advert: "November juice", summary: "Rule 'Too dear' paused 'November juice': each chat cost ₦1,000 over the last 3 days, above your limit of ₦800." } });
    expect(m.text).toContain("*Ads: a rule paused an advert*");
    expect(m.text).toContain("each chat cost ₦1,000 over the last 3 days");
    expect(m.text).toContain("Nothing turns it back on by itself.");
    expect(m.text).not.toContain("ads.rule_fired");
  });
  it("the safety stop", () => {
    const m = format({ eventType: "ads.safety_stop", payload: { account: "act_1", day: "2026-11-20", spend: 6000, cap: 5000, currency: "NGN", paused: 2 } });
    expect(m.text).toContain("*Ads: safety stop*");
    expect(m.text).toContain("₦6,000 spent today, at or over your daily cap of ₦5,000.");
    expect(m.text).toContain("2 adverts made in the suite were paused. Nothing turns them back on by itself.");
    const none = format({ eventType: "ads.safety_stop", payload: { account: "act_1", spend: 6000, cap: 5000, currency: "NGN", paused: 0 } });
    expect(none.text).toContain("No advert made in the suite was running.");
    expect(none.text).not.toContain("ads.safety_stop");
  });
});
