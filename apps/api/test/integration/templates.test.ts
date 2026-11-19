import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, inboxPhoneNumber, inboxTemplate } from "@ms/db";
import { STARTER_TEMPLATES } from "@ms/shared";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 06: /v1/templates. The Graph API is stubbed: the stub keeps "Meta's" templates in a
 * map, answers by URL and method, and can be told how the next create should go (timeout, refuse,
 * file it as Marketing). Nothing reaches Meta. The clock is a variable the tests move by hand
 * (the spec counts edits per day and per month), never the machine's time. The token is fake.
 */

const APP_ID = "1234567890";
const WABA = "WABA-AUTH";
const SESSION = "upload:S1";

interface Dto {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown[];
  meta_template_id: string | null;
  draft: Record<string, unknown> | null;
  draft_updated_at: string | null;
  draft_updated_by_name: string | null;
  last_error: string | null;
  edits_left: { today: number; month: number } | null;
  editable: boolean;
  not_editable_reason: string | null;
  system_use: string | null;
  starter_key: string | null;
}
interface Problem {
  code: string;
  level: string;
  message: string;
}
interface Err {
  error: {
    code: string;
    message: string;
    details: { reason?: string; problems?: Problem[]; meta_code?: string | null; meta_subcode?: string | null };
  };
}

// ── The Graph stub ──────────────────────────────────────────────────────────

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown[];
}
interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  rawBytes: number | null;
}
type CreateMode = "ok" | "timeout-created" | "timeout-lost" | "duplicate" | "marketing" | "bad-shape-once";

const store = new Map<string, MetaTemplate>();
let calls: GraphCall[] = [];
let createMode: CreateMode = "ok";
let seqId = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname.replace(/^\/v[\d.]+\//, ""));
    const raw = init?.body instanceof Uint8Array ? init.body : null;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, query: url.searchParams, headers: (init?.headers ?? {}) as Record<string, string>, body, rawBytes: raw ? raw.byteLength : null });

    if (path === `${APP_ID}/uploads` && method === "POST") return json({ id: SESSION });
    if (path === SESSION && method === "POST") return json({ h: "HANDLE-1" });

    if (path === `${WABA}/message_templates`) {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return json({ data: [...store.values()].filter((t) => !name || t.name === name) });
      }
      if (method === "DELETE") {
        store.delete(url.searchParams.get("hsm_id") ?? "");
        return json({ success: true });
      }
      if (method === "POST") {
        const b = body!;
        if (createMode === "duplicate") return json({ error: { message: "Template name already exists", code: 100, error_subcode: 2388024 } }, 400);
        if (createMode === "bad-shape-once") {
          createMode = "ok";
          return json({ error: { message: "Invalid parameter", code: 100 } }, 400);
        }
        if (createMode === "timeout-lost") throw new TypeError("fetch failed");
        const id = `T${++seqId}`;
        const category = createMode === "marketing" ? "MARKETING" : String(b.category);
        store.set(id, { id, name: String(b.name), language: String(b.language), status: "PENDING", category, components: b.components as unknown[] });
        if (createMode === "timeout-created") throw new TypeError("fetch failed");
        return json({ id, status: "PENDING", category });
      }
    }
    const held = store.get(path);
    if (held) {
      if (method === "GET") return json(held);
      if (method === "POST") {
        held.components = (body!.components as unknown[]) ?? held.components;
        return json({ success: true });
      }
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  }) as typeof fetch;
}

