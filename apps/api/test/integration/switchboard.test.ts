/**
 * The live switchboard (/v1/inbox/switchboard) and the voice routes it uses
 * (/v1/voice/connect, /v1/inbox/voice/calls/:ref/hold, presence). Twilio's REST
 * API is never reached: fetch to api.twilio.com is caught and recorded here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  auditLog,
  inboxCall,
  inboxPhoneNumber,
  inboxPresence,
  inboxTeam,
  inboxTeamMember,
  inboxUserNumberAccess,
} from "@ms/db";
import { twilioSignature, voiceIdentityFor } from "@ms/domain";
import { loginAs, seedOwner, seedUser, setupTestDb } from "./helpers.js";

const AUTH_TOKEN = "itest-twilio-auth-token";
const PUBLIC = "https://api.example.test";

interface BoardLine {
  id: string;
  state: string;
  staff_id: string | null;
  ringing_for_id: string | null;
  number_label: string;
}
interface BoardStaff {
  id: string;
  state: string;
  away_set_by: string | null;
}
interface Board {
  lines: BoardLine[];
  staff: BoardStaff[];
  teams: { id: string; name: string }[];
  can_pick_up: boolean;
}

describe("switchboard", () => {
  let container: StartedPostgreSqlContainer;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let ownerId: string;
  let agentId: string;
  let managerId: string;
  let teamId: string;
  let otherTeamId: string;
  let owner: string;
  let agent: string;
  let manager: string;
  let sid = 0;
  /** Twilio REST calls the API made (redirects). */
  const twilioCalls: { url: string; body: string }[] = [];
  let twilioFails = false;

  async function twilio(pathAndQuery: string, params: Record<string, string>) {
    const url = `${PUBLIC}/v1/voice${pathAndQuery}`;
    const res = await fetch(`${baseUrl}/v1/voice${pathAndQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params, AUTH_TOKEN) },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, xml: await res.text() };
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

  const board = async (cookie = owner) => (await call(cookie, "GET", "/inbox/switchboard")).body.data as Board;

  async function online(userId: string) {
    await db
      .insert(inboxPresence)
      .values({ userId, available: true, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: inboxPresence.userId, set: { available: true, lastSeenAt: new Date(), awaySetBy: null } });
  }

  /** A customer rings the main line; the online agent is rung. Returns the call row. */
  async function ringingCall() {
    const p = { CallSid: `CA${String(++sid).padStart(32, "0")}`, From: `+23470111${String(sid).padStart(5, "0")}`, To: "+2348100000201", CallStatus: "ringing" };
    const res = await twilio("/incoming", p);
    expect(res.xml).toContain("<Dial");
    const [row] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid));
    return row!;
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
        twilioCalls.push({ url, body: String(init?.body ?? "") });
        return Promise.resolve(new Response(twilioFails ? "{}" : JSON.stringify({ sid: "CAx" }), { status: twilioFails ? 404 : 200 }));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const [team] = await db.insert(inboxTeam).values({ name: "Orders" }).returning();
    const [other] = await db.insert(inboxTeam).values({ name: "Deliveries" }).returning();
    teamId = team!.id;
    otherTeamId = other!.id;
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000201", label: "Main line", channels: "voice", defaultTeamId: teamId })
      .returning();

    agentId = (await seedUser(db, { email: "sb-agent@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer"] })).id;
    await db.insert(inboxTeamMember).values({ teamId, userId: agentId });
    await db.insert(inboxUserNumberAccess).values({ userId: agentId, phoneNumberId: line!.id });
    managerId = (await seedUser(db, { email: "sb-manager@example.com", role: "manager" })).id;
    await db.insert(inboxTeamMember).values({ teamId, userId: managerId });
    await db.insert(inboxUserNumberAccess).values({ userId: managerId, phoneNumberId: line!.id });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    agent = await loginAs(baseUrl, "sb-agent@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "sb-manager@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    twilioCalls.length = 0;
    twilioFails = false;
    // Every test starts with no live calls and the agent online.
    await db.update(inboxCall).set({ endedAt: new Date() });
    await db.delete(inboxPresence);
    await online(agentId);
  });

  it("needs calls.switchboard: staff get 403, managers and owners see the board", async () => {
    expect((await call(agent, "GET", "/inbox/switchboard")).status).toBe(403);
    expect((await call(manager, "GET", "/inbox/switchboard")).status).toBe(200);
    const b = await board();
    expect(b.teams.map((t) => t.name)).toEqual(["Deliveries", "Orders"]);
    expect(b.can_pick_up).toBe(true);
  });

  it("shows a ringing call and each person's state", async () => {
    const c = await ringingCall();
    const b = await board();
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({ id: c.id, state: "ringing", number_label: "Main line" });
    expect(b.staff.find((s) => s.id === agentId)?.state).toBe("available");
    expect(b.staff.find((s) => s.id === ownerId)?.state).toBe("away");
  });

  it("pick up: refused while I'm not taking calls; then the caller is redirected to ring only me", async () => {
    const c = await ringingCall();
    const refused = await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/pickup`);
    expect(refused.status).toBe(409);
    expect(twilioCalls).toHaveLength(0);

    await online(ownerId);
    const ok = await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/pickup`);
    expect(ok.status).toBe(200);
    expect(twilioCalls).toHaveLength(1);
    expect(twilioCalls[0]!.url).toContain(`/Calls/${c.twilioCallSid}.json`);
    const redirect = new URLSearchParams(twilioCalls[0]!.body).get("Url")!;
    expect(redirect).toBe(`${PUBLIC}/v1/voice/connect?callId=${c.id}&userId=${ownerId}`);
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, c.id));
    expect(after!.ringUserId).toBe(ownerId);
    expect((await board()).lines[0]!.ringing_for_id).toBe(ownerId);

    // Twilio fetches the new instructions: ring the owner's app, nobody else.
    const twiml = await twilio(`/connect?callId=${c.id}&userId=${ownerId}`, { CallSid: c.twilioCallSid });
    expect(twiml.xml).toContain(voiceIdentityFor(ownerId));
    expect(twiml.xml).not.toContain(voiceIdentityFor(agentId));
    expect(twiml.xml).toContain(`/v1/voice/dial-result?callId=${c.id}`);
    // /connect for anyone else just hangs up.
    expect((await twilio(`/connect?callId=${c.id}&userId=${agentId}`, { CallSid: c.twilioCallSid })).xml).toContain("<Hangup/>");

    // The owner answers.
    expect((await call(owner, "POST", `/inbox/voice/calls/${c.id}/accepted`)).status).toBe(200);
    expect((await board()).lines[0]!.state).toBe("on_call");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.call_pickup"), eq(auditLog.entityId, c.id)));
    expect(audit).toBeTruthy();
  });

  it("pick up: a call someone answered can't be picked up", async () => {
    const c = await ringingCall();
    await online(ownerId);
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`)).status).toBe(200);
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/pickup`)).status).toBe(409);
    expect(twilioCalls).toHaveLength(0);
  });

  it("pick up: a Twilio failure puts the call back as it was", async () => {
    const c = await ringingCall();
    await online(ownerId);
    twilioFails = true;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/pickup`)).status).toBe(409);
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, c.id));
    expect(after!.ringUserId).toBeNull();
  });

  it("hold: the person on the call reports it and the board shows it; nobody else can", async () => {
    const c = await ringingCall();
    await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`);
    expect((await call(owner, "POST", `/inbox/voice/calls/${c.id}/hold`, { held: true })).status).toBe(404);
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/hold`, { held: true })).status).toBe(200);
    expect((await board()).lines[0]!.state).toBe("on_hold");
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/hold`, { held: false })).status).toBe(200);
    expect((await board()).lines[0]!.state).toBe("on_call");
    expect((await board()).staff.find((s) => s.id === agentId)?.state).toBe("on_call");
  });

  it("transfer to a person: the caller is redirected to ring them; audited", async () => {
    const c = await ringingCall();
    await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`);
    // The manager isn't taking calls yet.
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { user_id: managerId })).status).toBe(409);
    await online(managerId);
    const res = await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { user_id: managerId });
    expect(res.status).toBe(200);
    const redirect = new URLSearchParams(twilioCalls[0]!.body).get("Url")!;
    expect(redirect).toBe(`${PUBLIC}/v1/voice/connect?callId=${c.id}&userId=${managerId}&transfer=1`);
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, c.id));
    expect(after).toMatchObject({ outcome: "in_progress", answeredByUserId: null, ringUserId: managerId });
    const xml = (await twilio(`/connect?callId=${c.id}&userId=${managerId}&transfer=1`, { CallSid: c.twilioCallSid })).xml;
    expect(xml).toContain("Please hold while we transfer your call.");
    expect(xml).toContain(voiceIdentityFor(managerId));
    // The manager, put through, may accept it.
    expect((await call(manager, "POST", `/inbox/voice/calls/${c.id}/accepted`)).status).toBe(200);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.call_transfer"), eq(auditLog.entityId, c.id)));
    expect(audits).toHaveLength(1);
  });

  it("transfer to a team uses the same /transfer as the call bar; a Twilio failure restores the call", async () => {
    const c = await ringingCall();
    await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`);
    twilioFails = true;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { team_id: otherTeamId })).status).toBe(409);
    const [restored] = await db.select().from(inboxCall).where(eq(inboxCall.id, c.id));
    expect(restored).toMatchObject({ outcome: "answered", answeredByUserId: agentId, teamId });

    twilioFails = false;
    twilioCalls.length = 0;
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { team_id: otherTeamId })).status).toBe(200);
    expect(new URLSearchParams(twilioCalls[0]!.body).get("Url")).toBe(`${PUBLIC}/v1/voice/transfer?callId=${c.id}&teamId=${otherTeamId}`);
  });

  it("transfer needs a call someone is on, and exactly one target", async () => {
    const c = await ringingCall();
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { team_id: otherTeamId })).status).toBe(409);
    await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`);
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, {})).status).toBe(400);
    expect((await call(owner, "POST", `/inbox/switchboard/calls/${c.id}/transfer`, { team_id: otherTeamId, user_id: managerId })).status).toBe(400);
  });

  it("the call bar's own transfer still works as before", async () => {
    const c = await ringingCall();
    await call(agent, "POST", `/inbox/voice/calls/${c.id}/accepted`);
    expect((await call(agent, "POST", `/inbox/voice/calls/${c.id}/transfer`, { team_id: otherTeamId })).status).toBe(200);
    expect(new URLSearchParams(twilioCalls[0]!.body).get("Url")).toBe(`${PUBLIC}/v1/voice/transfer?callId=${c.id}&teamId=${otherTeamId}`);
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, c.id));
    expect(after).toMatchObject({ outcome: "in_progress", answeredByUserId: null, teamId: otherTeamId });
  });

  it("mark away: sticks through the person's heartbeat until they switch on themselves; audited", async () => {
    const res = await call(owner, "POST", `/inbox/switchboard/staff/${agentId}/presence`, { available: false });
    expect(res.status).toBe(200);
    let b = await board();
    expect(b.staff.find((s) => s.id === agentId)).toMatchObject({ state: "away", away_set_by: "owner@example.com" });

    // The agent's open app keeps beating: still away, and told so.
    const beat = await call(agent, "POST", "/inbox/voice/presence", { available: true, heartbeat: true });
    expect(beat.body.data).toMatchObject({ available: false, set_away_by_manager: true });
    expect((await board()).staff.find((s) => s.id === agentId)?.state).toBe("away");

    // Their own switch wins.
    const own = await call(agent, "POST", "/inbox/voice/presence", { available: true });
    expect(own.body.data).toMatchObject({ available: true });
    b = await board();
    expect(b.staff.find((s) => s.id === agentId)).toMatchObject({ state: "available", away_set_by: null });

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.presence_set"), eq(auditLog.entityId, agentId)));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("mark available from the board; unknown people are 404; staff can't do it", async () => {
    await call(owner, "POST", `/inbox/switchboard/staff/${agentId}/presence`, { available: false });
    expect((await call(manager, "POST", `/inbox/switchboard/staff/${agentId}/presence`, { available: true })).status).toBe(200);
    const [p] = await db.select().from(inboxPresence).where(eq(inboxPresence.userId, agentId));
    expect(p).toMatchObject({ available: true, awaySetBy: null });
    expect((await call(owner, "POST", `/inbox/switchboard/staff/00000000-0000-4000-8000-000000000000/presence`, { available: true })).status).toBe(404);
    expect((await call(agent, "POST", `/inbox/switchboard/staff/${managerId}/presence`, { available: false })).status).toBe(403);
  });

  it("a person marked available who has never opened the app is shown as not connected", async () => {
    await call(owner, "POST", `/inbox/switchboard/staff/${managerId}/presence`, { available: true });
    expect((await board()).staff.find((s) => s.id === managerId)?.state).toBe("offline");
  });
});
