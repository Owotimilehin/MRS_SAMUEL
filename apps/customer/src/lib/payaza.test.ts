import { describe, it, expect } from "vitest";
import {
  interpretPayazaResponse,
  payazaNames,
  isPayazaPopupVisible,
  sdkRetryDelayMs,
  payazaFailureMessage,
  readConnectionInfo,
} from "./payaza";

describe("isPayazaPopupVisible", () => {
  it("returns false during SSR / when there is no document", () => {
    // The watchdog polls this; it must be safe to call with no DOM (node/SSR).
    expect(isPayazaPopupVisible()).toBe(false);
  });
});

describe("sdkRetryDelayMs", () => {
  it("backs off between SDK load retries (increasing, positive delays)", () => {
    // The Payaza CDN bundle intermittently fails on flaky mobile networks; the
    // loader retries with a growing delay rather than giving up on the first miss.
    const first = sdkRetryDelayMs(0);
    const second = sdkRetryDelayMs(1);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });
});

describe("payazaFailureMessage", () => {
  it("gives a distinct, non-empty customer message per failure reason", () => {
    const load = payazaFailureMessage("sdk_load_failed");
    const popup = payazaFailureMessage("popup_not_visible");
    expect(load).toBeTruthy();
    expect(popup).toBeTruthy();
    expect(load).not.toBe(popup);
  });

  it("keeps Payaza's own message for an sdk_error when provided", () => {
    expect(payazaFailureMessage("sdk_error", "'last_name' cannot be blank")).toBe(
      "'last_name' cannot be blank",
    );
  });

  it("falls back to a generic message for an sdk_error with no detail", () => {
    expect(payazaFailureMessage("sdk_error")).toBeTruthy();
  });
});

describe("readConnectionInfo", () => {
  it("returns null when the Network Information API is unavailable (node/SSR/iOS)", () => {
    // navigator has no `connection` in node; must not throw and must return null.
    expect(readConnectionInfo()).toBeNull();
  });
});

describe("interpretPayazaResponse", () => {
  it("treats an explicit success as paid", () => {
    expect(interpretPayazaResponse({ type: "success", status: 201, data: {} })).toEqual({
      paid: true,
      errorMessage: null,
    });
  });

  it("surfaces a validation error message instead of reporting paid", () => {
    // This is the real-world failure: the SDK fires the SAME callback for errors,
    // so the launcher must NOT treat an error as a completed payment.
    const res = {
      type: "error",
      status: 400,
      data: { message: "Error during validation", errors: [{ field: "last_name", errors: ["'last_name' cannot be blank"] }] },
    };
    const out = interpretPayazaResponse(res);
    expect(out.paid).toBe(false);
    expect(out.errorMessage).toMatch(/last_name/i);
  });

  it("surfaces error-client responses too", () => {
    const out = interpretPayazaResponse({ type: "error-client", data: { message: "Merchant key invalid" } });
    expect(out.paid).toBe(false);
    expect(out.errorMessage).toBe("Merchant key invalid");
  });

  it("ignores non-terminal responses (copy/info/action) — neither paid nor error", () => {
    expect(interpretPayazaResponse({ type: "copy", data: {} })).toEqual({ paid: false, errorMessage: null });
    expect(interpretPayazaResponse({ type: "action", data: { data: "loaded-data" } })).toEqual({
      paid: false,
      errorMessage: null,
    });
  });

  it("falls back to a generic message when an error carries no detail", () => {
    const out = interpretPayazaResponse({ type: "error" });
    expect(out.paid).toBe(false);
    expect(out.errorMessage).toBeTruthy();
  });
});

describe("payazaNames", () => {
  it("keeps a real first and last name", () => {
    expect(payazaNames({ firstName: "Adaeze", lastName: "Okeke" })).toEqual({
      firstName: "Adaeze",
      lastName: "Okeke",
    });
  });

  it("fills a non-blank last name for single-word names (the SDK rejects blank last_name)", () => {
    // "Adaeze" alone → lastName would be "" → SDK validation fails → popup never opens.
    expect(payazaNames({ firstName: "Adaeze", lastName: "" })).toEqual({
      firstName: "Adaeze",
      lastName: "Adaeze",
    });
    expect(payazaNames({ firstName: "Adaeze" })).toEqual({
      firstName: "Adaeze",
      lastName: "Adaeze",
    });
  });

  it("never returns blanks even when nothing is provided", () => {
    const out = payazaNames({});
    expect(out.firstName.trim()).not.toBe("");
    expect(out.lastName.trim()).not.toBe("");
  });
});
