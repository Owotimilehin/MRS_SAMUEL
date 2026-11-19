import { describe, it, expect } from "vitest";
import {
  WA_PROFILE_LIMITS,
  changedWaFields,
  diffWaProfile,
  normaliseWaProfile,
  validateWaProfile,
  type WaProfileFields,
} from "./whatsapp-profile.js";

const ok = (over: Partial<WaProfileFields> = {}): WaProfileFields => ({
  about: "Fresh juice, made daily in Lagos",
  address: "1 Allen Avenue, Ikeja, Lagos",
  description: "We press every juice to order.\nOrder by message.",
  email: "hello@mrssamuel.com",
  websites: ["https://www.mrssamuel.com", "https://instagram.com/mrs_samuelfruitjuice"],
  vertical: "RESTAURANT",
  ...over,
});

describe("validateWaProfile", () => {
  it("accepts a full valid profile", () => {
    expect(validateWaProfile(ok())).toEqual({});
    expect(validateWaProfile(ok({ email: "", websites: [], vertical: "" }))).toEqual({});
    expect(validateWaProfile(ok({ about: "a".repeat(WA_PROFILE_LIMITS.about) }))).toEqual({});
  });

  it("refuses about over 139 characters and counts an emoji as one", () => {
    expect(validateWaProfile(ok({ about: "a".repeat(140) })).about).toBe("Keep this to 139 characters or fewer.");
    // 139 characters, one of them an emoji (two UTF-16 units): fine in the browser.
    const edge = "a".repeat(138) + "😀";
    expect([...edge].length).toBe(139);
    expect(validateWaProfile(ok({ about: edge })).about).toBeUndefined();
    // The server also counts UTF-16 units (rule 2), so it refuses the same text.
    expect(validateWaProfile(ok({ about: edge }), { utf16: true }).about).toBe("Keep this to 139 characters or fewer.");
    expect(validateWaProfile(ok({ address: "a".repeat(257) })).address).toBe("Keep the address to 256 characters or fewer.");
    expect(validateWaProfile(ok({ description: "a".repeat(513) })).description).toBe(
      "Keep the description to 512 characters or fewer.",
    );
  });

  it("refuses a third website and a website without http", () => {
    expect(validateWaProfile(ok({ websites: ["https://a.com", "https://b.com", "https://c.com"] })).websites).toBe(
      "WhatsApp allows two websites at most.",
    );
    expect(validateWaProfile(ok({ websites: ["mrssamuel.com"] })).websites).toBe("Start the website with https://");
    expect(validateWaProfile(ok({ websites: ["http://a.com"] })).websites).toBeUndefined();
    expect(validateWaProfile(ok({ websites: ["https://a.com/" + "x".repeat(260)] })).websites).toBe(
      "Keep each website to 256 characters or fewer.",
    );
  });

  it("refuses a bad email", () => {
    for (const email of ["hello", "a@b", "a b@c.com", "@c.com", `${"a".repeat(125)}@b.co`]) {
      expect(validateWaProfile(ok({ email })).email, email).toBe("That does not look like an email address.");
    }
  });

  it("allows only listed business types, or the one already on the profile", () => {
    expect(validateWaProfile(ok({ vertical: "SPACESHIPS" })).vertical).toBe("Choose a type of business from the list.");
    expect(validateWaProfile(ok({ vertical: "UNDEFINED" })).vertical).toBe("Choose a type of business from the list.");
    expect(validateWaProfile(ok({ vertical: "UNDEFINED" }), { keepVertical: "UNDEFINED" }).vertical).toBeUndefined();
    expect(validateWaProfile(ok({ vertical: "ALCOHOL" })).vertical).toBeUndefined();
  });
});

describe("normaliseWaProfile", () => {
  it("normalise trims, drops empty websites and moves the second website up", () => {
    const n = normaliseWaProfile({
      about: "  Fresh\njuice  ",
      address: "  1 Allen\nAvenue ",
      description: " Line one\nLine two ",
      email: " hello@mrssamuel.com ",
      websites: ["  ", " https://b.com "],
      vertical: " RESTAURANT ",
    });
    expect(n).toEqual({
      about: "Fresh juice",
      address: "1 Allen\nAvenue",
      description: "Line one\nLine two",
      email: "hello@mrssamuel.com",
      websites: ["https://b.com"],
      vertical: "RESTAURANT",
    });
  });
});

describe("diffWaProfile", () => {
  it("diff lists only changed fields with labels", () => {
    const before = ok();
    const after = ok({ about: "New line", websites: ["https://www.mrssamuel.com"], vertical: "GROCERY" });
    const rows = diffWaProfile(before, after);
    expect(rows.map((r) => r.field)).toEqual(["about", "websites", "vertical"]);
    expect(rows[0]).toEqual({ field: "about", label: "About", before: "Fresh juice, made daily in Lagos", after: "New line" });
    expect(rows[1]!.before).toBe("https://www.mrssamuel.com\nhttps://instagram.com/mrs_samuelfruitjuice");
    expect(rows[1]!.after).toBe("https://www.mrssamuel.com");
    expect(rows[2]).toMatchObject({ label: "Type of business", before: "Restaurant", after: "Food and grocery" });
    expect(diffWaProfile(before, ok())).toEqual([]);
    expect(changedWaFields(before, after)).toEqual(["about", "websites", "vertical"]);
  });

  it("ignores spacing differences that tidying removes", () => {
    expect(diffWaProfile(ok(), ok({ about: "  Fresh juice, made daily in Lagos " }))).toEqual([]);
  });
});
