import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  findChildCall,
  findConference,
  updateParticipant,
  twiml,
  twilioSignature,
  userIdFromVoiceIdentity,
  verifyTwilioSignature,
  voiceAccessToken,
  voiceIdentityFor,
  xmlEscape,
} from "./twilio.js";

describe("verifyTwilioSignature", () => {
  // Twilio's published example (docs: "Webhooks security").
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  };
  const token = "12345";
  const published = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

  it("matches Twilio's published example", () => {
    expect(twilioSignature(url, params, token)).toBe(published);
    expect(verifyTwilioSignature(url, params, published, token)).toBe(true);
  });

  it("is independent of parameter insertion order", () => {
    const shuffled = { To: params.To, Digits: params.Digits, CallSid: params.CallSid, From: params.From, Caller: params.Caller };
    expect(verifyTwilioSignature(url, shuffled, published, token)).toBe(true);
  });

  it("rejects tampering, wrong token, wrong url and missing header", () => {
    expect(verifyTwilioSignature(url, { ...params, Digits: "1235" }, published, token)).toBe(false);
    expect(verifyTwilioSignature(url, params, published, "54321")).toBe(false);
    expect(verifyTwilioSignature("https://mycompany.com/myapp.php", params, published, token)).toBe(false);
    expect(verifyTwilioSignature(url, params, null, token)).toBe(false);
    expect(verifyTwilioSignature(url, params, "", token)).toBe(false);
    expect(verifyTwilioSignature(url, params, published, "")).toBe(false);
    expect(verifyTwilioSignature(url, params, "short", token)).toBe(false);
  });

  it("handles repeated parameters as sorted name+value pairs", () => {
    const sig = crypto.createHmac("sha1", token).update(`${url}Aa1Aa2Bb`).digest("base64");
    expect(verifyTwilioSignature(url, { B: "b", A: ["a2", "a1"] }, sig, token)).toBe(true);
  });
});

