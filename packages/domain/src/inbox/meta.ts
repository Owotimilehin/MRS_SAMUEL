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
  /** META_APP_ID: our Meta app's numeric ID (tells our Messenger echoes from other apps'). */
  appId?: string;
  /** META_HUMAN_AGENT_ENABLED === "true": staff may reply on Messenger/Instagram up to 7 days. */
  humanAgent?: boolean;
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
  if (env.META_APP_ID) cfg.appId = env.META_APP_ID;
  cfg.humanAgent = env.META_HUMAN_AGENT_ENABLED === "true";
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
 * One Graph API call with a JSON body. Throws MetaApiError with Meta's code and
 * subcode on a refusal, and a delivery-"unknown" error when no answer came back.
 */
export async function graph<T>(
  cfg: MetaConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: GraphOptions = {},
): Promise<T> {
  return graphRaw<T>(
    cfg,
    method,
    path,
    {
      ...(body ? { headers: { "content-type": "application/json" } } : {}),
      body: body ? JSON.stringify(body) : null,
    },
    opts,
  );
}

/**
 * Like graph(), for calls that are not JSON-in (a file upload, the Resumable Upload
 * API). Same URL, same error mapping (MetaApiError). `authScheme` is "Bearer" unless
 * the call needs "OAuth" (the upload session). `opts` carries the same per-call
 * token, onResponse and service as graph().
 */
export async function graphRaw<T>(
  cfg: MetaConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit | null; authScheme?: "Bearer" | "OAuth"; timeoutMs?: number },
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
        authorization: `${init.authScheme ?? "Bearer"} ${opts.token ?? cfg.token}`,
        ...(init.headers ?? {}),
      },
      body: init.body ?? null,
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
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
        error?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          error_user_title?: string;
          error_user_msg?: string;
          error_data?: { details?: string };
        };
      } | null
    )?.error;
    const code = err?.code != null ? String(err.code) : null;
    const subcode = err?.error_subcode != null ? String(err.error_subcode) : null;
    const detail = err?.error_data?.details;
    const msg = [err?.message ?? `Meta API ${res.status}`, detail].filter(Boolean).join(": ");
    const retryable = res.status >= 500 || res.status === 429 || (code !== null && RETRYABLE_CODES.has(code));
    // Meta's own wording for a person (templates and Flows carry it), kept for support and for the screen.
    const details: Record<string, unknown> = {};
    if (subcode) details.subcode = subcode;
    if (typeof err?.error_user_title === "string" && err.error_user_title) details.userTitle = err.error_user_title;
    if (typeof err?.error_user_msg === "string" && err.error_user_msg) details.userMessage = err.error_user_msg;
    // A structured error means Meta refused it; a bare 5xx leaves it unknown.
    throw new MetaApiError(
      msg,
      res.status,
      code,
      retryable,
      err || res.status < 500 ? "not_sent" : "unknown",
      subcode,
      Object.keys(details).length > 0 ? details : undefined,
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
      /** The one blank a TEXT header can have. */
      headerText?: string;
      /** The file for an IMAGE / VIDEO / DOCUMENT header, by link (as ordinary media is sent). */
      headerMedia?: { type: "image" | "video" | "document"; link: string; filename?: string };
      /** The blank at the end of a link button; `index` is the button's position from 0. */
      buttonParams?: { index: number; text: string }[];
      /** A button that opens a WhatsApp form (suite spec 07): our signed token for it; `index` is the button's position from 0. */
      flowButtons?: { index: number; flowToken: string }[];
    }
  /** A WhatsApp form (Flow) sent as an interactive message inside the 24-hour window (suite spec 07). */
  | {
      type: "flow";
      /** Meta's Flow ID. */
      flowId: string;
      /** Our signed token; comes back with the answer. */
      flowToken: string;
      /** The button text. */
      cta: string;
      body: string;
      footer?: string;
      action: "navigate" | "data_exchange";
      /** The entry screen, for `navigate`. */
      screen?: string;
      mode: "published" | "draft";
    };

