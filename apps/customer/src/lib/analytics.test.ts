import { describe, expect, it } from "vitest";
import {
  analyticsEnabled,
  contactKind,
  gaHeadScripts,
  leadParams,
  resetLeadTracking,
  trackLeadOnce,
} from "./analytics";

describe("analytics (F5)", () => {
  it("stays off until a real Measurement ID is set", () => {
    expect(analyticsEnabled("")).toBe(false);
    expect(analyticsEnabled("UA-123")).toBe(false);
    expect(gaHeadScripts("")).toEqual([]);
    expect(analyticsEnabled("G-ABC123XYZ")).toBe(true);
  });

  it("loads gtag with the configured ID", () => {
    const [loader, init] = gaHeadScripts("G-ABC123XYZ");
    expect(loader!.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ");
    expect(init!.children).toContain("gtag('config','G-ABC123XYZ')");
  });

  it("classifies WhatsApp and phone links, and nothing else", () => {
    expect(contactKind("https://wa.me/2349019512246?text=hi")).toBe("whatsapp_click");
    expect(contactKind("https://api.whatsapp.com/send?phone=234")).toBe("whatsapp_click");
    expect(contactKind("tel:+2349019512246")).toBe("phone_click");
    expect(contactKind("/juices")).toBeNull();
    expect(contactKind("https://example.com/wa.me/")).toBeNull();
    expect(contactKind(null)).toBeNull();
  });

  it("generate_lead params name the form and page, never what was typed", () => {
    expect(leadParams("bulk_order", "events", "/events-juice-lagos")).toEqual({
      enquiry_type: "bulk_order",
      lead_source: "events",
      page_path: "/events-juice-lagos",
    });
  });

  it("counts a lead once per form per page", () => {
    resetLeadTracking();
    expect(trackLeadOnce("bulk_order", "events", "/events-juice-lagos")).toBe(true);
    expect(trackLeadOnce("bulk_order", "events", "/events-juice-lagos")).toBe(false);
    expect(trackLeadOnce("bulk_order", "gifts", "/gifts")).toBe(true);
  });
});
