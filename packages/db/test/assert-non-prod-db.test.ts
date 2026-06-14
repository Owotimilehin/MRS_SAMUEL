import { describe, it, expect } from "vitest";
import { assertNonProdDb } from "../src/lib/assert-non-prod-db.js";

describe("assertNonProdDb", () => {
  it("throws when the url host is a known prod host", () => {
    expect(() =>
      assertNonProdDb("postgres://u:p@138.68.165.230:5432/ms", ["138.68.165.230"]),
    ).toThrow(/production database/i);
  });
  it("throws when MS_DB_IS_PROD=1 regardless of host", () => {
    expect(() =>
      assertNonProdDb("postgres://u:p@localhost:5432/ms", [], "1"),
    ).toThrow(/production database/i);
  });
  it("allows a localhost/testcontainer url", () => {
    expect(() =>
      assertNonProdDb("postgres://u:p@localhost:54219/test", ["138.68.165.230"]),
    ).not.toThrow();
  });
  it("is armed by default — blocks the baked-in prod host with no denylist arg", () => {
    expect(() =>
      assertNonProdDb("postgres://u:p@138.68.165.230:5432/ms"),
    ).toThrow(/production database/i);
  });
});
