import { describe, it, expect } from "vitest";
import { getActiveProvider } from "../../src/payments/provider.js";

/**
 * OPay is the only provider. The owner-facing toggle and the Payaza fallback
 * were removed once OPay was proven in production, but the seam is kept so a
 * second provider could be reintroduced without reshaping call sites.
 */
describe("getActiveProvider", () => {
  it("always resolves to opay", async () => {
    const db = {} as Parameters<typeof getActiveProvider>[0];
    expect(await getActiveProvider(db)).toBe("opay");
  });
});
