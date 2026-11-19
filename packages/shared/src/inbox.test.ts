import { describe, it, expect } from "vitest";
import {
  toE164,
  waWindowOpen,
  waWindowRemainingMs,
  isOpenNow,
  localParts,
  messagePreview,
  channelForKind,
  isBsuid,
  channelLabel,
  CHANNEL_KINDS,
  IDENTITY_CHANNELS,
  WHATSAPP_ACCOUNT_KEY,
} from "./inbox.js";

describe("channel accounts and identities", () => {
  it("channelForKind maps phone to whatsapp and leaves the others", () => {
    expect(channelForKind("phone")).toBe("whatsapp");
    expect(channelForKind("messenger")).toBe("messenger");
    expect(channelForKind("instagram")).toBe("instagram");
  });
  it("isBsuid accepts US.123 and US.ENT.123 and rejects digits-only and empty", () => {
    expect(isBsuid("US.123")).toBe(true);
    expect(isBsuid("US.13491208655302741918")).toBe(true);
    expect(isBsuid("US.ENT.11815799212886844830")).toBe(true);
    expect(isBsuid("2347067220914")).toBe(false);
    expect(isBsuid("")).toBe(false);
    expect(isBsuid(null)).toBe(false);
    expect(isBsuid("us.123")).toBe(false);
    expect(isBsuid("US.")).toBe(false);
  });
  it("labels each channel in plain words", () => {
    expect(IDENTITY_CHANNELS.map(channelLabel)).toEqual(["WhatsApp", "Facebook Messenger", "Instagram"]);
    expect(CHANNEL_KINDS).toEqual(["phone", "messenger", "instagram"]);
    expect(WHATSAPP_ACCOUNT_KEY).toBe("global");
  });
});

describe("toE164", () => {
  it("normalises Nigerian local and international forms", () => {
    expect(toE164("0706 722 0914")).toBe("+2347067220914");
    expect(toE164("2347067220914")).toBe("+2347067220914");
    expect(toE164("+234 706 722 0914")).toBe("+2347067220914");
  });
  it("accepts foreign international numbers (WhatsApp wa_id has no +)", () => {
    expect(toE164("447700900123")).toBe("+447700900123");
    expect(toE164("+1 (415) 555-0100")).toBe("+14155550100");
  });
  it("rejects junk", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("12345")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("0123")).toBeNull();
  });
});

describe("24-hour window", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("is open just inside 24h and closed at 24h", () => {
    expect(waWindowOpen(new Date("2026-11-16T12:00:01Z"), now)).toBe(true);
    expect(waWindowOpen(new Date("2026-11-16T12:00:00Z"), now)).toBe(false);
    expect(waWindowOpen(null, now)).toBe(false);
    expect(waWindowOpen("not a date", now)).toBe(false);
  });
  it("reports remaining time", () => {
    expect(waWindowRemainingMs("2026-11-17T11:00:00Z", now)).toBe(23 * 3600_000);
    expect(waWindowRemainingMs("2026-11-15T11:00:00Z", now)).toBe(0);
  });
});

describe("business hours (Africa/Lagos, UTC+1)", () => {
  const rules = [
    { weekday: 2, openTime: "08:00", closeTime: "18:00" }, // Tuesday
    { weekday: 6, openTime: "10:00", closeTime: "14:00" }, // Saturday
  ];
  it("reads local wall-clock time", () => {
    // 2026-11-17 is a Tuesday; 07:30Z = 08:30 Lagos.
    expect(localParts(new Date("2026-11-17T07:30:00Z"), "Africa/Lagos")).toEqual({
      date: "2026-11-17",
      weekday: 2,
      minutes: 8 * 60 + 30,
    });
  });
  it("opens at open time and closes at close time", () => {
    expect(isOpenNow(rules, [], new Date("2026-11-17T06:59:00Z"))).toBe(false); // 07:59
    expect(isOpenNow(rules, [], new Date("2026-11-17T07:00:00Z"))).toBe(true); // 08:00
    expect(isOpenNow(rules, [], new Date("2026-11-17T16:59:00Z"))).toBe(true); // 17:59
    expect(isOpenNow(rules, [], new Date("2026-11-17T17:00:00Z"))).toBe(false); // 18:00
  });
  it("is closed on days with no rule and on holidays", () => {
    expect(isOpenNow(rules, [], new Date("2026-11-18T10:00:00Z"))).toBe(false); // Wednesday
    expect(isOpenNow(rules, ["2026-11-17"], new Date("2026-11-17T10:00:00Z"))).toBe(false);
  });
  it("treats an inverted window as closed", () => {
    expect(isOpenNow([{ weekday: 2, openTime: "18:00", closeTime: "08:00" }], [], new Date("2026-11-17T20:00:00Z"))).toBe(false);
  });
});

describe("messagePreview", () => {
  it("prefers body text, else a type label", () => {
    expect(messagePreview("text", "  hello ")).toBe("hello");
    expect(messagePreview("image", null)).toBe("📷 Photo");
    expect(messagePreview("weird", "")).toBe("Message");
  });
});
