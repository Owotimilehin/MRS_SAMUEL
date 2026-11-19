import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  adminUser,
  appSetting,
  contactConsent,
  contactImport,
  contactImportRow,
  contactOrigin,
  contactSummary,
  createDbClient,
  customer,
} from "@ms/db";
import {
  CONTACT_SUMMARY_WATERMARK_KEY,
  applyContactImports,
  cleanupContactImports,
  rebuildContactSummaries,
  refreshContactSummaries,
  sendContactConsentConfirmations,
} from "./contacts.js";

/**
 * Suite spec 14 (Phase A) worker jobs against a real Postgres (testcontainers).
 * Nothing here calls Meta: the one job that could is checked only with WhatsApp
 * not configured, and fetch is stubbed to fail loudly if anything tries.
 * Times are fixed; phone numbers are in the made-up range 0700 555 4xxx.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const log = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("contacts worker jobs", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let userId: string;
  const realFetch = globalThis.fetch;
  const outsideCalls: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const url = container.getConnectionUri();
    const sql = postgres(url, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(url);
    const [u] = await db.insert(adminUser).values({ email: "importer@example.com", passwordHash: "not-a-real-hash", role: "admin" }).returning();
    userId = u!.id;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      outsideCalls.push(url);
      throw new Error(`unexpected outside call in a test: ${url}`);
    }) as typeof fetch;
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.stop();
  });

  async function summaryOf(id: string) {
    const [row] = await db.select().from(contactSummary).where(eq(contactSummary.customerId, id));
    return row ?? null;
  }

  async function makeImport(
    rows: { name?: string | null; phone?: string | null; email?: string | null; outcome: "new" | "matched" | "rejected" }[],
    v: Partial<typeof contactImport.$inferInsert> = {},
  ): Promise<string> {
    const [imp] = await db
      .insert(contactImport)
      .values({ filename: "worker.csv", status: "applying", sourceLabel: "test sheet", customerSource: "phone", totalRows: rows.length, createdBy: userId, ...v })
      .returning();
    await db.insert(contactImportRow).values(
      rows.map((r, i) => ({
        importId: imp!.id,
        rowNo: i + 1,
        raw: { Name: r.name ?? "", Phone: r.phone ?? "" },
        name: r.name ?? null,
        phoneE164: r.phone ?? null,
        email: r.email ?? null,
        outcome: r.outcome,
      })),
    );
    return imp!.id;
  }

  it("contact_summary_refresh builds every row the first time, then follows changes from its watermark", async () => {
    const [a] = await db.insert(customer).values({ name: "Worker Ada", phone: "+2347005554001", source: "online" }).returning();
    const [gone] = await db.insert(customer).values({ name: "Worker Gone", source: "online", deletedAt: daysAgo(1) }).returning();
    expect(await summaryOf(a!.id)).toBeNull();

    // No watermark yet: everyone is summarised once, and the watermark is stored.
    const first = await refreshContactSummaries(db, log, { now: NOW });
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await summaryOf(a!.id)).toMatchObject({ nameSort: "worker ada", phoneDigits: "7005554001", hasPhone: true });
    expect(await summaryOf(gone!.id)).toBeNull();
    const [mark] = await db.select().from(appSetting).where(eq(appSetting.key, CONTACT_SUMMARY_WATERMARK_KEY));
    expect(mark!.value).toEqual({ at: NOW.toISOString() });

    // A customer changed in the shop afterwards (updated_at is set by whoever changes the row).
    const later = new Date(NOW.getTime() + 60_000);
    await db.update(customer).set({ name: "Worker Ada Renamed", updatedAt: later }).where(eq(customer.id, a!.id));
    const [b] = await db.insert(customer).values({ name: "Worker Bola", source: "online", createdAt: later, updatedAt: later }).returning();
    const second = await refreshContactSummaries(db, log, { now: new Date(later.getTime() + 60_000) });
    expect(second).toBeGreaterThanOrEqual(2);
    expect((await summaryOf(a!.id))!.nameSort).toBe("worker ada renamed");
    expect(await summaryOf(b!.id)).not.toBeNull();
    const [mark2] = await db.select().from(appSetting).where(eq(appSetting.key, CONTACT_SUMMARY_WATERMARK_KEY));
    expect(mark2!.value).toEqual({ at: new Date(later.getTime() + 60_000).toISOString() });

    // Nothing changed since: nothing to do. The nightly rebuild still covers everyone.
    const far = new Date("2099-01-01T00:00:00Z");
    await db.update(appSetting).set({ value: { at: far.toISOString() } }).where(eq(appSetting.key, CONTACT_SUMMARY_WATERMARK_KEY));
    expect(await refreshContactSummaries(db, log, { now: new Date(far.getTime() + 60_000) })).toBe(0);
    expect(await rebuildContactSummaries(db, log)).toBeGreaterThanOrEqual(2);
    // The customer rows themselves were never touched by the jobs.
    expect((await db.select().from(customer).where(eq(customer.id, gone!.id)))[0]!.name).toBe("Worker Gone");
  });

  it("contact_import_apply saves an import batch by batch, marks it applied, and never saves a row twice", async () => {
    const [existing] = await db.insert(customer).values({ name: "Already Here", phone: "+2347005554010", source: "online" }).returning();
    const id = await makeImport([
      { name: "Worker New One", phone: "+2347005554011", outcome: "new" },
      { name: "A Different Name", phone: "+2347005554010", outcome: "matched" },
      { name: "Refused Row", phone: null, outcome: "rejected" },
      { name: "Worker New Two", phone: "+2347005554012", outcome: "new" },
    ]);
    // Imports that are not waiting are left alone.
    const idle = await makeImport([{ name: "Not Confirmed", phone: "+2347005554019", outcome: "new" }], { status: "previewed" });

    expect(await applyContactImports(db, log, { batch: 2 })).toBe(2);
    expect((await db.select().from(contactImport).where(eq(contactImport.id, id)))[0]).toMatchObject({ status: "applying", appliedRows: 2 });
    expect(await applyContactImports(db, log, { batch: 2 })).toBe(1);
    const [done] = await db.select().from(contactImport).where(eq(contactImport.id, id));
    expect(done).toMatchObject({ status: "applied", appliedRows: 3, newCount: 2, matchedCount: 1, error: null });
    expect(done!.appliedAt).not.toBeNull();
    expect(await applyContactImports(db, log)).toBe(0);

    for (const phone of ["+2347005554011", "+2347005554012"]) {
      const rows = await db.select().from(customer).where(eq(customer.phone, phone));
      expect(rows, phone).toHaveLength(1);
      expect((await db.select().from(contactOrigin).where(eq(contactOrigin.customerId, rows[0]!.id)))[0]).toMatchObject({ origin: "import", importId: id, createdBy: userId });
      // On the Contacts page at once.
      expect(await summaryOf(rows[0]!.id)).not.toBeNull();
    }
    // The matched customer is unchanged; the refused row and the unconfirmed import made nobody.
    expect((await db.select().from(customer).where(eq(customer.id, existing!.id)))[0]).toMatchObject({ name: "Already Here", phone: "+2347005554010" });
    expect(await db.select().from(customer).where(eq(customer.name, "Refused Row"))).toHaveLength(0);
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005554019"))).toHaveLength(0);
    expect((await db.select().from(contactImport).where(eq(contactImport.id, idle)))[0]!.status).toBe("previewed");
    expect(await db.select().from(contactConsent)).toHaveLength(0); // nothing was declared
  });

  it("contact_import_apply marks an import failed with the reason and keeps the rows already saved", async () => {
    const id = await makeImport([
      { name: "Saved Before The Fault", phone: "+2347005554020", outcome: "new" },
      { name: "Faulty Row", phone: "not a phone number", outcome: "new" },
      { name: "After The Fault", phone: "+2347005554021", outcome: "new" },
    ]);
    expect(await applyContactImports(db, log)).toBe(0);
    const [failed] = await db.select().from(contactImport).where(eq(contactImport.id, id));
    expect(failed).toMatchObject({ status: "failed", appliedRows: 1 });
    expect(failed!.error).toContain("phone number");
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005554020"))).toHaveLength(1);
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005554021"))).toHaveLength(0);
    // A failed import is not picked up again by itself.
    expect(await applyContactImports(db, log)).toBe(0);
    expect(await db.select().from(customer).where(eq(customer.phone, "+2347005554020"))).toHaveLength(1);
  });

  it("contact_import_cleanup removes uploaded rows 30 days after an import ended and keeps the counts", async () => {
    const old = await makeImport([{ name: "Old Row", phone: "+2347005554030", outcome: "new" }], { status: "applied", appliedAt: daysAgo(31), newCount: 1, appliedRows: 1 });
    const recent = await makeImport([{ name: "Recent Row", phone: "+2347005554031", outcome: "new" }], { status: "applied", appliedAt: daysAgo(29), newCount: 1 });
    const oldCancelled = await makeImport([{ name: "Cancelled Row", phone: "+2347005554032", outcome: "new" }], { status: "cancelled", createdAt: daysAgo(40) });
    const oldWaiting = await makeImport([{ name: "Waiting Row", phone: "+2347005554033", outcome: "new" }], { status: "previewed", createdAt: daysAgo(40) });

    expect(await cleanupContactImports(db, log, { now: NOW })).toBe(2);
    const rowsOf = async (id: string) => (await db.select().from(contactImportRow).where(eq(contactImportRow.importId, id))).length;
    expect(await rowsOf(old)).toBe(0);
    expect(await rowsOf(oldCancelled)).toBe(0);
    expect(await rowsOf(recent)).toBe(1);
    expect(await rowsOf(oldWaiting)).toBe(1);
    const [kept] = await db.select().from(contactImport).where(eq(contactImport.id, old));
    expect(kept).toMatchObject({ status: "applied", newCount: 1, appliedRows: 1, totalRows: 1 });
    expect(kept!.rowsPurgedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await cleanupContactImports(db, log, { now: NOW })).toBe(0);
  });

  it("contact_consent_confirm returns at once when WhatsApp is not configured, and calls nothing outside", async () => {
    const saved = { token: process.env.META_SYSTEM_USER_TOKEN, secret: process.env.META_APP_SECRET };
    delete process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_APP_SECRET;
    try {
      const [c] = await db.insert(customer).values({ name: "Waiting For Config", phone: "+2347005554040", source: "whatsapp" }).returning();
      await db.insert(contactConsent).values({ customerId: c!.id, channel: "whatsapp", purpose: "marketing", state: "withdrawn", method: "keyword", confirmState: "pending" });
      expect(await sendContactConsentConfirmations(db, log, { now: NOW })).toBe(0);
      expect((await db.select().from(contactConsent).where(eq(contactConsent.customerId, c!.id)))[0]!.confirmState).toBe("pending");
    } finally {
      if (saved.token !== undefined) process.env.META_SYSTEM_USER_TOKEN = saved.token;
      if (saved.secret !== undefined) process.env.META_APP_SECRET = saved.secret;
    }
    expect(outsideCalls).toEqual([]);
  });
});
