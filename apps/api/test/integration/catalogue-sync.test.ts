import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  branch,
  catalogueBatch,
  catalogueItemSync,
  catalogueLink,
  outboxEvent,
  product,
  productPrice,
  productVariant,
  stockLedger,
  stockReservation,
  type DbClient,
} from "@ms/db";
import {
  checkOpenBatches,
  computeDesiredItems,
  reconcileCatalogue,
  requestCatalogueSync,
  retailerIdForVariant,
  syncCatalogue,
  type MetaConfig,
} from "@ms/domain";
import { authOwner, makeTestApp, seedOnlineOrder } from "./helpers.js";

/**
 * Catalogue sync (suite spec 08). Meta is never called: every Graph request is
 * answered by the stub below, which also records what would have been sent.
 */
const cfg: MetaConfig = { token: "itest-token", graphVersion: "v23.0" };
const CATALOG_ID = "123456789012345";
const STOREFRONT = "https://www.example.test";
const opts = { storefrontBase: STOREFRONT };

type GraphCall = { url: string; method: string; body: unknown };
type BatchRequest = { method: string; data: { id: string; price?: string; availability?: string; link?: string } };
const graphCalls: GraphCall[] = [];
let graphHandler: (call: GraphCall) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const defaultHandler = (call: GraphCall): Response => {
  if (call.url.includes("/items_batch")) return json({ handles: ["h1"], validation_status: [] });
  if (call.url.includes("/check_batch_request_status")) {
    return json({ data: [{ handle: "h1", status: "finished", errors_total_count: 0, warnings: [], ids_of_invalid_requests: [] }] });
  }
  if (call.url.includes("/products")) return json({ data: [] });
  return json({ error: { message: "unexpected call in test", code: 100 } }, 400);
};

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const call: GraphCall = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      graphCalls.push(call);
      return graphHandler(call);
    }
    return real(input, init);
  }) as typeof fetch;
}

const batchCalls = () => graphCalls.filter((c) => c.url.includes("/items_batch"));
const requestsOf = (c: GraphCall): BatchRequest[] => (c.body as { requests: BatchRequest[] }).requests;

