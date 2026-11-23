import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next.js";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/owner/orders?status=paid")).toBe("/owner/orders?status=paid");
    expect(safeNext("/branch/sell")).toBe("/branch/sell");
  });
  it("drops empty values", () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext("")).toBeNull();
  });
  it("drops scripts and other sites", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "https://evil.example/login",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "data:text/html,hi",
    ]) {
      expect(safeNext(bad), bad).toBeNull();
    }
  });
});