/**
 * The `components` array of a template message: only the parts that carry a
 * value (fixed headers, footers and buttons are sent by naming the template).
 * Shapes follow Meta's Cloud API "template messages" reference:
 *   header  { type: "header", parameters: [{ type: "text", text }] }
 *           { type: "header", parameters: [{ type: "image", image: { link } }] }
 *           (video → video: { link }; document → document: { link, filename })
 *   body    { type: "body", parameters: [{ type: "text", text }, …] }
 *   button  { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text }] }
 *           { type: "button", sub_type: "flow", index: "1", parameters: [{ type: "action", action: { flow_token } }] }
 *           (buttons go in the order of their index; no flow_action_data is sent)
 * `index` is sent as a string, as in Meta's examples.
 */
export function buildTemplateComponents(
  content: Extract<OutboundContent, { type: "template" }>,
): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (content.headerMedia) {
    const m = content.headerMedia;
    const media: Record<string, unknown> = { link: m.link };
    if (m.type === "document" && m.filename) media.filename = m.filename;
    components.push({ type: "header", parameters: [{ type: m.type, [m.type]: media }] });
  } else if (content.headerText) {
    components.push({ type: "header", parameters: [{ type: "text", text: content.headerText }] });
  }
  if (content.bodyParams?.length) {
    components.push({ type: "body", parameters: content.bodyParams.map((t) => ({ type: "text", text: t })) });
  }
  const buttons: { index: number; component: Record<string, unknown> }[] = [];
  for (const b of content.buttonParams ?? []) {
    buttons.push({
      index: b.index,
      component: { type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: b.text }] },
    });
  }
  for (const b of content.flowButtons ?? []) {
    buttons.push({
      index: b.index,
      component: { type: "button", sub_type: "flow", index: String(b.index), parameters: [{ type: "action", action: { flow_token: b.flowToken } }] },
    });
  }
  // Link buttons first on a tie (there is none in practice: one button per position).
  buttons.sort((x, y) => x.index - y.index);
  components.push(...buttons.map((b) => b.component));
  return components;
}

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
      const components = buildTemplateComponents(content);
      return {
        ...base,
        type: "template",
        template: {
          name: content.name,
          language: { code: content.language },
          ...(components.length ? { components } : {}),
        },
      };
    }
    case "flow":
      // No `data` is sent for the entry screen; `flow_action_payload` only goes with `navigate`.
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_id: content.flowId,
              flow_cta: content.cta,
              flow_token: content.flowToken,
              flow_action: content.action,
              ...(content.action === "navigate" ? { flow_action_payload: { screen: content.screen } } : {}),
              mode: content.mode,
            },
          },
        },
      };
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

export interface NumberInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  status?: string;
  /** The current field (suite spec 05, 14.1): the limit shared by the whole business. */
  whatsapp_business_manager_messaging_limit?: string;
  /** Deprecated by Meta; still read as a fallback. */
  messaging_limit_tier?: string;
}

const NUMBER_FIELDS = "display_phone_number,verified_name,quality_rating,status";

/**
 * Status, quality and daily limit of a number. Asks for the current limit field
 * together with the deprecated one; if Meta refuses the field list (code 100, an
 * unknown field) it asks again with the old field only, so nothing breaks.
 */
export async function getNumberInfo(cfg: MetaConfig, phoneNumberId: string): Promise<NumberInfo> {
  try {
    return await graph<NumberInfo>(
      cfg,
      "GET",
      `${phoneNumberId}?fields=${NUMBER_FIELDS},whatsapp_business_manager_messaging_limit,messaging_limit_tier`,
      undefined,
      WA,
    );
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.code !== "100") throw err;
    return graph<NumberInfo>(cfg, "GET", `${phoneNumberId}?fields=${NUMBER_FIELDS},messaging_limit_tier`, undefined, WA);
  }
}

/** The daily limit to store: the current field, else the deprecated one, else null. */
export function numberMessagingLimit(info: NumberInfo): string | null {
  return info.whatsapp_business_manager_messaging_limit ?? info.messaging_limit_tier ?? null;
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
