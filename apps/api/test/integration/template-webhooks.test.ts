import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { inboxPhoneNumber, inboxTemplate, inboxWebhookEvent, outboxEvent } from "@ms/db";
import { syncTemplatesForWaba } from "@ms/domain";
import { setupTestDb } from "./helpers.js";

/**
 * Suite spec 06, 5.3: the three template webhook fields arrive at POST /v1/webhooks/whatsapp
 * and update inbox_template. Event times come from the payload (`entry.time`), never from the
 * clock, so nothing here depends on the machine's time. The Graph API is stubbed.
 */

const APP_SECRET = "itest-meta-app-secret";
const WABA = "WABA-TPL";
const T0 = 1_790_000_000; // unix seconds; the events' own time

const graphCalls: { url: string; method: string }[] = [];
let metaTemplates: Record<string, unknown>[] = [];
/** When set, runs after Meta has built its list answer and before we receive it. */
let afterList: (() => Promise<void>) | null = null;
function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.facebook.com/")) {
      graphCalls.push({ url, method: init?.method ?? "GET" });
      if (url.includes(`/${WABA}/message_templates`)) {
        const answer = JSON.stringify({ data: metaTemplates });
        if (afterList) await afterList();
        return new Response(answer, { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "unexpected call", code: 100 } }), { status: 400 });
    }
    return real(input, init);
  }) as typeof fetch;
}

