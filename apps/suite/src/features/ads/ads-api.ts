/**
 * Calls for /v1/ads (suite spec 12).
 *
 * Anything that changes an advert, a setting or the ad account is sent ONCE
 * (`once` below): the shared api() helper retries a 502, and here a 502 means
 * "Meta refused it" or "Meta did not answer", which must be read, never
 * repeated. Reads use api() as usual.
 */
import { API_BASE, ApiError, api, refreshAccessToken } from "@admin/lib/api.js";
import type { AdDestination, AdDraftSpecInput } from "@ms/shared";

export interface AdsAccount {
  ad_account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number | null;
  last_synced_at: string | null;
  problem: string | null;
  budget_calibrated: boolean;
  budget_factor: number | null;
  min_daily: number | null;
  manageable_currency: boolean;
}

export interface AdsSettings {
  manage_enabled: boolean;
  daily_cap: number;
  rules_enabled: boolean;
  capi_enabled: boolean;
  capi_privacy_confirmed: boolean;
  attribution_window_days: number;
}

export interface AdsStatus {
  account: AdsAccount | null;
  settings: AdsSettings;
  shop_time_zone: string;
  usage: { accountPct: number | null; businessPct: number | null; regainSeconds: number | null; tier: string | null } | null;
  phase_b: { enabled_destinations: AdDestination[]; near_shop_available: boolean };
}

export interface DayFigures {
  day: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversations_started: number | null;
}

export interface AdsOverviewData {
  currency: string | null;
  day_zone: string | null;
  has_figures: boolean;
  totals: {
    spend: number;
    impressions: number;
    clicks: number;
    conversations_started: number;
    cost_per_conversation: number | null;
    orders: number;
    order_value_ngn: number;
    cost_per_order: number | null;
  };
  per_day: DayFigures[];
  orders_per_day: { day: string; orders: number; value_ngn: number }[];
}

export interface AdvertRow {
  ad_external_id: string;
  name: string | null;
  campaign_name: string | null;
  destination: AdDestination | "other";
  status: string | null;
  effective_status: string | null;
  created_by_suite: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  conversations_started: number;
  cost_per_conversation: number | null;
  chats_seen: number;
  orders: number;
  order_value_ngn: number;
}

export interface AdvertDetail extends AdvertRow {
  currency: string;
  day_zone: string;
  creative: { title: string | null; body: string | null };
  campaign_external_id: string | null;
  adset_external_id: string | null;
  campaign_status: string | null;
  start_time: string | null;
  budget: { daily: number; end_time: string | null } | null;
  per_day: DayFigures[];
}

export interface AdChat {
  id: string;
  touched_at: string;
  channel: AdDestination;
  ad_external_id: string | null;
  headline: string | null;
  conversation_id: string | null;
  customer_name: string | null;
  order: { order_number: string; value_ngn: number; reported: string; reported_note: string | null } | null;
  reporting_blocked: boolean;
}

export interface AdLogRow {
  request_id: string;
  at: string;
  actor_kind: "person" | "rule" | "safety" | "system";
  actor_name: string | null;
  action: string;
  summary: string;
  max_spend: number | null;
  currency: string | null;
  outcome: "ok" | "refused" | "unknown" | "blocked" | "pending";
  meta_message: string | null;
}

export interface CapLine {
  ok: boolean;
  cap: number;
  already_committed: number;
  requested: number;
  room: number;
}

