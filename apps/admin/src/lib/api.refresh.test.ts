import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "./api.js";

describe("api() refresh-on-401", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("refreshes once and retries when the access token has expired", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      const dataCalls = calls.filter((c) => c.includes("/products")).length;
      if (dataCalls === 1) {
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "p1" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api<{ data: { id: string }[] }>("/products");
    expect(result.data[0]!.id).toBe("p1");
    expect(calls).toContain("POST /v1/auth/refresh");
    expect(calls.filter((c) => c.includes("/auth/refresh"))).toHaveLength(1);
  });

  it("does not loop forever when refresh also fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/products")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
