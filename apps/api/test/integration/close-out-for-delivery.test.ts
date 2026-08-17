import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  expectedCashForDay,
  cashSalesForDay,
  expectedCashForShift,
  cashSalesForShift,
} from "@ms/domain";
import { setupTestDb, seedOnlineOrder } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Money in transit still counts at close.
 *
 * An online order paid by transfer is dispatched and sits in `out_for_delivery`
 * when the shift closes. The money is already in the account, so it MUST appear
 * in the branch's expected take and in the itemised close list — otherwise the
 * counted amount exceeds expected and the branch is handed a phantom overage
 * variance for a sale it never sees.
 *
 * `reports.ts` learned this in 90ece6e; `packages/domain/daily-close.ts` did not,
 * so every shift close and daily close still dropped these orders.
 */
describe("daily close counts out_for_delivery transfer sales", () => {
  let container: StartedPostgreSqlContainer;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let branchId: string;

  // seedOnlineOrder books subtotal 2500 + fee 0.
  const ORDER_NGN = 2500;

  beforeAll(async () => {
    const t = await setupTestDb();
    container = t.container;
    db = t.db;

    // Two transfer-paid online orders on the same day at the same branch:
    // one already delivered, one still with the rider at close time.
    const delivered = await seedOnlineOrder(db, { status: "delivered" });
    branchId = delivered.branchId;
    await seedOnlineOrder(db, { status: "out_for_delivery", branchId });
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("includes an out_for_delivery order in the day's expected take", async () => {
    const expected = await expectedCashForDay(db, branchId, new Date());
    expect(expected).toBe(ORDER_NGN * 2);
  });

  it("itemises the out_for_delivery order on the close screen", async () => {
    const lines = await cashSalesForDay(db, branchId, new Date());
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.status).sort()).toEqual(["delivered", "out_for_delivery"]);
  });

  it("applies the same coverage to a shift window", async () => {
    const openedAt = new Date(Date.now() - 60 * 60 * 1000);
    const closedAt = new Date(Date.now() + 60 * 60 * 1000);

    const expected = await expectedCashForShift(db, branchId, openedAt, closedAt);
    expect(expected).toBe(ORDER_NGN * 2);

    const lines = await cashSalesForShift(db, branchId, openedAt, closedAt);
    expect(lines).toHaveLength(2);
  });
});
