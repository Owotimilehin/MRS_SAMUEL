import { describe, it, expect } from "vitest";
import { countFailures, plainFailureReason, saleIdForOutboxRow, type FailureRowLike } from "./sale-failure.js";

const SALE = "1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
const SALE2 = "9a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";

function row(over: Partial<FailureRowLike>): FailureRowLike {
  return { id: SALE, endpoint: "/v1/branches/B1/sales", method: "POST", status: "dead", ...over };
}

describe("saleIdForOutboxRow", () => {
  it("reads the sale id from a Confirm row (its own id) and a Pay row (the path)", () => {
    expect(saleIdForOutboxRow(row({}))).toBe(SALE);
    expect(
      saleIdForOutboxRow(row({ id: "x", method: "PATCH", endpoint: `/v1/branches/B1/sales/${SALE}/pay` })),
    ).toBe(SALE);
  });

  it("is null for anything that isn't a till sale", () => {
    expect(saleIdForOutboxRow(row({ endpoint: "/v1/branches/B1/shift-open" }))).toBeNull();
  });
});

describe("countFailures", () => {
  it("counts each stuck sale once, and other failed changes separately", () => {
    const rows = [
      row({}),
      row({ id: "p1", method: "PATCH", endpoint: `/v1/branches/B1/sales/${SALE}/pay` }),
      row({ id: SALE2 }),
      row({ id: "s1", endpoint: "/v1/branches/B1/shift-open" }),
      row({ id: "ok", status: "pending" }),
    ];
    expect(countFailures(rows)).toEqual({ sales: 2, other: 1 });
  });
});

describe("plainFailureReason", () => {
  it("maps the common server rejections to plain English", () => {
    expect(plainFailureReason("insufficient stock", 422)).toBe("Not enough stock on the system for this sale.");
    expect(plainFailureReason("Open a shift before selling", 409)).toBe(
      "The shift was closed before this sale was sent.",
    );
    expect(plainFailureReason("cannot pay from cancelled", 409)).toMatch(/cancelled/);
    expect(plainFailureReason("this role may only create preorders", 403)).toMatch(/isn't allowed/);
  });

  it("falls back to the raw message so nothing is hidden", () => {
    expect(plainFailureReason("something odd", 400)).toBe("The system turned this down: something odd");
    expect(plainFailureReason(undefined)).toBe("The system turned this down.");
  });
});
