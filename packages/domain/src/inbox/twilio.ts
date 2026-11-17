/**
 * Twilio Programmable Voice, without the Twilio SDK: webhook signature check,
 * a tiny TwiML builder, the browser Voice access token, and the two REST calls
 * the worker needs (download + delete a recording).
 *
 * Config comes from env:
 *   TWILIO_ACCOUNT_SID     – AC…
 *   TWILIO_AUTH_TOKEN      – webhook signature (X-Twilio-Signature)
 *   TWILIO_API_KEY_SID     – SK… (REST Basic auth + access-token signing)
 *   TWILIO_API_KEY_SECRET
 *   TWILIO_TWIML_APP_SID   – AP… (the TwiML App whose Voice URL is /v1/voice/outbound)
 */
import crypto from "node:crypto";

// ── Webhook signature ────────────────────────────────────────────────────────

/**
 * Twilio's X-Twilio-Signature check: the full URL Twilio called (including any
 * query string), followed by every POST parameter as name+value, sorted by name
 * (case-sensitive), HMAC-SHA1 with the auth token, base64. Constant-time compare.
 */
export function verifyTwilioSignature(
  url: string,
  params: Readonly<Record<string, string | readonly string[]>>,
  header: string | null | undefined,
  authToken: string,
): boolean {
  if (!header || !authToken) return false;
  const expected = twilioSignature(url, params, authToken);
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Compute the signature Twilio would send (exported for tests and tooling). */
export function twilioSignature(
  url: string,
  params: Readonly<Record<string, string | readonly string[]>>,
  authToken: string,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key]!;
    const values = typeof v === "string" ? [v] : [...v].sort();
    for (const value of values) data += key + value;
  }
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

// ── TwiML ────────────────────────────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Attrs = Record<string, string | number | boolean | null | undefined>;

function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join("");
}

function el(name: string, a: Attrs, inner?: string): string {
  return inner === undefined || inner === "" ? `<${name}${attrs(a)}/>` : `<${name}${attrs(a)}>${inner}</${name}>`;
}

export const DEFAULT_VOICE = "Polly.Amy";
export const DEFAULT_LANGUAGE = "en-GB";

export interface SayOpts {
  voice?: string;
  language?: string;
}

export interface DialClient {
  identity: string;
  /** Custom parameters the Voice SDK exposes as call.customParameters. */
  params?: Record<string, string>;
}

export interface DialOpts {
  timeout?: number;
  callerId?: string;
  record?: "do-not-record" | "record-from-answer" | "record-from-answer-dual" | "record-from-ringing-dual";
  recordingStatusCallback?: string;
  action?: string;
  answerOnBridge?: boolean;
}

export interface RecordOpts {
  maxLength?: number;
  timeout?: number;
  playBeep?: boolean;
  action?: string;
  recordingStatusCallback?: string;
}

export interface GatherOpts {
  numDigits?: number;
  timeout?: number;
  action: string;
}

/** Chainable TwiML builder. Every text and attribute is XML-escaped. */
export class TwiML {
  private readonly parts: string[] = [];

  say(text: string, opts: SayOpts = {}): this {
    this.parts.push(this.sayXml(text, opts));
    return this;
  }

  play(url: string): this {
    this.parts.push(el("Play", {}, xmlEscape(url)));
    return this;
  }

  /** Gather one keypress while saying `prompt`. */
  gather(opts: GatherOpts, prompt?: { say?: string; play?: string; sayOpts?: SayOpts }): this {
    let inner = "";
    if (prompt?.play) inner += el("Play", {}, xmlEscape(prompt.play));
    else if (prompt?.say) inner += this.sayXml(prompt.say, prompt.sayOpts ?? {});
    this.parts.push(
      el(
        "Gather",
        {
          input: "dtmf",
          numDigits: opts.numDigits ?? 1,
          timeout: opts.timeout ?? 5,
          action: opts.action,
          method: "POST",
        },
        inner,
      ),
    );
    return this;
  }

  /** Ring several browser/app clients at once; the first to answer gets the call. */
  dialClients(clients: readonly DialClient[], opts: DialOpts = {}): this {
    const inner = clients
      .map((c) => {
        const params = Object.entries(c.params ?? {})
          .map(([name, value]) => el("Parameter", { name, value }))
          .join("");
        return el("Client", {}, el("Identity", {}, xmlEscape(c.identity)) + params);
      })
      .join("");
    this.parts.push(el("Dial", this.dialAttrs(opts), inner));
    return this;
  }

  /** Dial a PSTN number. */
  dialNumber(e164: string, opts: DialOpts = {}): this {
    this.parts.push(el("Dial", this.dialAttrs(opts), el("Number", {}, xmlEscape(e164))));
    return this;
  }

  record(opts: RecordOpts = {}): this {
    this.parts.push(
      el("Record", {
        maxLength: opts.maxLength ?? 120,
        timeout: opts.timeout,
        playBeep: opts.playBeep ?? true,
        action: opts.action,
        method: opts.action ? "POST" : undefined,
        recordingStatusCallback: opts.recordingStatusCallback,
        recordingStatusCallbackMethod: opts.recordingStatusCallback ? "POST" : undefined,
        recordingStatusCallbackEvent: opts.recordingStatusCallback ? "completed" : undefined,
      }),
    );
    return this;
  }

