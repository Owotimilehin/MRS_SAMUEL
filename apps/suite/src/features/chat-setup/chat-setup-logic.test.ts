import { describe, expect, it } from "vitest";
import { CHAT_SETUP_LIMITS, EMPTY_CHAT_SETUP, type ChatSetupConfig } from "@ms/shared";
import type { ChatSetupView } from "./chat-setup-api.js";
import { diffSetup, editorStart, moveItem, previewModel, publishBlockedReason, statusStrip } from "./chat-setup-logic.js";

const full: ChatSetupConfig = {
  greeting: "Hello {{user_first_name}}",
  getStarted: true,
  iceBreakers: ["What juices do you have today?", "Do you deliver to my area?"],
  menu: [
    { type: "postback", title: "Talk to us" },
    { type: "web_url", title: "Our shop", url: "https://www.mrssamuel.com" },
  ],
};

function view(over: Partial<ChatSetupView> = {}): ChatSetupView {
  return {
    account: { id: "11111111-1111-4111-8111-111111111111", label: "Facebook Page", kind: "messenger", is_active: true },
    supports: { greeting: true, getStarted: true, iceBreakers: true, menu: true },
    limits: CHAT_SETUP_LIMITS,
    draft: null,
    live: { config: EMPTY_CHAT_SETUP, other_locales: [], foreign_payloads: false, composer_disabled: false, read_at: "2026-11-20T13:05:00.000Z" },
    live_error: null,
    draft_differs_from_live: false,
    last_publish: null,
    can_publish_at: null,
    ...over,
  };
}

describe("diffSetup", () => {
  it("diffSetup lists only the parts that changed", () => {
    expect(diffSetup(full, full)).toEqual([]);
    const changed = diffSetup(full, { ...full, greeting: "Hi", iceBreakers: full.iceBreakers });
    expect(changed.map((r) => r.key)).toEqual(["greeting"]);
    expect(changed[0]).toMatchObject({ label: "Welcome text", now: { kind: "text", text: full.greeting }, after: { kind: "text", text: "Hi" } });

    const fromNothing = diffSetup(null, full);
    expect(fromNothing.map((r) => r.label)).toEqual(["Welcome text", "Get started button", "Starter questions", "Menu"]);
    expect(fromNothing[2]!.now).toEqual({ kind: "list", items: [] });
    expect(fromNothing[3]!.after).toEqual({ kind: "list", items: ["Talk to us", "Our shop → https://www.mrssamuel.com"] });

    // A menu switches Get started on, so removing it only is a menu change plus Get started off.
    const removed = diffSetup(full, { ...full, menu: [], getStarted: false });
    expect(removed.map((r) => r.key)).toEqual(["getStarted", "menu"]);
    // Order of questions counts; blank rows and surrounding spaces do not.
    expect(diffSetup(full, { ...full, iceBreakers: [...full.iceBreakers].reverse() }).map((r) => r.key)).toEqual(["iceBreakers"]);
    expect(diffSetup(full, { ...full, iceBreakers: [...full.iceBreakers, "  "], greeting: ` ${full.greeting} ` })).toEqual([]);
    // Instagram has no welcome text or Get started: they never show as changes.
    expect(diffSetup(null, full, "instagram").map((r) => r.key)).toEqual(["iceBreakers", "menu"]);
  });
});

describe("publishBlockedReason", () => {
  const now = new Date("2026-11-20T13:00:00.000Z");
  const base = { config: full, problems: 0, now };

  it("publishBlockedReason covers invalid, unchanged, rate-limited and unread-live", () => {
    expect(publishBlockedReason({ ...base, view: view() })).toBeNull();
    expect(publishBlockedReason({ ...base, problems: 2, view: view() })).toBe("Fix the problems above first.");
    expect(publishBlockedReason({ ...base, view: view({ live: null }) })).toBe("We need to read the live set-up first. Press Check now.");
    const unchanged = view({ live: { ...view().live!, config: full } });
    expect(publishBlockedReason({ ...base, view: unchanged })).toBe("Nothing to publish.");
    // Other languages mean publishing still changes something.
    const otherLangs = view({ live: { ...unchanged.live!, other_locales: ["fr_FR"] } });
    expect(publishBlockedReason({ ...base, view: otherLangs })).toBeNull();
    // Rate-limited: the time is shown in Lagos (UTC+1).
    const wait = view({ can_publish_at: "2026-11-20T13:07:00.000Z" });
    expect(publishBlockedReason({ ...base, view: wait })).toBe("You can publish again at 14:07.");
    expect(publishBlockedReason({ ...base, view: view({ can_publish_at: "2026-11-20T12:59:00.000Z" }) })).toBeNull();
    // A switched-off account comes first.
    const off = view();
    off.account.is_active = false;
    expect(publishBlockedReason({ ...base, problems: 1, view: off })).toBe("This account is switched off in Channels.");
  });
});

