/** Calls for /v1/channels/:accountId/chat-setup (suite spec 04). */
import { api, API_BASE, ApiError, refreshAccessToken } from "@admin/lib/api.js";
import type { CHAT_SETUP_LIMITS, ChatSetupConfig } from "@ms/shared";

export type SetupStatus = "pushing" | "live" | "failed" | "unknown" | "superseded";

export interface ChatSetupView {
  account: { id: string; label: string; kind: "messenger" | "instagram"; is_active: boolean };
  supports: { greeting: boolean; getStarted: boolean; iceBreakers: true; menu: true };
  limits: typeof CHAT_SETUP_LIMITS;
  draft: { version: number; config: ChatSetupConfig; updated_at: string; updated_by_name: string | null } | null;
  live: {
    config: ChatSetupConfig;
    other_locales: string[];
    foreign_payloads: boolean;
    composer_disabled: boolean;
    read_at: string;
  } | null;
  live_error: string | null;
  draft_differs_from_live: boolean;
  last_publish: {
    version: number;
    status: SetupStatus;
    by_name: string | null;
    at: string;
    error_message: string | null;
    error_code: string | null;
    config: ChatSetupConfig;
  } | null;
  can_publish_at: string | null;
}

export interface HistoryRow {
  version: number;
  status: SetupStatus;
  config: ChatSetupConfig;
  by_name: string | null;
  at: string;
  error_message: string | null;
}

export const chatSetupKeys = {
  all: (accountId: string) => ["channels", "chat-setup", accountId] as const,
  view: (accountId: string) => ["channels", "chat-setup", accountId, "view"] as const,
  history: (accountId: string) => ["channels", "chat-setup", accountId, "history"] as const,
};

const base = (accountId: string) => `/channels/${encodeURIComponent(accountId)}/chat-setup`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** What a publish answers: 200 = it is live; 502 = it did not go through (the view says why). */
export interface PublishAnswer {
  ok: boolean;
  view: ChatSetupView;
}

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Publish is sent once, never retried by the browser: the shared api() helper
 * retries a 502, and a 502 here means "Meta did not take it", which must be read, not repeated.
 */
async function publishOnce(accountId: string, version: number): Promise<PublishAnswer> {
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify({ version, confirm: true }),
  };
  let res = await fetch(`${API_BASE}${base(accountId)}/publish`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}${base(accountId)}/publish`, init).catch(() => null);
  }
  if (!res) throw new ApiError(0, "network_error", "We couldn't reach the server. Check your connection and try again.");
  let body: { data?: ChatSetupView; error?: { code?: string; message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not json */
  }
  if ((res.status === 200 || res.status === 502) && body.data) return { ok: res.status === 200, view: body.data };
  throw new ApiError(res.status, body.error?.code ?? "unknown", body.error?.message ?? `Something went wrong (${res.status}). Please try again.`);
}

export const chatSetupApi = {
  view: async (accountId: string) => (await api<{ data: ChatSetupView }>(base(accountId))).data,
  saveDraft: async (accountId: string, config: ChatSetupConfig) =>
    (await api<{ data: ChatSetupView }>(`${base(accountId)}/draft`, json("PUT", { config }))).data,
  discardDraft: async (accountId: string) =>
    (await api<{ data: ChatSetupView }>(`${base(accountId)}/draft`, { method: "DELETE" })).data,
  refresh: async (accountId: string) => (await api<{ data: ChatSetupView }>(`${base(accountId)}/refresh`, { method: "POST" })).data,
  publish: publishOnce,
  history: async (accountId: string) => (await api<{ data: HistoryRow[] }>(`${base(accountId)}/history`)).data,
  restore: async (accountId: string, version: number) =>
    (await api<{ data: ChatSetupView }>(`${base(accountId)}/history/${version}/restore`, { method: "POST" })).data,
};
