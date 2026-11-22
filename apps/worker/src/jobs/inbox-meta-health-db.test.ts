import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { appSetting, createDbClient, inboxPhoneNumber, outboxEvent } from "@ms/db";
import { META_HEALTH_KEY, type MetaHealthValue } from "@ms/shared";
import type { MetaConfig } from "@ms/domain";
import { ACCOUNT_BLOCK_KEY, META_HEALTH_ALERT, checkMetaHealth } from "./inbox-meta-health.js";

/**
 * The watchdog against a real Postgres (testcontainers; needs Docker). The
 * Graph API is stubbed; nothing reaches Meta. Every run passes a fixed "now".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const TOKEN = "itest-watchdog-system-token";
const cfg: MetaConfig = { token: TOKEN, graphVersion: "v23.0" };
const WABA = "104857600123456";
const WA_NUMBER = "900100200300";
const log = { info: () => {}, warn: () => {}, error: () => {} };
const T0 = new Date("2026-11-22T10:00:00.000Z");
const hours = (n: number): Date => new Date(T0.getTime() + n * 3600_000);

let tokenRevoked = false;
let numberStatus = "CONNECTED";
const graphCalls: { method: string; path: string }[] = [];

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call in test: ${href}`);
    const p = new URL(href).pathname.replace(/^\/v[\d.]+\//, "");
    graphCalls.push({ method: init?.method ?? "GET", path: p });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (p === "debug_token") {
      return ok({ data: tokenRevoked ? { is_valid: false } : { is_valid: true, expires_at: 0, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } });
    }
    if (p === WA_NUMBER) return ok({ status: numberStatus, quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" });
    if (p === WABA) return ok({ health_status: { can_send_message: "AVAILABLE" }, account_review_status: "APPROVED" });
    return new Response(JSON.stringify({ error: { message: "unknown", code: 100 } }), { status: 400 });
  }) as typeof fetch;
}

describe("checkMetaHealth (database)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let lineId: string;

  const stored = async (): Promise<MetaHealthValue> => {
    const [row] = await db.select().from(appSetting).where(eq(appSetting.key, META_HEALTH_KEY));
    return row!.value as MetaHealthValue;
  };
  const alerts = async () => db.select().from(outboxEvent).where(eq(outboxEvent.eventType, META_HEALTH_ALERT));

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const client = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder });
    await client.end();
    db = createDbClient(container.getConnectionUri());
    installStub();
    const [row] = await db
      .insert(inboxPhoneNumber)
      .values({ kind: "phone", e164: "+2348030000001", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: WA_NUMBER })
      .returning();
    lineId = row!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    tokenRevoked = false;
    numberStatus = "CONNECTED";
    graphCalls.length = 0;
    await db.delete(appSetting).where(eq(appSetting.key, META_HEALTH_KEY));
    await db.delete(appSetting).where(eq(appSetting.key, ACCOUNT_BLOCK_KEY));
    await db.delete(outboxEvent).where(eq(outboxEvent.eventType, META_HEALTH_ALERT));
  });

  it("stores one ok record per item, refreshes the number's columns, and only reads from Meta", async () => {
    await checkMetaHealth(db, log, cfg, T0);
    const v = await stored();
    expect(Object.keys(v.items).sort()).toEqual([`line:${lineId}`, "token", `waba:${WABA}`].sort());
    expect(Object.values(v.items).every((i) => i.status === "ok")).toBe(true);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    const [line] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, lineId));
    expect(line).toMatchObject({ waStatus: "CONNECTED", qualityRating: "GREEN", messagingLimit: "TIER_1K" });
    expect(graphCalls.every((c) => c.method === "GET")).toBe(true);
    expect(await alerts()).toHaveLength(0);
  });

  it("revoking the token raises one owner alert, and no second one an hour later", async () => {
    await checkMetaHealth(db, log, cfg, T0);
    tokenRevoked = true;
    await checkMetaHealth(db, log, cfg, hours(1));
    await checkMetaHealth(db, log, cfg, hours(2));
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.payload)).not.toContain(TOKEN);
    const v = await stored();
    expect(v.items.token).toMatchObject({ status: "broken", since: hours(1).toISOString() });
    // Not asked again while the token is gone; the number keeps its last record.
    expect(v.items[`line:${lineId}`]!.status).toBe("ok");
  });

  it("a banned number is broken and alerted once", async () => {
    numberStatus = "BANNED";
    await checkMetaHealth(db, log, cfg, T0);
    await checkMetaHealth(db, log, cfg, hours(1));
    expect((await stored()).items[`line:${lineId}`]!.status).toBe("broken");
    expect(await alerts()).toHaveLength(1);
  });

  it("reads an account block recorded by the account_update webhook", async () => {
    await db.insert(appSetting).values({ key: ACCOUNT_BLOCK_KEY, value: { [WABA]: { waba_id: WABA, event: "ACCOUNT_RESTRICTION", detail: null, at: T0.toISOString() } } });
    await checkMetaHealth(db, log, cfg, T0);
    expect((await stored()).items[`waba:${WABA}`]).toMatchObject({ status: "broken" });
  });

  it("does nothing without Meta configured", async () => {
    expect(await checkMetaHealth(db, log, null, T0)).toEqual({ items: 0, alerted: 0 });
    expect(graphCalls).toHaveLength(0);
  });
});