describe("catalogue sync", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let branchId: string;
  let seq = 0;

  beforeAll(async () => {
    const t = await makeTestApp();
    ({ app, db, container } = t);
    installGraphStub();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    graphCalls.length = 0;
    graphHandler = defaultHandler;
    // A clean shop and a clean catalogue for every test.
    await db.delete(catalogueLink); // batches and item rows go with it
    await db.delete(stockReservation);
    await db.delete(stockLedger);
    await db.delete(productPrice);
    await db.delete(productVariant);
    await db.delete(product);
    await db.delete(outboxEvent);
    await db.update(branch).set({ isOnlineDefault: false });
    const [br] = await db
      .insert(branch)
      .values({ name: "Online Branch", code: `OB${++seq}`, address: "1 Test Close, Lagos", isOnlineDefault: true })
      .returning();
    branchId = br!.id;
  });

  async function seedFlavour(o: {
    name: string;
    sizes?: { sizeMl: number; priceNgn: number | null }[];
    imageUrl?: string | null;
    category?: "regular" | "special" | "punch";
  }): Promise<{ productId: string; slug: string; variantIds: string[] }> {
    const slug = `${o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${++seq}`;
    const [p] = await db
      .insert(product)
      .values({
        name: o.name,
        slug,
        category: o.category ?? "regular",
        tagline: `${o.name}, freshly pressed.`,
        imageUrl: o.imageUrl === undefined ? "/media/bottles/test.png" : o.imageUrl,
      })
      .returning();
    const variantIds: string[] = [];
    for (const s of o.sizes ?? [{ sizeMl: 330, priceNgn: 1500 }]) {
      const [v] = await db.insert(productVariant).values({ productId: p!.id, sizeMl: s.sizeMl, sku: `${slug}-${s.sizeMl}` }).returning();
      if (s.priceNgn !== null) await db.insert(productPrice).values({ productId: p!.id, variantId: v!.id, priceNgn: s.priceNgn });
      variantIds.push(v!.id);
    }
    return { productId: p!.id, slug, variantIds };
  }

  async function addStock(productId: string, variantId: string, qty: number): Promise<void> {
    await db.insert(stockLedger).values({
      locationType: "branch",
      locationId: branchId,
      productId,
      variantId,
      delta: qty,
      sourceType: "opening_balance",
      sourceId: uuid(),
    });
  }

  async function link(over: Partial<typeof catalogueLink.$inferInsert> = {}) {
    const [row] = await db.insert(catalogueLink).values({ catalogId: CATALOG_ID, name: "Test Juices", syncEnabled: true, ...over }).returning();
    return row!;
  }

  const items = () => db.select().from(catalogueItemSync);
  const itemFor = async (variantId: string) =>
    (await db.select().from(catalogueItemSync).where(eq(catalogueItemSync.retailerId, retailerIdForVariant(variantId))))[0]!;
  const batches = () => db.select().from(catalogueBatch).orderBy(catalogueBatch.createdAt);
  const theLink = async () => (await db.select().from(catalogueLink))[0]!;
  /** Pretend the last batches are old, so the wait after a failure is over. */
  const ageBatches = () => db.execute(sql`update catalogue_batch set created_at = created_at - interval '1 hour'`);

  // ── What the shop says Meta should hold ───────────────────────────────────

  it("computeDesiredItems lists one item per active priced size with the storefront link and absolute picture URL", async () => {
    const f = await seedFlavour({ name: "Pineapple Ginger", sizes: [{ sizeMl: 330, priceNgn: 1500 }, { sizeMl: 650, priceNgn: 2800 }] });
    const desired = await computeDesiredItems(db, opts);
    expect(desired).toHaveLength(2);
    const small = desired.find((d) => d.variantId === f.variantIds[0])!;
    expect(small.retailerId).toBe(`v-${f.variantIds[0]}`);
    expect(small.blockedReason).toBeNull();
    expect(small.data).toEqual({
      id: `v-${f.variantIds[0]}`,
      title: "Pineapple Ginger 330ml",
      description: "Pineapple Ginger, freshly pressed.",
      availability: "out of stock",
      condition: "new",
      price: "1500.00 NGN",
      link: `${STOREFRONT}/juices/${f.slug}`,
      image: [{ url: `${STOREFRONT}/media/bottles/test.png` }],
      brand: "Mrs. Samuel",
      item_group_id: f.productId,
      size: "330 ml",
      google_product_category: "Food, Beverages & Tobacco > Beverages > Juice",
    });
    expect(desired.find((d) => d.variantId === f.variantIds[1])!.data!.price).toBe("2800.00 NGN");
  });

  it("a size with no stock at the online branch is out of stock; adding stock makes it in stock", async () => {
    const f = await seedFlavour({ name: "Zobo" });
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("out of stock");
    await addStock(f.productId, f.variantIds[0]!, 3);
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("in stock");
    // A made-to-order size is never shown as in stock (open question Q3).
    await db.update(productVariant).set({ preorderOnly: true }).where(eq(productVariant.id, f.variantIds[0]!));
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("out of stock");
  });

  it("a live reservation that uses the last bottle makes it out of stock", async () => {
    const f = await seedFlavour({ name: "Tigernut" });
    await addStock(f.productId, f.variantIds[0]!, 1);
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("in stock");
    const order = await seedOnlineOrder(db, { status: "confirmed", branchId });
    await db.insert(stockReservation).values({
      saleOrderId: order.id,
      branchId,
      productId: f.productId,
      variantId: f.variantIds[0]!,
      quantity: 1,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("out of stock");
    // The hold lapses with no write at all: the bottle is back.
    await db.update(stockReservation).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await computeDesiredItems(db, opts))[0]!.data!.availability).toBe("in stock");
  });

  it("with no online branch every item is out of stock", async () => {
    const f = await seedFlavour({ name: "Orange" });
    await addStock(f.productId, f.variantIds[0]!, 10);
    await db.update(branch).set({ isOnlineDefault: false });
    const desired = await computeDesiredItems(db, opts);
    expect(desired[0]!.data!.availability).toBe("out of stock");
  });

  it("a retired size, an inactive flavour and a deleted flavour all give data null", async () => {
    const retired = await seedFlavour({ name: "Retired Size", sizes: [{ sizeMl: 330, priceNgn: 1500 }, { sizeMl: 650, priceNgn: 2500 }] });
    await db.update(productVariant).set({ isActive: false }).where(eq(productVariant.id, retired.variantIds[1]!));
    const hidden = await seedFlavour({ name: "Hidden Flavour" });
    await db.update(product).set({ isActive: false }).where(eq(product.id, hidden.productId));
    const deleted = await seedFlavour({ name: "Deleted Flavour" });
    await db.update(product).set({ deletedAt: new Date(), isActive: false }).where(eq(product.id, deleted.productId));
    await db.update(productVariant).set({ deletedAt: new Date(), isActive: false }).where(eq(productVariant.productId, deleted.productId));

    const desired = await computeDesiredItems(db, opts);
    const by = (variantId: string) => desired.find((d) => d.variantId === variantId)!;
    expect(by(retired.variantIds[0]!).data).not.toBeNull();
    for (const id of [retired.variantIds[1]!, hidden.variantIds[0]!, deleted.variantIds[0]!]) {
      expect(by(id).data).toBeNull();
      expect(by(id).blockedReason).toBeNull();
    }
  });

  it("a flavour with no picture is blocked and never sent", async () => {
    const bare = await seedFlavour({ name: "No Picture", imageUrl: null });
    const unpriced = await seedFlavour({ name: "No Price", sizes: [{ sizeMl: 330, priceNgn: null }] });
    await link();
    const desired = await computeDesiredItems(db, opts);
    expect(desired.find((d) => d.variantId === bare.variantIds[0])).toMatchObject({ data: null, blockedReason: "no_picture" });
    expect(desired.find((d) => d.variantId === unpriced.variantIds[0])).toMatchObject({ data: null, blockedReason: "no_price" });

    const result = await syncCatalogue(db, cfg, opts);
    expect(result).toEqual({ pushed: 0, removed: 0, blocked: 2 });
    expect(graphCalls).toHaveLength(0);
    expect((await itemFor(bare.variantIds[0]!)).state).toBe("blocked");
    expect((await itemFor(bare.variantIds[0]!)).blockedReason).toBe("no_picture");
    expect((await itemFor(unpriced.variantIds[0]!)).blockedReason).toBe("no_price");
  });

  // ── The sync engine ───────────────────────────────────────────────────────

  it("syncCatalogue sends one UPDATE per changed item and nothing on a second pass", async () => {
    const a = await seedFlavour({ name: "Pineapple", sizes: [{ sizeMl: 330, priceNgn: 1500 }, { sizeMl: 650, priceNgn: 2800 }] });
    await link();
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 2, removed: 0, blocked: 0 });
    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0]!.url).toBe(`https://graph.facebook.com/v23.0/${CATALOG_ID}/items_batch`);
    const sent = requestsOf(batchCalls()[0]!);
    expect(sent.map((r) => r.method)).toEqual(["UPDATE", "UPDATE"]);
    expect(sent.map((r) => r.data.id).sort()).toEqual(a.variantIds.map((v) => `v-${v}`).sort());
    // The local batch row exists and is open; the items wait for Meta.
    expect((await batches()).map((b) => [b.state, b.handle, b.itemCount, b.kind])).toEqual([["open", "h1", 2, "changes"]]);
    expect((await items()).every((i) => i.state === "sent")).toBe(true);

    // One batch in flight at a time: nothing goes out while it is open.
    await syncCatalogue(db, cfg, opts);
    expect(batchCalls()).toHaveLength(1);

    expect(await checkOpenBatches(db, cfg)).toBe(1);
    expect((await items()).every((i) => i.state === "live" && i.pushedHash === i.desiredHash && i.pushedAt !== null)).toBe(true);

    // Nothing changed in the shop: the next pass sends nothing at all.
    graphCalls.length = 0;
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect(graphCalls).toHaveLength(0);
    expect(await batches()).toHaveLength(1);
    expect((await theLink()).lastSyncAt).not.toBeNull();
  });

  it("a stock change is sent as one UPDATE for that size only", async () => {
    const a = await seedFlavour({ name: "Mango" });
    const b = await seedFlavour({ name: "Guava" });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;

    await addStock(a.productId, a.variantIds[0]!, 5);
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 1, removed: 0, blocked: 0 });
    const sent = requestsOf(batchCalls()[0]!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data.id).toBe(`v-${a.variantIds[0]}`);
    expect(sent[0]!.data.availability).toBe("in stock");
    expect((await itemFor(b.variantIds[0]!)).state).toBe("live");
  });

  it("checkOpenBatches marks items live, and an item in ids_of_invalid_requests rejected", async () => {
    const ok = await seedFlavour({ name: "Good Juice" });
    const bad = await seedFlavour({ name: "Bad Juice" });
    const worse = await seedFlavour({ name: "Worse Juice" });
    await link();
    await syncCatalogue(db, cfg, opts);
    graphHandler = (call) =>
      call.url.includes("/check_batch_request_status")
        ? json({
            data: [
              {
                handle: "h1",
                status: "finished",
                errors_total_count: 2,
                errors: [{ line: 2, id: `v-${worse.variantIds[0]}`, message: "Image could not be downloaded" }],
                ids_of_invalid_requests: [`v-${bad.variantIds[0]}`],
              },
            ],
          })
        : defaultHandler(call);
    expect(await checkOpenBatches(db, cfg)).toBe(1);
    expect((await itemFor(ok.variantIds[0]!)).state).toBe("live");
    expect(await itemFor(bad.variantIds[0]!)).toMatchObject({ state: "rejected", problemMessage: "Meta refused this item", pushedHash: null });
    expect(await itemFor(worse.variantIds[0]!)).toMatchObject({ state: "rejected", problemMessage: "Image could not be downloaded" });
    expect((await batches())[0]).toMatchObject({ state: "finished", errorsTotal: 2 });

    // Rule R11: a refused item is not sent again until it changes…
    graphCalls.length = 0;
    await syncCatalogue(db, cfg, opts);
    expect(graphCalls).toHaveLength(0);
    // …and then it is.
    await db.update(product).set({ tagline: "A new description." }).where(eq(product.id, bad.productId));
    await syncCatalogue(db, cfg, opts);
    expect(requestsOf(batchCalls()[0]!).map((r) => r.data.id)).toEqual([`v-${bad.variantIds[0]}`]);
  });

  it("a batch Meta has not finished is checked again, then given up and its items sent again", async () => {
    const f = await seedFlavour({ name: "Slow Juice" });
    await link();
    await syncCatalogue(db, cfg, opts);
    graphHandler = (call) =>
      call.url.includes("/check_batch_request_status") ? json({ data: [{ handle: "h1", status: "started" }] }) : defaultHandler(call);
    expect(await checkOpenBatches(db, cfg)).toBe(0);
    expect((await batches())[0]).toMatchObject({ state: "open", checks: 1 });
    await db.update(catalogueBatch).set({ checks: 59 });
    expect(await checkOpenBatches(db, cfg)).toBe(0);
    expect((await batches())[0]!.state).toBe("lost");
    expect((await itemFor(f.variantIds[0]!)).state).toBe("pending");
  });

  it("validation_status errors mark only that item rejected", async () => {
    const ok = await seedFlavour({ name: "Fine Juice" });
    const bad = await seedFlavour({ name: "Refused Juice" });
    await link();
    graphHandler = (call) =>
      call.url.includes("/items_batch")
        ? json({
            handles: ["h1"],
            validation_status: [
              { retailer_id: `v-${bad.variantIds[0]}`, errors: [{ message: "Invalid price" }, { message: "Bad link" }], warnings: [] },
              { retailer_id: `v-${ok.variantIds[0]}`, errors: [], warnings: [{ message: "Add more pictures" }] },
            ],
          })
        : defaultHandler(call);
    await syncCatalogue(db, cfg, opts);
    expect(await itemFor(bad.variantIds[0]!)).toMatchObject({ state: "rejected", problemMessage: "Invalid price; Bad link" });
    expect((await itemFor(ok.variantIds[0]!)).state).toBe("sent");
    await checkOpenBatches(db, cfg);
    expect((await itemFor(ok.variantIds[0]!)).state).toBe("live");
    expect((await itemFor(bad.variantIds[0]!)).state).toBe("rejected");
  });

  it("a batch Meta takes nothing from fails, and its items wait to be sent again", async () => {
    const f = await seedFlavour({ name: "Empty Handle" });
    await link();
    graphHandler = (call) => (call.url.includes("/items_batch") ? json({ handles: [], validation_status: [] }) : defaultHandler(call));
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect((await batches())[0]!.state).toBe("failed");
    expect(await itemFor(f.variantIds[0]!)).toMatchObject({ state: "pending", attempts: 1 });
  });

  it("a timeout marks the batch lost and the items pending", async () => {
    const f = await seedFlavour({ name: "Timeout Juice" });
    await link();
    graphHandler = () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    };
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect((await batches()).map((b) => b.state)).toEqual(["lost"]);
    expect((await itemFor(f.variantIds[0]!)).state).toBe("pending");
    // A timeout is "unknown", not a problem with our access.
    expect((await theLink()).problemKind).toBeNull();

    // Rule R15: once the wait is over the same upsert goes out again.
    graphHandler = defaultHandler;
    await ageBatches();
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 1, removed: 0, blocked: 0 });
    expect((await batches()).map((b) => b.state)).toEqual(["lost", "open"]);
  });

  it("error 80014 leaves items pending and backs off", async () => {
    const f = await seedFlavour({ name: "Busy Juice" });
    await link();
    graphHandler = () => json({ error: { message: "(#80014) Too many batch calls", code: 80014 } }, 400);
    await syncCatalogue(db, cfg, opts);
    expect((await batches()).map((b) => [b.state, b.errorCode])).toEqual([["failed", "80014"]]);
    expect((await itemFor(f.variantIds[0]!)).state).toBe("pending");
    expect(await theLink()).toMatchObject({ problemKind: "temporary", problemCode: "80014" });
    expect(await db.select().from(outboxEvent)).toHaveLength(0);

    // Straight away: no second call. We wait before trying again.
    const before = graphCalls.length;
    await syncCatalogue(db, cfg, opts);
    expect(graphCalls).toHaveLength(before);
    expect(await batches()).toHaveLength(1);

    // After the wait Meta is well again: the item goes out and the banner clears.
    graphHandler = defaultHandler;
    await ageBatches();
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 1, removed: 0, blocked: 0 });
    expect((await theLink()).problemKind).toBeNull();
  });

  it("error 200 sets a config problem, queues one catalogue.sync_blocked alert, and a second failure within 24 hours queues none", async () => {
    const f = await seedFlavour({ name: "No Access Juice" });
    await link();
    graphHandler = () => json({ error: { message: "(#200) Permissions error", code: 200 } }, 403);
    await syncCatalogue(db, cfg, opts);
    expect(await theLink()).toMatchObject({ problemKind: "config", problemCode: "200", problemMessage: "(#200) Permissions error" });
    expect((await itemFor(f.variantIds[0]!)).state).toBe("pending");
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "catalogue.sync_blocked"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toEqual({ account: CATALOG_ID, code: "200", message: "(#200) Permissions error" });

    // Rule R17: a configuration problem stops all sync until a person fixes it.
    const before = graphCalls.length;
    await ageBatches();
    await syncCatalogue(db, cfg, opts);
    expect(await checkOpenBatches(db, cfg)).toBe(0);
    expect(graphCalls).toHaveLength(before);

    // The problem is cleared (as a successful GET /status does), and Meta refuses again: still one alert.
    await db.update(catalogueLink).set({ problemKind: null, problemCode: null, problemMessage: null, problemAt: null });
    await syncCatalogue(db, cfg, opts);
    expect(graphCalls.length).toBeGreaterThan(before);
    expect((await theLink()).problemKind).toBe("config");
    expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "catalogue.sync_blocked"))).toHaveLength(1);
  });

  it("a refusal of the whole batch is shown on its items and is not a configuration problem", async () => {
    const f = await seedFlavour({ name: "Refused Batch" });
    await link();
    graphHandler = () => json({ error: { message: "(#368) Blocked for policy reasons", code: 368 } }, 400);
    await syncCatalogue(db, cfg, opts);
    expect((await batches())[0]).toMatchObject({ state: "failed", errorCode: "368" });
    expect(await itemFor(f.variantIds[0]!)).toMatchObject({ state: "rejected", problemMessage: "(#368) Blocked for policy reasons" });
    expect((await theLink()).problemKind).toBeNull();
  });

  it("sync_enabled false makes no Graph call", async () => {
    await seedFlavour({ name: "Quiet Juice" });
    await link({ syncEnabled: false });
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect(await syncCatalogue(db, cfg, { ...opts, force: true, kind: "full" })).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect(await checkOpenBatches(db, cfg)).toBe(0);
    expect(await reconcileCatalogue(db, cfg, opts)).toEqual({ missing: 0, extra: 0, unmanaged: 0 });
    expect(graphCalls).toHaveLength(0);
    expect(await items()).toHaveLength(0);
  });

  it("with no catalogue linked nothing happens, and requestCatalogueSync is a no-op", async () => {
    await seedFlavour({ name: "Unlinked Juice" });
    await requestCatalogueSync(db, "test");
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect(graphCalls).toHaveLength(0);
  });

  it("send everything again re-sends live items in one batch", async () => {
    const f = await seedFlavour({ name: "Again Juice", sizes: [{ sizeMl: 330, priceNgn: 1500 }, { sizeMl: 650, priceNgn: 2500 }] });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;
    expect(await syncCatalogue(db, cfg, { ...opts, force: true, kind: "full" })).toEqual({ pushed: 2, removed: 0, blocked: 0 });
    expect(requestsOf(batchCalls()[0]!).map((r) => r.data.id).sort()).toEqual(f.variantIds.map((v) => `v-${v}`).sort());
    expect((await batches())[1]!.kind).toBe("full");
  });

  // ── Shop changes through the admin routes ─────────────────────────────────

  it("publishing a price through POST /v1/products/:id/prices sets sync_requested_at and the next pass sends the new price", async () => {
    const f = await seedFlavour({ name: "Price Juice" });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;
    const synced = (await theLink()).lastSyncAt!;
    expect((await theLink()).syncRequestedAt).toBeNull();

    const cookie = await authOwner(app);
    const res = await app.request(`/v1/products/${f.productId}/prices`, {
      method: "POST",
      headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({ variant_id: f.variantIds[0], price_ngn: 1800 }),
    });
    expect(res.status).toBe(201);
    const after = await theLink();
    expect(after.syncRequestReason).toBe("price_changed");
    expect(after.syncRequestedAt!.getTime()).toBeGreaterThan(synced.getTime());

    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 1, removed: 0, blocked: 0 });
    const sent = requestsOf(batchCalls()[0]!);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "UPDATE", data: { id: `v-${f.variantIds[0]}`, price: "1800.00 NGN" } });
  });

  it("hiding a flavour through PATCH /v1/products/:id sends a DELETE for each of its sizes", async () => {
    const f = await seedFlavour({ name: "Seasonal", sizes: [{ sizeMl: 330, priceNgn: 1500 }, { sizeMl: 650, priceNgn: 2500 }] });
    const stays = await seedFlavour({ name: "Stays" });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;

    const cookie = await authOwner(app);
    const hide = await app.request(`/v1/products/${f.productId}`, {
      method: "PATCH",
      headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(hide.status).toBe(200);
    expect((await theLink()).syncRequestReason).toBe("product_updated");

    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 2, blocked: 0 });
    const sent = requestsOf(batchCalls()[0]!);
    expect(sent.map((r) => r.method)).toEqual(["DELETE", "DELETE"]);
    expect(sent.map((r) => r.data).sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      f.variantIds.map((v) => ({ id: `v-${v}` })).sort((x, y) => x.id.localeCompare(y.id)),
    );
    await checkOpenBatches(db, cfg);
    expect((await itemFor(f.variantIds[0]!)).state).toBe("removed");
    expect((await itemFor(stays.variantIds[0]!)).state).toBe("live");

    // Unhide: the sizes come back by the normal upsert (rule R8).
    graphCalls.length = 0;
    await app.request(`/v1/products/${f.productId}`, {
      method: "PATCH",
      headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({ is_active: true }),
    });
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 2, removed: 0, blocked: 0 });
    expect(requestsOf(batchCalls()[0]!).map((r) => r.method)).toEqual(["UPDATE", "UPDATE"]);
  });

  it("a size that was never sent and is hidden needs no request", async () => {
    const f = await seedFlavour({ name: "Never Sent" });
    await db.update(product).set({ isActive: false }).where(eq(product.id, f.productId));
    await link();
    expect(await syncCatalogue(db, cfg, opts)).toEqual({ pushed: 0, removed: 0, blocked: 0 });
    expect(graphCalls).toHaveLength(0);
    expect((await itemFor(f.variantIds[0]!)).state).toBe("removed");
  });

  // ── Nightly reconcile ─────────────────────────────────────────────────────

  it("reconcile deletes a v- item Meta has that we do not, re-sends one Meta lost, and leaves unprefixed items alone", async () => {
    const kept = await seedFlavour({ name: "Kept Juice" });
    const lost = await seedFlavour({ name: "Lost Juice" });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;

    const ghost = `v-${uuid()}`;
    graphHandler = (call) =>
      call.url.includes("/products")
        ? json({
            data: [
              { id: "1", retailer_id: `v-${kept.variantIds[0]}`, availability: "out of stock", review_status: "approved" },
              { id: "2", retailer_id: ghost, availability: "in stock", review_status: "approved" },
              { id: "3", retailer_id: "SKU-FROM-SOMEONE-ELSE", availability: "in stock", review_status: "approved" },
            ],
          })
        : defaultHandler(call);
    expect(await reconcileCatalogue(db, cfg, opts)).toEqual({ missing: 1, extra: 1, unmanaged: 1 });

    const sent = requestsOf(batchCalls()[0]!);
    const byId = new Map(sent.map((r) => [r.data.id, r.method] as const));
    expect(byId.get(ghost)).toBe("DELETE");
    expect(byId.get(`v-${lost.variantIds[0]}`)).toBe("UPDATE");
    expect(byId.has("SKU-FROM-SOMEONE-ELSE")).toBe(false);
    expect((await theLink()).lastReconcileAt).not.toBeNull();
    expect((await batches()).at(-1)!.kind).toBe("reconcile");
    expect(await db.select().from(catalogueItemSync).where(eq(catalogueItemSync.retailerId, "SKU-FROM-SOMEONE-ELSE"))).toHaveLength(0);
  });

  it("reconcile records an item Meta's review rejected and does not send it again by itself", async () => {
    const f = await seedFlavour({ name: "Reviewed Juice" });
    await link();
    await syncCatalogue(db, cfg, opts);
    await checkOpenBatches(db, cfg);
    graphCalls.length = 0;
    graphHandler = (call) =>
      call.url.includes("/products")
        ? json({
            data: [
              {
                id: "1",
                retailer_id: `v-${f.variantIds[0]}`,
                review_status: "rejected",
                errors: [{ title: "Not allowed", description: "This item breaks the commerce policy" }],
              },
            ],
          })
        : defaultHandler(call);
    await reconcileCatalogue(db, cfg, opts);
    expect(await itemFor(f.variantIds[0]!)).toMatchObject({
      state: "rejected",
      reviewStatus: "rejected",
      problemMessage: "Not allowed: This item breaks the commerce policy",
    });
    expect(batchCalls()).toHaveLength(0);
  });
});