const metaPosts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A draft with nothing to warn about. Each caller passes its own number so no two bodies match. */
const draftFor = (n: number, over: Record<string, unknown> = {}) => ({
  category: "UTILITY",
  header: null,
  body: { text: `Hello {{1}}, your order {{2}} has been received and kitchen station ${n} is packing it now.`, examples: ["Ada", "MS-10482"] },
  footer: "",
  buttons: [] as unknown[],
  ...over,
});
const componentsFor = (n: number) => [
  { type: "BODY", text: `Hello {{1}}, your order {{2}} has been received and kitchen station ${n} is packing it now.`, example: { body_text: [["Ada", "MS-10482"]] } },
];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("template authoring routes", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let manager: string;
  let setClock: (iso: string) => void;
  let deps: { loadSample: (key: string) => Promise<Uint8Array>; now: () => Date };
  let seq = 0;

  async function api(method: string, path: string, body?: unknown, cookie = owner): Promise<Response> {
    // Hono is strict about a trailing slash: the list lives at /v1/templates, not /v1/templates/.
    return fetch(`${baseUrl}/v1/templates${path === "/" ? "" : path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const data = async (res: Response): Promise<Dto> => ((await res.json()) as { data: Dto }).data;
  const err = async (res: Response): Promise<Err["error"]> => ((await res.json()) as Err).error;
  const nextName = (p: string): string => `${p}_${++seq}`;

  async function newDraft(name: string, draft: unknown, language = "en"): Promise<Dto> {
    const res = await api("POST", "/", { waba_id: WABA, name, language, draft });
    expect(res.status).toBe(201);
    return data(res);
  }
  async function seedMeta(over: Partial<typeof inboxTemplate.$inferInsert> & { n: number }): Promise<typeof inboxTemplate.$inferSelect> {
    const { n, ...rest } = over;
    const id = `T${900 + n}`;
    store.set(id, { id, name: `seeded_${n}`, language: "en", status: String(rest.status ?? "APPROVED"), category: "UTILITY", components: componentsFor(n) });
    const [row] = await db
      .insert(inboxTemplate)
      .values({ wabaId: WABA, name: `seeded_${n}`, language: "en", status: "APPROVED", category: "UTILITY", components: componentsFor(n), metaTemplateId: id, ...rest })
      .returning();
    return row!;
  }
  const reload = async (id: string) => (await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, id)))[0]!;
  const audits = async (action: string, entityId: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-secret";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = APP_ID;
    // Made-up storage settings: links are signed locally, nothing is uploaded or fetched.
    process.env.R2_ACCOUNT_ID = "itestaccount";
    process.env.R2_ACCESS_KEY_ID = "itest-access-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "itest-secret-access-key";
    process.env.R2_BUCKET = "itest-bucket";
    installGraphStub();
    await seedOwner(db);
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000300", label: "Main line", channels: "whatsapp", wabaId: WABA, waPhoneNumberId: "5550003333" });

    const { buildApp } = await import("../../src/test-app.js");
    const mod = await import("../../src/routes/templates.js");
    deps = mod.templateDeps;
    let clock = new Date("2026-11-20T09:00:00.000Z");
    setClock = (iso) => {
      clock = new Date(iso);
    };
    deps.now = () => clock;
    deps.loadSample = async () => PNG;
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(() => {
    calls = [];
    createMode = "ok";
    process.env.META_APP_ID = APP_ID;
    setClock("2026-11-20T09:00:00.000Z");
    deps.loadSample = async () => PNG;
  });

  it("every route needs templates.manage", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const routes: [string, string, unknown?][] = [
      ["GET", "/"],
      ["GET", "/options"],
      ["GET", `/${id}`],
      ["POST", "/", { waba_id: WABA, name: "x", language: "en", draft: draftFor(1) }],
      ["PUT", `/${id}/draft`, { draft: draftFor(1), draft_updated_at: null }],
      ["DELETE", `/${id}/draft`],
      ["POST", `/${id}/sample`, { filename: "a.png", content_type: "image/png", size_bytes: 10 }],
      ["GET", `/${id}/sample-url`],
      ["POST", `/${id}/submit`, { draft_updated_at: "2026-11-20T09:00:00.000Z", accept_warnings: false }],
      ["POST", `/${id}/refresh`],
      ["POST", `/${id}/delete`, { confirm_name: "x" }],
      ["POST", "/sync"],
      ["POST", "/starter", { waba_id: WABA, keys: ["order_confirmed"] }],
    ];
    for (const [method, path, body] of routes) {
      const res = await api(method, path, body, manager);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const anon = await fetch(`${baseUrl}/v1/templates`);
    expect(anon.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("options lists the account, languages, limits and the starter set", async () => {
    const res = await api("GET", "/options");
    expect(res.status).toBe(200);
    const { data: o } = (await res.json()) as {
      data: { accounts: { waba_id: string; label: string }[]; languages: unknown[]; limits: { body: number }; sample_upload_ready: boolean; starter: { key: string; exists: boolean }[] };
    };
    expect(o.accounts).toEqual([{ waba_id: WABA, label: "Main line" }]);
    expect(o.languages).toHaveLength(5);
    expect(o.limits.body).toBe(1024);
    expect(o.sample_upload_ready).toBe(true);
    expect(o.starter.map((s) => s.key)).toEqual(STARTER_TEMPLATES.map((s) => s.key));
    expect(o.starter.every((s) => !s.exists)).toBe(true);
    delete process.env.META_APP_ID;
    const off = (await (await api("GET", "/options")).json()) as { data: { sample_upload_ready: boolean } };
    expect(off.data.sample_upload_ready).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("create draft; duplicate key refused; a DELETED key is reused", async () => {
    const name = nextName("draft_a");
    const created = await newDraft(name, draftFor(10));
    expect(created).toMatchObject({
      name,
      language: "en",
      status: "DRAFT",
      category: "UTILITY",
      components: [],
      meta_template_id: null,
      editable: true,
      not_editable_reason: null,
      system_use: null,
      draft_updated_by_name: "owner@example.com",
      draft_updated_at: "2026-11-20T09:00:00.000Z",
    });
    expect(created.draft).toMatchObject({ category: "UTILITY" });
    expect(await audits("template.draft_create", created.id)).toHaveLength(1);

    const dup = await api("POST", "/", { waba_id: WABA, name, language: "en", draft: draftFor(11) });
    expect(dup.status).toBe(409);
    expect((await err(dup)).message).toBe("A template with this name and language already exists.");
    // The same name in another language is a different template.
    const fr = await api("POST", "/", { waba_id: WABA, name, language: "fr", draft: draftFor(12) });
    expect(fr.status).toBe(201);

    // Problems do not stop a draft being saved.
    const broken = await api("POST", "/", { waba_id: WABA, name: nextName("draft_broken"), language: "en", draft: { ...draftFor(13), body: { text: "{{1}}", examples: [] } } });
    expect(broken.status).toBe(201);

    // Bad input is refused with a reason.
    expect((await api("POST", "/", { waba_id: WABA, name: "Bad Name", language: "en", draft: draftFor(14) })).status).toBe(400);
    expect((await api("POST", "/", { waba_id: WABA, name: nextName("x"), language: "yo", draft: draftFor(14) })).status).toBe(400);
    expect((await api("POST", "/", { waba_id: "NOT-OURS", name: nextName("x"), language: "en", draft: draftFor(14) })).status).toBe(400);
    expect((await api("POST", "/", { waba_id: WABA, name: nextName("x"), language: "en", draft: { category: "UTILITY" } })).status).toBe(400);

    // The list shows it; deleting it frees the key and the row is reused.
    const list = (await (await api("GET", "/")).json()) as { data: Dto[] };
    expect(list.data.some((t) => t.id === created.id)).toBe(true);
    const del = await api("POST", `/${created.id}/delete`, { confirm_name: name });
    expect(del.status).toBe(200);
    expect(((await (await api("GET", "/")).json()) as { data: Dto[] }).data.some((t) => t.id === created.id)).toBe(false);
    setClock("2026-11-20T10:00:00.000Z");
    const again = await newDraft(name, draftFor(15));
    expect(again.id).toBe(created.id);
    expect(again.status).toBe("DRAFT");
    expect(again.draft_updated_at).toBe("2026-11-20T10:00:00.000Z");
    expect(calls).toHaveLength(0);
  });

  it("save draft detects a change made elsewhere", async () => {
    const t = await newDraft(nextName("draft_b"), draftFor(20));
    const stamp0 = t.draft_updated_at!;
    setClock("2026-11-20T09:00:05.000Z");
    const saved = await api("PUT", `/${t.id}/draft`, { draft: draftFor(21), draft_updated_at: stamp0 });
    expect(saved.status).toBe(200);
    const s1 = await data(saved);
    expect(s1.draft_updated_at).toBe("2026-11-20T09:00:05.000Z");
    expect((s1.draft as { body: { text: string } }).body.text).toContain("station 21");

    setClock("2026-11-20T09:00:10.000Z");
    const stale = await api("PUT", `/${t.id}/draft`, { draft: draftFor(22), draft_updated_at: stamp0 });
    expect(stale.status).toBe(409);
    const e = await err(stale);
    expect(e.message).toBe("Someone else changed this draft. Reload to see their version.");
    expect(e.details.reason).toBe("changed_elsewhere");
    expect(((await reload(t.id)).draft as { body: { text: string } }).body.text).toContain("station 21");

    const ok = await api("PUT", `/${t.id}/draft`, { draft: draftFor(23), draft_updated_at: s1.draft_updated_at });
    expect(ok.status).toBe(200);
    // Name and language do not change: the body is only the draft.
    expect((await reload(t.id)).name).toBe(t.name);
    // Saving a draft is audited without an owner ping.
    expect((await audits("template.draft_save", t.id)).length).toBe(2);
  });

  it("submit: errors block, warnings need accept_warnings", async () => {
    const bad = await newDraft(nextName("sub_err"), { ...draftFor(30), body: { text: "{{1}} hello", examples: [] } });
    const blocked = await api("POST", `/${bad.id}/submit`, { draft_updated_at: bad.draft_updated_at, accept_warnings: true });
    expect(blocked.status).toBe(400);
    const e = await err(blocked);
    expect(e.details.reason).toBe("validation_failed");
    expect(e.details.problems!.map((p) => p.code)).toEqual(expect.arrayContaining(["blank_edge", "example_missing"]));
    expect(calls).toHaveLength(0);
    expect((await reload(bad.id)).submittedAt).toBeNull();

    const promo = await newDraft(
      nextName("sub_warn"),
      draftFor(31, { body: { text: "Hello {{1}}, enjoy free delivery on your order {{2}} this week and thank you for shopping with us at station 31.", examples: ["Ada", "MS-1"] } }),
    );
    const noTick = await api("POST", `/${promo.id}/submit`, { draft_updated_at: promo.draft_updated_at, accept_warnings: false });
    expect(noTick.status).toBe(400);
    const w = await err(noTick);
    expect(w.details.reason).toBe("warnings");
    expect(w.details.problems!.map((p) => p.code)).toEqual(["utility_promo"]);
    expect(calls).toHaveLength(0);

    const ticked = await api("POST", `/${promo.id}/submit`, { draft_updated_at: promo.draft_updated_at, accept_warnings: true });
    expect(ticked.status).toBe(200);
    expect(metaPosts(`${WABA}/message_templates`)).toHaveLength(1);

    // Nothing to send, and a stale stamp.
    const sent = await data(ticked);
    const nothing = await api("POST", `/${sent.id}/submit`, { draft_updated_at: "2026-11-20T09:00:00.000Z", accept_warnings: true });
    expect(nothing.status).toBe(400);
    expect((await err(nothing)).message).toBe("There is nothing to send. Make a change first.");
    const stale = await newDraft(nextName("sub_stale"), draftFor(32));
    const old = await api("POST", `/${stale.id}/submit`, { draft_updated_at: "2026-11-19T00:00:00.000Z", accept_warnings: true });
    expect(old.status).toBe(409);
    expect((await err(old)).details.reason).toBe("changed_elsewhere");
  });

  it("submit create: sends the right payload, stores Meta's id, status and category, clears the draft, audits", async () => {
    const name = nextName("sub_ok");
    const d = await newDraft(
      name,
      draftFor(40, { footer: "Mrs. Samuel Fruit Juice", buttons: [{ type: "QUICK_REPLY", text: "Call me back" }] }),
    );
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Dto; notice?: string };
    expect(body.notice).toBeUndefined();
    const metaId = body.data.meta_template_id!;
    expect(metaId).toMatch(/^T\d+$/);

    const posts = metaPosts(`${WABA}/message_templates`);
    expect(posts).toHaveLength(1);
    const expectedComponents = [
      { type: "BODY", text: componentsFor(40)[0]!.text, example: { body_text: [["Ada", "MS-10482"]] } },
      { type: "FOOTER", text: "Mrs. Samuel Fruit Juice" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Call me back" }] },
    ];
    expect(posts[0]!.body).toEqual({ name, language: "en", category: "UTILITY", parameter_format: "POSITIONAL", components: expectedComponents });
    // Then it read the template back.
    expect(calls.some((c) => c.method === "GET" && c.path === metaId)).toBe(true);

    const row = await reload(d.id);
    expect(row).toMatchObject({ status: "PENDING", category: "UTILITY", metaTemplateId: metaId, parameterFormat: "POSITIONAL", draft: null, draftUpdatedAt: null, lastError: null });
    expect(row.components).toEqual(expectedComponents);
    expect(row.submittedBy).not.toBeNull();
    expect(body.data).toMatchObject({ status: "PENDING", meta_template_id: metaId, draft: null, editable: false });

    const [audit] = await audits("template.submit", d.id);
    expect(audit).toBeDefined();
    expect(audit!.afterJson).toMatchObject({ name, language: "en", category: "UTILITY", mode: "create", result: "sent", components: expectedComponents, meta_answer: { id: metaId, status: "PENDING", category: "UTILITY" } });
    // The token never appears in what was recorded.
    expect(JSON.stringify(audit)).not.toContain("itest-token");
  });

  it("submit create: Meta files it as MARKETING and the response carries the notice", async () => {
    const d = await newDraft(nextName("sub_mkt"), draftFor(41));
    createMode = "marketing";
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Dto; notice?: string };
    expect(body.notice).toBe("WhatsApp filed this under Marketing instead of Order and account updates.");
    expect(body.data.category).toBe("MARKETING");
    expect((await reload(d.id)).category).toBe("MARKETING");
  });

  it("submit create: the other shape of body examples is tried once when Meta answers code 100", async () => {
    const d = await newDraft(nextName("sub_shape"), draftFor(42));
    createMode = "bad-shape-once";
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(200);
    const posts = metaPosts(`${WABA}/message_templates`);
    expect(posts).toHaveLength(2);
    const bodyOf = (i: number) => ((posts[i]!.body!.components as { example?: { body_text: unknown } }[])[0]!.example!.body_text);
    expect(bodyOf(0)).toEqual([["Ada", "MS-10482"]]);
    expect(bodyOf(1)).toEqual(["Ada", "MS-10482"]);
  });

  it("submit create with a picture heading uploads the sample and puts the handle in the payload", async () => {
    const header = { format: "IMAGE", sampleKey: "inbox/template-samples/2026/11/abc.png", sampleMime: "image/png", sampleName: "sample.png" };
    const d = await newDraft(nextName("sub_img"), draftFor(43, { header }));
    const loaded: string[] = [];
    deps.loadSample = async (key) => {
      loaded.push(key);
      return PNG;
    };
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(200);
    expect(loaded).toEqual([header.sampleKey]);
    const open = calls.find((c) => c.path === `${APP_ID}/uploads`)!;
    expect(open.query.get("file_name")).toBe("sample.png");
    expect(open.query.get("file_length")).toBe(String(PNG.byteLength));
    expect(open.query.get("file_type")).toBe("image/png");
    const send = calls.find((c) => c.path === SESSION)!;
    expect(send.rawBytes).toBe(PNG.byteLength);
    expect(send.headers.authorization).toBe("OAuth itest-token");
    const create = metaPosts(`${WABA}/message_templates`)[0]!;
    expect((create.body!.components as unknown[])[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["HANDLE-1"] } });
  });

  it("submit with a picture heading: no app ID, or a file that is not what it says, is refused before Meta is asked", async () => {
    const header = { format: "IMAGE", sampleKey: "inbox/template-samples/2026/11/abc.png", sampleMime: "image/png", sampleName: "sample.png" };
    const d = await newDraft(nextName("sub_img_bad"), draftFor(44, { header }));
    delete process.env.META_APP_ID;
    const off = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(off.status).toBe(503);
    expect((await err(off)).message).toBe("Sample upload is not set up on this server yet.");
    expect((await reload(d.id)).submittedAt).toBeNull();

    process.env.META_APP_ID = APP_ID;
    deps.loadSample = async () => new TextEncoder().encode("this is not a picture at all");
    const fake = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(fake.status).toBe(400);
    expect((await err(fake)).message).toBe("That sample file is not what it says it is. Choose it again.");
    expect(calls).toHaveLength(0);
    const row = await reload(d.id);
    expect(row.status).toBe("DRAFT");
    expect(row.lastError).toBe("That sample file is not what it says it is. Choose it again.");
    // The draft is still there, and the person can fix the file and send again.
    expect(row.draft).not.toBeNull();
    deps.loadSample = async () => PNG;
    expect((await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false })).status).toBe(200);
  });

  it("submit create: a timeout adopts the template when Meta has it, keeps the draft when it does not", async () => {
    const adopted = await newDraft(nextName("sub_to1"), draftFor(50));
    createMode = "timeout-created";
    const ok = await api("POST", `/${adopted.id}/submit`, { draft_updated_at: adopted.draft_updated_at, accept_warnings: false });
    expect(ok.status).toBe(200);
    const row = await reload(adopted.id);
    expect(row).toMatchObject({ status: "PENDING", draft: null, lastError: null });
    expect(row.metaTemplateId).toMatch(/^T\d+$/);
    expect(metaPosts(`${WABA}/message_templates`)).toHaveLength(1);
    expect(calls.some((c) => c.method === "GET" && c.path === `${WABA}/message_templates` && c.query.get("name") === adopted.name)).toBe(true);

    calls = [];
    const lost = await newDraft(nextName("sub_to2"), draftFor(51));
    createMode = "timeout-lost";
    const res = await api("POST", `/${lost.id}/submit`, { draft_updated_at: lost.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(502);
    const e = await err(res);
    expect(e.message).toBe("WhatsApp did not answer. Nothing was lost. Check the list in a minute before trying again.");
    const kept = await reload(lost.id);
    expect(kept.status).toBe("DRAFT");
    expect(kept.draft).not.toBeNull();
    expect(kept.metaTemplateId).toBeNull();
    expect(kept.lastError).toBe(e.message);
    // Only one create was sent: a timeout is never resubmitted on its own.
    expect(metaPosts(`${WABA}/message_templates`)).toHaveLength(1);
    const [audit] = await audits("template.submit", lost.id);
    expect(audit!.afterJson).toMatchObject({ result: "unknown" });
  });

  it("submit create: duplicate name keeps the draft and explains", async () => {
    const d = await newDraft(nextName("sub_dup"), draftFor(52));
    createMode = "duplicate";
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(409);
    const e = await err(res);
    expect(e.message).toMatch(/^A template with this name and language already exists at WhatsApp\. Press Sync to bring it in, or choose another name\./);
    expect(e.details).toMatchObject({ meta_code: "100", meta_subcode: "2388024" });
    // The same refusal is not tried a second way.
    expect(metaPosts(`${WABA}/message_templates`)).toHaveLength(1);
    const row = await reload(d.id);
    expect(row.status).toBe("DRAFT");
    expect(row.draft).not.toBeNull();
    expect(row.lastError).toMatch(/^A template with this name and language already exists at WhatsApp\./);
    expect(row.lastError).toContain("Meta 100/2388024");
  });

  it("a second submit of a draft that is still being sent is refused", async () => {
    const d = await newDraft(nextName("sub_busy"), draftFor(53));
    await db.update(inboxTemplate).set({ submittedAt: new Date("2026-11-20T09:00:00.000Z"), lastError: null }).where(eq(inboxTemplate.id, d.id));
    setClock("2026-11-20T09:00:30.000Z");
    const res = await api("POST", `/${d.id}/submit`, { draft_updated_at: d.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(409);
    expect((await err(res)).message).toBe("This template is already being sent. Wait a moment.");
    expect(calls).toHaveLength(0);
  });

  it("submit edit of an approved template records the edit and refuses a second one the same day", async () => {
    const t = await seedMeta({ n: 60 });
    const dto = await data(await api("GET", `/${t.id}`));
    expect(dto).toMatchObject({ status: "APPROVED", editable: true, edits_left: { today: 1, month: 10 } });

    const save = await api("PUT", `/${t.id}/draft`, { draft: draftFor(61), draft_updated_at: null });
    expect(save.status).toBe(200);
    const stamp = (await data(save)).draft_updated_at!;
    const first = await api("POST", `/${t.id}/submit`, { draft_updated_at: stamp, accept_warnings: false });
    expect(first.status).toBe(200);
    const edits = metaPosts("T960");
    expect(edits).toHaveLength(1);
    // An approved template's type is never in the edit; the components are replaced whole.
    expect(edits[0]!.body).toEqual({ components: [{ type: "BODY", text: componentsFor(61)[0]!.text, example: { body_text: [["Ada", "MS-10482"]] } }] });
    let row = await reload(t.id);
    expect(row.metaEditTimes).toEqual(["2026-11-20T09:00:00.000Z"]);
    expect(row.draft).toBeNull();
    expect(row.status).toBe("APPROVED");
    expect((await data(await api("GET", `/${t.id}`))).edits_left).toEqual({ today: 0, month: 9 });
    const [audit] = await audits("template.submit", t.id);
    expect(audit!.afterJson).toMatchObject({ mode: "edit", result: "sent" });

    setClock("2026-11-20T10:00:00.000Z");
    const save2 = await data(await api("PUT", `/${t.id}/draft`, { draft: draftFor(62), draft_updated_at: null }));
    const second = await api("POST", `/${t.id}/submit`, { draft_updated_at: save2.draft_updated_at, accept_warnings: false });
    expect(second.status).toBe(409);
    expect((await err(second)).message).toMatch(/^WhatsApp allows one change a day to an approved template\. Try again after /);
    expect(metaPosts("T960")).toHaveLength(1);
    expect((await reload(t.id)).draft).not.toBeNull();

    // More than a day later it goes through, and both edits are on record.
    setClock("2026-11-21T10:00:00.000Z");
    const third = await api("POST", `/${t.id}/submit`, { draft_updated_at: save2.draft_updated_at, accept_warnings: false });
    expect(third.status).toBe(200);
    expect(metaPosts("T960")).toHaveLength(2);
    row = await reload(t.id);
    expect(row.metaEditTimes).toEqual(["2026-11-20T09:00:00.000Z", "2026-11-21T10:00:00.000Z"]);
  });

  it("submit edit refuses an eleventh change in 30 days", async () => {
    const times = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`);
    const t = await seedMeta({ n: 63, metaEditTimes: times });
    const save = await data(await api("PUT", `/${t.id}/draft`, { draft: draftFor(64), draft_updated_at: null }));
    const res = await api("POST", `/${t.id}/submit`, { draft_updated_at: save.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(409);
    expect((await err(res)).message).toMatch(/^WhatsApp allows 10 changes in 30 days to an approved template\. The next one is possible on /);
    expect(metaPosts("T963")).toHaveLength(0);
  });

  it("submit edit refuses a category change on an approved template", async () => {
    const t = await seedMeta({ n: 65 });
    const save = await data(await api("PUT", `/${t.id}/draft`, { draft: draftFor(66, { category: "MARKETING" }), draft_updated_at: null }));
    const res = await api("POST", `/${t.id}/submit`, { draft_updated_at: save.draft_updated_at, accept_warnings: false });
    expect(res.status).toBe(400);
    expect((await err(res)).message).toBe("The type of an approved template cannot be changed. Make a new template instead.");
    expect(calls).toHaveLength(0);
    expect((await reload(t.id)).category).toBe("UTILITY");
  });

  it("a template that is being checked cannot be changed, and one the editor cannot open is read-only", async () => {
    const pending = await seedMeta({ n: 67, status: "PENDING" });
    const res = await api("PUT", `/${pending.id}/draft`, { draft: draftFor(68), draft_updated_at: null });
    expect(res.status).toBe(409);
    expect((await err(res)).message).toBe("WhatsApp is checking this template. You can change it once it has decided.");

    const carousel = await seedMeta({ n: 69, components: [{ type: "BODY", text: "Rare succulents" }, { type: "CAROUSEL", cards: [] }] });
    const dto = await data(await api("GET", `/${carousel.id}`));
    expect(dto.editable).toBe(false);
    expect(dto.not_editable_reason).toMatch(/^This template has a part the suite cannot edit yet \(.*carousel.*\)\. Change it in WhatsApp Manager\.$/);
    const sub = await api("PUT", `/${carousel.id}/draft`, { draft: draftFor(70), draft_updated_at: null });
    expect(sub.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("discarding changes to a Meta template clears the draft; a draft row says delete instead", async () => {
    const t = await seedMeta({ n: 71 });
    await api("PUT", `/${t.id}/draft`, { draft: draftFor(72), draft_updated_at: null });
    const res = await api("DELETE", `/${t.id}/draft`);
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ draft: null, draft_updated_at: null });
    expect(await audits("template.draft_discard", t.id)).toHaveLength(1);

    const d = await newDraft(nextName("disc"), draftFor(73));
    const bad = await api("DELETE", `/${d.id}/draft`);
    expect(bad.status).toBe(400);
    expect((await err(bad)).message).toBe("Delete the draft instead.");
  });

  it("delete: wrong name refused; draft deleted without a Meta call; Meta template deleted by hsm_id and name; DISABLED refused", async () => {
    const draft = await newDraft(nextName("del_draft"), draftFor(80));
    const wrong = await api("POST", `/${draft.id}/delete`, { confirm_name: "nope" });
    expect(wrong.status).toBe(400);
    expect((await err(wrong)).message).toBe("Type the template's name exactly to delete it.");
    expect((await reload(draft.id)).status).toBe("DRAFT");

    const gone = await api("POST", `/${draft.id}/delete`, { confirm_name: draft.name });
    expect(gone.status).toBe(200);
    expect(await data(gone)).toMatchObject({ status: "DELETED", draft: null });
    expect(calls).toHaveLength(0);

    const live = await seedMeta({ n: 81 });
    const del = await api("POST", `/${live.id}/delete`, { confirm_name: live.name });
    expect(del.status).toBe(200);
    expect((await data(del)).status).toBe("DELETED");
    const hit = calls.filter((c) => c.method === "DELETE");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.path).toBe(`${WABA}/message_templates`);
    expect(hit[0]!.query.get("hsm_id")).toBe("T981");
    expect(hit[0]!.query.get("name")).toBe(live.name);
    expect(store.has("T981")).toBe(false);
    const [audit] = await audits("template.delete", live.id);
    expect(audit!.afterJson).toMatchObject({ status: "DELETED", result: "deleted", meta_template_id: "T981" });

    calls = [];
    const off = await seedMeta({ n: 82, status: "DISABLED" });
    const refused = await api("POST", `/${off.id}/delete`, { confirm_name: off.name });
    expect(refused.status).toBe(409);
    expect((await err(refused)).message).toBe("WhatsApp does not allow a switched-off template to be deleted.");
    expect(calls).toHaveLength(0);
    expect((await reload(off.id)).status).toBe("DISABLED");
  });

  it("delete with no Meta ID syncs once, then asks for a sync if it is still unknown", async () => {
    store.clear();
    const old = await seedMeta({ n: 83, metaTemplateId: null });
    store.clear();
    const res = await api("POST", `/${old.id}/delete`, { confirm_name: old.name });
    expect(res.status).toBe(409);
    expect((await err(res)).message).toBe("Press Sync first, then try again.");
    expect(calls.filter((c) => c.method === "GET" && c.path === `${WABA}/message_templates`)).toHaveLength(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("refresh reads one template again; a draft cannot be refreshed", async () => {
    const t = await seedMeta({ n: 84, status: "PENDING" });
    store.get("T984")!.status = "APPROVED";
    const res = await api("POST", `/${t.id}/refresh`);
    expect(res.status).toBe(200);
    expect((await data(res)).status).toBe("APPROVED");
    const d = await newDraft(nextName("refr"), draftFor(85));
    expect((await api("POST", `/${d.id}/refresh`)).status).toBe(400);
  });

  it("sample presign accepts a picture, a video and a PDF and refuses the rest; sample-url needs a sample", async () => {
    const d = await newDraft(nextName("samp"), draftFor(86, { header: { format: "IMAGE", sampleKey: "inbox/template-samples/2026/11/x.png", sampleMime: "image/png", sampleName: "x.png" } }));
    const ok = await api("POST", `/${d.id}/sample`, { filename: "photo.png", content_type: "image/png", size_bytes: 2048 });
    expect(ok.status).toBe(201);
    const out = ((await ok.json()) as { data: { upload_url: string; object_key: string } }).data;
    expect(out.object_key).toMatch(/^inbox\/template-samples\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
    expect(out.upload_url).toContain("itest-bucket");
    expect((await api("POST", `/${d.id}/sample`, { filename: "v.mp4", content_type: "video/mp4", size_bytes: 10 * 1024 * 1024 })).status).toBe(201);
    expect((await api("POST", `/${d.id}/sample`, { filename: "d.pdf", content_type: "application/pdf", size_bytes: 1024 })).status).toBe(201);

    const gif = await api("POST", `/${d.id}/sample`, { filename: "a.gif", content_type: "image/gif", size_bytes: 1024 });
    expect(gif.status).toBe(400);
    expect((await err(gif)).message).toBe("Use a JPG or PNG picture, an MP4 video or a PDF.");
    expect((await api("POST", `/${d.id}/sample`, { filename: "big.png", content_type: "image/png", size_bytes: 6 * 1024 * 1024 })).status).toBe(400);
    expect((await api("POST", `/${d.id}/sample`, { filename: "big.mp4", content_type: "video/mp4", size_bytes: 17 * 1024 * 1024 })).status).toBe(400);

    const link = await api("GET", `/${d.id}/sample-url`);
    expect(link.status).toBe(200);
    expect(((await link.json()) as { data: { url: string } }).data.url).toContain("template-samples");
    const plain = await newDraft(nextName("samp2"), draftFor(87));
    expect((await api("GET", `/${plain.id}/sample-url`)).status).toBe(404);
    expect((await api("GET", `/not-a-uuid`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("GET /v1/inbox/templates hides drafts", async () => {
    const draft = await newDraft(nextName("hidden"), draftFor(90));
    const live = await seedMeta({ n: 91 });
    const res = await fetch(`${baseUrl}/v1/inbox/templates`, { headers: { cookie: owner } });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { data: { name: string }[] }).data.map((t) => t.name);
    expect(names).toContain(live.name);
    expect(names).not.toContain(draft.name);
  });

  it("starter: adds seven drafts once, skips them the second time", async () => {
    const keys = STARTER_TEMPLATES.map((s) => s.key);
    const first = await api("POST", "/starter", { waba_id: WABA, keys });
    expect(first.status).toBe(200);
    const a = ((await first.json()) as { data: { created: string[]; skipped: string[] } }).data;
    expect(a.created).toEqual(keys);
    expect(a.skipped).toEqual([]);
    const rows = await db.select().from(inboxTemplate).where(eq(inboxTemplate.status, "DRAFT"));
    const starters = rows.filter((r) => r.starterKey);
    expect(starters).toHaveLength(7);
    const missed = starters.find((r) => r.name === "missed_call_followup")!;
    expect(missed).toMatchObject({ language: "en", category: "UTILITY", components: [], metaTemplateId: null, starterKey: "missed_call_followup" });
    expect(missed.draft).toEqual(STARTER_TEMPLATES.find((s) => s.key === "missed_call_followup")!.draft);
    expect((await data(await api("GET", `/${missed.id}`))).system_use).toBe("missed_call");

    const second = await api("POST", "/starter", { waba_id: WABA, keys });
    const b = ((await second.json()) as { data: { created: string[]; skipped: string[] } }).data;
    expect(b.created).toEqual([]);
    expect(b.skipped).toEqual(keys);
    expect((await db.select().from(inboxTemplate).where(eq(inboxTemplate.status, "DRAFT"))).filter((r) => r.starterKey)).toHaveLength(7);

    expect((await api("POST", "/starter", { waba_id: WABA, keys: ["no_such_starter"] })).status).toBe(400);
    expect((await api("POST", "/starter", { waba_id: "NOT-OURS", keys })).status).toBe(400);
    expect(calls).toHaveLength(0);
    // Nothing was ever sent to Meta.
    expect(await audits("template.starter_add", WABA)).toHaveLength(2);
  });

  it("sync keeps drafts, adopts a Meta template onto a draft row keeping its draft, marks vanished Meta templates DELETED", async () => {
    store.clear();
    const keepDraft = await newDraft(nextName("sync_draft"), draftFor(100));
    const adoptDraft = await newDraft("adopt_me", draftFor(101));
    const vanished = await seedMeta({ n: 102 });
    store.clear(); // Meta no longer has it
    const kept = await seedMeta({ n: 103, status: "PENDING" });
    store.get("T1003")!.status = "APPROVED";
    store.set("T1004", { id: "T1004", name: "adopt_me", language: "en", status: "APPROVED", category: "UTILITY", components: componentsFor(104) });
    store.set("T1005", { id: "T1005", name: "from_manager", language: "en", status: "APPROVED", category: "MARKETING", components: componentsFor(105) });

    const res = await api("POST", "/sync");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { synced: number } }).data.synced).toBe(3);

    expect((await reload(keepDraft.id)).status).toBe("DRAFT");
    expect((await reload(keepDraft.id)).draft).not.toBeNull();
    const adopted = await reload(adoptDraft.id);
    expect(adopted).toMatchObject({ status: "APPROVED", metaTemplateId: "T1004", category: "UTILITY" });
    expect(adopted.components).toEqual(componentsFor(104));
    expect((adopted.draft as { body: { text: string } }).body.text).toContain("station 101");
    expect((await reload(vanished.id)).status).toBe("DELETED");
    expect((await reload(kept.id)).status).toBe("APPROVED");
    const [made] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.name, "from_manager"));
    expect(made).toMatchObject({ status: "APPROVED", category: "MARKETING", metaTemplateId: "T1005", wabaId: WABA });
    expect((await audits("inbox.templates_sync", "all")).length).toBeGreaterThanOrEqual(1);

    // The inbox's own sync button now runs the same code.
    const again = await fetch(`${baseUrl}/v1/inbox/templates/sync`, { method: "POST", headers: { cookie: owner } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { synced: number } }).data.synced).toBe(3);
    expect((await reload(keepDraft.id)).status).toBe("DRAFT");
  });
});