export interface AdDraft {
  id: string;
  status: "draft" | "creating" | "created" | "failed" | "needs_check";
  step: string;
  spec: AdDraftSpecInput;
  campaign_external_id: string | null;
  adset_external_id: string | null;
  ad_external_id: string | null;
  confirmed: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftPreview {
  lines: string[];
  max_spend: number;
  confirm_text: string;
  content_hash: string;
  cap: CapLine;
  min_daily: number | null;
  warnings: string[];
}

export interface TurnOnPreview {
  name: string;
  daily: number;
  end_time: string;
  remaining_max: number;
  confirm_text: string;
  cap: CapLine;
}

export interface BudgetPreview {
  name: string;
  current_daily: number;
  new_daily: number;
  end_time: string;
  remaining_max: number;
  confirm_text: string;
  live: boolean;
  cap: CapLine;
  min_daily: number | null;
}

export interface AdRule {
  id: string;
  name: string;
  threshold: number;
  currency: string;
  lookback_days: 1 | 3 | 7;
  min_spend: number;
  scope_campaign_external_id: string | null;
  is_active: boolean;
  last_evaluated_at: string | null;
  last_fired_at: string | null;
}

export interface RuleInput {
  name: string;
  threshold: number;
  lookback_days: 1 | 3 | 7;
  min_spend: number;
  scope_campaign_external_id: string | null;
  is_active: boolean;
}

export interface AvailableAccount {
  id: string;
  name: string;
  currency: string;
  timezone_name: string;
}

export const adsKeys = {
  all: ["ads"] as const,
  status: ["ads", "status"] as const,
  overview: (from: string, to: string) => ["ads", "overview", from, to] as const,
  adverts: (from: string, to: string) => ["ads", "adverts", from, to] as const,
  advert: (id: string, from: string, to: string) => ["ads", "advert", id, from, to] as const,
  chats: (from: string, to: string, ad: string) => ["ads", "chats", from, to, ad] as const,
  log: ["ads", "log"] as const,
  rules: ["ads", "rules"] as const,
  draft: (id: string) => ["ads", "draft", id] as const,
  destinations: ["ads", "destinations"] as const,
  source: (conversationId: string) => ["ads", "source", conversationId] as const,
};

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/**
 * One request, no retry (one more try only after a sign-in refresh, when the
 * first never ran). Throws ApiError with the server's own sentence.
 */
async function once<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  };
  let res = await fetch(`${API_BASE}/ads${path}`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}/ads${path}`, init).catch(() => null);
  }
  if (!res) {
    throw new ApiError(0, "network_error", "We couldn't reach the server, so we cannot tell if this went through. Check the activity log before trying again.");
  }
  let parsed: ({ data?: T } & ErrorBody) | null = null;
  try {
    parsed = (await res.json()) as { data?: T } & ErrorBody;
  } catch {
    parsed = null;
  }
  if (res.ok && parsed && "data" in parsed) return parsed.data as T;
  throw new ApiError(
    res.status,
    parsed?.error?.code ?? "unknown",
    parsed?.error?.message ?? `Something went wrong (${res.status}). Check the activity log before trying again.`,
    parsed?.error?.details,
  );
}

const range = (from: string, to: string) => `from=${from}&to=${to}`;

export const adsApi = {
  // ── Reads ──
  status: async () => (await api<{ data: AdsStatus }>("/ads/status")).data,
  overview: async (from: string, to: string) => (await api<{ data: AdsOverviewData }>(`/ads/overview?${range(from, to)}`)).data,
  adverts: async (from: string, to: string) => (await api<{ data: AdvertRow[]; currency: string | null }>(`/ads/adverts?${range(from, to)}`)),
  advert: async (id: string, from: string, to: string) => (await api<{ data: AdvertDetail }>(`/ads/adverts/${id}?${range(from, to)}`)).data,
  chats: async (from: string, to: string, ad?: string, cursor?: string) =>
    api<{ data: AdChat[]; reporting_on: boolean; next_cursor: string | null }>(
      `/ads/chats?${range(from, to)}${ad ? `&ad=${ad}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  log: async (cursor?: string) => api<{ data: AdLogRow[]; next_cursor: string | null }>(`/ads/log${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  exportUrl: (from: string, to: string) => `${API_BASE}/ads/export.csv?${range(from, to)}`,
  availableAccounts: async () => (await api<{ data: AvailableAccount[] }>("/ads/accounts/available", {}, { silentError: true })).data,
  calibration: async () =>
    (await api<{ data: { currency: string; budget_factor: number | null; adsets: { external_id: string; name: string; daily_budget_units: number }[] } }>("/ads/calibration", {}, { silentError: true })).data,
  rules: async () =>
    api<{ data: AdRule[]; rules_enabled: boolean; manage_enabled: boolean; campaigns: { external_id: string; name: string | null }[] }>("/ads/rules"),
  drafts: async () => (await api<{ data: AdDraft[] }>("/ads/drafts", {}, { silentError: true })).data,
  draft: async (id: string) => (await api<{ data: AdDraft }>(`/ads/drafts/${id}`, {}, { silentError: true })).data,
  destinations: async () => (await api<{ data: { destination: AdDestination; accounts: { id: string; label: string }[] }[] }>("/ads/destinations")).data,
  turnOnPreview: (campaignId: string) => once<TurnOnPreview>("GET", `/adverts/${campaignId}/turn-on-preview`),
  budgetPreview: (adsetId: string, daily: number) => once<BudgetPreview>("POST", `/adsets/${adsetId}/budget-preview`, { daily_budget: daily }),
  preview: (draftId: string) => once<DraftPreview>("POST", `/drafts/${draftId}/preview`),

  // ── Changes: each sent once ──
  refresh: () => once<{ ok: true }>("POST", "/refresh"),
  link: (adAccountId: string) => once<AdsAccount>("POST", "/accounts/link", { ad_account_id: adAccountId }),
  unlink: () => once<{ ok: true }>("POST", "/accounts/unlink"),
  saveSettings: (patch: Partial<AdsSettings>) => once<AdsSettings>("PUT", "/settings", patch),
  calibrate: (adsetExternalId: string, amount: number) =>
    once<{ budget_factor: number }>("POST", "/calibration", { adset_external_id: adsetExternalId, amount_in_ads_manager: amount }),
  blockReporting: (touchId: string, block: boolean) => once<{ id: string }>("POST", `/chats/${touchId}/${block ? "block" : "unblock"}-reporting`),
  upload: (file: File) =>
    once<{ upload_url: string; object_key: string; upload_token: string }>("POST", "/uploads", {
      filename: file.name,
      content_type: file.type,
      size_bytes: file.size,
    }),
  createDraft: (spec: AdDraftSpecInput, imageToken: string | null) => once<AdDraft>("POST", "/drafts", { spec, ...(imageToken ? { image_token: imageToken } : {}) }),
  updateDraft: (id: string, spec: AdDraftSpecInput, imageToken: string | null) =>
    once<AdDraft>("PATCH", `/drafts/${id}`, { spec, ...(imageToken ? { image_token: imageToken } : {}) }),
  deleteDraft: (id: string) => once<{ ok: true }>("DELETE", `/drafts/${id}`),
  /** The server works the total out itself; only what the person typed and the summary's fingerprint are sent. */
  create: (draftId: string, contentHash: string, typed: string) => once<AdDraft>("POST", `/drafts/${draftId}/create`, { content_hash: contentHash, typed }),
  continueDraft: (draftId: string) => once<AdDraft>("POST", `/drafts/${draftId}/continue`),
  turnOn: (campaignId: string, typed: string) => once<{ ok: true }>("POST", `/adverts/${campaignId}/turn-on`, { typed }),
  pause: (level: "campaign" | "adset" | "ad", externalId: string) => once<{ ok: true }>("POST", `/objects/${level}/${externalId}/pause`),
  changeBudget: (adsetId: string, daily: number, typed: string) => once<{ ok: true }>("POST", `/adsets/${adsetId}/budget`, { daily_budget: daily, typed }),
  createRule: (rule: RuleInput) => once<AdRule>("POST", "/rules", rule),
  updateRule: (id: string, patch: Partial<RuleInput>) => once<AdRule>("PATCH", `/rules/${id}`, patch),
  deleteRule: (id: string) => once<{ ok: true }>("DELETE", `/rules/${id}`),
};

/** Put the picture straight into storage with the signed address. One try. */
export async function putPicture(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": file.type }, body: file }).catch(() => null);
  if (!res || !res.ok) throw new ApiError(res?.status ?? 0, "upload_failed", "The picture could not be uploaded. Try again.");
}