  redirect(url: string): this {
    this.parts.push(el("Redirect", { method: "POST" }, xmlEscape(url)));
    return this;
  }

  hangup(): this {
    this.parts.push("<Hangup/>");
    return this;
  }

  toString(): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${this.parts.join("")}</Response>`;
  }

  private sayXml(text: string, opts: SayOpts): string {
    return el(
      "Say",
      { voice: opts.voice ?? DEFAULT_VOICE, language: opts.language ?? DEFAULT_LANGUAGE },
      xmlEscape(text),
    );
  }

  private dialAttrs(opts: DialOpts): Attrs {
    return {
      timeout: opts.timeout,
      callerId: opts.callerId,
      answerOnBridge: opts.answerOnBridge,
      record: opts.record,
      recordingStatusCallback: opts.recordingStatusCallback,
      recordingStatusCallbackMethod: opts.recordingStatusCallback ? "POST" : undefined,
      recordingStatusCallbackEvent: opts.recordingStatusCallback ? "completed" : undefined,
      action: opts.action,
      method: opts.action ? "POST" : undefined,
    };
  }
}

export function twiml(): TwiML {
  return new TwiML();
}

// ── Voice access token (browser / mobile SDK) ────────────────────────────────

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export interface VoiceTokenInput {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  identity: string;
  outgoingApplicationSid: string;
  ttlSeconds?: number;
  incomingAllow?: boolean;
  /** Twilio push credential (FCM / APNs VoIP) so a closed phone still rings. */
  pushCredentialSid?: string;
  /** Seconds since epoch; injectable for tests. */
  nowSeconds?: number;
}

/** A Twilio Access Token (JWT, HS256) carrying a Voice grant. */
export function voiceAccessToken(input: VoiceTokenInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 3600;
  const header = { alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${input.apiKeySid}-${now}`,
    iss: input.apiKeySid,
    sub: input.accountSid,
    iat: now,
    exp: now + ttl,
    grants: {
      identity: input.identity,
      voice: {
        incoming: { allow: input.incomingAllow ?? true },
        outgoing: { application_sid: input.outgoingApplicationSid },
        ...(input.pushCredentialSid ? { push_credential_sid: input.pushCredentialSid } : {}),
      },
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", input.apiKeySecret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

// ── Client identities ────────────────────────────────────────────────────────

/** Twilio client identity for a staff user: u_ + uuid without dashes. */
export function voiceIdentityFor(userId: string): string {
  return `u_${userId.replace(/-/g, "").toLowerCase()}`;
}

/** Inverse of voiceIdentityFor. Accepts a bare identity or "client:u_…". */
export function userIdFromVoiceIdentity(identity: string | null | undefined): string | null {
  if (!identity) return null;
  const m = /^(?:client:)?u_([0-9a-f]{32})$/i.exec(identity.trim());
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── REST (recordings) ────────────────────────────────────────────────────────

export interface TwilioRestConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  baseUrl?: string;
}

export function twilioRestConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioRestConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const apiKeySid = env.TWILIO_API_KEY_SID;
  const apiKeySecret = env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !apiKeySid || !apiKeySecret) return null;
  return { accountSid, apiKeySid, apiKeySecret };
}

export class TwilioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TwilioApiError";
  }
}

function basicAuth(cfg: TwilioRestConfig): string {
  return "Basic " + Buffer.from(`${cfg.apiKeySid}:${cfg.apiKeySecret}`).toString("base64");
}

/**
 * Download a recording's audio. `recordingUrl` is the RecordingUrl from the
 * status callback (no extension). Dual-channel recordings are requested with
 * both channels kept apart, so a transcriber can tell staff from customer.
 */
export async function downloadRecording(
  cfg: TwilioRestConfig,
  recordingUrl: string,
  opts: { format?: "mp3" | "wav"; channels?: number | null } = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  const format = opts.format ?? "mp3";
  const base = recordingUrl.replace(/\.(mp3|wav|json)$/i, "");
  const url = `${base}.${format}${opts.channels === 2 ? "?RequestedChannels=2" : ""}`;
  const res = await fetch(url, {
    headers: { authorization: basicAuth(cfg) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new TwilioApiError(
      `recording download failed: ${res.status}`,
      res.status,
      res.status === 404 || res.status === 429 || res.status >= 500,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") ?? (format === "mp3" ? "audio/mpeg" : "audio/wav") };
}

/** Delete a recording from Twilio once we hold our own copy. 404 counts as done. */
export async function deleteRecording(cfg: TwilioRestConfig, recordingSid: string): Promise<void> {
  const base = cfg.baseUrl ?? "https://api.twilio.com";
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.json`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: basicAuth(cfg) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) {
    throw new TwilioApiError(`recording delete failed: ${res.status}`, res.status, res.status === 429 || res.status >= 500);
  }
}

/**
 * Point a live call at new instructions (TwiML fetched from `url`). Used for
 * transfer: the customer's leg is redirected, which ends the current <Dial>.
 */
export async function redirectCall(cfg: TwilioRestConfig, callSid: string, url: string): Promise<void> {
  const base = cfg.baseUrl ?? "https://api.twilio.com";
  const endpoint = `${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: basicAuth(cfg), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Url: url, Method: "POST" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new TwilioApiError(`call redirect failed: ${res.status}`, res.status, res.status === 429 || res.status >= 500);
  }
}
