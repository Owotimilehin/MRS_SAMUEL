import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { local } from "../db/local.js";
import { fileLocalShiftOpen, isOpenedToday } from "./local-shift-open.js";
import { lagosToday } from "../lib/biz-date.js";

const BRANCH = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  await local.shiftOpenMarker.clear();
  await local.outbox.clear();
  await local.meta.clear();
});

describe("local shift-open filing", () => {
  it("writes a date-keyed marker and an outbox row in one go, and unlocks", async () => {
    expect(await isOpenedToday(BRANCH)).toBe(false);
    await fileLocalShiftOpen({
      branchId: BRANCH,
      businessDate: lagosToday(),
      stockCounts: [{ product_id: "p1", counted_quantity: 3 }],
    });
    expect(await isOpenedToday(BRANCH)).toBe(true);
    const outbox = await local.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].endpoint).toBe(`/v1/branches/${BRANCH}/shift-open`);
    expect(outbox[0].method).toBe("POST");
  });

  it("isOpenedToday is satisfied by meta.opened_today even with no marker", async () => {
    await local.meta.put({ id: "default", last_pull_at: null, branch_id: BRANCH, opened_today: true });
    expect(await isOpenedToday(BRANCH)).toBe(true);
  });
});
