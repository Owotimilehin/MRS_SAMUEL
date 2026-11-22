/**
 * Meta connection health ("Watchdog", blueprint stage 1).
 *
 * Every hour the worker asks Meta, with read-only Graph calls only:
 *   - is our system-user access key still valid, and not about to run out?  (debug_token)
 *   - for each WhatsApp number: status and quality rating                   (getNumberInfo)
 *   - for each WhatsApp account: can it send, and its review state          ({waba}?fields=health_status,account_review_status)
 * Facebook Pages and Instagram accounts are not asked again: the hourly
 * ensureMetaSubscriptions job already checks their subscription and stamps
 * webhook_checked_at / problem_* on the row, and this file reads those.
 *
 * Each check gives one item: ok / warning / broken, a plain-English reason and
 * what it means for customers. mergeMetaHealth keeps "since" and decides which
 * items newly need an owner alert (once, when an item becomes broken).
 *
 * The token is only ever sent to Meta (as the bearer header, and as
 * input_token to debug_token). It is never logged, stored or returned.
 */
import {
  type MetaHealthItem,
  type MetaHealthKind,
  type MetaHealthStatus,
  type MetaHealthValue,
} from "@ms/shared";
import { getNumberInfo, graph, MetaApiError, type MetaConfig, type NumberInfo } from "./meta.js";

// ── Inputs ───────────────────────────────────────────────────────────────────

/** The facts of one active channel row the check needs (plain data, no DB). */
export interface HealthLine {
  id: string;
  kind: "phone" | "messenger" | "instagram";
  label: string;
  /** Phone rows: voice | whatsapp | both. */
  channels: string;
  wabaId: string | null;
  waPhoneNumberId: string | null;
  webhookCheckedAt: Date | null;
  webhookSubscribedAt: Date | null;
  problemText: string | null;
  problemAt: Date | null;
}

/**
 * An account block recorded by the WhatsApp account_update webhook (keyed by
 * WABA id, the shape the broadcasts work stores under app_settings
 * "broadcast_account_block"). Read when present; this file never writes it.
 */
export interface AccountBlock {
  event?: string | null;
  detail?: string | null;
  at?: string | null;
}

/** The outcome of one check before it is merged with what was stored. */
export type HealthOutcome =
  | {
      key: string;
      kind: MetaHealthKind;
      label: string;
      line_ids: string[];
      status: MetaHealthStatus;
      reason: string;
      impact: string;
    }
  | {
      key: string;
      kind: MetaHealthKind;
      label: string;
      line_ids: string[];
      /** Meta did not answer (or the key is broken, so this was not asked): keep what was stored. */
      unchecked: true;
    };

type Verdict = { status: MetaHealthStatus; reason: string; impact: string };

/** A Page/Instagram row not checked for this long is "needs attention". */
export const PAGE_CHECK_STALE_MS = 3 * 3600_000;
/** An access key that runs out within this long is "needs attention". */
export const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 3600_000;
/** After an alert, a flapping item is not alerted again for this long. */
export const REALERT_AFTER_MS = 6 * 3600_000;

const KEY_GONE = "Meta no longer accepts the suite's access key. The technical lead needs to make a new one.";
const ALL_CHANNELS_DOWN = "Customers on WhatsApp, Facebook and Instagram are not getting replies";

// ── Classifiers (pure) ───────────────────────────────────────────────────────

/** What debug_token says about the token (Graph: GET /debug_token?input_token=…). */
export interface DebugTokenData {
  is_valid?: boolean;
  /** Unix seconds; 0 = never runs out. */
  expires_at?: number;
  scopes?: string[];
  granular_scopes?: { scope?: string }[];
  error?: { message?: string; code?: number };
}

/** The permissions each kind of channel needs on the system-user token. [unverified against the live token] */
export function neededScopes(lines: readonly HealthLine[]): string[] {
  const need = new Set<string>();
  for (const l of lines) {
    if (l.kind === "phone" && l.channels !== "voice" && l.waPhoneNumberId) {
      need.add("whatsapp_business_messaging");
      need.add("whatsapp_business_management");
    }
    if (l.kind === "messenger") need.add("pages_messaging");
    if (l.kind === "instagram") need.add("instagram_manage_messages");
  }
  return [...need].sort();
}

