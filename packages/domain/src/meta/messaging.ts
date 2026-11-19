/**
 * Messenger and Instagram direct messages: the Graph calls (suite spec 02).
 *
 * Every call here uses a Page access token from pageAccessToken() (never
 * stored, never logged). A Meta code 190 on a Page-token call clears the
 * cached token and tries once more with a fresh one.
 *
 * Errors are classified by code AND subcode (foundation C2, spec 02 table 3.5)
 * in classifyMessagingError: "config" (stop, tell the owner, show a banner),
 * "temporary" (retry) or "refusal" (record it, show it, do not retry).
 */
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { clearPageTokenCache, pageAccessToken } from "./accounts.js";

/** The Page webhook fields we subscribe to (spec 02, M2). */
export const PAGE_WEBHOOK_FIELDS = [
  "messages",
  "messaging_postbacks",
  "message_echoes",
  "message_deliveries",
  "message_reads",
  "messaging_referrals",
  "message_reactions",
  "message_edits",
  "standby",
  "messaging_handovers",
  "messaging_policy_enforcement",
] as const;

/** Run a Page-token call; on code 190 forget the token and try once more. */
export async function withPageTokenRetry<T>(cfg: MetaConfig, pageId: string, call: (token: string) => Promise<T>): Promise<T> {
  const token = await pageAccessToken(cfg, pageId);
  try {
    return await call(token);
  } catch (err) {
    if (!(err instanceof MetaApiError) || err.code !== "190") throw err;
    clearPageTokenCache(pageId);
    return call(await pageAccessToken(cfg, pageId));
  }
}

// ── Webhook subscription ─────────────────────────────────────────────────────

/** POST {pageId}/subscribed_apps?subscribed_fields=… with the Page token. Throws MetaApiError. */
export async function subscribePage(cfg: MetaConfig, pageId: string): Promise<void> {
  const res = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<{ success?: boolean }>(
      cfg,
      "POST",
      `${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${PAGE_WEBHOOK_FIELDS.join(",")}`,
      undefined,
      { token },
    ),
  );
  if (res && res.success === false) {
    throw new MetaApiError("Meta did not confirm the subscription", 502, null, true);
  }
}

interface SubscribedApp {
  id?: string;
  subscribed_fields?: (string | { name?: string })[];
}

/**
 * GET {pageId}/subscribed_apps. True when the app with id cfg.appId lists every
 * PAGE_WEBHOOK_FIELDS entry. When cfg.appId is unset: true when any app does.
 */
export async function isPageSubscribed(cfg: MetaConfig, pageId: string): Promise<boolean> {
  const res = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<{ data?: SubscribedApp[] }>(cfg, "GET", `${encodeURIComponent(pageId)}/subscribed_apps`, undefined, { token }),
  );
  const apps = (res?.data ?? []).filter((a) => !cfg.appId || a.id === cfg.appId);
  return apps.some((a) => {
    const fields = new Set((a.subscribed_fields ?? []).map((f) => (typeof f === "string" ? f : (f?.name ?? ""))));
    return PAGE_WEBHOOK_FIELDS.every((f) => fields.has(f));
  });
}

// ── Sending ──────────────────────────────────────────────────────────────────

export type MetaSendContent =
  | { type: "text"; body: string }
  | { type: "image" | "video" | "audio" | "document"; link: string };

export interface MetaSendOptions {
  /** Send with the HUMAN_AGENT tag (a person answering 24 h to 7 days after the customer wrote). */
  humanAgent: boolean;
  /** Comes back on the Messenger echo ("suite:<message id>"). */
  metadata?: string;
}

/** The Send API body (spec 02, S1, S2, S5). */
export function buildMetaSendPayload(
  recipientId: string,
  content: MetaSendContent,
  opts: MetaSendOptions,
): Record<string, unknown> {
  const message: Record<string, unknown> =
    content.type === "text"
      ? { text: content.body }
      : {
          attachment: {
            type: content.type === "document" ? "file" : content.type,
            payload: { url: content.link, is_reusable: false },
          },
        };
  if (opts.metadata !== undefined) message.metadata = opts.metadata;
  return {
    recipient: { id: recipientId },
    messaging_type: opts.humanAgent ? "MESSAGE_TAG" : "RESPONSE",
    ...(opts.humanAgent ? { tag: "HUMAN_AGENT" } : {}),
    message,
  };
}

/** POST {pageId}/messages with the Page token; returns message_id. Retries once with a fresh token on code 190. */
export async function sendMetaMessage(
  cfg: MetaConfig,
  pageId: string,
  recipientId: string,
  content: MetaSendContent,
  opts: MetaSendOptions,
): Promise<string> {
  const res = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<{ recipient_id?: string; message_id?: string }>(
      cfg,
      "POST",
      `${encodeURIComponent(pageId)}/messages`,
      buildMetaSendPayload(recipientId, content, opts),
      { token },
    ),
  );
  if (!res?.message_id) throw new MetaApiError("Meta returned no message id", 502, null, false, "unknown");
  return res.message_id;
}

/** typing_on | mark_seen. Best effort: callers catch and ignore every error. */
export async function sendSenderAction(
  cfg: MetaConfig,
  pageId: string,
  recipientId: string,
  action: "typing_on" | "mark_seen",
): Promise<void> {
  await withPageTokenRetry(cfg, pageId, (token) =>
    graph(cfg, "POST", `${encodeURIComponent(pageId)}/messages`, { recipient: { id: recipientId }, sender_action: action }, { token }),
  );
}

