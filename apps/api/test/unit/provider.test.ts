import { describe, it, expect } from "vitest";
import { getActiveProvider } from "../../src/payments/provider.js";

function fakeDb(rows: Array<{ key: string; value: unknown }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => rows.filter((r) => r.key === "payment_provider"),
      }),
    }),
  } as unknown as Parameters<typeof getActiveProvider>[0];
}

describe("getActiveProvider", () => {
  it("defaults to opay when no setting row exists", async () => {
    expect(await getActiveProvider(fakeDb([]))).toBe("opay");
  });
  it("returns payaza when the setting says so", async () => {
    expect(await getActiveProvider(fakeDb([{ key: "payment_provider", value: { provider: "payaza" } }]))).toBe("payaza");
  });
  it("falls back to opay on a malformed value", async () => {
    expect(await getActiveProvider(fakeDb([{ key: "payment_provider", value: { provider: "nonsense" } }]))).toBe("opay");
  });
});
