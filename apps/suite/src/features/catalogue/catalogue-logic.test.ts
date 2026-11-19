import { describe, expect, it } from "vitest";
import {
  chooseBanner,
  countChips,
  looksLikeCatalogueId,
  matchesFilter,
  sortItems,
  stateLabel,
  stockLabel,
  templatesNotReady,
  whatToDo,
} from "./catalogue-logic.js";
import type { CatalogueLink, ItemState } from "./catalogue-api.js";

const link = (over: Partial<CatalogueLink> = {}): CatalogueLink => ({
  catalog_id: "123456789012345",
  name: "Test Juices",
  whatsapp_connected: true,
  is_cart_enabled: true,
  is_catalog_visible: true,
  sync_enabled: true,
  ask_fulfilment_auto: false,
  order_updates_enabled: false,
  last_sync_at: null,
  last_reconcile_at: null,
  problem: null,
  ...over,
});
const branch = { id: "b", name: "Lekki" };

describe("catalogue page rules", () => {
  it("badge text for each state", () => {
    const want: Record<ItemState, string> = {
      live: "Live",
      pending: "Waiting to send",
      sent: "Sent, waiting for Meta",
      rejected: "Refused by Meta",
      blocked: "Not sent",
      removed: "Hidden",
    };
    for (const [state, text] of Object.entries(want)) expect(stateLabel(state as ItemState)).toBe(text);
  });

  it("sort puts refused and not-sent first", () => {
    const sorted = sortItems([
      { state: "live" as const, title: "Apple" },
      { state: "removed" as const, title: "Aardvark" },
      { state: "blocked" as const, title: "Cherry" },
      { state: "pending" as const, title: "Date" },
      { state: "rejected" as const, title: "Banana" },
      { state: "live" as const, title: "apricot" },
    ]);
    expect(sorted.map((i) => i.title)).toEqual(["Banana", "Cherry", "Date", "Apple", "apricot", "Aardvark"]);
  });

  it("banner choice: config beats no-branch beats temporary", () => {
    const config = { kind: "config" as const, code: "200", message: "(#200)", plain: "Meta says we do not have permission.", at: null };
    const busy = { kind: "temporary" as const, code: "80014", message: "busy", plain: "x", at: null };
    expect(chooseBanner({ link: link({ problem: config }), online_branch: null })).toEqual({
      tone: "bad",
      text: "Meta has stopped accepting our updates: Meta says we do not have permission. Nothing will sync until this is fixed. (Meta code 200)",
    });
    expect(chooseBanner({ link: link({ problem: busy }), online_branch: null })?.text).toContain("No branch is set to take online orders");
    expect(chooseBanner({ link: link({ problem: busy }), online_branch: branch })).toEqual({ tone: "warn", text: "Meta is busy. We will try again shortly." });
    expect(chooseBanner({ link: link(), online_branch: branch })).toBeNull();
    expect(chooseBanner({ link: null, online_branch: null })).toBeNull();
  });

  it("the four counts add the states that belong together, and filter the same way", () => {
    const chips = countChips({ live: 5, pending: 2, sent: 1, rejected: 1, blocked: 3, removed: 4 });
    expect(chips.map((c) => `${c.label} ${c.n}`)).toEqual(["Live 5", "Waiting 3", "Needs attention 4", "Hidden 4"]);
    expect(matchesFilter("sent", "waiting")).toBe(true);
    expect(matchesFilter("blocked", "attention")).toBe(true);
    expect(matchesFilter("live", "attention")).toBe(false);
    expect(matchesFilter("removed", "all")).toBe(true);
  });

  it("names the order templates that are missing or not approved", () => {
    expect(
      templatesNotReady({ order_confirmed: "APPROVED", order_paid: "PENDING", order_out_for_delivery: "missing", order_delivered: "approved" }),
    ).toEqual(["order_paid", "order_out_for_delivery"]);
  });

  it("small wording helpers", () => {
    expect(stockLabel("in stock")).toBe("In stock");
    expect(stockLabel("out of stock")).toBe("Out of stock");
    expect(stockLabel(null)).toBe("");
    expect(whatToDo({ state: "blocked", review_status: null })).toContain("shop admin");
    expect(whatToDo({ state: "rejected", review_status: "rejected" })).toContain("Commerce Manager");
    expect(looksLikeCatalogueId(" 123456789012345 ")).toBe(true);
    expect(looksLikeCatalogueId("12ab")).toBe(false);
  });
});
