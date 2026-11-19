import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { INSIGHTS_STATE_KEY, appSetting, createDbClient, inboxPhoneNumber, insightMetricDaily, outboxEvent } from "@ms/db";
import {
  claimInsightsRun,
  clearPageTokenCache,
  patchInsightsState,
  readInsightsState,
  releaseInsightsRun,
  runInsightsCollection,
} from "@ms/domain";
import { collectInsightsIfDue, resetInsightsCollectMemory, type InsightsCollectDeps } from "./insights-collect.js";

/**
 * Suite spec 11: the collector against a real Postgres (testcontainers), so the upsert,
 * the stored state and the "one worker at a time" marker are checked as SQL. The Graph
 * API is stubbed; nothing reaches Meta. Every call passes a fixed "now".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const PAGE = "100200300400";
const IG = "17841400000000001";
const WABA = "104857600123456";
const log = { info: () => {}, warn: () => {}, error: () => {} };

let tokenRejected = false;
const graphCalls: { method: string; path: string }[] = [];
const unix = (iso: string): number => Date.parse(iso) / 1000;

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call in test: ${href}`);
    const url = new URL(href);
    const p = decodeURIComponent(url.pathname.replace(/^\/v[\d.]+\//, ""));
    graphCalls.push({ method: init?.method ?? "GET", path: p });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (tokenRejected) return new Response(JSON.stringify({ error: { message: "Error validating access token", code: 190 } }), { status: 401 });
    const fields = url.searchParams.get("fields") ?? "";
    const metrics = (url.searchParams.get("metric") ?? "").split(",");
    if (p === PAGE && fields === "access_token") return ok({ access_token: "itest-worker-page-token" });
    if (p === `${PAGE}/insights`) {
      return ok({
        data: metrics.map((name) => ({
          name,
          period: "day",
          values: [
            { value: 10, end_time: "2026-11-18T08:00:00+0000" },
            { value: 20, end_time: "2026-11-19T08:00:00+0000" },
          ],
        })),
      });
    }
    if (p === `${PAGE}/feed` || p === `${IG}/media` || p === `${IG}/stories`) return ok({ data: [] });
    if (p === `${IG}/insights`) {
      if (url.searchParams.get("breakdown")) return ok({ data: [] });
      return ok({ data: metrics.map((name) => ({ name, period: "day", total_value: { value: 7 } })) });
    }
    if (p === IG) return ok({ followers_count: 540, media_count: 61, id: IG });
    if (p === WABA && fields.startsWith("analytics.")) {
      return ok({ id: WABA, analytics: { data_points: [{ start: unix("2026-11-18T00:00:00Z"), end: unix("2026-11-19T00:00:00Z"), sent: 5, delivered: 4 }] } });
    }
    if (p === WABA && fields.startsWith("pricing_analytics.")) {
      return ok({
        id: WABA,
        pricing_analytics: {
          data: [{ data_points: [{ start: unix("2026-11-18T00:00:00Z"), end: unix("2026-11-19T00:00:00Z"), pricing_category: "MARKETING", pricing_type: "REGULAR", volume: 2, cost: 0.1 }] }],
        },
      });
    }
    if (p === WABA && fields === "currency") return ok({ currency: "USD", id: WABA });
    return new Response(JSON.stringify({ error: { message: `Unsupported get request: ${p}`, code: 100 } }), { status: 400 });
  }) as typeof fetch;
}

describe("spec 11 worker: collectInsightsIfDue against Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  // The real collector, without the 200 ms pause between calls.
  const fast: InsightsCollectDeps["run"] = (d, cfg, l, opts = {}) => runInsightsCollection(d, cfg, l, { ...opts, sleepMs: 0 });
  const countRows = async (): Promise<number> => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(insightMetricDaily);
    return r!.n;
  };
  const pageViews = async (day: string): Promise<string | undefined> => {
    const [r] = await db
      .select({ value: insightMetricDaily.value })
      .from(insightMetricDaily)
      .where(
        and(
          eq(insightMetricDaily.source, "facebook_page"),
          eq(insightMetricDaily.accountKey, PAGE),
          eq(insightMetricDaily.metric, "page_media_view"),
          eq(insightMetricDaily.day, day),
        ),
      );
    return r?.value;
  };
  const claimedAt = async (): Promise<string | null> => {
    const [r] = await db
      .select({ at: sql<string | null>`${appSetting.value}->>'run_claimed_at'` })
      .from(appSetting)
      .where(eq(appSetting.key, INSIGHTS_STATE_KEY));
    return r?.at ?? null;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const client = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(client), { migrationsFolder });
    await client.end();
    db = createDbClient(container.getConnectionUri());
    process.env.META_SYSTEM_USER_TOKEN = "itest-worker-system-token";
    delete process.env.META_GRAPH_BASE_URL;
    installStub();
    resetInsightsCollectMemory();
    clearPageTokenCache();
    await db.insert(inboxPhoneNumber).values([
      { kind: "messenger", e164: null, externalId: PAGE, pageExternalId: PAGE, label: "Facebook Page", channels: "whatsapp" },
      { kind: "instagram", e164: null, externalId: IG, pageExternalId: PAGE, label: "Instagram", channels: "whatsapp" },
      { e164: "+2348000000000", label: "Main line", channels: "both", wabaId: WABA, waPhoneNumberId: "109876543210987" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("collects after 10:00 Lagos, stores what Meta returned and records the run", async () => {
    // 09:30 UTC is 10:30 in Lagos.
    expect(await collectInsightsIfDue(db, log, new Date("2026-11-19T09:30:00Z"), { run: fast })).toBe("full");
    expect(await countRows()).toBeGreaterThan(0);
    // Pacific days: the value stamped 18 Nov 08:00Z belongs to 17 Nov.
    expect(Number(await pageViews("2026-11-17"))).toBe(10);
    expect(Number(await pageViews("2026-11-18"))).toBe(20);

    const state = await readInsightsState(db);
    expect(state.last_daily_run_day).toBe("2026-11-19");
    expect(state.last_run_at).toBe("2026-11-19T09:30:00.000Z");
    expect(state.refresh_requested_at).toBeNull();
    expect(state.sources[`facebook_page:${PAGE}`]).toMatchObject({ backfilled: true, problem_code: null, last_ok_at: "2026-11-19T09:30:00.000Z" });
    expect(state.sources[`instagram_account:${IG}`]).toMatchObject({ backfilled: true, problem_code: null });
    expect(state.sources[`whatsapp:${WABA}`]).toMatchObject({ backfilled: true, problem_code: null });
    expect(state.currencies).toEqual({ [WABA]: "USD" });
    expect(state.template_analytics).toEqual({});
    // The marker was given back, and nothing was written to Meta.
    expect(await claimedAt()).toBeNull();
    expect(graphCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a second collection overwrites the same rows: same count, same values", async () => {
    const before = await countRows();
    await patchInsightsState(db, { refresh_requested_at: "2026-11-19T09:40:00.000Z" });
    expect(await collectInsightsIfDue(db, log, new Date("2026-11-19T09:41:00Z"), { run: fast })).toBe("full");
    expect(await countRows()).toBe(before);
    expect(Number(await pageViews("2026-11-17"))).toBe(10);
    expect(Number(await pageViews("2026-11-18"))).toBe(20);
    const state = await readInsightsState(db);
    // A refresh is not the daily collection.
    expect(state.last_daily_run_day).toBe("2026-11-19");
    expect(state.last_run_at).toBe("2026-11-19T09:41:00.000Z");
    expect(state.refresh_requested_at).toBeNull();
  });

  it("only one worker collects at a time; a marker left by a dead worker is taken over after 30 minutes", async () => {
    const t = new Date("2026-11-19T12:00:00Z");
    expect(await claimInsightsRun(db, t)).toBe(true);
    expect(await claimInsightsRun(db, new Date("2026-11-19T12:10:00Z"))).toBe(false);
    await patchInsightsState(db, { refresh_requested_at: "2026-11-19T12:05:00.000Z" });
    expect(await collectInsightsIfDue(db, log, new Date("2026-11-19T12:10:00Z"), { run: fast })).toBe("busy");
    expect((await readInsightsState(db)).last_run_at).toBe("2026-11-19T09:41:00.000Z");
    expect(await claimInsightsRun(db, new Date("2026-11-19T12:31:00Z"))).toBe(true);
    await releaseInsightsRun(db);
    expect(await claimedAt()).toBeNull();
    // The pending refresh is served by the next tick.
    expect(await collectInsightsIfDue(db, log, new Date("2026-11-19T12:40:00Z"), { run: fast })).toBe("full");
  });

  it("a rejected token keeps the stored figures, records the problem and alerts the owner once", async () => {
    const before = await countRows();
    tokenRejected = true;
    clearPageTokenCache();
    for (const [asked, at] of [
      ["2026-11-19T13:00:00.000Z", "2026-11-19T13:01:00Z"],
      ["2026-11-19T13:20:00.000Z", "2026-11-19T13:21:00Z"],
    ] as const) {
      await patchInsightsState(db, { refresh_requested_at: asked });
      expect(await collectInsightsIfDue(db, log, new Date(at), { run: fast })).toBe("full");
    }
    tokenRejected = false;
    expect(await countRows()).toBe(before);
    const state = await readInsightsState(db);
    expect(state.sources[`facebook_page:${PAGE}`]).toMatchObject({
      problem_code: "token",
      problem_message: "The connection to Meta has expired. Tell the technical team.",
      last_ok_at: "2026-11-19T12:40:00.000Z",
    });
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "insights.config_error"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account: "token", code: "190" });
    expect(JSON.stringify(alerts[0]!.payload)).not.toContain("itest-worker");
  });
});
