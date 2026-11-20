/**
 * Call queue and supervisor tools (the owner's beta switch, app_settings
 * "call_features"). Twilio's REST API is caught here; nothing reaches Twilio.
 * The OFF path is proven unchanged by voice-twiml-golden.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { appSetting, auditLog, inboxCall, inboxPhoneNumber, inboxPresence, inboxTeam, inboxTeamMember, inboxUserNumberAccess } from "@ms/db";
import { twilioSignature, voiceIdentityFor } from "@ms/domain";
import { loginAs, seedOwner, seedUser, setupTestDb } from "./helpers.js";

const AUTH_TOKEN = "itest-twilio-auth-token";
const PUBLIC = "https://api.example.test";

describe("switchboard beta: call queue and supervisor tools", () => {
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerId: string;
  let agentId: string;
  let owner: string;
  let agent: string;
  let sid = 0;
  const twilioCalls: { url: string; method: string; body: string }[] = [];
  let childSid: string | null = "CAchild000000000000000000000000000";

  async function twilio(pathAndQuery: string, params: Record<string, string>) {
    const url = `${PUBLIC}/v1/voice${pathAndQuery}`;
    const res = await fetch(`${baseUrl}/v1/voice${pathAndQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params, AUTH_TOKEN) },
      body: new URLSearchParams(params).toString(),
    });
    return res.text();
  }
  async function call(cookie: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
  async function online(userId: string) {
    await db
      .insert(inboxPresence)
      .values({ userId, available: true, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: inboxPresence.userId, set: { available: true, lastSeenAt: new Date() } });
  }
  async function setFeatures(enabled: boolean) {
    expect((await call(owner, "PUT", "/inbox/call-features", { enabled, hold_audio_key: null, max_wait_s: 120 })).status).toBe(200);
  }
  function newCall() {
    return { CallSid: `CA${String(++sid).padStart(32, "0")}`, From: `+23470222${String(sid).padStart(5, "0")}`, To: "+2348100000401", CallStatus: "ringing" };
  }
  async function rowFor(callSid: string) {
    const [row] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, callSid));
    return row!;
  }
  /** A call the agent is talking on. */
  async function answeredCall() {
    const p = newCall();
    expect(await twilio("/incoming", p)).toContain("<Dial");
    const c = await rowFor(p.CallSid);
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`)).status).toBe(200);
    return { p, c };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_API_URL = PUBLIC;
    process.env.TWILIO_ACCOUNT_SID = "ACitest";
    process.env.TWILIO_API_KEY_SID = "SKitest";
    process.env.TWILIO_API_KEY_SECRET = "itest-secret";
    ownerId = (await seedOwner(db)).id;

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.twilio.com/")) {
        twilioCalls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
        if (url.includes("/Calls.json?")) return Promise.resolve(new Response(JSON.stringify({ calls: childSid ? [{ sid: childSid }] : [] })));
        if (url.includes("/Conferences.json?")) return Promise.resolve(new Response(JSON.stringify({ conferences: [{ sid: "CFroom" }] })));
        return Promise.resolve(new Response("{}"));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const [team] = await db.insert(inboxTeam).values({ name: "Orders" }).returning();
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000401", label: "Main line", channels: "voice", defaultTeamId: team!.id })
      .returning();
    agentId = (await seedUser(db, { email: "beta-agent@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer"] })).id;
    await db.insert(inboxTeamMember).values({ teamId: team!.id, userId: agentId });
    await db.insert(inboxUserNumberAccess).values({ userId: agentId, phoneNumberId: line!.id });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    agent = await loginAs(baseUrl, "beta-agent@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    twilioCalls.length = 0;
    childSid = "CAchild000000000000000000000000000";
    await db.update(inboxCall).set({ endedAt: new Date() });
    await db.delete(inboxPresence);
    await db.delete(appSetting).where(eq(appSetting.key, "call_features"));
    await online(agentId);
  });

  it("the setting: OFF by default, only inbox.settings may change it, audited", async () => {
    expect((await call(owner, "GET", "/inbox/call-features")).body.data).toEqual({ enabled: false, hold_audio_key: null, max_wait_s: 300 });
    expect((await call(agent, "PUT", "/inbox/call-features", { enabled: true, hold_audio_key: null, max_wait_s: 120 })).status).toBe(403);
    expect((await call(owner, "PUT", "/inbox/call-features", { enabled: true, hold_audio_key: "http://x/y.mp3", max_wait_s: 120 })).status).toBe(400);
    await setFeatures(true);
    expect((await call(owner, "GET", "/inbox/call-features")).body.data).toMatchObject({ enabled: true, max_wait_s: 120 });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "inbox.call_features"))).length).toBeGreaterThan(0);
  });

  it("OFF: a busy agent is still rung (no queue)", async () => {
    await answeredCall();
    const p = newCall();
    const xml = await twilio("/incoming", p);
    expect(xml).toContain(voiceIdentityFor(agentId));
    expect(xml).not.toContain("<Enqueue");
  });

  it("ON: everyone busy → the caller waits in the queue, hears their place, and the board shows them waiting", async () => {
    await setFeatures(true);
    await answeredCall();
    const p = newCall();
    const xml = await twilio("/incoming", p);
    const c = await rowFor(p.CallSid);
    expect(xml).toContain(
      `<Enqueue action="${PUBLIC}/v1/voice/queue-result?callId=${c.id}" method="POST" waitUrl="${PUBLIC}/v1/voice/queue-wait?callId=${c.id}" waitUrlMethod="POST">line-`,
    );
    expect(c.queuedAt).not.toBeNull();
    const board = (await call(owner, "GET", "/inbox/switchboard")).body.data as { lines: { id: string; state: string }[]; queue_and_supervisor_tools: boolean };
    expect(board.queue_and_supervisor_tools).toBe(true);
    expect(board.lines.find((l) => l.id === c.id)?.state).toBe("waiting");

    const wait = await twilio(`/queue-wait?callId=${c.id}`, { CallSid: p.CallSid, QueuePosition: "2", QueueTime: "10" });
    expect(wait).toContain("You are number 2 in line.");
    expect(wait).toContain('<Pause length="20"/>');
    // Waited too long: leave, and with nobody free, voicemail.
    expect(await twilio(`/queue-wait?callId=${c.id}`, { CallSid: p.CallSid, QueuePosition: "1", QueueTime: "120" })).toContain("<Leave/>");
    const result = await twilio(`/queue-result?callId=${c.id}`, { CallSid: p.CallSid, QueueResult: "leave" });
    expect(result).toContain("<Record");
    const after = await rowFor(p.CallSid);
    expect(after).toMatchObject({ outcome: "missed", queuedAt: null });
  });

  it("ON: when someone becomes free the caller leaves the queue and rings them", async () => {
    await setFeatures(true);
    const { p: first } = await answeredCall();
    const p = newCall();
    await twilio("/incoming", p);
    const c = await rowFor(p.CallSid);
    // The first call ends: the agent is free.
    await twilio("/status", { ...first, CallStatus: "completed", CallDuration: "30" });
    expect(await twilio(`/queue-wait?callId=${c.id}`, { CallSid: p.CallSid, QueuePosition: "1", QueueTime: "15" })).toContain("<Leave/>");
    const result = await twilio(`/queue-result?callId=${c.id}`, { CallSid: p.CallSid, QueueResult: "leave" });
    expect(result).toContain(voiceIdentityFor(agentId));
  });

  it("ON: take the longest-waiting caller from the board", async () => {
    await setFeatures(true);
    await answeredCall();
    const p = newCall();
    await twilio("/incoming", p);
    const c = await rowFor(p.CallSid);
    expect((await call(owner, "POST", "/inbox/switchboard/queue/take-next")).status).toBe(409); // owner isn't taking calls
    await online(ownerId);
    const res = await call(owner, "POST", "/inbox/switchboard/queue/take-next");
    expect(res.status).toBe(200);
    expect(res.body.call_id).toBe(c.id);
    expect(new URLSearchParams(twilioCalls[0]!.body).get("Url")).toBe(`${PUBLIC}/v1/voice/connect?callId=${c.id}&userId=${ownerId}`);
    expect(await rowFor(p.CallSid)).toMatchObject({ queuedAt: null, ringUserId: ownerId });
    // Twilio reports the redirect out of the queue: nothing else happens.
    expect(await twilio(`/queue-result?callId=${c.id}`, { CallSid: p.CallSid, QueueResult: "redirected" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect((await call(owner, "POST", "/inbox/switchboard/queue/take-next")).status).toBe(409); // nobody left
  });

  it("listen in: refused while the switch is OFF", async () => {
    const { c } = await answeredCall();
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/listen`, { mode: "listen" })).status).toBe(409);
    expect(twilioCalls).toHaveLength(0);
  });

  it("listen in: moves the call into a conference, then the supervisor joins muted, whispers, joins, leaves", async () => {
    await setFeatures(true);
    const { p, c } = await answeredCall();
    const res = await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/listen`, { mode: "listen" });
    expect(res.status).toBe(200);
    // The staff leg was looked up and redirected into the room.
    expect(twilioCalls[0]!.url).toContain(`ParentCallSid=${p.CallSid}`);
    expect(twilioCalls[1]!.url).toContain(`/Calls/${childSid}.json`);
    expect(new URLSearchParams(twilioCalls[1]!.body).get("Url")).toBe(`${PUBLIC}/v1/voice/conference?callId=${c.id}&role=agent`);
    let row = await rowFor(p.CallSid);
    expect(row).toMatchObject({ conferenceName: `call-${c.id}`, agentCallSid: childSid, monitorUserId: ownerId, monitorMode: "listen" });

    // The staff leg's TwiML, then the caller's <Dial> ends and they follow into the room (recorded).
    expect(await twilio(`/conference?callId=${c.id}&role=agent`, { CallSid: childSid! })).toContain(`>call-${c.id}</Conference>`);
    const caller = await twilio(`/dial-result?callId=${c.id}`, { ...p, DialCallStatus: "completed", DialCallDuration: "20" });
    expect(caller).toContain('record="record-from-start"');
    expect(caller).toContain('endConferenceOnExit="true"');
    expect(caller).toContain(`>call-${c.id}</Conference>`);

    // The supervisor's app connects: muted.
    const sup = await twilio("/outbound", { CallSid: "CAsup0000000000000000000000000000", From: `client:${voiceIdentityFor(ownerId)}`, listenCallId: c.id });
    expect(sup).toContain('muted="true"');
    expect(sup).toContain('startConferenceOnEnter="false"');
    expect(sup).toContain(`/v1/voice/conference-done?callId=${c.id}&amp;role=monitor`);
    // Someone else can't use the same door.
    const other = await twilio("/outbound", { CallSid: "CAx00000000000000000000000000000000", From: `client:${voiceIdentityFor(agentId)}`, listenCallId: c.id });
    expect(other).toContain("can&apos;t listen");

    // Whisper: coach the staff leg.
    twilioCalls.length = 0;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/monitor`, { mode: "whisper" })).status).toBe(200);
    expect(twilioCalls[1]!.url).toContain("/Conferences/CFroom/Participants/CAsup0000000000000000000000000000.json");
    expect(twilioCalls[1]!.body).toBe(`Muted=false&Coaching=true&CallSidToCoach=${childSid}`);
    // Join.
    twilioCalls.length = 0;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/monitor`, { mode: "join" })).status).toBe(200);
    expect(twilioCalls[1]!.body).toBe("Muted=false&Coaching=false");
    expect((await rowFor(p.CallSid)).monitorMode).toBe("join");

    // The supervisor hangs up: their leg's status clears it.
    await twilio("/status", { CallSid: "CAsup0000000000000000000000000000", CallStatus: "completed" });
    row = await rowFor(p.CallSid);
    expect(row).toMatchObject({ monitorUserId: null, monitorCallSid: null, monitorMode: null, conferenceName: `call-${c.id}` });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.call_listen"), eq(auditLog.entityId, c.id)));
    expect(audits).toHaveLength(3);
  });

  it("listen in: no staff leg found → refused and nothing changed", async () => {
    await setFeatures(true);
    const { p, c } = await answeredCall();
    childSid = null;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/listen`, { mode: "listen" })).status).toBe(409);
    expect(await rowFor(p.CallSid)).toMatchObject({ conferenceName: null, monitorUserId: null });
  });

  it("transfer out of a conference clears the room", async () => {
    await setFeatures(true);
    const { p, c } = await answeredCall();
    await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/listen`, { mode: "listen" });
    const team = (await db.select().from(inboxTeam))[0]!;
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/transfer`, { team_id: team.id })).status).toBe(200);
    expect(await rowFor(p.CallSid)).toMatchObject({ conferenceName: null, agentCallSid: null, monitorUserId: null, outcome: "in_progress" });
    // The caller's next answered dial ends normally (no conference).
    expect(await twilio(`/dial-result?callId=${c.id}`, { ...p, DialCallStatus: "completed" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    );
  });
});
