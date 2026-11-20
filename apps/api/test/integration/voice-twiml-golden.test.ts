/**
 * Today's call flow, byte for byte. Every TwiML answer Twilio gets in the
 * normal flow (call queue and supervisor tools switched OFF, the default) is
 * compared with fixtures/voice-twiml-off.json, which was recorded from the
 * code BEFORE the switchboard was added (branch work/olu/suite-calls). If this
 * test fails, the ordinary call flow has changed.
 *
 * Ids differ per run, so they are replaced by names ({call}, {agent}, …)
 * before comparing. To re-record (only when a change to the flow is
 * intended): VOICE_GOLDEN_RECORD=1 npx vitest run test/integration/voice-twiml-golden.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  customer,
  inboxCall,
  inboxConversation,
  inboxHoursProfile,
  inboxHoursRule,
  inboxIvrMenu,
  inboxIvrOption,
  inboxPhoneNumber,
  inboxPresence,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
} from "@ms/db";
import { twilioSignature, voiceIdentityFor } from "@ms/domain";
import { seedOwner, seedUser, setupTestDb } from "./helpers.js";

const AUTH_TOKEN = "itest-twilio-auth-token";
const PUBLIC = "https://api.example.test";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "voice-twiml-off.json");
const RECORD = process.env.VOICE_GOLDEN_RECORD === "1";

describe("voice TwiML with the call queue and supervisor tools OFF (unchanged from before)", () => {
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  const names = new Map<string, string>();
  const recorded: Record<string, string> = {};
  const expected: Record<string, string> = RECORD ? {} : (JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, string>);
  let sid = 0;

  function name(id: string, label: string): void {
    names.set(id, `{${label}}`);
    names.set(voiceIdentityFor(id), `{${label}-identity}`);
  }
  function normalise(xml: string): string {
    let out = xml;
    // Longest first so an identity is replaced before the bare id inside nothing else.
    for (const [raw, label] of [...names.entries()].sort((a, b) => b[0].length - a[0].length)) out = out.split(raw).join(label);
    // A call's own id is only known after its first answer: any id not named yet.
    return out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}");
  }

  async function twilio(label: string, pathAndQuery: string, params: Record<string, string>): Promise<string> {
    const url = `${PUBLIC}/v1/voice${pathAndQuery}`;
    const res = await fetch(`${baseUrl}/v1/voice${pathAndQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params, AUTH_TOKEN) },
      body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);
    const xml = normalise(await res.text());
    recorded[label] = xml;
    if (!RECORD) expect(xml, label).toBe(expected[label]);
    return xml;
  }

  function newCall(to: string, from = "+2347011112222") {
    const CallSid = `CA${String(++sid).padStart(32, "0")}`;
    names.set(CallSid, `{sid${sid}}`);
    return { CallSid, From: from, To: to, CallStatus: "ringing" };
  }
  async function callId(sidValue: string, label: string): Promise<string> {
    const [row] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, sidValue));
    name(row!.id, label);
    return row!.id;
  }

  let agentId: string;
  let busyId: string;
  let teamId: string;
  let soloTeamId: string;
  let mainLine: string;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_API_URL = PUBLIC;
    await seedOwner(db);

    const [team] = await db.insert(inboxTeam).values({ name: "Orders" }).returning();
    const [solo] = await db.insert(inboxTeam).values({ name: "Solo" }).returning();
    const [empty] = await db.insert(inboxTeam).values({ name: "Empty" }).returning();
    teamId = team!.id;
    soloTeamId = solo!.id;
    name(teamId, "team");
    name(soloTeamId, "solo-team");
    name(empty!.id, "empty-team");

    const [open] = await db.insert(inboxHoursProfile).values({ name: "Always" }).returning();
    await db.insert(inboxHoursRule).values(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ profileId: open!.id, weekday, openTime: "00:00", closeTime: "24:00" })),
    );
    const [closed] = await db.insert(inboxHoursProfile).values({ name: "Closed" }).returning();
    const [menu] = await db.insert(inboxIvrMenu).values({ name: "Main", greetingText: "Press 1 for orders. Press 2 to leave a message." }).returning();
    await db.insert(inboxIvrOption).values([
      { menuId: menu!.id, digit: "1", label: "Orders", action: "ring_team", teamId },
      { menuId: menu!.id, digit: "2", label: "Message", action: "voicemail" },
      { menuId: menu!.id, digit: "3", label: "Empty", action: "ring_team", teamId: empty!.id },
      { menuId: menu!.id, digit: "9", label: "Address", action: "play", playText: "We are in Lekki." },
    ]);
    const [n1] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000301", label: "Main line", channels: "voice", hoursProfileId: open!.id, ivrMenuId: menu!.id, defaultTeamId: teamId })
      .returning();
    mainLine = n1!.id;
    name(mainLine, "main-line");
    const [n2] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000302", label: "Night line", channels: "voice", hoursProfileId: closed!.id, defaultTeamId: teamId, afterHoursText: "We are closed. Leave a message." })
      .returning();
    name(n2!.id, "night-line");
    const [n3] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000303", label: "Direct line", channels: "voice", defaultTeamId: soloTeamId })
      .returning();
    name(n3!.id, "direct-line");

    agentId = (await seedUser(db, { email: "golden-agent@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer", "calls.outbound"] })).id;
    name(agentId, "agent");
    busyId = (await seedUser(db, { email: "golden-busy@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer"] })).id;
    name(busyId, "busy");
    for (const [u, t] of [
      [agentId, teamId],
      [busyId, teamId],
      [busyId, soloTeamId],
    ] as const) {
      await db.insert(inboxTeamMember).values({ teamId: t, userId: u });
    }
    for (const u of [agentId, busyId]) {
      for (const n of [mainLine, n3!.id]) await db.insert(inboxUserNumberAccess).values({ userId: u, phoneNumberId: n });
    }

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    if (RECORD) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    await container?.stop();
  });

  it("after hours: the closed message and voicemail", async () => {
    const p = newCall("+2348100000302");
    await twilio("after-hours", "/incoming", p);
  });

  it("unknown number and withheld caller", async () => {
    await twilio("unknown-number", "/incoming", newCall("+2348100000999"));
    await twilio("withheld", "/incoming", { ...newCall("+2348100000301"), From: "anonymous" });
  });

  it("the phone menu, a wrong key, no key, then the default option", async () => {
    const p = newCall("+2348100000301");
    await twilio("menu-greeting", "/incoming", p);
    const id = await callId(p.CallSid, "call-menu");
    await twilio("menu-wrong-key", `/menu?callId=${id}&attempt=1`, { ...p, Digits: "7" });
    await twilio("menu-no-key-fallback", `/menu?callId=${id}&attempt=2`, p);
  });

  it("menu options: nobody online (voicemail), voicemail option, play option, empty team", async () => {
    const a = newCall("+2348100000301");
    await twilio("menu-greeting-2", "/incoming", a);
    const idA = await callId(a.CallSid, "call-a");
    await twilio("ring-team-nobody-online", `/menu?callId=${idA}`, { ...a, Digits: "1" });

    const b = newCall("+2348100000301");
    await twilio("menu-greeting-3", "/incoming", b);
    const idB = await callId(b.CallSid, "call-b");
    await twilio("voicemail-option", `/menu?callId=${idB}`, { ...b, Digits: "2" });

    const c = newCall("+2348100000301");
    await twilio("menu-greeting-4", "/incoming", c);
    const idC = await callId(c.CallSid, "call-c");
    await twilio("play-option", `/menu?callId=${idC}`, { ...c, Digits: "9" });

    const d = newCall("+2348100000301");
    await twilio("menu-greeting-5", "/incoming", d);
    const idD = await callId(d.CallSid, "call-d");
    await twilio("ring-empty-team", `/menu?callId=${idD}`, { ...d, Digits: "3" });
  });

  it("ringing staff, answer, no answer, transfer, status", async () => {
    await db.insert(inboxPresence).values({ userId: agentId, available: true, lastSeenAt: new Date() });
    const p = newCall("+2348100000301");
    await twilio("menu-greeting-6", "/incoming", p);
    const id = await callId(p.CallSid, "call-ring");
    await twilio("ring-team-agent-online", `/menu?callId=${id}`, { ...p, Digits: "1" });
    await twilio("dial-result-no-answer", `/dial-result?callId=${id}`, { ...p, DialCallStatus: "no-answer" });

    const q = newCall("+2348100000301");
    await twilio("menu-greeting-7", "/incoming", q);
    const id2 = await callId(q.CallSid, "call-answered");
    await twilio("ring-team-agent-online-2", `/menu?callId=${id2}`, { ...q, Digits: "1" });
    await twilio("dial-result-answered", `/dial-result?callId=${id2}`, { ...q, DialCallStatus: "completed", DialCallDuration: "42" });
    await twilio("transfer-to-team", `/transfer?callId=${id2}&teamId=${teamId}`, q);
    await twilio("status-completed", "/status", { ...q, CallStatus: "completed", CallDuration: "60" });
    await twilio("done", "/done", q);
  });

  it("a busy colleague (already on a call) is still rung, as today", async () => {
    await db
      .insert(inboxPresence)
      .values({ userId: busyId, available: true, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: inboxPresence.userId, set: { available: true, lastSeenAt: new Date() } });
    // busy is talking to another customer.
    const [cust] = await db.insert(customer).values({ phone: "+2347099990000", name: "Other", source: "phone" }).returning();
    const [conv] = await db.insert(inboxConversation).values({ customerId: cust!.id, phoneNumberId: mainLine, teamId }).returning();
    await db.insert(inboxCall).values({
      conversationId: conv!.id,
      customerId: cust!.id,
      phoneNumberId: mainLine,
      twilioCallSid: "CAbusy0000000000000000000000000000",
      direction: "in",
      fromE164: "+2347099990000",
      toE164: "+2348100000303",
      outcome: "answered",
      answeredByUserId: busyId,
      answeredAt: new Date(),
    });
    // The direct line rings the Solo team (busy only) straight away.
    const p = newCall("+2348100000303");
    await twilio("direct-line-busy-colleague", "/incoming", p);
    await callId(p.CallSid, "call-direct");
  });

  it("an outgoing call from the browser", async () => {
    const p = { CallSid: `CA${String(++sid).padStart(32, "0")}`, From: `client:${voiceIdentityFor(agentId)}`, To: "+2347055556666", callerNumberId: mainLine };
    names.set(p.CallSid, `{sid${sid}}`);
    await twilio("outbound-call", "/outbound", p);
  });

  it("matches the recording made before the switchboard existed", () => {
    if (RECORD) return;
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(expected).sort());
  });
});