export function classifyToken(data: DebugTokenData | null | undefined, now: Date, needed: readonly string[]): Verdict {
  if (!data || data.is_valid !== true) {
    return { status: "broken", reason: KEY_GONE, impact: ALL_CHANNELS_DOWN };
  }
  const exp = typeof data.expires_at === "number" ? data.expires_at * 1000 : 0;
  if (exp > 0 && exp <= now.getTime()) {
    return { status: "broken", reason: "The suite's Meta access key has run out. The technical lead needs to make a new one.", impact: ALL_CHANNELS_DOWN };
  }
  const granted = new Set<string>([
    ...(data.scopes ?? []),
    ...(data.granular_scopes ?? []).map((g) => g.scope ?? "").filter(Boolean),
  ]);
  const missing = needed.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    return {
      status: "warning",
      reason: `The suite's Meta access key is missing a permission it needs (${missing.join(", ")}). The technical lead needs to add it.`,
      impact: "Some messages may not go out",
    };
  }
  if (exp > 0 && exp - now.getTime() < TOKEN_EXPIRY_WARN_MS) {
    const days = Math.max(1, Math.ceil((exp - now.getTime()) / (24 * 3600_000)));
    return {
      status: "warning",
      reason: `The suite's Meta access key runs out in ${days} ${days === 1 ? "day" : "days"}. The technical lead needs to renew it.`,
      impact: "Replies on every channel will stop when it runs out",
    };
  }
  return { status: "ok", reason: "Meta accepts the suite's access key.", impact: "Customers are getting replies" };
}

/** Status and quality of one WhatsApp number (Graph phone-number fields `status`, `quality_rating`). */
export function classifyNumber(info: NumberInfo, label: string): Verdict {
  const down = `Customers on WhatsApp (${label}) are not getting replies`;
  const limited = `WhatsApp messages on ${label} may be limited`;
  const status = (info.status ?? "").toUpperCase();
  const quality = (info.quality_rating ?? "").toUpperCase();
  switch (status) {
    case "BANNED":
      return { status: "broken", reason: "Meta has banned this number from WhatsApp.", impact: down };
    case "DELETED":
      return { status: "broken", reason: "This number has been deleted from the WhatsApp account at Meta.", impact: down };
    case "DISCONNECTED":
      return { status: "broken", reason: "This number is no longer connected to WhatsApp at Meta.", impact: down };
    case "MIGRATED":
      return { status: "broken", reason: "This number has been moved to another WhatsApp account.", impact: down };
    case "RESTRICTED":
      return {
        status: "warning",
        reason: "Meta has limited this number for now: it can answer customers who write first, but cannot start new chats.",
        impact: limited,
      };
    case "RATE_LIMITED":
      return { status: "warning", reason: "Meta is slowing down how fast this number can send.", impact: limited };
    case "FLAGGED":
      return { status: "warning", reason: "Meta has flagged this number for low-quality messages; its daily limit may be lowered.", impact: limited };
    case "PENDING":
    case "UNVERIFIED":
      return { status: "warning", reason: "This number is not fully set up at Meta yet.", impact: limited };
    case "CONNECTED":
      if (quality === "RED") {
        return {
          status: "warning",
          reason: "Meta rates the quality of this number's messages as low; it may lower the daily limit.",
          impact: limited,
        };
      }
      return { status: "ok", reason: "Connected to WhatsApp.", impact: "Customers are getting replies" };
    default:
      return { status: "warning", reason: "Meta did not say whether this number is working.", impact: limited };
  }
}

/** What GET {waba-id}?fields=health_status,account_review_status answers. [unverified against the live API] */
export interface WabaHealthResponse {
  account_review_status?: string;
  health_status?: {
    can_send_message?: string;
    entities?: {
      entity_type?: string;
      id?: string;
      can_send_message?: string;
      errors?: { error_code?: number; error_description?: string; possible_solution?: string }[];
    }[];
  };
}

