/**
 * Meta WhatsApp Cloud API client (Graph API, direct — no reseller).
 * Shared by the API (send, mark read, register, webhook signature) and the
 * worker (media download, template sync, follow-ups).
 *
 * Config comes from env:
 *   META_APP_SECRET         – webhook signature (X-Hub-Signature-256)
 *   META_VERIFY_TOKEN       – webhook GET handshake
 *   META_SYSTEM_USER_TOKEN  – bearer token for every Graph call
 *   META_GRAPH_VERSION      – e.g. "v23.0"
 *
 * Phone number IDs and WABA IDs live on inbox_phone_number rows, so several
 * business numbers work with no code change.
 */
import crypto from "node:crypto";

export interface MetaConfig {
  token: string;
  graphVersion: string;
  baseUrl?: string;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    /** Worth retrying: rate limit or Meta-side failure. */
    public readonly retryable: boolean,
    /**
     * Did the request reach Meta? "not_sent" = Meta refused it or we never
     * connected (safe to retry). "unknown" = no answer came back (timeout,
     * dropped connection), so the message may have been delivered.
     */
    public readonly delivery: "not_sent" | "unknown" = "not_sent",
    /** Meta's error_subcode, when it sent one (foundation C2 classifies by code and subcode). */
    public readonly subcode: string | null = null,
    /** Extra structured detail for support (never a token). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export function metaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const token = env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const cfg: MetaConfig = { token, graphVersion: env.META_GRAPH_VERSION || "v23.0" };
  if (env.META_GRAPH_BASE_URL) cfg.baseUrl = env.META_GRAPH_BASE_URL;
  return cfg;
}

/** Constant-time check of Meta's X-Hub-Signature-256 header over the raw body. */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algo, sig] = header.split("=", 2);
  if (algo !== "sha256" || !sig) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta error codes that are worth a retry (throttling / temporary).
const RETRYABLE_CODES = new Set(["4", "17", "32", "613", "80007", "130429", "131048", "131056", "1", "2"]);

export interface GraphOptions {
  /** Bearer token for this call instead of cfg.token (a Page access token). */
  token?: string;
  /** Called with the raw response before the body is read (rate-limit headers and the like). */
  onResponse?: (res: Response) => void;
  /** Who we are talking to, for the network-failure wording: "Could not reach {service}". Default "Meta". */
  service?: string;
}

/**
 * One Graph API call. Throws MetaApiError with Meta's code and subcode on a
 * refusal, and a delivery-"unknown" error when no answer came back.
 */
export async function graph<T>(
  cfg: MetaConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: GraphOptions = {},
): Promise<T> {
  const service = opts.service ?? "Meta";
  const base = cfg.baseUrl ?? "https://graph.facebook.com";
  const url = path.startsWith("http") ? path : `${base}/${cfg.graphVersion}/${path.replace(/^\//, "")}`;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${opts.token ?? cfg.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(15_000),
    });
    opts.onResponse?.(res);
    text = await res.text();
  } catch (err) {
    // Never connected → certainly not sent. Anything else (timeout, reset
    // mid-flight) → we can't know whether Meta acted on it.
    const code = String((err as { cause?: { code?: string } }).cause?.code ?? "");
    const neverConnected = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code);
    throw new MetaApiError(
      neverConnected ? `Could not reach ${service}` : `No answer from ${service}`,
      0,
      code || null,
      true,
      neverConnected ? "not_sent" : "unknown",
    );
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (
      json as {
        error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
      } | null
    )?.error;
    const code = err?.code != null ? String(err.code) : null;
    const subcode = err?.error_subcode != null ? String(err.error_subcode) : null;
    const detail = err?.error_data?.details;
    const msg = [err?.message ?? `Meta API ${res.status}`, detail].filter(Boolean).join(": ");
    const retryable = res.status >= 500 || res.status === 429 || (code !== null && RETRYABLE_CODES.has(code));
    // A structured error means Meta refused it; a bare 5xx leaves it unknown.
    throw new MetaApiError(
      msg,
      res.status,
      code,
      retryable,
      err || res.status < 500 ? "not_sent" : "unknown",
      subcode,
    );
  }
  return json as T;
}

/** WhatsApp calls keep their "Could not reach WhatsApp" wording. */
const WA: GraphOptions = { service: "WhatsApp" };

// ── Sending ──────────────────────────────────────────────────────────────────

export type OutboundContent =
  | { type: "text"; body: string }
  | { type: "image" | "video" | "audio" | "document"; link: string; caption?: string; filename?: string }
  | {
      type: "template";
      name: string;
      language: string;
      /** Body variables {{1}}, {{2}}… in order. */
      bodyParams?: string[];
    };

