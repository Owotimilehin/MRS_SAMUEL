import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROADCAST_SETTINGS,
  SKIP_REASONS,
  SKIP_REASON_TEXT,
  STOP_REASONS,
  STOP_REASON_TEXT,
  blanksProblem,
  broadcastSettingsProblem,
  defaultBlanks,
  estimateDays,
  fillBlanks,
  hasStopWording,
  nextSendingStart,
  perDayFor,
  plainFailure,
  readBlanks,
  readBroadcastSettings,
  scheduleProblem,
  skipReasonText,
  templateBroadcastUse,
  tickBatch,
  tierToNumber,
  valuesProblem,
  withinSendingHours,
  type BroadcastBlanks,
} from "./broadcasts.js";
import { templateNeeds } from "./inbox-templates.js";

/** A Lagos wall-clock time on 18 Nov 2026 as a Date (Lagos is UTC+1 all year). */
const lagos = (hhmm: string, day = "2026-11-18"): Date => new Date(`${day}T${hhmm}:00+01:00`);
const HOURS = { send_from: "09:00", send_until: "19:00" };

const promo = (extra: unknown[] = [], body = "Hello {{1}}, fresh juice this week. Reply STOP to stop these messages.") => [
  { type: "BODY", text: body },
  ...extra,
];

describe("broadcast settings", () => {
  it("the owner switch is off by default, and a missing or damaged row reads as off", () => {
    expect(DEFAULT_BROADCAST_SETTINGS.enabled).toBe(false);
    expect(readBroadcastSettings(undefined).enabled).toBe(false);
    expect(readBroadcastSettings(null)).toEqual(DEFAULT_BROADCAST_SETTINGS);
    expect(readBroadcastSettings({ enabled: "true" }).enabled).toBe(false);
    expect(readBroadcastSettings({ enabled: 1 }).enabled).toBe(false);
    expect(readBroadcastSettings({ enabled: true }).enabled).toBe(true);
  });

  it("the defaults are the spec's: 09:00 to 19:00, 20 a minute, 7 days, consent only, 80% of the limit, the cloud route", () => {
    expect(DEFAULT_BROADCAST_SETTINGS).toEqual({
      enabled: false,
      send_from: "09:00",
      send_until: "19:00",
      rate_per_minute: 20,
      min_days_between: 7,
      attribution_days: 7,
      audience_rule: "consent_only",
      recent_customer_months: 12,
      daily_share: 0.8,
      route: "cloud",
    });
  });

  it("anything out of range falls back to the default, never to something wider", () => {
    const s = readBroadcastSettings({ rate_per_minute: 600, daily_share: 5, min_days_between: -1, audience_rule: "everyone", route: "fast", send_from: "19:00", send_until: "09:00" });
    expect(s).toEqual(DEFAULT_BROADCAST_SETTINGS);
    expect(readBroadcastSettings({ rate_per_minute: 6, daily_share: 0.1, min_days_between: 0 })).toMatchObject({ rate_per_minute: 6, daily_share: 0.1, min_days_between: 0 });
  });

  it("broadcastSettingsProblem refuses a speed above 60 and hours the wrong way round", () => {
    expect(broadcastSettingsProblem(DEFAULT_BROADCAST_SETTINGS)).toBeNull();
    expect(broadcastSettingsProblem({ ...DEFAULT_BROADCAST_SETTINGS, rate_per_minute: 61 })).toMatch(/between 6 and 60/);
    expect(broadcastSettingsProblem({ ...DEFAULT_BROADCAST_SETTINGS, send_from: "20:00" })).toMatch(/earlier/);
    expect(broadcastSettingsProblem({ ...DEFAULT_BROADCAST_SETTINGS, daily_share: 1.5 })).toMatch(/10% and 100%/);
  });
});