describe("template webhooks", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let settle: () => Promise<void>;
  let seq = 0;

  async function post(field: string, value: Record<string, unknown>, opts: { waba?: string; time?: number } = {}): Promise<void> {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: opts.waba ?? WABA, time: opts.time ?? T0, changes: [{ field, value }] }],
    });
    const res = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex"),
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    await settle();
  }

  async function addTemplate(over: Partial<typeof inboxTemplate.$inferInsert> = {}): Promise<typeof inboxTemplate.$inferSelect> {
    seq += 1;
    const [row] = await db
      .insert(inboxTemplate)
      .values({
        wabaId: WABA,
        name: `tpl_${seq}`,
        language: "en",
        status: "PENDING",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Hello there" }],
        metaTemplateId: String(5000 + seq),
        ...over,
      })
      .returning();
    return row!;
  }
  const status = (t: typeof inboxTemplate.$inferSelect, event: string, extra: Record<string, unknown> = {}) =>
    post("message_template_status_update", {
      event,
      message_template_id: Number(t.metaTemplateId),
      message_template_name: t.name,
      message_template_language: t.language,
      ...extra,
    });
  const reload = async (id: string) => (await db.select().from(inboxTemplate).where(eq(inboxTemplate.id, id)))[0]!;
  const alerts = async (templateId: string) =>
    (await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.template_alert")))
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p.template_id === templateId);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000200", label: "Templates line", channels: "whatsapp", wabaId: WABA, waPhoneNumberId: "5550002222" });
    const { buildApp } = await import("../../src/test-app.js");
    ({ settleTemplateResyncs: settle } = await import("../../src/routes/webhooks-whatsapp.js"));
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(() => {
    graphCalls.length = 0;
    metaTemplates = [];
  });

  it("status APPROVED / REJECTED (with rejection_info) / PAUSED / DISABLED update the row", async () => {
    const a = await addTemplate({ rejectedReason: "INVALID_FORMAT", reviewInfo: { rejection: { reason: "INVALID_FORMAT" } } });
    await status(a, "APPROVED", { reason: "NONE" });
    const aAfter = await reload(a.id);
    expect(aAfter.status).toBe("APPROVED");
    expect(aAfter.rejectedReason).toBeNull();
    expect(aAfter.reviewInfo).toBeNull();
    expect(aAfter.statusChangedAt?.toISOString()).toBe(new Date(T0 * 1000).toISOString());

    const r = await addTemplate();
    await status(r, "REJECTED", { reason: "INVALID_FORMAT", rejection_info: { reason: "INVALID_FORMAT", recommendation: "Add words between the blanks." } });
    const rAfter = await reload(r.id);
    expect(rAfter.status).toBe("REJECTED");
    expect(rAfter.rejectedReason).toBe("INVALID_FORMAT");
    expect(rAfter.reviewInfo?.rejection).toEqual({ reason: "INVALID_FORMAT", recommendation: "Add words between the blanks." });
    expect((await alerts(r.id)).map((p) => p.kind)).toEqual(["rejected"]);

    const p = await addTemplate({ status: "APPROVED" });
    await status(p, "PAUSED", { other_info: { title: "FIRST_PAUSE", description: "Paused for three hours." } });
    const pAfter = await reload(p.id);
    expect(pAfter.status).toBe("PAUSED");
    expect(pAfter.reviewInfo?.pause).toEqual({ title: "FIRST_PAUSE", description: "Paused for three hours." });
    expect((await alerts(p.id)).map((x) => x.kind)).toEqual(["paused"]);

    const d = await addTemplate({ status: "PAUSED" });
    await status(d, "DISABLED", { disable_info: { disable_date: "2026-11-20" } });
    const dAfter = await reload(d.id);
    expect(dAfter.status).toBe("DISABLED");
    expect(dAfter.reviewInfo?.disableDate).toBe("2026-11-20");
    expect((await alerts(d.id)).map((x) => x.kind)).toEqual(["disabled"]);

    // The event was kept and marked processed.
    const stored = await db.select().from(inboxWebhookEvent);
    expect(stored.length).toBeGreaterThanOrEqual(4);
    expect(stored.every((e) => e.processedAt !== null)).toBe(true);
  });

  it("matches by name and language when the id is unknown, with en-US normalised", async () => {
    const t = await addTemplate({ name: "by_name_only", language: "en_US", status: "APPROVED", metaTemplateId: null });
    await post("message_template_status_update", {
      event: "PAUSED",
      message_template_id: 424242,
      message_template_name: "by_name_only",
      message_template_language: "en-US",
    });
    const after = await reload(t.id);
    expect(after.status).toBe("PAUSED");
    expect(after.metaTemplateId).toBe("424242");
    expect(graphCalls).toHaveLength(0);
  });

  it("an older event does not undo a newer status", async () => {
    const t = await addTemplate({ status: "APPROVED", statusChangedAt: new Date((T0 + 1000) * 1000) });
    await status(t, "REJECTED", { reason: "INVALID_FORMAT" });
    const after = await reload(t.id);
    expect(after.status).toBe("APPROVED");
    expect(after.rejectedReason).toBeNull();
    expect(await alerts(t.id)).toEqual([]);
  });

  it("M11: a status event in the same second as our own last change is not dropped as stale", async () => {
    // Our clock is in milliseconds, Meta's event time in whole seconds: 400 ms into the same second is not "newer".
    const t = await addTemplate({ status: "PENDING", statusChangedAt: new Date(T0 * 1000 + 400) });
    await status(t, "APPROVED", { reason: "NONE" });
    expect((await reload(t.id)).status).toBe("APPROVED");
    // A change a full second later still wins over the event.
    const later = await addTemplate({ status: "PAUSED", statusChangedAt: new Date((T0 + 1) * 1000) });
    await status(later, "APPROVED", { reason: "NONE" });
    expect((await reload(later.id)).status).toBe("PAUSED");
  });

  it("M3: the sync does not put back a status that changed after its list was fetched", async () => {
    const now = new Date((T0 + 500) * 1000);
    const cfg = { token: "itest-token", graphVersion: "v23.0" };
    const raced = await addTemplate({ status: "APPROVED", statusChangedAt: new Date((T0 - 100) * 1000) });
    const quiet = await addTemplate({ status: "PENDING", statusChangedAt: new Date((T0 - 100) * 1000) });
    const asMeta = (t: typeof raced) => ({ id: t.metaTemplateId, name: t.name, language: t.language, status: "APPROVED", category: "UTILITY", components: t.components });
    metaTemplates = [asMeta(raced), asMeta(quiet)];
    // Meta's list still says APPROVED; a moment later the template is paused (a webhook, or staff in the suite).
    afterList = async () => {
      await db.update(inboxTemplate).set({ status: "PAUSED", statusChangedAt: new Date(now.getTime() + 2_000) }).where(eq(inboxTemplate.id, raced.id));
    };
    try {
      await syncTemplatesForWaba(db, cfg, WABA, now);
    } finally {
      afterList = null;
    }
    const after = await reload(raced.id);
    expect(after.status).toBe("PAUSED");
    expect(after.statusChangedAt?.getTime()).toBe(now.getTime() + 2_000);
    // A row nobody touched still takes Meta's status.
    expect(await reload(quiet.id)).toMatchObject({ status: "APPROVED", statusChangedAt: now });
  });

  it("quality update to RED sets quality and raises one alert, not two", async () => {
    const t = await addTemplate({ status: "APPROVED", qualityScore: "GREEN" });
    const value = {
      previous_quality_score: "GREEN",
      new_quality_score: "RED",
      message_template_id: Number(t.metaTemplateId),
      message_template_name: t.name,
      message_template_language: "en",
    };
    await post("message_template_quality_update", value);
    await post("message_template_quality_update", value, { time: T0 + 60 });
    const after = await reload(t.id);
    expect(after.qualityScore).toBe("RED");
    const rows = await alerts(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "quality_red", name: t.name, language: "en" });

    const g = await addTemplate({ status: "APPROVED", qualityScore: "UNKNOWN" });
    await post("message_template_quality_update", {
      previous_quality_score: "UNKNOWN",
      new_quality_score: "GREEN",
      message_template_id: Number(g.metaTemplateId),
      message_template_name: g.name,
      message_template_language: "en",
    });
    expect((await reload(g.id)).qualityScore).toBe("GREEN");
    expect(await alerts(g.id)).toEqual([]);
  });

  it("category notice sets correct_category and the date; the done event changes the category", async () => {
    const t = await addTemplate({ status: "APPROVED", category: "UTILITY" });
    const ids = {
      message_template_id: Number(t.metaTemplateId),
      message_template_name: t.name,
      message_template_language: "en",
    };
    const due = T0 + 86_400;
    await post("template_category_update", { ...ids, new_category: "UTILITY", correct_category: "MARKETING", category_update_timestamp: due });
    const notice = await reload(t.id);
    expect(notice.category).toBe("UTILITY");
    expect(notice.correctCategory).toBe("MARKETING");
    expect(notice.categoryChangeAt?.toISOString()).toBe(new Date(due * 1000).toISOString());
    expect((await alerts(t.id)).map((a) => a.kind)).toEqual(["category_notice"]);

    await post("template_category_update", { ...ids, previous_category: "UTILITY", new_category: "MARKETING" }, { time: due });
    const done = await reload(t.id);
    expect(done.category).toBe("MARKETING");
    expect(done.previousCategory).toBe("UTILITY");
    expect(done.correctCategory).toBeNull();
    expect(done.categoryChangeAt).toBeNull();
    expect((await alerts(t.id)).map((a) => a.kind).sort()).toEqual(["category_changed", "category_notice"]);
  });

  it("an APPROVED event that carries a new category records the change and alerts for Marketing", async () => {
    const t = await addTemplate({ category: "UTILITY" });
    await status(t, "APPROVED", { message_template_category: "MARKETING" });
    const after = await reload(t.id);
    expect(after.status).toBe("APPROVED");
    expect(after.category).toBe("MARKETING");
    expect(after.previousCategory).toBe("UTILITY");
    expect((await alerts(t.id)).map((a) => a.kind)).toEqual(["approved_as_marketing"]);
  });

  it("an event for an unknown template triggers a sync; an event for an unknown WABA is ignored", async () => {
    metaTemplates = [{ id: "777001", name: "made_in_manager", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi" }] }];
    await post("message_template_status_update", {
      event: "APPROVED",
      message_template_id: 777001,
      message_template_name: "made_in_manager",
      message_template_language: "en",
    });
    const [row] = await db.select().from(inboxTemplate).where(eq(inboxTemplate.name, "made_in_manager"));
    expect(row).toMatchObject({ status: "APPROVED", category: "MARKETING", metaTemplateId: "777001", wabaId: WABA });
    expect(graphCalls.filter((c) => c.url.includes(`/${WABA}/message_templates`))).toHaveLength(1);

    graphCalls.length = 0;
    await post(
      "message_template_status_update",
      { event: "APPROVED", message_template_id: 1, message_template_name: "elsewhere", message_template_language: "en" },
      { waba: "SOMEONE-ELSES-WABA" },
    );
    expect(graphCalls).toHaveLength(0);
    expect(await db.select().from(inboxTemplate).where(eq(inboxTemplate.name, "elsewhere"))).toHaveLength(0);
    const open = (await db.select().from(inboxWebhookEvent)).filter((e) => e.processedAt === null);
    expect(open).toHaveLength(0);
  });

  it("the same event twice changes nothing the second time", async () => {
    const t = await addTemplate();
    await status(t, "REJECTED", { reason: "SCAM", rejection_info: { reason: "SCAM" } });
    const first = await reload(t.id);
    const alertsFirst = await alerts(t.id);
    await status(t, "REJECTED", { reason: "SCAM", rejection_info: { reason: "SCAM" } });
    expect(await reload(t.id)).toEqual(first);
    expect(await alerts(t.id)).toEqual(alertsFirst);
  });

  it("a local draft is not changed by an event; it asks for a sync instead", async () => {
    const draft = await addTemplate({ name: "my_draft", status: "DRAFT", metaTemplateId: null, components: [], draft: { category: "UTILITY" } });
    metaTemplates = [];
    await post("message_template_status_update", {
      event: "APPROVED",
      message_template_id: 888001,
      message_template_name: "my_draft",
      message_template_language: "en",
    });
    const after = await reload(draft.id);
    expect(after.status).toBe("DRAFT");
    expect(after.components).toEqual([]);
    expect(after.draft).toEqual({ category: "UTILITY" });
  });
});
