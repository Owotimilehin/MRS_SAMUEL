import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, catalogueItemSync, catalogueLink, inboxPhoneNumber, inboxTemplate, type DbClient } from "@ms/db";
import { authOwner, makeTestApp, seedUser } from "./helpers.js";

/**
 * /v1/catalogue (suite spec 08). Meta is never called: every Graph request is
 * answered by the stub below. The token is an obvious fake.
 */
const CATALOG_ID = "123456789012345";
const WABA = "WABA1";
const PNID = "1098765432";

type GraphCall = { method: string; path: string; query: URLSearchParams; body: unknown };
const graphCalls: GraphCall[] = [];
let graphHandler: (call: GraphCall) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let wabaCatalogues: string[] = [];
let commerce = { is_cart_enabled: true, is_catalog_visible: false };
const defaultHandler = (call: GraphCall): Response => {
  if (call.path.endsWith(`/${CATALOG_ID}`) && call.method === "GET") return json({ id: CATALOG_ID, name: "Test Juices", product_count: 0 });
  if (call.path.endsWith(`/${WABA}/product_catalogs`)) {
    if (call.method === "GET") return json({ data: wabaCatalogues.map((id) => ({ id, name: "Test Juices" })) });
    wabaCatalogues = [String((call.body as { catalog_id: string }).catalog_id)];
    return json({ success: true });
  }
  if (call.path.endsWith(`/${PNID}/whatsapp_commerce_settings`)) {
    if (call.method === "GET") return json({ data: [{ ...commerce, id: PNID }] });
    if (call.query.has("is_cart_enabled")) commerce.is_cart_enabled = call.query.get("is_cart_enabled") === "true";
    if (call.query.has("is_catalog_visible")) commerce.is_catalog_visible = call.query.get("is_catalog_visible") === "true";
    return json({ success: true });
  }
  return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
};

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const call: GraphCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    graphCalls.push(call);
    return graphHandler(call);
  }) as typeof fetch;
}

