import { describe, it, expect } from "vitest";
import { headerMediaLabel, templateNeeds } from "./inbox-templates.js";
import { closedSince } from "./inbox.js";

// The four sample templates Meta gives every new WhatsApp account, in the
// shape GET /{waba}/message_templates returns them.
const HELLO_WORLD = [
  { type: "HEADER", format: "TEXT", text: "Hello World" },
  {
    type: "BODY",
    text: "Welcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.",
  },
  { type: "FOOTER", text: "WhatsApp Business Platform sample message" },
];
const PLAIN_TEXT = [
  {
    type: "BODY",
    text: "Great news! Your next order at Jasper's Market is 20% off. Just show this message in store.",
  },
];
const IMAGE_CTA = [
  { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/t61/sample.jpg"] } },
  { type: "BODY", text: "Free delivery for all online orders with Jasper's Market" },
  { type: "FOOTER", text: "Free delivery on orders over $20" },
  { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://www.jaspersmarket.com/" }] },
];
const MEDIA_CAROUSEL = [
  { type: "BODY", text: "Rare succulents for sale! Shop now and add some unique and beautiful plants to your collection." },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Unsubscribe" }] },
  {
    type: "CAROUSEL",
    cards: [
      {
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/t61/card1.jpg"] } },
          { type: "BODY", text: "Add a touch of elegance to your collection with the beautiful Aloe 'Blue Elf' succulent." },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop", url: "https://www.jaspersmarket.com/blue-elf" }] },
        ],
      },
      {
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/t61/card2.jpg"] } },
          { type: "BODY", text: "The Crassula Buddha's Temple is sure to be a conversation starter." },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop", url: "https://www.jaspersmarket.com/buddha" }] },
        ],
      },
    ],
  },
];

describe("templateNeeds — Meta's sample templates", () => {
  it("hello_world: fixed text heading, nothing to fill", () => {
    expect(templateNeeds(HELLO_WORLD, "UTILITY")).toEqual({
      sendable: true,
      reason: null,
      bodyParams: 0,
      headerText: "Hello World",
      headerParams: 0,
      headerMedia: null,
      urlButtons: [],
      footerText: "WhatsApp Business Platform sample message",
      buttonLabels: [],
      // No form button (suite spec 07 added this field; empty by default).
      flowButtons: [],
    });
  });
  it("jaspers_market_plain_text_v1: body only", () => {
    const n = templateNeeds(PLAIN_TEXT, "MARKETING");
    expect(n).toMatchObject({ sendable: true, bodyParams: 0, headerMedia: null, headerParams: 0, urlButtons: [] });
  });
  it("jaspers_market_image_cta_v1: needs a picture; its fixed link button needs nothing", () => {
    const n = templateNeeds(IMAGE_CTA, "MARKETING");
    expect(n).toMatchObject({ sendable: true, headerMedia: "image", headerParams: 0, urlButtons: [], buttonLabels: ["Shop now"] });
  });
  it("jaspers_market_media_carousel_v1: can't be sent, and says why in plain words", () => {
    const n = templateNeeds(MEDIA_CAROUSEL, "MARKETING");
    expect(n.sendable).toBe(false);
    expect(n.reason).toBe("This template has a carousel, which the inbox can't send yet");
  });
});

describe("templateNeeds — blanks", () => {
  it("counts body blanks by the highest number", () => {
    expect(templateNeeds([{ type: "BODY", text: "Hi {{1}}, your order {{2}} is ready. Thanks {{1}}!" }]).bodyParams).toBe(2);
  });
  it("finds the blank in a text heading", () => {
    const n = templateNeeds([
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["A123"] } },
      { type: "BODY", text: "Hi {{1}}" },
    ]);
    expect(n).toMatchObject({ sendable: true, headerText: "Order {{1}}", headerParams: 1, bodyParams: 1 });
  });
  it("video and document headings need that kind of file", () => {
    expect(templateNeeds([{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "x" }]).headerMedia).toBe("video");
    expect(templateNeeds([{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "x" }]).headerMedia).toBe("document");
    expect(headerMediaLabel("image")).toBe("picture");
    expect(headerMediaLabel("document")).toBe("document");
  });
  it("finds link buttons with a blank, keeping each button's position", () => {
    const n = templateNeeds([
      { type: "BODY", text: "Track your order" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Stop" },
          { type: "PHONE_NUMBER", text: "Call us", phone_number: "+2348000000000" },
          { type: "URL", text: "Track", url: "https://shop.example/track/{{1}}", example: ["https://shop.example/track/abc"] },
          { type: "URL", text: "Website", url: "https://shop.example/" },
        ],
      },
    ]);
    expect(n.sendable).toBe(true);
    expect(n.urlButtons).toEqual([{ index: 2, text: "Track", url: "https://shop.example/track/{{1}}" }]);
    expect(n.buttonLabels).toEqual(["Stop", "Call us", "Track", "Website"]);
  });
});