describe("the WhatsApp limit", () => {
  it("tierToNumber: TIER_250, TIER_2K, TIER_10K, TIER_100K, TIER_UNLIMITED, 2000, null and nonsense", () => {
    expect(tierToNumber("TIER_250")).toBe(250);
    expect(tierToNumber("TIER_2K")).toBe(2000);
    expect(tierToNumber("TIER_10K")).toBe(10_000);
    expect(tierToNumber("TIER_100K")).toBe(100_000);
    expect(tierToNumber("TIER_UNLIMITED")).toBe(Infinity);
    expect(tierToNumber("TIER_50")).toBe(50);
    expect(tierToNumber(2000)).toBe(2000);
    expect(tierToNumber("2000")).toBe(2000);
    expect(tierToNumber(null)).toBe(250);
    expect(tierToNumber(undefined)).toBe(250);
    expect(tierToNumber("TIER_NOT_SET")).toBe(250);
    expect(tierToNumber("nonsense")).toBe(250);
    expect(tierToNumber(0)).toBe(250);
  });

  it("perDayFor takes the owner's share of the limit; unlimited is capped at 20,000", () => {
    expect(perDayFor("TIER_250", 0.8)).toBe(200);
    expect(perDayFor("TIER_2K", 0.5)).toBe(1000);
    expect(perDayFor(null, 0.8)).toBe(200);
    expect(perDayFor("TIER_UNLIMITED", 0.8)).toBe(20_000);
    expect(estimateDays(450, 200)).toBe(3);
    expect(estimateDays(0, 200)).toBe(0);
    expect(estimateDays(5, 0)).toBe(Infinity);
  });

  it("tickBatch is a twelfth of the minute's rate, rounded up", () => {
    expect(tickBatch(20)).toBe(2);
    expect(tickBatch(6)).toBe(1);
    expect(tickBatch(60)).toBe(5);
  });
});

describe("sending hours (Africa/Lagos)", () => {
  it("withinSendingHours and nextSendingStart at 08:59, 09:00, 18:59 and 19:00 Lagos time", () => {
    expect(withinSendingHours(lagos("08:59"), HOURS)).toBe(false);
    expect(withinSendingHours(lagos("09:00"), HOURS)).toBe(true);
    expect(withinSendingHours(lagos("18:59"), HOURS)).toBe(true);
    expect(withinSendingHours(lagos("19:00"), HOURS)).toBe(false);

    expect(nextSendingStart(lagos("08:59"), HOURS).toISOString()).toBe(lagos("09:00").toISOString());
    expect(nextSendingStart(lagos("09:00"), HOURS).toISOString()).toBe(lagos("09:00").toISOString());
    expect(nextSendingStart(lagos("18:59"), HOURS).toISOString()).toBe(lagos("18:59").toISOString());
    expect(nextSendingStart(lagos("19:00"), HOURS).toISOString()).toBe(lagos("09:00", "2026-11-19").toISOString());
  });

  it("hours the wrong way round never allow sending", () => {
    expect(withinSendingHours(lagos("12:00"), { send_from: "19:00", send_until: "09:00" })).toBe(false);
    expect(withinSendingHours(lagos("12:00"), { send_from: "nonsense", send_until: "09:00" })).toBe(false);
  });

  it("scheduleProblem: at least 10 minutes ahead, inside the hours, within 30 days", () => {
    const now = lagos("10:00");
    expect(scheduleProblem(lagos("10:05"), now, HOURS)).toBe("Pick a time at least 10 minutes from now.");
    expect(scheduleProblem(lagos("20:00", "2026-11-19"), now, HOURS)).toBe("Pick a time between 09:00 and 19:00.");
    expect(scheduleProblem(lagos("10:00", "2027-01-18"), now, HOURS)).toBe("Pick a time in the next 30 days.");
    expect(scheduleProblem(lagos("10:00", "2026-11-19"), now, HOURS)).toBeNull();
    expect(scheduleProblem(null, now, HOURS)).toBe("Pick a date and time.");
  });
});

