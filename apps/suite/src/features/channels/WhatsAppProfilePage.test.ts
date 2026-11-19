import { describe, expect, it } from "vitest";
import { connectionLabel, nameStatusLabel, qualityLabel, reachLabel } from "./WhatsAppProfilePage.js";
import { checkPhoto } from "./ProfilePhotoDialog.js";

describe("labels", () => {
  it("labels: every known name status, connection, quality and reach value has wording; unknown values fall back to the raw value", () => {
    expect(nameStatusLabel("APPROVED")).toEqual({ text: "Approved", tone: "good" });
    expect(nameStatusLabel("AVAILABLE_WITHOUT_REVIEW")).toEqual({ text: "In use, not reviewed yet", tone: "grey" });
    expect(nameStatusLabel("PENDING_REVIEW")).toEqual({ text: "Waiting for WhatsApp to review", tone: "warn" });
    expect(nameStatusLabel("DECLINED")).toEqual({ text: "Refused by WhatsApp", tone: "bad" });
    expect(nameStatusLabel("EXPIRED")).toEqual({ text: "Expired. The number must be set up again", tone: "bad" });
    expect(nameStatusLabel("NONE")).toEqual({ text: "No name on record", tone: "grey" });
    expect(nameStatusLabel("SOMETHING_NEW")).toEqual({ text: "SOMETHING_NEW", tone: "grey" });

    expect(connectionLabel("CONNECTED")).toEqual({ text: "Connected", tone: "good" });
    expect(connectionLabel(null)).toEqual({ text: "Unknown", tone: "grey" });
    expect(connectionLabel("FLAGGED")).toEqual({ text: "Not working normally (WhatsApp says: FLAGGED)", tone: "bad" });

    expect(qualityLabel("GREEN")).toEqual({ text: "Good", tone: "good" });
    expect(qualityLabel("YELLOW").tone).toBe("warn");
    expect(qualityLabel("YELLOW").text).toBe("Medium. Customers have been blocking or reporting some messages");
    expect(qualityLabel("RED")).toEqual({ text: "Low. Slow down on templates until this improves", tone: "bad" });
    for (const v of ["NA", "UNKNOWN", null, "NEW_VALUE"]) {
      expect(qualityLabel(v), String(v)).toEqual({ text: "Not rated yet", tone: "grey" });
    }

    expect(reachLabel("TIER_250")).toBe("Up to 250 new customers a day");
    expect(reachLabel("TIER_2K")).toBe("Up to 2,000 new customers a day");
    expect(reachLabel("TIER_10K")).toBe("Up to 10,000 new customers a day");
    expect(reachLabel("TIER_100K")).toBe("Up to 100,000 new customers a day");
    expect(reachLabel("TIER_UNLIMITED")).toBe("No daily limit");
    expect(reachLabel(null)).toBe("Unknown");
    expect(reachLabel("TIER_1M")).toBe("TIER_1M");
  });
});

describe("checkPhoto", () => {
  const png = (size = 1000) => ({ type: "image/png", size });
  it("blocks a wrong type, a file over 5 MB and a side under 192 px", () => {
    expect(checkPhoto({ type: "image/gif", size: 10 }, { width: 640, height: 640 }).error).toBe("Use a JPG or PNG picture.");
    expect(checkPhoto(png(5 * 1024 * 1024 + 1), { width: 640, height: 640 }).error).toBe("That picture is larger than 5 MB. Choose a smaller one.");
    expect(checkPhoto(png(), { width: 100, height: 100 }).error).toBe("That picture is too small. Use one at least 192 pixels wide and tall.");
    expect(checkPhoto(png(), { width: 640, height: 191 }).error).toBe("That picture is too small. Use one at least 192 pixels wide and tall.");
  });
  it("warns, but does not block, when the sides differ by more than 2 percent", () => {
    expect(checkPhoto(png(), { width: 640, height: 640 })).toEqual({ error: null, warning: null });
    expect(checkPhoto(png(), { width: 640, height: 630 })).toEqual({ error: null, warning: null });
    expect(checkPhoto(png(), { width: 640, height: 400 })).toEqual({
      error: null,
      warning: "This picture is not square. WhatsApp will crop it to a circle from the middle.",
    });
    expect(checkPhoto(png(), null)).toEqual({ error: null, warning: null });
  });
});
