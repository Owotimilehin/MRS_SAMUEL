// apps/customer/src/lib/api/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, ApiError } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals(); // stubGlobal("fetch") is NOT undone by restoreAllMocks
});

describe("apiFetch", () => {
  it("unwraps the { data } envelope on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { hello: "world" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const out = await apiFetch<{ hello: string }>("/v1/public/catalog/products");
    expect(out).toEqual({ hello: "world" });
  });

  it("throws ApiError carrying code + status on the { error } envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(apiFetch("/v1/public/blog/missing")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      status: 404,
    });
  });

  it("throws ApiError on a non-JSON 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream boom", { status: 500 })),
    );
    await expect(apiFetch("/v1/public/catalog/products")).rejects.toBeInstanceOf(ApiError);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiFetch retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a 502 then succeeds, returning data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(502, { error: { code: "upstream", message: "bad gateway" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const out = await apiFetch<{ ok: boolean }>("/health");
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a real 404", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(404, { error: { code: "not_found", message: "nope" } }));
    await expect(apiFetch("/missing")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after max attempts on persistent network failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(apiFetch("/health")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