// ── Sender profile ───────────────────────────────────────────────────────────

export interface SenderProfile {
  displayName: string | null;
  username: string | null;
  profilePicUrl: string | null;
}

const NO_PROFILE: SenderProfile = { displayName: null, username: null, profilePicUrl: null };

function clean(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Messenger: fields first_name,last_name,profile_pic. Instagram: name,username,profile_pic.
 * Returns all-null (never throws) for: an empty object, code 2018218, a consent
 * error, any refusal. Throws temporary and configuration errors, so the worker
 * tries again later (or stops its batch on a configuration problem).
 */
export async function fetchSenderProfile(
  cfg: MetaConfig,
  channel: "messenger" | "instagram",
  pageId: string,
  scopedId: string,
): Promise<SenderProfile> {
  const fields = channel === "messenger" ? "first_name,last_name,profile_pic" : "name,username,profile_pic";
  let p: Record<string, unknown> | null;
  try {
    p = await withPageTokenRetry(cfg, pageId, (token) =>
      graph<Record<string, unknown> | null>(cfg, "GET", `${encodeURIComponent(scopedId)}?fields=${fields}`, undefined, {
        token,
      }),
    );
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
    if (err.code === "2018218" || err.subcode === "2018218" || /consent/i.test(err.message)) return { ...NO_PROFILE };
    const { cls } = classifyMessagingError(err, channel === "messenger" ? "Messenger" : "Instagram", "");
    if (cls === "refusal") return { ...NO_PROFILE };
    throw err;
  }
  if (!p) return { ...NO_PROFILE };
  const displayName =
    channel === "messenger"
      ? clean([clean(p.first_name), clean(p.last_name)].filter(Boolean).join(" ")) ?? clean(p.name)
      : clean(p.name);
  return {
    displayName,
    username: channel === "instagram" ? clean(p.username) : null,
    profilePicUrl: clean(p.profile_pic),
  };
}

// ── Errors (table 3.5) ───────────────────────────────────────────────────────

export type MetaErrorClass = "config" | "temporary" | "refusal";

export interface MessagingErrorClass {
  cls: MetaErrorClass;
  /** The plain sentence staff see. */
  staffText: string;
  /** Worth sending again (temporary trouble, or Meta could not fetch our file). */
  retryable: boolean;
}

const TEMPORARY_CODES = new Set([
  "4", "17", "32", "613", "1", "2",
  // Foundation D10 and C3: Pages, Instagram, Messenger and other Meta rate limits.
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014",
]);

/**
 * Classify a Meta error from a Messenger or Instagram call by code and subcode
 * (spec 02 table 3.5; the first matching row wins). `channelName` is
 * "Messenger" or "Instagram"; `label` is the account's label.
 */
export function classifyMessagingError(err: MetaApiError, channelName: string, label: string): MessagingErrorClass {
  const code = err.code ?? "";
  const sub = err.subcode ?? "";
  const is = (c: string, ...subs: string[]) => code === c && (subs.length === 0 || subs.includes(sub));
  const config = (staffText: string): MessagingErrorClass => ({ cls: "config", staffText, retryable: false });
  const refusal = (staffText: string, retryable = false): MessagingErrorClass => ({ cls: "refusal", staffText, retryable });
  const busy: MessagingErrorClass = { cls: "temporary", staffText: `${channelName} is busy. Try again in a minute.`, retryable: true };

  // No answer at all: the existing "unconfirmed" state. Never retried (R19).
  if (err.delivery === "unknown" && !code) {
    return refusal(`No answer from ${channelName}. It may have been sent: check before sending again.`);
  }
  if (is("190")) return config("Our connection to Meta has expired. The owner has been told.");
  if (is("10", "2018278", "2018065", "2534022")) {
    return refusal(`${channelName} refused this: it is more than 24 hours since the customer last wrote.`);
  }
  if (is("10", "2018108") || is("200", "1545041") || is("551")) {
    return refusal("This person can't receive messages from us right now. They may have blocked us or closed their account.");
  }
  if (is("10", "2018300") || is("100", "2534037")) {
    return refusal(
      "Another app is handling this chat for the Page. Ask the owner to check Conversation routing in Meta Business Suite.",
    );
  }
  if (is("10", "1893063") || is("2022")) return config(`Meta has paused messaging on ${label}. The owner has been told.`);
  if (is("10", "2534077") || is("100", "2534013")) {
    return config("Instagram is no longer linked to the Facebook Page. The owner has been told.");
  }
  if (is("200", "2534041")) return config("Message access is switched off in the Instagram app. The owner has been told.");
  if (is("200", "2018028") || (code === "200" && !sub)) {
    return config("Meta has not yet approved us to message people outside the test team.");
  }
  if (is("10") || is("299") || is("36103") || is("283") || code === "no_page_token") {
    return config("Meta says we are not allowed to do this. The owner has been told.");
  }
  if (is("100", "2018001", "2534014")) return refusal(`${channelName} can't find this person any more.`);
  if (is("100", "2018008", "2018294")) return refusal(`${channelName} couldn't collect the file. Try sending it again.`, true);
  if (is("100", "2018047", "2018109")) return refusal(`${channelName} doesn't accept this file (wrong type or too large).`);
  if (is("100")) return refusal(`${channelName} refused this message.`);
  if (TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500) return busy;
  // Could not connect at all (delivery not_sent, no Meta code): certainly not sent, worth another go.
  if (err.status === 0 && err.retryable) return busy;
  return refusal(`${channelName} refused this message.`);
}