describe("TwiML builder", () => {
  it("escapes text and attributes", () => {
    expect(xmlEscape(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
    const xml = twiml().say("Fish & <chips>").redirect("https://x/menu?callId=1&attempt=2").toString();
    expect(xml).toContain("Fish &amp; &lt;chips&gt;");
    expect(xml).toContain(">https://x/menu?callId=1&amp;attempt=2</Redirect>");
    expect(xml).not.toContain("<chips>");
  });

  it("produces a well-formed Response with the expected verbs", () => {
    const xml = twiml()
      .say("This call may be recorded for quality and training.")
      .gather({ action: "https://api/v1/voice/menu?callId=c1&attempt=1", timeout: 5 }, { say: "Press 1 for sales" })
      .redirect("https://api/v1/voice/menu?callId=c1&attempt=1")
      .toString();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml.endsWith("</Response>")).toBe(true);
    expect(xml).toMatch(/<Gather input="dtmf" numDigits="1" timeout="5" action="[^"]+" method="POST"><Say [^>]*>Press 1 for sales<\/Say><\/Gather>/);
    expect(xml).toContain('voice="Polly.Amy" language="en-GB"');
  });

  it("dials several clients with recording and custom parameters", () => {
    const xml = twiml()
      .dialClients(
        [
          { identity: "u_aaa", params: { callId: "c1" } },
          { identity: "u_bbb" },
        ],
        {
          timeout: 25,
          record: "record-from-answer-dual",
          recordingStatusCallback: "https://api/v1/voice/recording?kind=call&callId=c1",
          action: "https://api/v1/voice/dial-result?callId=c1",
        },
      )
      .toString();
    expect(xml).toContain('<Dial timeout="25" record="record-from-answer-dual"');
    expect(xml).toContain('recordingStatusCallback="https://api/v1/voice/recording?kind=call&amp;callId=c1"');
    expect(xml).toContain('action="https://api/v1/voice/dial-result?callId=c1" method="POST"');
    expect(xml).toContain('<Client><Identity>u_aaa</Identity><Parameter name="callId" value="c1"/></Client>');
    expect(xml).toContain("<Client><Identity>u_bbb</Identity></Client>");
  });

  it("builds Record, Play, Hangup and Number dial", () => {
    const xml = twiml()
      .play("https://cdn/x.mp3")
      .record({ recordingStatusCallback: "https://api/rec", action: "https://api/done" })
      .hangup()
      .toString();
    expect(xml).toContain("<Play>https://cdn/x.mp3</Play>");
    expect(xml).toContain('<Record maxLength="120" playBeep="true" action="https://api/done" method="POST" recordingStatusCallback="https://api/rec"');
    expect(xml).toContain("<Hangup/></Response>");
    expect(twiml().dialNumber("+2348000000000", { callerId: "+2349000000000" }).toString()).toContain(
      '<Dial callerId="+2349000000000"><Number>+2348000000000</Number></Dial>',
    );
  });
});

describe("voiceAccessToken", () => {
  const input = {
    accountSid: "AC00000000000000000000000000000000",
    apiKeySid: "SK00000000000000000000000000000000",
    apiKeySecret: "secret",
    identity: "u_0123456789abcdef0123456789abcdef",
    outgoingApplicationSid: "AP00000000000000000000000000000000",
    nowSeconds: 1_700_000_000,
  };

  it("has the Twilio header, claims and voice grant, and a valid HS256 signature", () => {
    const token = voiceAccessToken(input);
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header).toEqual({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" });
    expect(payload).toMatchObject({
      jti: `${input.apiKeySid}-1700000000`,
      iss: input.apiKeySid,
      sub: input.accountSid,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      grants: {
        identity: input.identity,
        voice: { incoming: { allow: true }, outgoing: { application_sid: input.outgoingApplicationSid } },
      },
    });
    const expected = crypto.createHmac("sha256", "secret").update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });

  it("honours ttl and incomingAllow=false", () => {
    const token = voiceAccessToken({ ...input, ttlSeconds: 60, incomingAllow: false });
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(payload.exp).toBe(1_700_000_060);
    expect(payload.grants.voice.incoming.allow).toBe(false);
  });
});

describe("voice identities", () => {
  it("round-trips a user id", () => {
    const id = "0f8b6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const identity = voiceIdentityFor(id);
    expect(identity).toBe("u_0f8b6a3e1c2d4e5f8a9b0c1d2e3f4a5b");
    expect(userIdFromVoiceIdentity(identity)).toBe(id);
    expect(userIdFromVoiceIdentity(`client:${identity}`)).toBe(id);
  });
  it("rejects anything else", () => {
    expect(userIdFromVoiceIdentity(null)).toBeNull();
    expect(userIdFromVoiceIdentity("u_123")).toBeNull();
    expect(userIdFromVoiceIdentity("+2348000000000")).toBeNull();
    expect(userIdFromVoiceIdentity("client:bob")).toBeNull();
  });
});

describe("TwiML for the call queue and conferences", () => {
  it("enqueues with a wait URL and an action", () => {
    const xml = twiml().enqueue("line-1", { action: "https://x/queue-result?callId=1", waitUrl: "https://x/queue-wait?callId=1" }).toString();
    expect(xml).toContain(
      '<Enqueue action="https://x/queue-result?callId=1" method="POST" waitUrl="https://x/queue-wait?callId=1" waitUrlMethod="POST">line-1</Enqueue>',
    );
  });
  it("leaves the queue and pauses", () => {
    expect(twiml().pause(15).leave().toString()).toContain('<Pause length="15"/><Leave/>');
  });
  it("dials a conference, with coach and silent waiting", () => {
    const xml = twiml()
      .dialConference("call-1", { muted: false, coach: "CAagent", startConferenceOnEnter: false, waitUrl: "" }, { action: "https://x/done" })
      .toString();
    expect(xml).toContain('<Dial action="https://x/done" method="POST"><Conference muted="false" beep="false" coach="CAagent"');
    expect(xml).toContain('startConferenceOnEnter="false" endConferenceOnExit="false" waitUrl="" waitMethod="POST">call-1</Conference></Dial>');
  });
});

describe("conference REST helpers (fetch mocked)", () => {
  const cfg = { accountSid: "AC1", apiKeySid: "SK1", apiKeySecret: "s", baseUrl: "https://tw.test" };
  function mockFetch(respond: (url: string, init?: RequestInit) => Response): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
    const real = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return Promise.resolve(respond(url, init));
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = real) };
  }

  it("finds the staff leg of a call", async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ calls: [{ sid: "CAchild" }] })));
    try {
      expect(await findChildCall(cfg, "CAparent")).toBe("CAchild");
      expect(m.calls[0]!.url).toBe("https://tw.test/2010-04-01/Accounts/AC1/Calls.json?ParentCallSid=CAparent&Status=in-progress&PageSize=5");
    } finally {
      m.restore();
    }
  });
  it("finds a live conference by name, or null", async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ conferences: [] })));
    try {
      expect(await findConference(cfg, "call-1")).toBeNull();
      expect(m.calls[0]!.url).toContain("/Conferences.json?FriendlyName=call-1&Status=in-progress");
    } finally {
      m.restore();
    }
  });
  it("updates a participant: whisper sends Coaching and CallSidToCoach", async () => {
    const m = mockFetch(() => new Response("{}"));
    try {
      await updateParticipant(cfg, "CF1", "CAsup", { muted: false, coaching: true, callSidToCoach: "CAagent" });
      expect(m.calls[0]!.url).toBe("https://tw.test/2010-04-01/Accounts/AC1/Conferences/CF1/Participants/CAsup.json");
      expect(String(m.calls[0]!.init?.body)).toBe("Muted=false&Coaching=true&CallSidToCoach=CAagent");
    } finally {
      m.restore();
    }
  });
  it("throws a TwilioApiError when Twilio refuses", async () => {
    const m = mockFetch(() => new Response("{}", { status: 404 }));
    try {
      await expect(updateParticipant(cfg, "CF1", "CAsup", { muted: true, coaching: false })).rejects.toThrow("participant update failed: 404");
    } finally {
      m.restore();
    }
  });
});
