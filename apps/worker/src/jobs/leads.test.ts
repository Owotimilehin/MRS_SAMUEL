import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDbClient, inboxConversation, inboxPhoneNumber, lead, leadForm, outboxEvent } from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { backfillLeads, fetchLeads, syncForms } from "./leads.js";

/**
 * Suite spec 13 worker jobs, against a real Postgres (testcontainers). The Graph
 * API is stubbed; nothing reaches Meta. Nothing depends on the wall clock: the
 * jobs get NOW and every next_fetch_at is set by the test. No person is real.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const PAGE_ID = "100200300400";
const FORM_ID = "777000111222";
const FORM_REFUSED = "777000111999";
const NOW = new Date("2026-06-01T09:00:00.000Z");
const log = { info: () => {}, warn: () => {}, error: () => {} };
const cfg = { token: "itest-system-user-token", graphVersion: "v23.0" };
const QUESTIONS = [
  { key: "full_name", label: "Full name", type: "FULL_NAME" },
  { key: "phone_number", label: "Phone number", type: "PHONE" },
];

const graphCalls: { method: string; path: string }[] = [];
/** Lead IDs Meta answers "busy" for. */
const busy = new Set<string>();

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call in test: ${url}`);
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v[\d.]+\//, "");
    const fields = u.searchParams.get("fields") ?? "";
    graphCalls.push({ method: init?.method ?? "GET", path: p });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const fail = (code: number, message: string, status = 400) => new Response(JSON.stringify({ error: { code, message } }), { status });
    if (fields === "access_token") return ok({ access_token: "itest-worker-page-token" });
    if (p.endsWith("/leadgen_forms")) return ok({ data: [{ id: FORM_ID, name: "Bulk orders" }] });
    if (p === `${FORM_REFUSED}/leads`) return fail(200, "(#200) Requires leads_retrieval permission", 403);
    if (p === FORM_ID) return fields.includes("questions") ? ok({ id: FORM_ID, name: "Bulk orders", questions: QUESTIONS }) : ok({ status: "ACTIVE" });
    if (busy.has(p)) return fail(80005, "Too many leadgen api calls to this Page");
    if (/^5550009\d+$/.test(p)) {
      if (fields.includes("ad_name")) return ok({});
      return ok({ id: p, created_time: "2026-05-30T10:00:00+0000", form_id: FORM_ID, field_data: [{ name: "full_name", values: [`Person ${p.slice(-2)}`] }] });
    }
    return fail(100, "Unsupported get request. Object does not exist");
  }) as typeof fetch;
}

describe("spec 13 worker: lead jobs", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;

  const seed = async (leadgenId: string, nextFetchAt: Date, createdAt: Date) =>
    (await db.insert(lead).values({ leadgenId, formId: FORM_ID, pageId: PAGE_ID, nextFetchAt, createdAt }).returning())[0]!;
  const read = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]!;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    installStub();
    clearPageTokenCache();
    await db
      .insert(inboxPhoneNumber)
      .values({ kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, label: "Facebook Page", channels: "whatsapp" });
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("every job does nothing when Meta is not configured", async () => {
    graphCalls.length = 0;
    expect(await fetchLeads(db, log, null, NOW)).toBe(0);
    expect(await backfillLeads(db, log, null, NOW)).toBe(0);
    expect(await syncForms(db, log, null, NOW)).toBe(0);
    expect(graphCalls).toHaveLength(0);
  });

  it("lead_fetch reads due leads oldest first and stops the tick at the first temporary error", async () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    const a = await seed("555000900001", minutesAgo(5), minutesAgo(50));
    const b = await seed("555000900002", minutesAgo(5), minutesAgo(40));
    const c = await seed("555000900003", minutesAgo(5), minutesAgo(30));
    const notDue = await seed("555000900004", new Date(NOW.getTime() + 60_000), minutesAgo(60));
    busy.add("555000900002");

    expect(await fetchLeads(db, log, cfg, NOW)).toBe(1);
    expect(await read(a.id)).toMatchObject({ fetchState: "fetched", fullName: "Person 01" });
    expect(await read(b.id)).toMatchObject({ fetchState: "pending", fetchAttempts: 1, fetchErrorCode: "80005" });
    expect((await read(b.id)).nextFetchAt.toISOString()).toBe(new Date(NOW.getTime() + 30_000).toISOString());
    // The tick stopped: the third was not tried, and the one that is not due was never picked.
    expect(await read(c.id)).toMatchObject({ fetchState: "pending", fetchAttempts: 0 });
    expect(await read(notDue.id)).toMatchObject({ fetchState: "pending", fetchAttempts: 0 });
    expect(graphCalls.some((g) => g.path === "555000900003" || g.path === "555000900004")).toBe(false);

    // Next tick, 30 seconds later, Meta is no longer busy.
    busy.clear();
    expect(await fetchLeads(db, log, cfg, new Date(NOW.getTime() + 30_000))).toBe(2);
    expect(await read(b.id)).toMatchObject({ fetchState: "fetched" });
    expect(await read(c.id)).toMatchObject({ fetchState: "fetched" });
    // There is no WhatsApp line here, so no conversation was opened and nothing was sent.
    expect(await db.select().from(inboxConversation)).toHaveLength(0);
    expect(graphCalls.some((g) => g.method === "POST")).toBe(false);
  });

  it("lead_forms_sync stores the Page's forms with their questions", async () => {
    expect(await syncForms(db, log, cfg, NOW)).toBe(1);
    const [form] = await db.select().from(leadForm).where(eq(leadForm.formId, FORM_ID));
    expect(form).toMatchObject({ name: "Bulk orders", pageId: PAGE_ID, status: "ACTIVE" });
    expect(form!.questions).toHaveLength(2);
  });

  it("lead_backfill stops when Meta will not let us read the form's leads, says why and tells the owner once", async () => {
    expect(await backfillLeads(db, log, cfg, NOW)).toBe(0); // nothing is waiting
    const [form] = await db
      .insert(leadForm)
      .values({ formId: FORM_REFUSED, pageId: PAGE_ID, name: "Refused form", questions: QUESTIONS, backfillRequestedAt: NOW })
      .returning();
    expect(await backfillLeads(db, log, cfg, NOW)).toBe(0);
    const [after] = await db.select().from(leadForm).where(eq(leadForm.id, form!.id));
    expect(after!.backfillDoneAt?.toISOString()).toBe(NOW.toISOString());
    expect(after!.backfillError).toBe("200: (#200) Requires leads_retrieval permission");
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "lead.fetch_blocked"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account: PAGE_ID, code: "200" });
    // It is finished (stopped): the next tick does not try again.
    graphCalls.length = 0;
    expect(await backfillLeads(db, log, cfg, NOW)).toBe(0);
    expect(graphCalls).toHaveLength(0);
  });
});