/** Meta's first explanation for a LIMITED / BLOCKED account, if it gave one. */
function healthDetail(h: WabaHealthResponse["health_status"]): string | null {
  for (const e of h?.entities ?? []) {
    if ((e.can_send_message ?? "AVAILABLE").toUpperCase() === "AVAILABLE") continue;
    const err = e.errors?.find((x) => x.error_description);
    if (err?.error_description) return err.error_description.replace(/[.\s]+$/, "");
  }
  return null;
}

export function classifyWaba(resp: WabaHealthResponse | null, block: AccountBlock | null | undefined): Verdict {
  const down = "Customers on WhatsApp are not getting replies";
  const limited = "WhatsApp messages may be limited";
  if (block && (block.event || block.detail)) {
    const what = block.detail || block.event || "";
    return { status: "broken", reason: `Meta has restricted the WhatsApp account (${what}).`, impact: down };
  }
  const can = (resp?.health_status?.can_send_message ?? "").toUpperCase();
  const detail = healthDetail(resp?.health_status);
  const review = (resp?.account_review_status ?? "").toUpperCase();
  if (can === "BLOCKED") {
    return { status: "broken", reason: `Meta has blocked the WhatsApp account from sending${detail ? `: ${detail}` : ""}.`, impact: down };
  }
  if (review === "REJECTED") {
    return { status: "broken", reason: "Meta rejected the WhatsApp account in its review.", impact: down };
  }
  if (can === "LIMITED") {
    return { status: "warning", reason: `Meta is limiting what the WhatsApp account can send${detail ? `: ${detail}` : ""}.`, impact: limited };
  }
  if (review === "PENDING") {
    return { status: "warning", reason: "Meta is still reviewing the WhatsApp account.", impact: limited };
  }
  return { status: "ok", reason: "Meta says the WhatsApp account can send messages.", impact: "Customers are getting replies" };
}

/**
 * A Facebook Page or Instagram row, from what ensureMetaSubscriptions (and a
 * failed send) last wrote on it. A problem newer than the last good check is
 * broken; a success after it clears it.
 */
export function classifyPageLine(line: HealthLine, now: Date): Verdict {
  const where = line.kind === "instagram" ? `Instagram (${line.label})` : `Facebook Messenger (${line.label})`;
  const down = `Messages from customers on ${where} are not reaching the inbox`;
  const maybe = `Messages from customers on ${where} may not be reaching the inbox`;
  const checked = line.webhookCheckedAt?.getTime() ?? null;
  const problem = line.problemAt?.getTime() ?? null;
  if (line.problemText && problem !== null && (checked === null || problem >= checked)) {
    return { status: "broken", reason: line.problemText, impact: down };
  }
  if (!line.webhookSubscribedAt) {
    return { status: "warning", reason: "Meta has not started sending this account's messages to the suite yet.", impact: maybe };
  }
  if (checked === null || now.getTime() - checked > PAGE_CHECK_STALE_MS) {
    const hours = checked === null ? null : Math.floor((now.getTime() - checked) / 3600_000);
    return {
      status: "warning",
      reason: hours === null ? "The suite has not checked this account at Meta yet." : `The suite has not been able to check this account at Meta for ${hours} hours.`,
      impact: maybe,
    };
  }
  return { status: "ok", reason: "Meta is sending this account's messages to the suite.", impact: "Customers are getting replies" };
}

/** A refusal from Meta for one item, as a verdict; null when it is worth trying again next hour. */
export function classifyCheckError(err: unknown, impactIfBroken: string): Verdict | null {
  if (!(err instanceof MetaApiError) || err.retryable) return null;
  if (err.code === "190") return { status: "broken", reason: KEY_GONE, impact: impactIfBroken };
  if (err.code === "10" || err.code === "200" || err.code === "299" || (err.code === "100" && err.subcode === "33")) {
    return {
      status: "broken",
      reason: "The suite's access key can no longer see this at Meta. The technical lead needs to check it is still assigned to our system user.",
      impact: impactIfBroken,
    };
  }
  const code = err.code ? (err.subcode ? `${err.code}/${err.subcode}` : err.code) : String(err.status);
  return { status: "warning", reason: `Meta refused the health check (code ${code}).`, impact: impactIfBroken.replace("are not", "may not be") };
}

// ── Graph reads ──────────────────────────────────────────────────────────────