describe("blanks", () => {
  const blanks: BroadcastBlanks = { body: [{ from: "first_name", fallback: "there" }, { from: "fixed", text: "20% off" }] };

  it("fillBlanks uses the first name, the fallback when there is none, and trims to 60 characters", () => {
    expect(fillBlanks(blanks, { name: "ada obi" })).toEqual({ body: ["Ada", "20% off"] });
    expect(fillBlanks(blanks, { name: null })).toEqual({ body: ["there", "20% off"] });
    expect(fillBlanks(blanks, { name: "   " })).toEqual({ body: ["there", "20% off"] });
    expect(fillBlanks(blanks, { name: "@ada_juice" })).toEqual({ body: ["there", "20% off"] });
    expect(fillBlanks(blanks, { name: "0803 555 0100" })).toEqual({ body: ["there", "20% off"] });
    const long = "x".repeat(200);
    expect(fillBlanks({ body: [{ from: "fixed", text: long }] }, { name: null }).body[0]).toHaveLength(60);
    expect(fillBlanks({ body: [{ from: "full_name", fallback: "friend" }] }, { name: "  Ada \n Obi\t" })).toEqual({ body: ["Ada Obi"] });
    expect(fillBlanks({ body: [{ from: "full_name", fallback: "friend" }] }, { name: "@handle" })).toEqual({ body: ["friend"] });
    expect(fillBlanks({ body: [], header: { from: "first_name", fallback: "there" } }, { name: "Chi" })).toEqual({ body: [], header: "Chi" });
  });

  it("fillBlanks never returns undefined, null or a literal {{1}} for a missing field", () => {
    for (const name of [null, "", "undefined", "null", "NaN", "  ", "@x"]) {
      const out = fillBlanks(blanks, { name });
      expect(out.body[0]).toBe("there");
      expect(JSON.stringify(out)).not.toMatch(/undefined|null|\{\{/i);
    }
  });

  it("defaultBlanks: blank 1 is the first name with “there”, every other blank is empty and blocks confirming", () => {
    const needs = templateNeeds(promo([], "Hi {{1}}, {{2}} until {{3}}. Reply STOP to stop."), "MARKETING");
    const d = defaultBlanks(needs);
    expect(d.body).toEqual([{ from: "first_name", fallback: "there" }, { from: "fixed", text: "" }, { from: "fixed", text: "" }]);
    expect(blanksProblem(d, needs)).toBe("Fill in every blank.");
    d.body[1] = { from: "fixed", text: "20% off" };
    d.body[2] = { from: "fixed", text: "Friday" };
    expect(blanksProblem(d, needs)).toBeNull();
  });

  it("blanksProblem refuses the wrong number of blanks, an empty fallback, a typed {{1}} and a missing link ending", () => {
    const needs = templateNeeds(promo(), "MARKETING");
    expect(blanksProblem({ body: [] }, needs)).toBe("Fill in every blank.");
    expect(blanksProblem({ body: [{ from: "first_name", fallback: " " }] }, needs)).toBe("Fill in every blank.");
    expect(blanksProblem({ body: [{ from: "fixed", text: "{{1}}" }] }, needs)).toBe("Fill in every blank.");
    expect(blanksProblem({ body: [{ from: "fixed", text: "undefined" }] }, needs)).toBe("Fill in every blank.");
    const withLink = templateNeeds(promo([{ type: "BUTTONS", buttons: [{ type: "URL", text: "Order", url: "https://example.com/{{1}}" }] }]), "MARKETING");
    const ok: BroadcastBlanks = { body: [{ from: "first_name", fallback: "there" }] };
    expect(blanksProblem(ok, withLink)).toBe("Fill in every blank.");
    expect(blanksProblem({ ...ok, buttons: [{ index: 0, text: "menu" }] }, withLink)).toBeNull();
    const withHeading = templateNeeds([{ type: "HEADER", format: "TEXT", text: "News for {{1}}" }, ...promo()], "MARKETING");
    expect(blanksProblem(ok, withHeading)).toBe("Fill in every blank.");
    expect(blanksProblem({ ...ok, header: { from: "first_name", fallback: "you" } }, withHeading)).toBeNull();
  });

  it("valuesProblem is the last check before sending: no empty value, no {{1}}, no “undefined”, the right count", () => {
    const needs = templateNeeds(promo(), "MARKETING");
    expect(valuesProblem({ body: ["Ada"] }, needs)).toBeNull();
    expect(valuesProblem(null, needs)).not.toBeNull();
    expect(valuesProblem({ body: [] }, needs)).not.toBeNull();
    expect(valuesProblem({ body: ["Ada", "extra"] }, needs)).not.toBeNull();
    expect(valuesProblem({ body: [""] }, needs)).not.toBeNull();
    expect(valuesProblem({ body: ["{{1}}"] }, needs)).not.toBeNull();
    expect(valuesProblem({ body: ["undefined"] }, needs)).not.toBeNull();
    expect(valuesProblem({ body: [undefined as unknown as string] }, needs)).not.toBeNull();
  });

  it("readBlanks drops anything that is not the expected shape", () => {
    expect(readBlanks(null)).toEqual({ body: [] });
    expect(readBlanks({ body: [{ from: "fixed", text: "a" }, { from: "order_total" }, 5], header: { from: "x" }, buttons: [{ index: 0, text: "m" }, { index: "0" }] })).toEqual({
      body: [{ from: "fixed", text: "a" }],
      buttons: [{ index: 0, text: "m" }],
    });
  });
});

describe("which templates can be broadcast", () => {
  const base = { status: "APPROVED", category: "MARKETING", qualityScore: "GREEN", reviewInfo: null };

  it("an approved promotion that says how to stop is usable", () => {
    expect(templateBroadcastUse({ ...base, components: promo() })).toMatchObject({ usable: true, why_not: null, has_stop_wording: true });
  });

  it("a promotion with no STOP wording is not usable, with the reason", () => {
    const use = templateBroadcastUse({ ...base, components: [{ type: "BODY", text: "Hello {{1}}, fresh juice." }] });
    expect(use.usable).toBe(false);
    expect(use.why_not).toMatch(/does not tell people how to stop/);
    // The word inside another word does not count; a STOP quick-reply button does.
    expect(hasStopWording([{ type: "BODY", text: "Our nonstop offers" }])).toBe(false);
    expect(hasStopWording([{ type: "BODY", text: "Hi" }, { type: "FOOTER", text: "Reply stop to opt out" }])).toBe(true);
    expect(hasStopWording([{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop promotions" }] }])).toBe(true);
    expect(hasStopWording([{ type: "BODY", text: "Hi" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Tell me more" }] }])).toBe(false);
  });

  it("an update (UTILITY) template does not need STOP wording", () => {
    expect(templateBroadcastUse({ ...base, category: "UTILITY", components: [{ type: "BODY", text: "Your order {{1}} is ready." }] }).usable).toBe(true);
  });

  it("not approved, the wrong category, paused and low quality are each refused in plain words", () => {
    expect(templateBroadcastUse({ ...base, status: "PAUSED", components: promo() }).why_not).toBe("WhatsApp has not approved this template.");
    expect(templateBroadcastUse({ ...base, status: "PENDING", components: promo() }).usable).toBe(false);
    expect(templateBroadcastUse({ ...base, category: "AUTHENTICATION", components: promo() }).why_not).toBe("Only promotion and update templates can be broadcast.");
    expect(templateBroadcastUse({ ...base, reviewInfo: { pause: { title: "Paused" } }, components: promo() }).why_not).toBe("WhatsApp has paused this template.");
    expect(templateBroadcastUse({ ...base, qualityScore: "RED", components: promo() }).why_not).toBe("WhatsApp rates this template as low quality.");
  });

  it("a template that needs something the broadcast send cannot supply is refused: a form button, a carousel, a video or document heading", () => {
    const form = promo([{ type: "BUTTONS", buttons: [{ type: "FLOW", text: "Book", flow_id: "123" }] }]);
    expect(templateBroadcastUse({ ...base, components: form }).why_not).toBe("This template has a part broadcasts can't send yet.");
    expect(templateBroadcastUse({ ...base, components: promo([{ type: "CAROUSEL" }]) }).why_not).toBe("This template has a part broadcasts can't send yet.");
    expect(templateBroadcastUse({ ...base, components: [{ type: "HEADER", format: "VIDEO" }, ...promo()] }).why_not).toBe("Broadcasts can only carry a picture heading for now.");
    expect(templateBroadcastUse({ ...base, components: [{ type: "HEADER", format: "DOCUMENT" }, ...promo()] }).usable).toBe(false);
    expect(templateBroadcastUse({ ...base, components: [{ type: "HEADER", format: "IMAGE" }, ...promo()] }).usable).toBe(true);
  });
});

describe("wording", () => {
  it("plainFailure and STOP_REASON_TEXT have wording for every code and reason in the spec", () => {
    expect(plainFailure("131026")).toBe("Not on WhatsApp, or their WhatsApp is out of date");
    expect(plainFailure("131049")).toBe("WhatsApp held it back: they have had enough promotions lately");
    expect(plainFailure("131050")).toBe("They have switched off promotions from us in WhatsApp");
    expect(plainFailure("130472")).toBe("WhatsApp left them out as part of its own test");
    expect(plainFailure("131062")).toBe("They hide their number, and WhatsApp can't deliver this kind of message to them");
    expect(plainFailure("132015")).toBe("WhatsApp paused the template");
    expect(plainFailure("132016")).toBe("WhatsApp paused the template");
    expect(plainFailure("131042")).toBe("WhatsApp could not take payment");
    expect(plainFailure("99999")).toBe("WhatsApp refused it (code 99999)");
    expect(plainFailure(null)).toBe("It did not go");
    for (const reason of STOP_REASONS) expect(STOP_REASON_TEXT[reason], reason).toBeTruthy();
    expect(Object.keys(STOP_REASON_TEXT).sort()).toEqual([...STOP_REASONS].sort());
  });

  it("every skip reason has wording, and “recent” carries the owner's gap", () => {
    for (const reason of SKIP_REASONS) expect(SKIP_REASON_TEXT[reason], reason).toBeTruthy();
    expect(skipReasonText("recent", 7)).toBe("Got a broadcast in the last 7 days");
    expect(skipReasonText("no_consent", 7)).toBe("Has not agreed to promotions on WhatsApp");
    expect(skipReasonText("something_new", 7)).toBe("Left out");
  });
});
