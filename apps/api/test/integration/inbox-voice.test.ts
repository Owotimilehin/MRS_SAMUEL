import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  inboxCall,
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
import { twilioSignature } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser } from "./helpers.js";

const AUTH_TOKEN = "itest-twilio-auth-token";
const PUBLIC = "https://api.example.test";

describe("unified inbox — voice webhooks", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let openNumber: string;
  let teamId: string;
  let agentId: string;
  let sid = 0;

  /** POST a form to /v1/voice/<pathAndQuery>, signed as Twilio would sign it. */
  async function twilio(pathAndQuery: string, params: Record<string, string>, signature?: string) {
    const url = `${PUBLIC}/v1/voice${pathAndQuery}`;
    const sig = signature ?? twilioSignature(url, params, AUTH_TOKEN);
    const res = await fetch(`${baseUrl}/v1/voice${pathAndQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, xml: await res.text() };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_API_URL = PUBLIC;
    await seedOwner(db);

    const [team] = await db.insert(inboxTeam).values({ name: "Orders" }).returning();
    teamId = team!.id;

    // Always open: every day 00:00–24:00.
    const [open] = await db.insert(inboxHoursProfile).values({ name: "Always" }).returning();
    await db.insert(inboxHoursRule).values(
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ profileId: open!.id, weekday, openTime: "00:00", closeTime: "24:00" })),
    );
    // Never open: a profile with no rules.
    const [closed] = await db.insert(inboxHoursProfile).values({ name: "Closed" }).returning();

    const [menu] = await db.insert(inboxIvrMenu).values({ name: "Main", greetingText: "Press 1 for orders." }).returning();
    await db.insert(inboxIvrOption).values([
      { menuId: menu!.id, digit: "1", label: "Orders", action: "ring_team", teamId },
      { menuId: menu!.id, digit: "9", label: "Address", action: "play", playText: "We are in Lekki." },
    ]);

    const [n1] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000001", label: "Main line", channels: "voice", hoursProfileId: open!.id, ivrMenuId: menu!.id, defaultTeamId: teamId })
      .returning();
    openNumber = n1!.id;
    await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348100000002", label: "Night line", channels: "voice", hoursProfileId: closed!.id, defaultTeamId: teamId });

    const agent = await seedUser(db, { email: "voice-agent@example.com", role: "branch_staff", granted: ["inbox.view", "calls.answer"] });
    agentId = agent.id;
    await db.insert(inboxTeamMember).values({ teamId, userId: agentId });
    await db.insert(inboxUserNumberAccess).values({ userId: agentId, phoneNumberId: openNumber });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  const callParams = (to: string) => ({ CallSid: `CA${String(++sid).padStart(32, "0")}`, From: "+2347011112222", To: to, CallStatus: "ringing" });

  it("rejects an unsigned request", async () => {
    const res = await twilio("/incoming", callParams("+2348100000001"), "bogus");
    expect(res.status).toBe(403);
  });

  it("after hours: closed message, voicemail, outcome after_hours", async () => {
    const p = callParams("+2348100000002");
    const res = await twilio("/incoming", p);
    expect(res.status).toBe(200);
    expect(res.xml).toContain("<Record");
    const [call] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid));
    expect(call!.outcome).toBe("after_hours");
  });

  it("open hours: plays the recording notice and the menu", async () => {
    const p = callParams("+2348100000001");
    const res = await twilio("/incoming", p);
    expect(res.status).toBe(200);
    expect(res.xml).toContain("<Gather");
    expect(res.xml).toContain("Press 1 for orders.");
    expect(res.xml.toLowerCase()).toContain("recorded");
  });

  it("menu choice with nobody online goes to voicemail and marks the call missed", async () => {
    const p = callParams("+2348100000001");
    await twilio("/incoming", p);
    const [call] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid));
    const res = await twilio(`/menu?callId=${call!.id}`, { ...p, Digits: "1" });
    expect(res.xml).toContain("<Record");
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, call!.id));
    expect(after!.outcome).toBe("missed");
    expect(after!.ivrChoice).toBe("1");
  });

  it("menu choice rings the online agent in the team as a browser client", async () => {
    await db.insert(inboxPresence).values({ userId: agentId, available: true, lastSeenAt: new Date() });
    const p = callParams("+2348100000001");
    await twilio("/incoming", p);
    const [call] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid));
    const res = await twilio(`/menu?callId=${call!.id}`, { ...p, Digits: "1" });
    expect(res.xml).toContain("<Dial");
    expect(res.xml).toContain(`u_${agentId.replace(/-/g, "")}`);
  });

  it("an information-only option is not counted as a missed call", async () => {
    const p = callParams("+2348100000001");
    await twilio("/incoming", p);
    const [call] = await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid));
    const res = await twilio(`/menu?callId=${call!.id}`, { ...p, Digits: "9" });
    expect(res.xml).toContain("We are in Lekki.");
    await twilio("/status", { ...p, CallStatus: "completed", CallDuration: "12" });
    const [after] = await db.select().from(inboxCall).where(eq(inboxCall.id, call!.id));
    expect(after!.outcome).toBe("information");
  });

  it("an incoming call never matches a non-phone row", async () => {
    // A Facebook Page row that (wrongly) carries an inbound match value: still never a call target (rule R21).
    await db.insert(inboxPhoneNumber).values({
      kind: "messenger",
      e164: null,
      externalId: "100000000000077",
      pageExternalId: "100000000000077",
      externalName: "Mrs Samuel fruit juice",
      label: "Facebook Page",
      channels: "whatsapp",
      inboundMatch: "+2348100000077",
    });
    const p = callParams("+2348100000077");
    const res = await twilio("/incoming", p);
    expect(res.status).toBe(200);
    expect(res.xml).toContain("not in service");
    expect(await db.select().from(inboxCall).where(eq(inboxCall.twilioCallSid, p.CallSid))).toHaveLength(0);
  });
});
