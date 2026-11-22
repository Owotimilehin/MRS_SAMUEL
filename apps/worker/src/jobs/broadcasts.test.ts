import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import {
  appSetting,
  broadcast,
  broadcastEvent,
  broadcastRecipient,
  contactConsent,
  contactList,
  contactListMember,
  contactSummary,
  createDbClient,
  customer,
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  inboxTemplate,
  outboxEvent,
} from "@ms/db";
import {
  applyAccountEvent,
  broadcastDeps,
  buildAudience,
  claimRecipients,
  ingestWhatsAppPayload,
  refreshContactSummary,
  runBroadcastTick,
  sendFromConversation,
  startDueBroadcasts,
  sweepBroadcasts,
  type MetaConfig,
} from "@ms/domain";
import { BROADCAST_ACCOUNT_BLOCK_KEY, BROADCAST_SETTINGS_KEY, DEFAULT_BROADCAST_SETTINGS } from "@ms/shared";

/**
 * Suite spec 14, Phase B: the broadcast engine against a real Postgres (testcontainers), with
 * Meta replaced by a stub that answers each send as the test asks. Nothing leaves this machine.
 * The clock is fixed at 12:00 Lagos time today (inside the default sending hours). Phone
 * numbers are in the made-up range +234 700 555 7xxx.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T11:00:00Z`);
const cfg: MetaConfig = { token: "itest-token-not-real", graphVersion: "v23.0", baseUrl: "https://graph.test" };
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

type Answer = { kind: "ok" } | { kind: "error"; code: number; status?: number } | { kind: "timeout" };
type Call = { url: string; to: string | null; body: Record<string, unknown> | null };

describe("broadcast worker (suite spec 14, Phase B)", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  const realFetch = globalThis.fetch;
  let calls: Call[] = [];
  let answer: (to: string | null) => Answer = () => ({ kind: "ok" });
  let onSend: ((to: string | null) => Promise<void>) | null = null;
  let seq = 0;
  let phoneSeq = 7000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const url = container.getConnectionUri();
    const sql = postgres(url, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(url);
    broadcastDeps.sleep = async () => {};
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!u.startsWith("https://graph.test/")) throw new Error(`unexpected outside call in a test: ${u}`);
      const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const to = (body?.to as string | undefined) ?? null;
      calls.push({ url: u, to, body });
      if (onSend) await onSend(to);
      const a = answer(to);
      if (a.kind === "timeout") throw new Error("The operation was aborted due to timeout");
      if (a.kind === "error") return new Response(JSON.stringify({ error: { code: a.code, message: `refused ${a.code}` } }), { status: a.status ?? 400 });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.bc.${++seq}` }] }), { status: 200 });
    }) as typeof fetch;
  }, 180_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.stop();
  });

  beforeEach(async () => {
    calls = [];
    answer = () => ({ kind: "ok" });
    onSend = null;
    await setSettings({ enabled: true });
  });

  async function setSettings(patch: Partial<typeof DEFAULT_BROADCAST_SETTINGS>) {
    const value = { ...DEFAULT_BROADCAST_SETTINGS, ...patch };
    await db.insert(appSetting).values({ key: BROADCAST_SETTINGS_KEY, value }).onConflictDoUpdate({ target: appSetting.key, set: { value } });
  }

  /** A line with its own WhatsApp account and an approved promotion template. */
  async function freshLine(o: { tier?: string; quality?: string } = {}) {
    const n = ++seq;
    const waba = `WABA-${n}`;
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: `+23480000${String(n).padStart(5, "0")}`, label: `Line ${n}`, channels: "whatsapp", wabaId: waba, waPhoneNumberId: `PN${n}`, messagingLimit: o.tier ?? "TIER_100K", qualityRating: o.quality ?? "GREEN" })
      .returning();
    const [tpl] = await db
      .insert(inboxTemplate)
      .values({
        wabaId: waba,
        name: "promo",
        language: "en",
        status: "APPROVED",
        category: "MARKETING",
        components: [{ type: "BODY", text: "Hi {{1}}, juice is 10% off." }, { type: "FOOTER", text: "Reply STOP to stop these messages" }],
      })
      .returning();
    return { line: line!, tpl: tpl! };
  }

  async function person(o: { name?: string; consent?: "granted" | "withdrawn" } = {}) {
    const digits = `234700555${String(++phoneSeq).padStart(4, "0")}`;
    const [c] = await db.insert(customer).values({ name: o.name ?? `Person ${phoneSeq}`, phone: `+${digits}`, source: "online" }).returning();
    if (o.consent) await db.insert(contactConsent).values({ customerId: c!.id, channel: "whatsapp", purpose: "marketing", state: o.consent, method: "staff", wording: "yes" });
    await refreshContactSummary(db, [c!.id]);
    return { id: c!.id, wa: digits, name: c!.name };
  }

  /** A broadcast already confirmed and sending, as confirmBroadcast leaves it. */
  async function sendingBroadcast(n: number, o: { tier?: string; status?: string; scheduledAt?: Date; quality?: string } = {}) {
    const { line, tpl } = await freshLine(o);
    const ppl = [];
    for (let i = 0; i < n; i++) ppl.push(await person({ consent: "granted" }));
    const [b] = await db
      .insert(broadcast)
      .values({
        name: `Broadcast ${seq}`,
        status: o.status ?? "sending",
        phoneNumberId: line.id,
        templateId: tpl.id,
        templateName: tpl.name,
        templateLanguage: "en",
        templateCategory: "MARKETING",
        blanks: { body: [{ from: "first_name", fallback: "there" }] },
        confirmedCount: n,
        startedAt: o.status === "scheduled" ? null : minutes(-1),
        scheduledAt: o.scheduledAt ?? null,
      })
      .returning();
    for (let i = 0; i < ppl.length; i++) {
      await db.insert(broadcastRecipient).values({
        broadcastId: b!.id,
        customerId: ppl[i]!.id,
        toWa: ppl[i]!.wa,
        state: "pending",
        values: { body: [ppl[i]!.name!.split(" ")[0]!] },
        createdAt: new Date(NOW.getTime() - 3600_000 + i * 1000),
      });
    }
    if ((o.status ?? "sending") === "sending") await db.insert(broadcastEvent).values({ broadcastId: b!.id, kind: "started", at: minutes(-1) });
    return { b: b!, line, tpl, ppl };
  }

  const recipients = (id: string) => db.select().from(broadcastRecipient).where(eq(broadcastRecipient.broadcastId, id));
  const statusOf = async (id: string) => (await db.select({ s: broadcast.status, r: broadcast.stopReason }).from(broadcast).where(eq(broadcast.id, id)))[0]!;
  const alerts = async (type: string, id: string) =>
    (await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, type))).filter((e) => String((e.payload as { account?: string }).account ?? "").startsWith(id));
  const sendsTo = (wa: string) => calls.filter((c) => c.to === wa).length;
  const statusWebhook = (pn: string, s: Record<string, unknown>) =>
    ingestWhatsAppPayload(db, {
      object: "whatsapp_business_account",
      entry: [{ id: "x", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: pn }, statuses: [s as never] } }] }],
    });
  const inbound = (pn: string, from: string, text: string, at: Date) =>
    ingestWhatsAppPayload(db, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "x",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: pn },
                contacts: [{ wa_id: from, profile: { name: "Someone" } }],
                messages: [{ from, id: `wamid.in.${++seq}`, timestamp: String(Math.floor(at.getTime() / 1000)), type: "text", text: { body: text } }],
              },
            },
          ],
        },
      ],
    });

  it("a tick sends at most rate/12 messages, each through sendFromConversation with auto broadcast and the callback value", async () => {
    const { b, ppl } = await sendingBroadcast(5);
    expect(await runBroadcastTick(db, cfg, b.id, NOW)).toBe("sent");
    expect(calls).toHaveLength(2); // 20 a minute → 2 per 5-second tick
    const rs = await recipients(b.id);
    const sent = rs.filter((r) => r.state === "sent");
    expect(sent).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ type: "template", to: ppl[0]!.wa, biz_opaque_callback_data: `bc:${sent.find((r) => r.toWa === ppl[0]!.wa)!.id}` });
    const [m] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, sent[0]!.messageId!));
    expect(m!.payload).toMatchObject({ auto: "broadcast", broadcast_id: b.id });
    expect(m!.senderUserId).toBeNull();
  });

  it("a recipient is claimed and its message written before Meta is called; a crash after the claim leaves it unknown, never waiting", async () => {
    const { b, ppl } = await sendingBroadcast(1);
    let seen: { state: string; messageId: string | null } | null = null;
    onSend = async () => {
      const [r] = await recipients(b.id);
      seen = { state: r!.state, messageId: r!.messageId };
    };
    await runBroadcastTick(db, cfg, b.id, NOW);
    expect(seen).toMatchObject({ state: "sending" });
    expect(seen!.messageId).not.toBeNull();
    expect(sendsTo(ppl[0]!.wa)).toBe(1);

    // A crash right after the claim: the sweep settles it as unknown, and nothing sends it again.
    const other = await sendingBroadcast(1);
    const claimed = await claimRecipients(db, other.b.id, 1, NOW);
    expect(claimed).toHaveLength(1);
    await sweepBroadcasts(db, minutes(6));
    expect((await recipients(other.b.id))[0]!.state).toBe("unknown");
    await runBroadcastTick(db, cfg, other.b.id, minutes(7));
    expect(sendsTo(other.ppl[0]!.wa)).toBe(0);
  });

  it("running the tick twice at once sends each recipient once", async () => {
    await setSettings({ enabled: true, rate_per_minute: 60 });
    const { b, ppl } = await sendingBroadcast(10);
    await Promise.all([runBroadcastTick(db, cfg, b.id, NOW), runBroadcastTick(db, cfg, b.id, NOW), runBroadcastTick(db, cfg, b.id, NOW)]);
    for (const p of ppl) expect(sendsTo(p.wa)).toBeLessThanOrEqual(1);
    const rs = await recipients(b.id);
    expect(rs.filter((r) => r.state === "sent").length).toBe(calls.length);
    // And again later: still nobody twice.
    await Promise.all([runBroadcastTick(db, cfg, b.id, minutes(1)), runBroadcastTick(db, cfg, b.id, minutes(1))]);
    for (const p of ppl) expect(sendsTo(p.wa)).toBeLessThanOrEqual(1);
  });

  it("a timeout makes the recipient unknown and it is not sent again; a status webhook carrying bc:<id> settles it as sent, then delivered", async () => {
    const { b, line, ppl } = await sendingBroadcast(1);
    answer = () => ({ kind: "timeout" });
    await runBroadcastTick(db, cfg, b.id, NOW);
    let [r] = await recipients(b.id);
    expect(r!.state).toBe("unknown");
    answer = () => ({ kind: "ok" });
    await runBroadcastTick(db, cfg, b.id, minutes(15));
    expect(sendsTo(ppl[0]!.wa)).toBe(1);

    await statusWebhook(line.waPhoneNumberId!, { id: "wamid.late.1", status: "sent", timestamp: String(Math.floor(NOW.getTime() / 1000)), biz_opaque_callback_data: `bc:${r!.id}` });
    [r] = await recipients(b.id);
    expect(r).toMatchObject({ state: "sent", waMessageId: "wamid.late.1" });
    const [m] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, r!.messageId!));
    expect(m).toMatchObject({ status: "sent", waMessageId: "wamid.late.1" });
    await statusWebhook(line.waPhoneNumberId!, { id: "wamid.late.1", status: "delivered", timestamp: String(Math.floor(minutes(1).getTime() / 1000)) });
    [r] = await recipients(b.id);
    expect(r!.state).toBe("delivered");
  });

  it("delivered and read statuses move the recipient forward only", async () => {
    const { b, line } = await sendingBroadcast(1);
    await runBroadcastTick(db, cfg, b.id, NOW);
    const [r0] = await recipients(b.id);
    const ts = String(Math.floor(NOW.getTime() / 1000));
    await statusWebhook(line.waPhoneNumberId!, { id: r0!.waMessageId, status: "read", timestamp: ts });
    await statusWebhook(line.waPhoneNumberId!, { id: r0!.waMessageId, status: "delivered", timestamp: ts });
    const [r] = await recipients(b.id);
    expect(r!.state).toBe("read");
    expect(r!.deliveredAt).not.toBeNull();
  });

  it("a failed status with 131049 is a recipient failure and blocks that person for 24 hours in the next audience", async () => {
    const { b, line, ppl } = await sendingBroadcast(1);
    await runBroadcastTick(db, cfg, b.id, NOW);
    const [r0] = await recipients(b.id);
    await statusWebhook(line.waPhoneNumberId!, { id: r0!.waMessageId, status: "failed", timestamp: String(Math.floor(NOW.getTime() / 1000)), errors: [{ code: 131049, title: "held" }] });
    const [r] = await recipients(b.id);
    expect(r).toMatchObject({ state: "failed", errorCode: "131049" });
    const [l] = await db.insert(contactList).values({ name: `L${seq}`, nameKey: `l${seq}`, kind: "static" }).returning();
    await db.insert(contactListMember).values({ listId: l!.id, customerId: ppl[0]!.id });
    const aud = await buildAudience(db, { listId: l!.id, phoneNumberId: line.id, templateCategory: "MARKETING", broadcastId: "00000000-0000-0000-0000-000000000000" }, { ...DEFAULT_BROADCAST_SETTINGS, min_days_between: 0 }, minutes(60));
    expect(aud[0]!.reason).toBe("held_back");
  });

  it("131026 marks the contact not on WhatsApp; an inbound message clears it", async () => {
    const { b, line, ppl } = await sendingBroadcast(1);
    answer = () => ({ kind: "error", code: 131026 });
    await runBroadcastTick(db, cfg, b.id, NOW);
    expect((await recipients(b.id))[0]).toMatchObject({ state: "failed", errorCode: "131026" });
    let [s] = await db.select().from(contactSummary).where(eq(contactSummary.customerId, ppl[0]!.id));
    expect(s!.waUnreachableAt).not.toBeNull();
    await inbound(line.waPhoneNumberId!, ppl[0]!.wa, "hello", minutes(1));
    [s] = await db.select().from(contactSummary).where(eq(contactSummary.customerId, ppl[0]!.id));
    expect(s!.waUnreachableAt).toBeNull();
  });

  it("131050 records a withdrawal with method meta_refusal", async () => {
    const { b, ppl } = await sendingBroadcast(1);
    answer = () => ({ kind: "error", code: 131050 });
    await runBroadcastTick(db, cfg, b.id, NOW);
    const [k] = await db
      .select()
      .from(contactConsent)
      .where(and(eq(contactConsent.customerId, ppl[0]!.id), eq(contactConsent.isCurrent, true)));
    expect(k).toMatchObject({ state: "withdrawn", method: "meta_refusal" });
  });

  it("a 130429 answer puts the recipient back to waiting, backs off, and the fifth in a row stops the broadcast", async () => {
    const { b } = await sendingBroadcast(8);
    answer = () => ({ kind: "error", code: 130429, status: 429 });
    let at = NOW;
    for (let i = 1; i <= 5; i++) {
      await runBroadcastTick(db, cfg, b.id, at);
      const [row] = await db.select().from(broadcast).where(eq(broadcast.id, b.id));
      if (i < 5) {
        expect(row!.status).toBe("sending");
        expect(row!.tempErrors).toBe(i);
        expect(row!.waitUntil!.getTime()).toBeGreaterThan(at.getTime());
        // Nobody was sent; a person refused three times in a row is failed, never sent again.
        const rs = await recipients(b.id);
        expect(rs.some((r) => r.state === "sent" || r.state === "sending")).toBe(false);
      }
      at = new Date(at.getTime() + 16 * 60_000);
    }
    expect(await statusOf(b.id)).toMatchObject({ s: "stopped", r: "meta_busy" });
    expect(await alerts("broadcast.stopped", b.id)).toHaveLength(1);
  });

  it("131042 stops with payment; 132015 stops with template; 190 stops with config and raises inbox.meta_config", async () => {
    for (const [code, reason] of [
      [131042, "payment"],
      [132015, "template"],
      [190, "config"],
    ] as const) {
      const { b } = await sendingBroadcast(3);
      answer = () => ({ kind: "error", code });
      expect(await runBroadcastTick(db, cfg, b.id, NOW)).toBe("stopped");
      expect(await statusOf(b.id)).toMatchObject({ s: "stopped", r: reason });
      expect(calls.length).toBeGreaterThan(0);
      calls = [];
      // Stopped means stopped: another tick sends nothing.
      answer = () => ({ kind: "ok" });
      await runBroadcastTick(db, cfg, b.id, minutes(1));
      expect(calls).toHaveLength(0);
      expect(await alerts("broadcast.stopped", b.id)).toHaveLength(1);
      if (reason === "config") {
        const cfgAlerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.meta_config"));
        expect(cfgAlerts.some((e) => (e.payload as { area?: string }).area === "whatsapp_broadcasts")).toBe(true);
      }
    }
  });

  it("nothing is sent outside sending hours; sending continues at the next start", async () => {
    const { b } = await sendingBroadcast(2);
    const evening = new Date(NOW.getTime() + 8 * 3600_000); // 20:00 Lagos
    expect(await runBroadcastTick(db, cfg, b.id, evening)).toBe("waiting");
    expect(calls).toHaveLength(0);
    const events = await db.select().from(broadcastEvent).where(and(eq(broadcastEvent.broadcastId, b.id), eq(broadcastEvent.kind, "waiting_hours")));
    expect(events).toHaveLength(1);
    expect(await runBroadcastTick(db, cfg, b.id, new Date(NOW.getTime() + 22 * 3600_000))).toBe("sent"); // 10:00 Lagos next day
  });

  it("nothing is sent beyond the daily allowance; templates sent from the inbox in the last 24 hours count against it", async () => {
    // TIER_50 × 0.8 = 40 a day.
    const { b, line } = await sendingBroadcast(2, { tier: "TIER_50" });
    for (let i = 0; i < 40; i++) {
      const p = await person();
      const [conv] = await db.insert(inboxConversation).values({ customerId: p.id, phoneNumberId: line.id, status: "open", channel: "whatsapp" }).returning();
      await db.insert(inboxMessage).values({ conversationId: conv!.id, direction: "out", type: "template", status: "sent", channel: "whatsapp", createdAt: minutes(-60) });
    }
    expect(await runBroadcastTick(db, cfg, b.id, NOW)).toBe("waiting");
    expect(calls).toHaveLength(0);
  });

  it("after the first 20 the broadcast waits 10 minutes", async () => {
    await setSettings({ enabled: true, rate_per_minute: 60 }); // 5 a tick
    const { b } = await sendingBroadcast(25);
    for (let i = 0; i < 4; i++) await runBroadcastTick(db, cfg, b.id, NOW);
    expect(calls).toHaveLength(20);
    const [row] = await db.select().from(broadcast).where(eq(broadcast.id, b.id));
    expect(row!.warmupUntil!.getTime()).toBe(NOW.getTime() + 10 * 60_000);
    expect(await runBroadcastTick(db, cfg, b.id, minutes(5))).toBe("waiting");
    expect(calls).toHaveLength(20);
    await runBroadcastTick(db, cfg, b.id, minutes(11));
    expect(calls).toHaveLength(25);
  });

  it("a RED quality rating, a paused template, an account_update restriction and the switch going off each stop it and raise one owner alert", async () => {
    // RED quality
    let x = await sendingBroadcast(2, { quality: "RED" });
    await runBroadcastTick(db, cfg, x.b.id, NOW);
    await runBroadcastTick(db, cfg, x.b.id, minutes(1));
    expect(await statusOf(x.b.id)).toMatchObject({ s: "stopped", r: "quality" });
    expect(await alerts("broadcast.stopped", x.b.id)).toHaveLength(1);
    // Paused template
    x = await sendingBroadcast(2);
    await db.update(inboxTemplate).set({ status: "PAUSED" }).where(eq(inboxTemplate.id, x.tpl.id));
    await runBroadcastTick(db, cfg, x.b.id, NOW);
    expect(await statusOf(x.b.id)).toMatchObject({ s: "stopped", r: "template" });
    expect(await alerts("broadcast.stopped", x.b.id)).toHaveLength(1);
    // account_update restriction
    x = await sendingBroadcast(2);
    await applyAccountEvent(db, x.line.wabaId!, "account_update", { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: 0 }] });
    await runBroadcastTick(db, cfg, x.b.id, NOW);
    expect(await statusOf(x.b.id)).toMatchObject({ s: "stopped", r: "account" });
    expect(await alerts("broadcast.stopped", x.b.id)).toHaveLength(1);
    await db.delete(appSetting).where(eq(appSetting.key, BROADCAST_ACCOUNT_BLOCK_KEY));
    // The switch going off
    x = await sendingBroadcast(2);
    await setSettings({ enabled: false });
    await runBroadcastTick(db, cfg, x.b.id, NOW);
    await startDueBroadcasts(db, NOW);
    expect(await statusOf(x.b.id)).toMatchObject({ s: "stopped", r: "switched_off" });
    expect(await alerts("broadcast.stopped", x.b.id)).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("nothing reaches a customer while the owner switch is off, even when it goes off between the claim and the send", async () => {
    const { b, ppl } = await sendingBroadcast(3);
    // Off before the tick: the tick stops the broadcast and claims nobody.
    await setSettings({ enabled: false });
    expect(await runBroadcastTick(db, cfg, b.id, NOW)).toBe("stopped");
    for (const p of ppl) expect(sendsTo(p.wa)).toBe(0);
    expect((await recipients(b.id)).every((r) => r.state === "pending")).toBe(true);

    // Off after the claim: the send itself refuses, before anything is written or sent.
    await setSettings({ enabled: true });
    const x = await sendingBroadcast(1);
    const [claimed] = await claimRecipients(db, x.b.id, 1, NOW);
    await setSettings({ enabled: false });
    const [conv] = await db.insert(inboxConversation).values({ customerId: x.ppl[0]!.id, phoneNumberId: x.line.id, status: "closed", channel: "whatsapp" }).returning();
    await expect(
      sendFromConversation(db, cfg, {
        conversationId: conv!.id,
        userId: null,
        auto: "broadcast",
        broadcast: { broadcastId: x.b.id, recipientId: claimed!.id, route: "cloud" },
        content: { type: "template", name: "promo", language: "en", bodyParams: ["Ada"] },
      }),
    ).rejects.toMatchObject({ code: "broadcast_off" });
    expect(sendsTo(x.ppl[0]!.wa)).toBe(0);
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv!.id))).toHaveLength(0);
  });

  it("a failure rate of 30% over the last 50 stops it; 131026 failures do not count", async () => {
    const a = await sendingBroadcast(0);
    const rows = Array.from({ length: 50 }, (_, i) => ({
      broadcastId: a.b.id,
      toWa: `2347009${String(i).padStart(5, "0")}`,
      state: i < 15 ? "failed" : "sent",
      errorCode: i < 15 ? "131049" : null,
      sentAt: NOW,
    }));
    await db.insert(broadcastRecipient).values(rows);
    await db.insert(broadcastRecipient).values({ broadcastId: a.b.id, toWa: "2347008000001", state: "pending", values: { body: ["x"] } });
    expect(await runBroadcastTick(db, cfg, a.b.id, NOW)).toBe("stopped");
    expect(await statusOf(a.b.id)).toMatchObject({ r: "failure_spike" });

    const c = await sendingBroadcast(1);
    await db.insert(broadcastRecipient).values(
      Array.from({ length: 50 }, (_, i) => ({ broadcastId: c.b.id, toWa: `2347007${String(i).padStart(5, "0")}`, state: i < 30 ? "failed" : "sent", errorCode: i < 30 ? "131026" : null, sentAt: NOW })),
    );
    expect(await runBroadcastTick(db, cfg, c.b.id, NOW)).not.toBe("stopped");
  });

  it("a STOP between confirm and that person's turn skips them", async () => {
    const { b, line, ppl } = await sendingBroadcast(2);
    await inbound(line.waPhoneNumberId!, ppl[0]!.wa, "STOP", minutes(-1));
    await runBroadcastTick(db, cfg, b.id, NOW);
    expect(sendsTo(ppl[0]!.wa)).toBe(0);
    expect(sendsTo(ppl[1]!.wa)).toBe(1);
    expect((await recipients(b.id)).find((r) => r.customerId === ppl[0]!.id)).toMatchObject({ state: "skipped", skipReason: "opted_out" });
  });

  it("a broadcast send does not assign the conversation, change its preview or move it in the list; a new conversation is closed and a reply reopens it, unread", async () => {
    const { b, line, ppl } = await sendingBroadcast(2);
    // Person 0 already has an open, unassigned chat.
    const [open] = await db
      .insert(inboxConversation)
      .values({ customerId: ppl[0]!.id, phoneNumberId: line.id, status: "open", channel: "whatsapp", lastPreview: "their words", lastActivityAt: minutes(-120) })
      .returning();
    await runBroadcastTick(db, cfg, b.id, NOW);
    const [after] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, open!.id));
    expect(after).toMatchObject({ assigneeId: null, lastPreview: "their words", status: "open" });
    expect(after!.lastActivityAt!.getTime()).toBe(minutes(-120).getTime());
    expect(after!.firstResponseAt).toBeNull();
    // Person 1 had no chat: a closed one was made for the message.
    const [made] = await db.select().from(inboxConversation).where(eq(inboxConversation.customerId, ppl[1]!.id));
    expect(made!.status).toBe("closed");
    // Their reply reopens it as an ordinary unread message and counts as a reply.
    await inbound(line.waPhoneNumberId!, ppl[1]!.wa, "How much is a bottle?", minutes(2));
    const [reopened] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, made!.id));
    expect(reopened!.status).toBe("open");
    expect(reopened!.unreadCount).toBe(1);
    expect((await recipients(b.id)).find((r) => r.customerId === ppl[1]!.id)!.repliedAt).not.toBeNull();
    // A STOP sets opted_out_at.
    await inbound(line.waPhoneNumberId!, ppl[0]!.wa, "stop", minutes(3));
    expect((await recipients(b.id)).find((r) => r.customerId === ppl[0]!.id)!.optedOutAt).not.toBeNull();
  });

  it("the broadcast finishes when nobody is waiting and raises broadcast.finished once", async () => {
    const { b } = await sendingBroadcast(2);
    await runBroadcastTick(db, cfg, b.id, NOW);
    await runBroadcastTick(db, cfg, b.id, minutes(1));
    await sweepBroadcasts(db, minutes(2));
    await sweepBroadcasts(db, minutes(3));
    expect((await statusOf(b.id)).s).toBe("done");
    expect(await alerts("broadcast.finished", b.id)).toHaveLength(1);
  });

  it("scheduled broadcasts start at their time, one per line, and are stopped instead if the switch is off", async () => {
    const x = await sendingBroadcast(1, { status: "scheduled", scheduledAt: minutes(5) });
    await startDueBroadcasts(db, NOW);
    expect((await statusOf(x.b.id)).s).toBe("scheduled");
    await startDueBroadcasts(db, minutes(6));
    expect((await statusOf(x.b.id)).s).toBe("sending");

    const y = await sendingBroadcast(1, { status: "scheduled", scheduledAt: minutes(5) });
    await setSettings({ enabled: false });
    await startDueBroadcasts(db, minutes(6));
    expect(await statusOf(y.b.id)).toMatchObject({ s: "stopped", r: "switched_off" });
    expect(calls).toHaveLength(0);
  });
});