/** GET /debug_token about our own token. Read-only. The token is never put in an error or a log. */
export async function debugToken(cfg: MetaConfig): Promise<DebugTokenData | null> {
  const res = await graph<{ data?: DebugTokenData }>(
    cfg,
    "GET",
    `debug_token?input_token=${encodeURIComponent(cfg.token)}`,
    undefined,
    { service: "Meta" },
  );
  return res.data ?? null;
}

/** GET {waba-id}?fields=health_status,account_review_status. Read-only. */
export async function getWabaHealth(cfg: MetaConfig, wabaId: string): Promise<WabaHealthResponse> {
  return graph<WabaHealthResponse>(cfg, "GET", `${wabaId}?fields=health_status,account_review_status`, undefined, {
    service: "WhatsApp",
  });
}

// ── One run (Meta reads only; no DB) ─────────────────────────────────────────

export interface CollectResult {
  outcomes: HealthOutcome[];
  /** What Meta said about each WhatsApp number, by line id (the worker refreshes the row's columns). */
  numberInfo: Map<string, NumberInfo>;
}

export const TOKEN_KEY = "token";

/**
 * Check every active line. Order: the token first; if Meta says the token is
 * gone, nothing else is asked (every call would fail the same way) and every
 * other item keeps what was stored. Pages and Instagram are classified from
 * the row only (no Meta call here).
 */
export async function collectMetaHealth(
  cfg: MetaConfig,
  lines: readonly HealthLine[],
  now: Date,
  opts: { accountBlocks?: Record<string, AccountBlock | undefined> } = {},
): Promise<CollectResult> {
  const outcomes: HealthOutcome[] = [];
  const numberInfo = new Map<string, NumberInfo>();
  const waLines = lines.filter((l) => l.kind === "phone" && l.channels !== "voice" && l.waPhoneNumberId);
  const pageLines = lines.filter((l) => l.kind === "messenger" || l.kind === "instagram");
  // The access key affects every line that goes through Meta (not a calls-only line).
  const allIds = [...waLines, ...pageLines].map((l) => l.id);
  const wabas = new Map<string, string[]>();
  for (const l of waLines) if (l.wabaId) wabas.set(l.wabaId, [...(wabas.get(l.wabaId) ?? []), l.id]);

  const tokenBase = { key: TOKEN_KEY, kind: "token" as const, label: "Meta access key", line_ids: allIds };
  let tokenGone = false;
  try {
    const v = classifyToken(await debugToken(cfg), now, neededScopes(lines));
    tokenGone = v.status === "broken";
    outcomes.push({ ...tokenBase, ...v });
  } catch (err) {
    const v = classifyCheckError(err, ALL_CHANNELS_DOWN);
    if (v) {
      tokenGone = v.status === "broken";
      outcomes.push({ ...tokenBase, ...v });
    } else outcomes.push({ ...tokenBase, unchecked: true });
  }

  for (const l of waLines) {
    const base = { key: `line:${l.id}`, kind: "whatsapp_number" as const, label: `WhatsApp ${l.label}`, line_ids: [l.id] };
    if (tokenGone) {
      outcomes.push({ ...base, unchecked: true });
      continue;
    }
    try {
      const info = await getNumberInfo(cfg, l.waPhoneNumberId!);
      numberInfo.set(l.id, info);
      outcomes.push({ ...base, ...classifyNumber(info, l.label) });
    } catch (err) {
      const v = classifyCheckError(err, `Customers on WhatsApp (${l.label}) are not getting replies`);
      outcomes.push(v ? { ...base, ...v } : { ...base, unchecked: true });
    }
  }

  for (const [wabaId, ids] of wabas) {
    const base = { key: `waba:${wabaId}`, kind: "whatsapp_account" as const, label: "WhatsApp account", line_ids: ids };
    if (tokenGone) {
      outcomes.push({ ...base, unchecked: true });
      continue;
    }
    const block = opts.accountBlocks?.[wabaId] ?? null;
    try {
      outcomes.push({ ...base, ...classifyWaba(await getWabaHealth(cfg, wabaId), block) });
    } catch (err) {
      // A recorded block is still true when Meta does not answer.
      if (block && (block.event || block.detail)) {
        outcomes.push({ ...base, ...classifyWaba(null, block) });
        continue;
      }
      const v = classifyCheckError(err, "Customers on WhatsApp are not getting replies");
      outcomes.push(v ? { ...base, ...v } : { ...base, unchecked: true });
    }
  }

  for (const l of pageLines) {
    outcomes.push({ key: `line:${l.id}`, kind: "page", label: l.label, line_ids: [l.id], ...classifyPageLine(l, now) });
  }
  return { outcomes, numberInfo };
}