/**
 * Who a WhatsApp message goes to: a phone number (wa_id digits) or, for a
 * customer who has hidden their number, a business-scoped user ID (sent as
 * `recipient` instead of `to`; spec 01, M14).
 */
export type WaRecipient = string | { bsuid: string };

export function buildSendPayload(to: WaRecipient, content: OutboundContent): Record<string, unknown> {
  const base =
    typeof to === "string"
      ? { messaging_product: "whatsapp", recipient_type: "individual", to }
      : { messaging_product: "whatsapp", recipient_type: "individual", recipient: to.bsuid };
  switch (content.type) {
    case "text":
      return { ...base, type: "text", text: { body: content.body, preview_url: true } };
    case "template": {
      const components = content.bodyParams?.length
        ? [{ type: "body", parameters: content.bodyParams.map((t) => ({ type: "text", text: t })) }]
        : undefined;
      return {
        ...base,
        type: "template",
        template: { name: content.name, language: { code: content.language }, ...(components ? { components } : {}) },
      };
    }
    default: {
      const media: Record<string, unknown> = { link: content.link };
      if (content.caption && content.type !== "audio") media.caption = content.caption;
      if (content.type === "document" && content.filename) media.filename = content.filename;
      return { ...base, type: content.type, [content.type]: media };
    }
  }
}

/** Send a message; returns Meta's message id (wamid…). */
export async function sendMessage(
  cfg: MetaConfig,
  phoneNumberId: string,
  to: WaRecipient,
  content: OutboundContent,
): Promise<string> {
  const res = await graph<{ messages?: { id: string }[] }>(
    cfg,
    "POST",
    `${phoneNumberId}/messages`,
    buildSendPayload(to, content),
    WA,
  );
  const id = res.messages?.[0]?.id;
  if (!id) throw new MetaApiError("Meta returned no message id", 502, null, true);
  return id;
}

/** Blue ticks for an incoming message. */
export async function markRead(cfg: MetaConfig, phoneNumberId: string, waMessageId: string): Promise<void> {
  await graph(
    cfg,
    "POST",
    `${phoneNumberId}/messages`,
    { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
    WA,
  );
}

// ── Media ────────────────────────────────────────────────────────────────────

/** Download incoming media: resolve the short-lived URL, then fetch it with the token. */
export async function downloadMedia(
  cfg: MetaConfig,
  mediaId: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const meta = await graph<{ url: string; mime_type: string }>(cfg, "GET", mediaId, undefined, WA);
  const res = await fetch(meta.url, {
    headers: { authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new MetaApiError(`media download ${res.status}`, res.status, null, res.status >= 500);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: meta.mime_type };
}

// ── Templates and numbers ────────────────────────────────────────────────────

export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
}

export async function listTemplates(cfg: MetaConfig, wabaId: string): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let next: string | null = `${wabaId}/message_templates?limit=100&fields=name,language,status,category,components`;
  for (let page = 0; next && page < 50; page++) {
    const res: { data?: MetaTemplate[]; paging?: { next?: string } } = await graph(cfg, "GET", next, undefined, WA);
    out.push(...(res.data ?? []));
    next = res.paging?.next ?? null;
  }
  return out;
}

/** Register a number for Cloud API (6-digit two-step PIN). Meta allows 10 tries / 72h. */
export async function registerNumber(cfg: MetaConfig, phoneNumberId: string, pin: string): Promise<void> {
  await graph(cfg, "POST", `${phoneNumberId}/register`, { messaging_product: "whatsapp", pin }, WA);
}

export async function getNumberInfo(
  cfg: MetaConfig,
  phoneNumberId: string,
): Promise<{ display_phone_number?: string; verified_name?: string; quality_rating?: string; status?: string; messaging_limit_tier?: string }> {
  return graph(
    cfg,
    "GET",
    `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status,messaging_limit_tier`,
    undefined,
    WA,
  );
}

/** Body text of a template with {{n}} filled, for showing in the timeline. */
export function renderTemplateBody(components: unknown[] | null | undefined, params: string[] = []): string | null {
  const body = (components ?? []).find(
    (c): c is { type: string; text?: string } =>
      typeof c === "object" && c !== null && String((c as { type?: string }).type).toUpperCase() === "BODY",
  );
  if (!body?.text) return null;
  return body.text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? `{{${n}}}`);
}

/** How many {{n}} variables a template body has. */
export function templateParamCount(components: unknown[] | null | undefined): number {
  const text = renderTemplateBody(components, []) ?? "";
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}