describe("templateNeeds — what the inbox can't send", () => {
  const body = { type: "BODY", text: "x" };
  const reason = (components: unknown[], category?: string): string | null => templateNeeds(components, category).reason;

  it("refuses each unsupported part with a plain reason", () => {
    expect(reason([{ type: "HEADER", format: "LOCATION" }, body])).toBe("This template has a map location, which the inbox can't send yet");
    expect(reason([body, { type: "LIMITED_TIME_OFFER", limited_time_offer: { text: "Ends soon", has_expiration: true } }])).toBe(
      "This template has a limited-time offer, which the inbox can't send yet",
    );
    expect(reason([body, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAVE20" }] }])).toBe(
      "This template has a copy-code button, which the inbox can't send yet",
    );
    expect(reason([body, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }])).toBe(
      "This template is a login-code message, which the inbox can't send yet",
    );
    expect(reason([body, { type: "BUTTONS", buttons: [{ type: "CATALOG", text: "View catalog" }] }])).toBe(
      "This template shows the product catalogue, which the inbox can't send yet",
    );
    expect(reason([body, { type: "BUTTONS", buttons: [{ type: "MPM", text: "View items" }] }])).toBe(
      "This template shows a list of products, which the inbox can't send yet",
    );
  });
  it("refuses login-code templates by category", () => {
    expect(reason([{ type: "BODY", add_security_recommendation: true }], "AUTHENTICATION")).toBe(
      "This template is a login-code message, which the inbox can't send yet",
    );
  });
  it("refuses named blanks and anything it does not recognise", () => {
    expect(reason([{ type: "BODY", text: "Hi {{first_name}}" }])).toBe("This template uses named blanks, which the inbox can't send yet");
    expect(reason([body, { type: "SOMETHING_NEW" }])).toBe("This template has a part the inbox doesn't recognise, which the inbox can't send yet");
    expect(reason([body, { type: "BUTTONS", buttons: [{ type: "BRAND_NEW" }] }])).toBe(
      "This template has a button the inbox doesn't recognise, which the inbox can't send yet",
    );
    expect(reason([body, "junk"])).toContain("doesn't recognise");
  });
  it("copes with missing or empty components", () => {
    expect(templateNeeds(null).sendable).toBe(true);
    expect(templateNeeds([]).bodyParams).toBe(0);
  });
});

describe("templateNeeds — a button that opens a form (suite spec 07)", () => {
  const body = { type: "BODY", text: "Tap the button to tell us your delivery address." };
  const flow = (text: string, flow_id?: unknown) => ({ type: "FLOW", text, ...(flow_id === undefined ? {} : { flow_id }), flow_action: "navigate", navigate_screen: "ADDRESS" });

  it("a template with one FLOW button is sendable and reports flowButtons; two FLOW buttons are not", () => {
    const one = templateNeeds([body, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Not now" }, flow("Add address", "9001")] }], "UTILITY");
    expect(one.sendable).toBe(true);
    expect(one.reason).toBeNull();
    expect(one.flowButtons).toEqual([{ index: 1, text: "Add address", flowId: "9001" }]);
    expect(one.buttonLabels).toEqual(["Not now", "Add address"]);
    expect(one.urlButtons).toEqual([]);

    const two = templateNeeds([body, { type: "BUTTONS", buttons: [flow("Add address", "9001"), flow("Report a problem", "9002")] }], "UTILITY");
    expect(two.sendable).toBe(false);
    expect(two.reason).toBe("This template has more than one form button, which the inbox can't send yet");
  });

  it("reads a numeric flow_id, and reports null when Meta did not list one", () => {
    expect(templateNeeds([body, { type: "BUTTONS", buttons: [flow("Add address", 9001)] }]).flowButtons[0]!.flowId).toBe("9001");
    expect(templateNeeds([body, { type: "BUTTONS", buttons: [flow("Add address")] }]).flowButtons).toEqual([{ index: 0, text: "Add address", flowId: null }]);
    expect(templateNeeds([body]).flowButtons).toEqual([]);
  });
});

describe("closedSince", () => {
  // Mon–Fri 08:00–18:00, Sat 09:00–13:00, Lagos time (UTC+1).
  const rules = [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, openTime: "08:00", closeTime: "18:00" })),
    { weekday: 6, openTime: "09:00", closeTime: "13:00" },
  ];
  it("is null while open", () => {
    expect(closedSince(rules, [], new Date("2026-11-17T10:00:00Z"))).toBeNull(); // Tue 11:00
  });
  it("in the evening: closed since today's closing time", () => {
    expect(closedSince(rules, [], new Date("2026-11-17T20:30:15Z"))?.toISOString()).toBe("2026-11-17T17:00:00.000Z"); // Tue 21:30
  });
  it("before opening: closed since yesterday's closing time", () => {
    expect(closedSince(rules, [], new Date("2026-11-18T05:00:00Z"))?.toISOString()).toBe("2026-11-17T17:00:00.000Z"); // Wed 06:00
  });
  it("on Sunday: closed since Saturday lunchtime", () => {
    expect(closedSince(rules, [], new Date("2026-11-22T12:00:00Z"))?.toISOString()).toBe("2026-11-21T12:00:00.000Z");
  });
  it("on a holiday: closed since the last working day", () => {
    // Tuesday 17 Nov is a holiday; at 11:00 that day the last opening was Monday.
    expect(closedSince(rules, ["2026-11-17"], new Date("2026-11-17T10:00:00Z"))?.toISOString()).toBe("2026-11-16T17:00:00.000Z");
  });
  it("between two windows on the same day: closed since the first one ended", () => {
    const split = [
      { weekday: 2, openTime: "08:00", closeTime: "12:00" },
      { weekday: 2, openTime: "14:00", closeTime: "18:00" },
    ];
    expect(closedSince(split, [], new Date("2026-11-17T12:30:00Z"))?.toISOString()).toBe("2026-11-17T11:00:00.000Z"); // Tue 13:30
  });
  it("never open in the look-back: falls back to the look-back's start", () => {
    const now = new Date("2026-11-17T10:00:00Z");
    expect(closedSince([], [], now)?.getTime()).toBe(now.getTime() - 14 * 86_400_000);
  });
});
