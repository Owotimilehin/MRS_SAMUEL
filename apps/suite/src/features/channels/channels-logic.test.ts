import { describe, expect, it } from "vitest";
import {
  connectReady,
  statusOf,
  connectedToText,
  connectedToast,
  emptySelection,
  healthDotOf,
  secondLine,
  toggleBox,
  usedForText,
} from "./channels-logic.js";

describe("healthDotOf (Watchdog)", () => {
  const base = { since: "", checked_at: "", impact: "x" };
  const items = [
    { ...base, key: "token", kind: "token" as const, label: "Meta access key", line_ids: ["a", "b"], status: "ok" as const, reason: "Fine." },
    { ...base, key: "line:b", kind: "whatsapp_number" as const, label: "WhatsApp B", line_ids: ["b"], status: "broken" as const, reason: "Banned." },
  ];
  it("is green for a checked row with no problem", () => {
    expect(healthDotOf(items, "a")).toEqual({ status: "ok", text: "Meta check: working", why: null });
  });
  it("is red with the reason for a broken row", () => {
    expect(healthDotOf(items, "b")).toEqual({ status: "broken", text: "Meta check: broken", why: "Banned." });
  });
  it("shows nothing for a row that was not checked, or before the first check", () => {
    expect(healthDotOf(items, "zzz")).toBeNull();
    expect(healthDotOf(undefined, "a")).toBeNull();
  });
});

describe("channel rows", () => {
  it("usedForText for each kind", () => {
    expect(usedForText({ kind: "phone", channels: "both" })).toBe("WhatsApp and calls");
    expect(usedForText({ kind: "phone", channels: "voice" })).toBe("Calls only");
    expect(usedForText({ kind: "phone", channels: "whatsapp" })).toBe("WhatsApp only");
    expect(usedForText({ kind: "messenger", channels: "whatsapp" })).toBe("Facebook Messenger");
    expect(usedForText({ kind: "instagram", channels: "whatsapp" })).toBe("Instagram messages");
  });

  it("secondLine for each kind", () => {
    expect(secondLine({ kind: "phone", channels: "both", e164: "+2348031234567", external_name: null })).toBe("+234 803 123 4567");
    expect(secondLine({ kind: "messenger", channels: "whatsapp", e164: null, external_name: "Mrs Samuel fruit juice" })).toBe(
      "Facebook Page: Mrs Samuel fruit juice",
    );
    expect(secondLine({ kind: "instagram", channels: "whatsapp", e164: null, external_name: "mrs_samuelfruitjuice" })).toBe(
      "Instagram: @mrs_samuelfruitjuice",
    );
  });

  it("says what an account is connected to in the edit dialog", () => {
    expect(connectedToText({ kind: "messenger", external_name: "Mrs Samuel fruit juice" })).toBe(
      "Connected to Facebook Page: Mrs Samuel fruit juice",
    );
    expect(connectedToText({ kind: "instagram", external_name: "ms" })).toBe("Connected to Instagram: @ms");
  });
});

describe("connect dialog", () => {
  it("connectReady is false until a box is ticked and names are filled", () => {
    let sel = emptySelection();
    expect(connectReady(sel)).toBe(false);
    sel = toggleBox(sel, "1001", "messenger", true);
    expect(connectReady(sel)).toBe(true);
    sel = { ...sel, labels: { ...sel.labels, messenger: "  " } };
    expect(connectReady(sel)).toBe(false);
    sel = { ...sel, labels: { ...sel.labels, messenger: "Facebook" } };
    sel = toggleBox(sel, "1001", "instagram", true);
    expect(connectReady(sel)).toBe(true);
    sel = { ...sel, labels: { ...sel.labels, instagram: "x".repeat(61) } };
    expect(connectReady(sel)).toBe(false);
  });

  it("only one Page per run: ticking another Page's box unticks the first", () => {
    let sel = toggleBox(emptySelection(), "1001", "messenger", true);
    sel = toggleBox(sel, "1001", "instagram", true);
    sel = toggleBox(sel, "1002", "messenger", true);
    expect(sel).toMatchObject({ pageId: "1002", messenger: true, instagram: false });
    sel = toggleBox(sel, "1002", "messenger", false);
    expect(sel).toMatchObject({ pageId: null, messenger: false, instagram: false });
  });

  it("joins the connected names for the toast", () => {
    expect(connectedToast(["Facebook", "Instagram"])).toBe("Connected: Facebook and Instagram.");
    expect(connectedToast(["Facebook"])).toBe("Connected: Facebook.");
  });
});

describe("statusOf (spec 02, 7.6)", () => {
  const base = { kind: "messenger" as const, is_active: true, webhook_subscribed_at: "2026-11-19T10:00:00Z", problem_text: null };
  it("says whether a Page or Instagram account is receiving messages", () => {
    expect(statusOf(base)).toEqual({ tone: "success", text: "On · receiving messages", detail: null });
    expect(statusOf({ ...base, webhook_subscribed_at: null })).toEqual({ tone: "warning", text: "On · not receiving messages yet", detail: null });
    expect(statusOf({ ...base, problem_text: "Meta says no." })).toEqual({ tone: "danger", text: "Problem", detail: "Meta says no." });
    expect(statusOf({ ...base, is_active: false })).toEqual({ tone: "off", text: "Switched off", detail: null });
  });
  it("phone lines stay plain On", () => {
    expect(statusOf({ kind: "phone", is_active: true, webhook_subscribed_at: null, problem_text: null }).text).toBe("On");
  });
});
