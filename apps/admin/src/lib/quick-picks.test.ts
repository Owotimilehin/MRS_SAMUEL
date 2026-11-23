import { describe, it, expect } from "vitest";
import { rankQuickPicks, type QuickPickSourceRow } from "./quick-picks.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function sale(at: number, items: Array<[string, number]>, branch = "B1"): QuickPickSourceRow {
  return {
    endpoint: `/v1/branches/${branch}/sales`,
    method: "POST",
    payload: { items: items.map(([variant_id, quantity]) => ({ variant_id, quantity })) },
    created_at_local: at,
  };
}

describe("rankQuickPicks", () => {
  it("ranks variants by units sold in the window, best first", () => {
    const rows = [
      sale(NOW - DAY, [["mango-650", 1], ["zobo-330", 2]]),
      sale(NOW - 2 * DAY, [["mango-650", 3]]),
      sale(NOW - 3 * DAY, [["beet-650", 1]]),
    ];
    expect(rankQuickPicks(rows, { branchId: "B1", sinceMs: NOW - 7 * DAY })).toEqual([
      "mango-650",
      "zobo-330",
      "beet-650",
    ]);
  });

  it("ignores old sales, other branches, Pay rows and junk payloads", () => {
    const rows: QuickPickSourceRow[] = [
      sale(NOW - 8 * DAY, [["old", 50]]),
      sale(NOW - DAY, [["elsewhere", 50]], "B2"),
      { endpoint: "/v1/branches/B1/sales/x/pay", method: "PATCH", payload: null, created_at_local: NOW },
      { endpoint: "/v1/branches/B1/sales", method: "POST", payload: null, created_at_local: NOW },
      sale(NOW - DAY, [["kept", 1]]),
    ];
    expect(rankQuickPicks(rows, { branchId: "B1", sinceMs: NOW - 7 * DAY })).toEqual(["kept"]);
  });

  it("breaks ties by the most recent sale", () => {
    const rows = [sale(NOW - 3 * DAY, [["a", 2]]), sale(NOW - DAY, [["b", 2]])];
    expect(rankQuickPicks(rows, { branchId: "B1", sinceMs: NOW - 7 * DAY })).toEqual(["b", "a"]);
  });

  it("returns nothing when this device has no sales", () => {
    expect(rankQuickPicks([], { branchId: "B1", sinceMs: 0 })).toEqual([]);
  });
});