// ── Merge with what was stored; the alert rule (pure) ─────────────────────────

/**
 * Kinds whose "became broken" raises our owner alert. A Page or Instagram
 * problem is already alerted by ensureMetaSubscriptions (inbox.meta_config,
 * once a day), so it is shown here but not alerted twice.
 */
const ALERT_KINDS: readonly MetaHealthKind[] = ["token", "whatsapp_number", "whatsapp_account"];

/**
 * Combine this run's outcomes with the stored value.
 *  - A checked item keeps `since` while its status is unchanged.
 *  - An unchecked item keeps its stored record; with none stored it is left out (checked next hour).
 *  - An item for a line that is gone or switched off is dropped.
 *  - Alert rule: an alertable item that is broken now and was not broken before (no
 *    stored record counts as "not broken") is alerted, unless it was alerted in the
 *    last REALERT_AFTER_MS (an item flapping broken/ok). Staying broken never re-alerts.
 */
export function mergeMetaHealth(
  prev: MetaHealthValue | null,
  outcomes: readonly HealthOutcome[],
  now: Date,
): { value: MetaHealthValue; newlyBroken: MetaHealthItem[] } {
  const iso = now.toISOString();
  const items: Record<string, MetaHealthItem> = {};
  const newlyBroken: MetaHealthItem[] = [];
  for (const o of outcomes) {
    const old = prev?.items?.[o.key];
    if ("unchecked" in o) {
      if (old) items[o.key] = { ...old, label: o.label, line_ids: o.line_ids };
      continue;
    }
    const sameStatus = old?.status === o.status;
    const item: MetaHealthItem = {
      key: o.key,
      kind: o.kind,
      label: o.label,
      line_ids: o.line_ids,
      status: o.status,
      reason: o.reason,
      impact: o.impact,
      since: sameStatus && old ? old.since : iso,
      checked_at: iso,
      alerted_at: old?.alerted_at ?? null,
    };
    const becameBroken = o.status === "broken" && old?.status !== "broken";
    const recentlyAlerted = item.alerted_at !== null && now.getTime() - Date.parse(item.alerted_at) < REALERT_AFTER_MS;
    if (becameBroken && ALERT_KINDS.includes(o.kind) && !recentlyAlerted) {
      item.alerted_at = iso;
      newlyBroken.push(item);
    }
    items[o.key] = item;
  }
  return { value: { checked_at: iso, items }, newlyBroken };
}

/** Read a stored value defensively (a hand-edited or older row must not break the worker or the API). */
export function parseMetaHealthValue(raw: unknown): MetaHealthValue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { checked_at?: unknown; items?: unknown };
  const items: Record<string, MetaHealthItem> = {};
  if (r.items && typeof r.items === "object") {
    for (const [k, v] of Object.entries(r.items as Record<string, unknown>)) {
      const i = v as Partial<MetaHealthItem> | null;
      if (!i || typeof i !== "object") continue;
      if (i.status !== "ok" && i.status !== "warning" && i.status !== "broken") continue;
      items[k] = {
        key: k,
        kind: (i.kind ?? "token") as MetaHealthKind,
        label: String(i.label ?? ""),
        line_ids: Array.isArray(i.line_ids) ? i.line_ids.map(String) : [],
        status: i.status,
        reason: String(i.reason ?? ""),
        impact: String(i.impact ?? ""),
        since: String(i.since ?? ""),
        checked_at: String(i.checked_at ?? ""),
        alerted_at: typeof i.alerted_at === "string" ? i.alerted_at : null,
      };
    }
  }
  return { checked_at: typeof r.checked_at === "string" ? r.checked_at : null, items };
}
