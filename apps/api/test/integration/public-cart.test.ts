import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Product { id: string; slug: string; variants?: Array<{ id: string; size_ml: number }> }

describe("public cart add-to-cart", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let variantId: string;
  let cookieJar = "";

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: string; setCookie: string | null }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = uuid();
    if (cookieJar) headers["cookie"] = cookieJar;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookieJar = sc.split(";")[0]!; // first part is name=value
    const text = await res.text();
    return { status: res.status, body: text, setCookie: sc };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    const cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    // Create a product with one variant via the admin POST so all relations + prices exist.
    const createRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        "idempotency-key": uuid(),
      },
      body: JSON.stringify({
        name: "Cart Sunrise",
        slug: "cart-sunrise",
        category: "regular",
        ingredients: ["x"],
        initial_price_ngn: 2500,
      }),
    });
    expect(createRes.status).toBe(201);

    // GET the product to retrieve its variant id (created automatically with initial_price_ngn).
    const listRes = await fetch(`${baseUrl}/v1/public/catalog/products`);
    const { data } = (await listRes.json()) as { data: Product[] };
    const p = data.find((x) => x.slug === "cart-sunrise");
    if (!p?.variants?.[0]) throw new Error("seed variant missing");
    variantId = p.variants[0].id;
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("POST /v1/public/cart/lines adds a line and returns the cart", async () => {
    const res = await call("POST", "/v1/public/cart/lines", { variant_id: variantId, quantity: 2 });
    if (res.status !== 200) console.error("ADD-TO-CART BODY:", res.body);
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { data: { lines: Array<{ variant_id: string; quantity: number }>; total_items: number } };
    expect(json.data.lines.length).toBe(1);
    expect(json.data.lines[0]!.variant_id).toBe(variantId);
    expect(json.data.lines[0]!.quantity).toBe(2);
    expect(json.data.total_items).toBe(2);
  });

  it("POST again increments the existing line via onConflict", async () => {
    const res = await call("POST", "/v1/public/cart/lines", { variant_id: variantId, quantity: 3 });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { data: { total_items: number } };
    expect(json.data.total_items).toBe(5);
  });
});