describe("/v1/catalogue", () => {
  let container: StartedPostgreSqlContainer;
  let app: Hono;
  let db: DbClient;
  let owner: Record<string, string>;
  let admin: Record<string, string>;
  let manager: Record<string, string>;
  let cashier: Record<string, string>;

  async function login(email: string): Promise<Record<string, string>> {
    const res = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "userpassword123" }),
    });
    if (!res.ok) throw new Error(`login failed ${res.status}`);
    return { cookie: res.headers.get("set-cookie") ?? "" };
  }

  const call = (who: Record<string, string>, method: string, path: string, body?: unknown) =>
    app.request(`/v1/catalogue${path}`, {
      method,
      headers: { ...who, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    const t = await makeTestApp();
    ({ app, db, container } = t);
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: PNID });
    await seedUser(db, { email: "admin@example.com", role: "admin" });
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    await seedUser(db, { email: "cashier@example.com", role: "branch_staff" });
    owner = await authOwner(app);
    admin = await login("admin@example.com");
    manager = await login("manager@example.com");
    cashier = await login("cashier@example.com");
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    graphCalls.length = 0;
    graphHandler = defaultHandler;
    wabaCatalogues = [];
    commerce = { is_cart_enabled: true, is_catalog_visible: false };
    await db.delete(catalogueLink);
    await db.delete(auditLog);
  });

  const theLink = async () => (await db.select().from(catalogueLink))[0];
  const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
  async function linked(over: Partial<typeof catalogueLink.$inferInsert> = {}) {
    const [row] = await db.insert(catalogueLink).values({ catalogId: CATALOG_ID, name: "Test Juices", wabaId: WABA, ...over }).returning();
    return row!;
  }
  async function item(linkId: string, n: number, over: Partial<typeof catalogueItemSync.$inferInsert> = {}) {
    const retailerId = `v-00000000-0000-4000-8000-00000000000${n}`;
    const [row] = await db
      .insert(catalogueItemSync)
      .values({
        linkId,
        retailerId,
        title: `Juice ${n} 330ml`,
        desired: {
          id: retailerId,
          title: `Juice ${n} 330ml`,
          description: "Fresh.",
          availability: "in stock",
          condition: "new",
          price: "1500.00 NGN",
          link: "https://www.example.test/juices/j",
          image: [{ url: "https://www.example.test/media/j.png" }],
          brand: "Mrs. Samuel",
          item_group_id: "g",
          size: "330 ml",
          google_product_category: "Food, Beverages & Tobacco > Beverages > Juice",
        },
        desiredHash: "h",
        state: "live",
        ...over,
      })
      .returning();
    return row!;
  }

  it("GET /v1/catalogue/status needs catalogue.manage (403 for a manager, 200 for an admin)", async () => {
    expect((await app.request("/v1/catalogue/status")).status).toBe(401);
    expect((await call(manager, "GET", "/status")).status).toBe(403);
    expect((await call(cashier, "GET", "/status")).status).toBe(403);
    const res = await call(admin, "GET", "/status");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      configured: true,
      link: null,
      online_branch: null,
      counts: { live: 0, pending: 0, sent: 0, rejected: 0, blocked: 0, removed: 0 },
      templates: { order_confirmed: "missing", order_paid: "missing", order_out_for_delivery: "missing", order_delivered: "missing" },
    });
    // The status never carries the token.
    expect(JSON.stringify(data)).not.toContain("itest-token");
  });

  it("GET /status counts items by state and reports the order templates", async () => {
    const link = await linked({ syncEnabled: true });
    await item(link.id, 1);
    await item(link.id, 2, { state: "rejected", problemMessage: "Image could not be downloaded" });
    await item(link.id, 3, { state: "blocked", desired: null, blockedReason: "no_picture" });
    await db.insert(inboxTemplate).values({ wabaId: WABA, name: "order_paid", language: "en", status: "APPROVED", components: [] });
    await db.insert(inboxTemplate).values({ wabaId: WABA, name: "order_delivered", language: "en", status: "PENDING", components: [] });
    const { data } = (await (await call(owner, "GET", "/status")).json()) as {
      data: { link: { catalog_id: string; sync_enabled: boolean; problem: unknown }; counts: Record<string, number>; templates: Record<string, string> };
    };
    expect(data.link).toMatchObject({ catalog_id: CATALOG_ID, sync_enabled: true, problem: null });
    expect(data.counts).toEqual({ live: 1, pending: 0, sent: 0, rejected: 1, blocked: 1, removed: 0 });
    expect(data.templates).toEqual({ order_confirmed: "missing", order_paid: "APPROVED", order_out_for_delivery: "missing", order_delivered: "PENDING" });
    await db.delete(inboxTemplate);
  });

  it("GET /status clears a configuration problem once the catalogue can be reached again", async () => {
    await linked({ syncEnabled: true, problemKind: "config", problemCode: "200", problemMessage: "(#200) Permissions error", problemAt: new Date() });
    graphHandler = () => json({ error: { message: "(#200) Permissions error", code: 200 } }, 403);
    const still = (await (await call(admin, "GET", "/status")).json()) as { data: { link: { problem: { kind: string; code: string; plain: string } } } };
    expect(still.data.link.problem).toMatchObject({
      kind: "config",
      code: "200",
      plain: "Meta says we do not have permission to manage this catalogue. Check the system user still has full control of it.",
    });
    graphHandler = defaultHandler;
    const cleared = (await (await call(admin, "GET", "/status")).json()) as { data: { link: { problem: unknown } } };
    expect(cleared.data.link.problem).toBeNull();
    expect((await theLink())!.problemKind).toBeNull();
  });

  it("POST /link stores the catalogue, refuses a second, and returns 422 with a plain message when Meta refuses", async () => {
    expect((await call(manager, "POST", "/link", { catalog_id: CATALOG_ID })).status).toBe(403);
    const bad = await call(admin, "POST", "/link", { catalog_id: "abc" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe(
      "That doesn't look like a catalogue ID. It should be numbers only.",
    );
    expect(graphCalls).toHaveLength(0);

    graphHandler = () => json({ error: { message: "Unsupported get request. Object does not exist", code: 100, error_subcode: 33 } }, 400);
    const refused = await call(admin, "POST", "/link", { catalog_id: CATALOG_ID });
    expect(refused.status).toBe(422);
    const refusedBody = (await refused.json()) as { error: { message: string; details: { reason: string; meta_message: string } } };
    expect(refusedBody.error.details.reason).toBe("catalogue_unreachable");
    expect(refusedBody.error.message).toContain("Meta wouldn't let us open that catalogue.");
    expect(refusedBody.error.details.meta_message).toContain("Unsupported get request");
    expect(await theLink()).toBeUndefined();

    graphHandler = defaultHandler;
    const ok = await call(admin, "POST", "/link", { catalog_id: CATALOG_ID });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      catalog_id: CATALOG_ID,
      name: "Test Juices",
      whatsapp_connected: false,
      // Every switch starts off.
      sync_enabled: false,
      ask_fulfilment_auto: false,
      order_updates_enabled: false,
    });
    expect(await theLink()).toMatchObject({ catalogId: CATALOG_ID, wabaId: WABA, syncEnabled: false });
    expect(await audits("catalogue.link")).toHaveLength(1);

    const again = await call(admin, "POST", "/link", { catalog_id: "999999999" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("already_linked");

    const gone = await call(admin, "DELETE", "/link");
    expect(gone.status).toBe(200);
    expect(await theLink()).toBeUndefined();
    expect(await audits("catalogue.unlink")).toHaveLength(1);
    // Nothing was deleted at Meta.
    expect(graphCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("POST /link notices a catalogue already connected in WhatsApp Manager", async () => {
    wabaCatalogues = [CATALOG_ID];
    const res = await call(admin, "POST", "/link", { catalog_id: CATALOG_ID });
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      whatsapp_connected: true,
      is_cart_enabled: true,
      is_catalog_visible: false,
    });
  });

  it("POST /connect-whatsapp calls product_catalogs then whatsapp_commerce_settings and writes an audit row", async () => {
    await linked();
    expect((await call(admin, "POST", "/connect-whatsapp", {})).status).toBe(400);
    expect(graphCalls).toHaveLength(0);

    const res = await call(admin, "POST", "/connect-whatsapp", { confirm: true });
    expect(res.status).toBe(200);
    expect(graphCalls.map((c) => `${c.method} ${c.path.split("/").slice(2).join("/")}`)).toEqual([
      `POST ${WABA}/product_catalogs`,
      `POST ${PNID}/whatsapp_commerce_settings`,
      `GET ${PNID}/whatsapp_commerce_settings`,
    ]);
    expect(graphCalls[0]!.body).toEqual({ catalog_id: CATALOG_ID });
    expect(graphCalls[1]!.query.get("is_cart_enabled")).toBe("true");
    expect(graphCalls[1]!.query.get("is_catalog_visible")).toBe("true");
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      whatsapp_connected: true,
      is_cart_enabled: true,
      is_catalog_visible: true,
    });
    expect(await theLink()).toMatchObject({ whatsappConnected: true, isCartEnabled: true, isCatalogVisible: true });
    const rows = await audits("catalogue.connect_whatsapp");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.afterJson).toMatchObject({ catalog_id: CATALOG_ID, waba_id: WABA, numbers: 1 });
  });

  it("POST /connect-whatsapp shows Meta's refusal in plain words and changes nothing", async () => {
    await linked();
    graphHandler = (c) =>
      c.path.endsWith("/product_catalogs") ? json({ error: { message: "(#100) Test accounts cannot connect a catalog", code: 100 } }, 400) : defaultHandler(c);
    const res = await call(admin, "POST", "/connect-whatsapp", { confirm: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string; details: { reason: string } } };
    expect(body.error.details.reason).toBe("connect_refused");
    expect(body.error.message).toBe("WhatsApp would not connect this catalogue. Meta said: (#100) Test accounts cannot connect a catalog");
    expect((await theLink())!.whatsappConnected).toBe(false);
    expect(await audits("catalogue.connect_whatsapp")).toHaveLength(0);
  });

  it("PATCH /settings refuses order_updates_enabled for a non-owner", async () => {
    await linked();
    for (const body of [{ order_updates_enabled: true }, { ask_fulfilment_auto: true }, { sync_enabled: true, order_updates_enabled: true }]) {
      const res = await call(admin, "PATCH", "/settings", body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { message: string; details: { reason: string } } }).error).toMatchObject({
        message: "Only the owner can change this.",
        details: { reason: "owner_only" },
      });
    }
    expect(await theLink()).toMatchObject({ syncEnabled: false, orderUpdatesEnabled: false, askFulfilmentAuto: false });

    // An admin may switch sync on; that asks for a pass straight away.
    const sync = await call(admin, "PATCH", "/settings", { sync_enabled: true });
    expect(sync.status).toBe(200);
    expect(await theLink()).toMatchObject({ syncEnabled: true, syncRequestReason: "sync_enabled" });
    expect((await theLink())!.syncRequestedAt).not.toBeNull();

    // The owner may switch on both.
    const own = await call(owner, "PATCH", "/settings", { order_updates_enabled: true, ask_fulfilment_auto: true });
    expect(own.status).toBe(200);
    expect(await theLink()).toMatchObject({ orderUpdatesEnabled: true, askFulfilmentAuto: true });
    const rows = await audits("catalogue.settings");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => (r.afterJson as Record<string, unknown>)["order_updates_enabled"] === true)!.beforeJson).toEqual({
      order_updates_enabled: false,
      ask_fulfilment_auto: false,
    });
    expect((await call(admin, "PATCH", "/settings", {})).status).toBe(400);
    expect((await call(admin, "PATCH", "/settings", { name: "x" })).status).toBe(400);
  });

  it("PATCH /settings sends the cart and menu switches to Meta first; a refusal changes nothing here", async () => {
    await linked({ whatsappConnected: true, isCartEnabled: true, isCatalogVisible: true });
    const off = await call(admin, "PATCH", "/settings", { is_cart_enabled: false });
    expect(off.status).toBe(200);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.query.get("is_cart_enabled")).toBe("false");
    expect(graphCalls[0]!.query.has("is_catalog_visible")).toBe(false);
    expect((await theLink())!.isCartEnabled).toBe(false);

    graphHandler = () => json({ error: { message: "(#80008) Too many calls", code: 80008 } }, 400);
    const refused = await call(admin, "PATCH", "/settings", { is_catalog_visible: false });
    expect(refused.status).toBe(422);
    expect((await theLink())!.isCatalogVisible).toBe(true);
  });

  it("POST /sync sets the flags the worker reads and sends nothing itself", async () => {
    expect((await call(admin, "POST", "/sync", { mode: "changes" })).status).toBe(404);
    await linked({ syncEnabled: true });
    const res = await call(admin, "POST", "/sync", { mode: "changes" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { queued: true } });
    expect((await theLink())!.syncRequestedAt).not.toBeNull();
    expect((await theLink())!.fullSyncRequestedAt).toBeNull();
    expect((await call(admin, "POST", "/sync", { mode: "full" })).status).toBe(202);
    expect((await theLink())!.fullSyncRequestedAt).not.toBeNull();
    expect(await audits("catalogue.sync_requested")).toHaveLength(2);
    expect(graphCalls).toHaveLength(0);
    expect((await call(manager, "POST", "/sync", { mode: "full" })).status).toBe(403);
  });

  it("GET /items lists refused and not-sent items first, with plain reasons, and filters", async () => {
    const link = await linked();
    await item(link.id, 1, { title: "Apple 330ml" });
    await item(link.id, 2, { title: "Banana 330ml", state: "rejected", problemMessage: "Image could not be downloaded" });
    await item(link.id, 3, { title: "Cherry 330ml", state: "blocked", desired: null, blockedReason: "no_price" });
    expect((await call(manager, "GET", "/items")).status).toBe(403);
    const { data } = (await (await call(admin, "GET", "/items")).json()) as {
      data: { total: number; items: { title: string; state: string; price_ngn: number | null; availability: string | null; picture_url: string | null; problem_plain: string | null; problem_raw: string | null }[] };
    };
    expect(data.total).toBe(3);
    expect(data.items.map((i) => i.title)).toEqual(["Banana 330ml", "Cherry 330ml", "Apple 330ml"]);
    expect(data.items[0]).toMatchObject({
      state: "rejected",
      price_ngn: 1500,
      availability: "in stock",
      picture_url: "https://www.example.test/media/j.png",
      problem_raw: "Image could not be downloaded",
    });
    expect(data.items[0]!.problem_plain).toContain("Meta could not use this picture.");
    expect(data.items[1]).toMatchObject({ state: "blocked", price_ngn: null, problem_plain: "This size has no price. Set one in the shop admin.", problem_raw: null });
    expect(data.items[2]).toMatchObject({ state: "live", problem_plain: null });

    const filtered = (await (await call(admin, "GET", "/items?state=live&q=app")).json()) as { data: { total: number; items: { title: string }[] } };
    expect(filtered.data).toMatchObject({ total: 1, items: [{ title: "Apple 330ml" }] });
    expect((await call(admin, "GET", "/items?state=nonsense")).status).toBe(400);
  });

  it("POST /items/:id/retry puts a rejected item back to pending", async () => {
    const link = await linked({ syncEnabled: true });
    const row = await item(link.id, 1, { state: "rejected", pushedHash: "old", problemMessage: "Invalid price", reviewStatus: "rejected" });
    expect((await call(manager, "POST", `/items/${row.id}/retry`)).status).toBe(403);
    expect((await call(admin, "POST", "/items/not-an-id/retry")).status).toBe(404);
    const res = await call(admin, "POST", `/items/${row.id}/retry`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { state: string; problem_plain: unknown } }).data).toMatchObject({ state: "pending", problem_plain: null });
    const [after] = await db.select().from(catalogueItemSync).where(eq(catalogueItemSync.id, row.id));
    expect(after).toMatchObject({ state: "pending", pushedHash: null, problemMessage: null, reviewStatus: null });
    expect(await theLink()).toMatchObject({ syncRequestReason: "retry" });
    expect(await audits("catalogue.item_retry")).toHaveLength(1);
    expect(graphCalls).toHaveLength(0);
  });

  it("GET /sendable needs inbox.reply and lists only live and sent items", async () => {
    expect((await call(cashier, "GET", "/sendable")).status).toBe(403);
    // No link, or not connected to WhatsApp: an empty list, not an error.
    expect(await (await call(manager, "GET", "/sendable")).json()).toEqual({ data: { catalog_id: null, items: [] } });
    const link = await linked();
    await item(link.id, 1);
    expect(await (await call(manager, "GET", "/sendable")).json()).toEqual({ data: { catalog_id: null, items: [] } });

    await db.update(catalogueLink).set({ whatsappConnected: true });
    await item(link.id, 2, { state: "sent" });
    await item(link.id, 3, { state: "pending" });
    await item(link.id, 4, { state: "rejected" });
    await item(link.id, 5, { state: "removed", desired: null });
    await item(link.id, 6, { state: "blocked", desired: null });
    const { data } = (await (await call(manager, "GET", "/sendable")).json()) as {
      data: { catalog_id: string; items: { retailer_id: string; title: string; price_ngn: number; availability: string }[] };
    };
    expect(data.catalog_id).toBe(CATALOG_ID);
    expect(data.items.map((i) => i.title).sort()).toEqual(["Juice 1 330ml", "Juice 2 330ml"]);
    expect(data.items[0]).toMatchObject({ price_ngn: 1500, availability: "in stock" });
    const one = (await (await call(manager, "GET", "/sendable?q=juice%202")).json()) as { data: { items: unknown[] } };
    expect(one.data.items).toHaveLength(1);
  });
});
