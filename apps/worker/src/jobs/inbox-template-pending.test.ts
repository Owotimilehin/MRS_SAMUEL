import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDbClient, inboxTemplate, outboxEvent } from "@ms/db";
import { refreshPendingTemplates } from "./inbox-whatsapp.js";

/**
 * Suite spec 06, section 6: the job that asks Meta about templates still in review. Real Postgres
 * (testcontainers); Meta is stubbed. The clock is passed in, never read.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const log = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-07-01T12:00:00Z");

type Answer = (id: string) => Response;
const asked: string[] = [];
let answer: Answer = () => new Response("{}", { status: 404 });

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      const id = new URL(url).pathname.split("/").pop() ?? "";
      asked.push(id);
      return answer(id);
    }
    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;
}
const ok = (id: string, status: string, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ id, name: `n_${id}`, language: "en", status, category: "UTILITY", components: [{ type: "BODY", text: "Hi" }], ...extra }), { status: 200 });

describe("refreshPendingTemplates", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    process.env.META_SYSTEM_USER_TOKEN = "itest-worker-token";
    installStub();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    asked.length = 0;
    await db.delete(outboxEvent);
    await db.delete(inboxTemplate);
  });

  async function seed(i: number, over: Partial<typeof inboxTemplate.$inferInsert> = {}) {
    const [row] = await db
      .insert(inboxTemplate)
      .values({
        wabaId: "WABA-P",
        name: `n_P${i}`,
        language: "en",
        status: "PENDING",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hi" }],
        metaTemplateId: `P${i}`,
        syncedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        ...over,
      })
      .returning();
    return row!;
  }
  const statusOf = async (i: number) =>
    (await db.select().from(inboxTemplate).where(eq(inboxTemplate.metaTemplateId, `P${i}`)))[0]!.status;

  it("refreshes PENDING rows oldest first, at most 20, and stops on a rate limit", async () => {
    for (let i = 0; i < 25; i++) await seed(i);
    await seed(100, { metaTemplateId: null, name: "no_meta_id" }); // never sent: nothing to ask about
    await seed(101, { status: "APPROVED" }); // not waiting
    answer = (id) => ok(id, "APPROVED");

    const done = await refreshPendingTemplates(db, log, { now: NOW });
    expect(done).toBe(20);
    expect(asked).toEqual(Array.from({ length: 20 }, (_, i) => `P${i}`));
    expect(await statusOf(0)).toBe("APPROVED");
    expect(await statusOf(19)).toBe("APPROVED");
    expect(await statusOf(20)).toBe("PENDING");
    expect(await statusOf(24)).toBe("PENDING");

    // Next run: the five left, oldest first (the refreshed ones are no longer waiting).
    asked.length = 0;
    expect(await refreshPendingTemplates(db, log, { now: NOW })).toBe(5);
    expect(asked).toEqual(["P20", "P21", "P22", "P23", "P24"]);

    // A rate limit stops the run.
    await db.delete(inboxTemplate);
    for (let i = 0; i < 6; i++) await seed(i);
    asked.length = 0;
    answer = (id) => (id === "P2" ? new Response(JSON.stringify({ error: { message: "Too many calls", code: 80008 } }), { status: 429 }) : ok(id, "APPROVED"));
    expect(await refreshPendingTemplates(db, log, { now: NOW })).toBe(2);
    expect(asked).toEqual(["P0", "P1", "P2"]);
    expect(await statusOf(2)).toBe("PENDING");
    expect(await statusOf(3)).toBe("PENDING");
  });

  it("skips a template Meta refuses to read and carries on", async () => {
    for (let i = 0; i < 3; i++) await seed(i);
    answer = (id) => (id === "P0" ? new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400 }) : ok(id, "APPROVED"));
    expect(await refreshPendingTemplates(db, log, { now: NOW })).toBe(2);
    expect(asked).toEqual(["P0", "P1", "P2"]);
    expect(await statusOf(0)).toBe("PENDING");
    expect(await statusOf(1)).toBe("APPROVED");
  });

  it("a refusal found here raises the same owner alert as the webhook", async () => {
    const t = await seed(0);
    answer = (id) => ok(id, "REJECTED", { rejected_reason: "INVALID_FORMAT" });
    await refreshPendingTemplates(db, log, { now: NOW });
    const row = (await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, t.id)))[0]!;
    expect(row).toMatchObject({ status: "REJECTED", rejectedReason: "INVALID_FORMAT" });
    const alerts = (await db.select().from(outboxEvent)).filter((e) => e.eventType === "inbox.template_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ kind: "rejected", template_id: t.id, reason: "INVALID_FORMAT" });
    // Looking again does not alert again.
    await refreshPendingTemplates(db, log, { now: NOW });
    expect((await db.select().from(outboxEvent)).filter((e) => e.eventType === "inbox.template_alert")).toHaveLength(1);
  });

  it("also reads a template whose category change has come due, once", async () => {
    await seed(0, {
      status: "APPROVED",
      correctCategory: "MARKETING",
      categoryChangeAt: new Date("2026-06-01T00:00:00Z"),
      syncedAt: new Date("2026-05-01T00:00:00Z"),
    });
    await seed(1, {
      status: "APPROVED",
      correctCategory: "MARKETING",
      categoryChangeAt: new Date("2026-08-01T00:00:00Z"), // not due yet
      syncedAt: new Date("2026-05-01T00:00:00Z"),
    });
    answer = (id) => ok(id, "APPROVED", { category: "MARKETING" });
    expect(await refreshPendingTemplates(db, log, { now: NOW })).toBe(1);
    expect(asked).toEqual(["P0"]);
    const [row] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.metaTemplateId, "P0"));
    expect(row!.category).toBe("MARKETING");
    asked.length = 0;
    expect(await refreshPendingTemplates(db, log, { now: NOW })).toBe(0);
    expect(asked).toEqual([]);
  });
});