describe("previewModel", () => {
  it("previewModel shows questions instead of Get started when both are set", () => {
    const both = previewModel(full, "messenger");
    expect(both.greeting).toBe("Hello Ada");
    expect(both.chips).toEqual(full.iceBreakers);
    expect(both.getStartedButton).toBe(false);
    expect(both.menu).toEqual([
      { title: "Talk to us", isLink: false },
      { title: "Our shop", isLink: true },
    ]);

    const startOnly = previewModel({ ...EMPTY_CHAT_SETUP, getStarted: true }, "messenger");
    expect(startOnly).toMatchObject({ getStartedButton: true, chips: [], empty: false });

    expect(previewModel(EMPTY_CHAT_SETUP, "messenger").empty).toBe(true);
    // Instagram: questions only; no welcome text, no Get started button.
    const insta = previewModel(full, "instagram");
    expect(insta).toMatchObject({ greeting: null, getStartedButton: false, empty: false });
    expect(previewModel({ ...full, iceBreakers: [] }, "instagram").empty).toBe(true);
  });
});

describe("status strip and editor start", () => {
  it("statusStrip picks one main line, then the grey notes", () => {
    expect(statusStrip(view(), false)[0]).toMatchObject({ tone: "ok", action: "check" });
    expect(statusStrip(view(), false)[0]!.text).toBe("This is what customers see now. Last checked 14:05.");
    expect(statusStrip(view(), true)[0]).toMatchObject({ tone: "warn", text: "You have changes that are not published yet." });
    expect(statusStrip(view({ live: null, live_error: "Meta is busy." }), false)[0]).toMatchObject({ tone: "bad", action: "check" });
    const failed = view({ last_publish: { version: 3, status: "failed", by_name: "Ada", at: "2026-11-20T13:00:00.000Z", error_message: "Meta refused this.", error_code: "100", config: full } });
    expect(statusStrip(failed, false)[0]).toEqual({ tone: "bad", text: "The last publish did not go through. Meta refused this.", action: "retry" });
    const unknown = view({ last_publish: { ...failed.last_publish!, status: "unknown" } });
    expect(statusStrip(unknown, false)[0]).toMatchObject({ tone: "warn", action: "check" });

    const notes = view({ live: { ...view().live!, other_locales: ["fr_FR", "es_ES"], foreign_payloads: true, composer_disabled: true } });
    const items = statusStrip(notes, false);
    expect(items.filter((i) => i.tone === "note").map((i) => i.text)).toEqual([
      "This account also has set-up in other languages (fr_FR, es_ES). Publishing from here replaces all of them with one version.",
      "Some buttons were set up outside the suite. Publishing replaces them. If another tool answers those buttons, it will stop getting the taps.",
      "The message box is switched off for customers on this Page. Publishing from here switches it back on.",
    ]);
  });

  it("editorStart: the draft, else a version that did not go through, else what is live", () => {
    expect(editorStart(view({ draft: { version: 2, config: full, updated_at: "x", updated_by_name: null } }))).toEqual(full);
    const failed = view({ last_publish: { version: 3, status: "failed", by_name: null, at: "x", error_message: null, error_code: null, config: full } });
    expect(editorStart(failed)).toEqual(full);
    expect(editorStart(view({ live: { ...view().live!, config: { ...EMPTY_CHAT_SETUP, greeting: "Live" } } })).greeting).toBe("Live");
    expect(editorStart(view({ live: null }))).toEqual(EMPTY_CHAT_SETUP);
  });

  it("moveItem swaps neighbours and ignores moves off the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
