import { describe, expect, it } from "vitest";
import { ADS_SETTINGS_DEFAULT } from "@ms/db";
import { buildPurchaseEvent, capiAllowed, redactPurchaseEvent } from "./ads-attribution.js";

describe("buildPurchaseEvent", () => {
  const event = buildPurchaseEvent({
    channel: "whatsapp",
    wabaId: "100200300400500",
    ctwaClid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a",
    valueNgn: 12500,
    at: new Date(1763550000_500),
  });
  it("exact shape; contains no phone, name or email", () => {
    expect(event).toEqual({
      data: [
        {
          event_name: "Purchase",
          event_time: 1763550000,
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: {
            whatsapp_business_account_id: "100200300400500",
            ctwa_clid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a",
          },
          custom_data: { currency: "NGN", value: 12500 },
        },
      ],
    });
    const d = (event.data as Record<string, unknown>[])[0]!;
    expect(Object.keys(d).sort()).toEqual(["action_source", "custom_data", "event_name", "event_time", "messaging_channel", "user_data"]);
    expect(Object.keys(d.user_data as object).sort()).toEqual(["ctwa_clid", "whatsapp_business_account_id"]);
    expect(Object.keys(d.custom_data as object).sort()).toEqual(["currency", "value"]);
    const text = JSON.stringify(event).toLowerCase();
    for (const banned of ["phone", "\"ph\"", "\"em\"", "email", "\"fn\"", "\"ln\"", "\"name\"", "first_name", "address", "order_id", "contents", "external_id", "partner_agent"]) {
      expect(text).not.toContain(banned);
    }
  });
  it("the log copy keeps only the first 6 characters of the click ID", () => {
    const red = redactPurchaseEvent(event);
    expect(JSON.stringify(red)).toContain('"ctwa_clid":"ARAkLk…"');
    expect(JSON.stringify(red)).not.toContain("ARAkLkA8");
    // The original is untouched.
    expect(JSON.stringify(event)).toContain("ARAkLkA8rmlFei");
  });
});

describe("capiAllowed", () => {
  it("off by default, and off without the owner's privacy statement on record", () => {
    expect(capiAllowed(ADS_SETTINGS_DEFAULT)).toBe(false);
    expect(capiAllowed({ ...ADS_SETTINGS_DEFAULT, capi_enabled: true })).toBe(false);
    expect(capiAllowed({ ...ADS_SETTINGS_DEFAULT, capi_enabled: true, capi_privacy_confirmed_at: "2026-11-20T08:00:00.000Z" })).toBe(false);
    expect(
      capiAllowed({ ...ADS_SETTINGS_DEFAULT, capi_enabled: true, capi_privacy_confirmed_at: "2026-11-20T08:00:00.000Z", capi_privacy_confirmed_by: "u1" }),
    ).toBe(true);
    expect(
      capiAllowed({ ...ADS_SETTINGS_DEFAULT, capi_enabled: false, capi_privacy_confirmed_at: "2026-11-20T08:00:00.000Z", capi_privacy_confirmed_by: "u1" }),
    ).toBe(false);
  });
});
