// fake-indexeddb MUST be imported before anything that constructs the Dexie
// database (engine.js → db/local.ts builds `new BranchDB()` at module load).
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local, localAvailableForVariant } from "../db/local.js";
import { adjustBranchStock } from "./stock-adjust.js";

/**
 * Unit suite for the till's owner-only stock edit. The helper is the whole
 * client-side feature: it posts the same audited /inventory/adjust the Inventory
 * page uses (always scoped to a BRANCH), then resyncs the authoritative snapshot
 * so the till can never diverge from the server.
 */

function setOnline(online: boolean): void {
  vi.stubGlobal("navigator", { onLine: online });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await local.stock.clear();
  await local.meta.clear();
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("adjustBranchStock", () => {
  it("posts a branch-scoped adjust with the right body, then resyncs the snapshot", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        seen.push({ url, init });
        if (url.includes("/inventory/adjust")) {
          return Promise.resolve(jsonResponse(201, { data: { id: "adj1", items_recorded: 1 } }));
        }
        // The resync pull returns the new authoritative on-hand.
        return Promise.resolve(
          jsonResponse(200, {
            data: {
              products: [], variants: [], prices: [], ledger: [],
              stock: [{ productId: "P1", variantId: "V1", qty: 42 }],
              transfers: [], sales: [],
            },
            next_cursor: new Date().toISOString(),
          }),
        );
      }),
    );

    await adjustBranchStock({
      branchId: "B1",
      productId: "P1",
      variantId: "V1",
      newQuantity: 42,
      reasonCode: "physical_recount",
    });

    const post = seen.find((c) => c.url.includes("/inventory/adjust"));
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.init.body));
    expect(body).toMatchObject({
      location_type: "branch",
      location_id: "B1",
      reason_code: "physical_recount",
      items: [{ product_id: "P1", variant_id: "V1", new_quantity: 42 }],
    });
    // A pull was issued and the local snapshot now reflects server truth.
    expect(seen.some((c) => c.url.includes("/sync/pull"))).toBe(true);
    expect(await localAvailableForVariant("B1", "P1", "V1")).toBe(42);
  });

  it("includes reason_note only when provided", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        if (url.includes("/inventory/adjust")) bodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          url.includes("/inventory/adjust")
            ? jsonResponse(201, { data: { id: "a", items_recorded: 1 } })
            : jsonResponse(200, {
                data: { products: [], variants: [], prices: [], ledger: [], stock: [], transfers: [], sales: [] },
                next_cursor: new Date().toISOString(),
              }),
        );
      }),
    );

    await adjustBranchStock({
      branchId: "B1", productId: "P1", variantId: null,
      newQuantity: 5, reasonCode: "other_with_note", reasonNote: "  spill in the cold room  ",
    });

    expect(bodies[0]).toMatchObject({ reason_code: "other_with_note", reason_note: "spill in the cold room" });
  });

  it("refuses to edit while offline and never touches the network", async () => {
    setOnline(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      adjustBranchStock({
        branchId: "B1", productId: "P1", variantId: "V1",
        newQuantity: 3, reasonCode: "physical_recount",
      }),
    ).rejects.toThrow(/offline/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("propagates a would-go-negative rejection and does not resync", async () => {
    let pulled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/inventory/adjust")) {
          return Promise.resolve(
            jsonResponse(422, {
              error: {
                code: "conflict",
                message: "stock would go negative",
                details: { reason: "would_go_negative" },
              },
            }),
          );
        }
        pulled = true;
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );

    await expect(
      adjustBranchStock({
        branchId: "B1", productId: "P1", variantId: "V1",
        newQuantity: 0, reasonCode: "physical_recount",
      }),
    ).rejects.toThrow(/negative/i);
    expect(pulled).toBe(false);
  });
});
