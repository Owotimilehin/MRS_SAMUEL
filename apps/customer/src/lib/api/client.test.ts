// apps/customer/src/lib/api/client.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
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
