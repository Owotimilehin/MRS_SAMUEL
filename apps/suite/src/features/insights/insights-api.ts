/** Calls for /v1/insights (suite spec 11). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";

export type ProblemCode = "not_connected" | "no_permission" | "token" | "too_small" | "temporary" | "not_enabled" | "other";
export interface SourceStatus {
  source: string;
  account_key: string;
  label: string;
  last_ok_at: string | null;
  problem: null | { code: ProblemCode; message: string };
}
export interface Tile {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  how: "sum" | "latest" | "daily_average";
  note: string | null;
}
export interface Summary {
  range: { from: string; to: string };
  previous: { from: string; to: string };
  sources: SourceStatus[];
  tiles: Tile[];
  cost_currency: string | null;
}
export interface Point {
  day: string;
  value: number | null;
}
export interface Series {
  source: string;
  metric: string;
  day_zone: string;
  is_running_total: boolean;
  /** Present unless the call asked for breakdown "*". */
  points?: Point[];
  /** Present when the call asked for breakdown "*": one series per part. */
  series?: { breakdown: string; points: Point[] }[];
}
export interface PostRow {
  network: "facebook" | "instagram";
  subject_id: string;
  kind: string | null;
  title: string | null;
  permalink: string | null;
  published_at: string | null;
  from_suite: boolean;
  removed: boolean;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  comments: number | null;
  clicks: number | null;
}
export interface TemplateRow {
  template_id: string;
  name: string;
  sent: number | null;
  delivered: number | null;
  read: number | null;
  clicked: number | null;
  read_rate: number | null;
}
export interface WhatsAppFigures {
  day_zone: string;
  by_type: { day: string; template: number | null; free_form: number | null; delivered: number | null }[];
  pricing: { category: string; type: string; volume: number | null; cost: number | null }[];
  cost_currency: string | null;
  templates: TemplateRow[];
  template_analytics: "on" | "off" | "unknown";
  accounts: { waba_id: string; template_analytics: "on" | "off" }[];
}
export interface InsightsStatus {
  last_run_at: string | null;
  last_daily_run_day: string | null;
  refresh_requested_at: string | null;
  sources: SourceStatus[];
}

export const insightKeys = {
  all: ["insights"] as const,
  summary: (f: string, t: string) => ["insights", "summary", f, t] as const,
  series: (source: string, metric: string, breakdown: string, f: string, t: string) => ["insights", "series", source, metric, breakdown, f, t] as const,
  posts: (f: string, t: string, network: string) => ["insights", "posts", f, t, network] as const,
  whatsapp: (f: string, t: string) => ["insights", "whatsapp", f, t] as const,
  status: ["insights", "status"] as const,
};

export const EXPORT_URL = (from: string, to: string, source = "all"): string =>
  `${API_BASE}/insights/export.csv?${new URLSearchParams({ from, to, source }).toString()}`;

/** A POST that did not return 200. */
export class PostFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PostFailure";
  }
}

/**
 * One POST, never retried by the browser (the shared api() helper retries 429 and 502;
 * "refreshed a few minutes ago" and "WhatsApp did not accept this" are answers, not hiccups).
 */
async function postOnce<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let res = await fetch(`${API_BASE}${path}`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) res = await fetch(`${API_BASE}${path}`, init).catch(() => null);
  if (!res) throw new PostFailure(0, "We couldn't reach the server. Check your connection and try again.");
  let parsed: { data?: T; error?: { message?: string } } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    /* not json */
  }
  if (res.status === 200 && parsed.data !== undefined) return parsed.data;
  throw new PostFailure(res.status, parsed.error?.message ?? `Something went wrong (${res.status}). Please try again.`);
}

const range = (from: string, to: string, extra: Record<string, string> = {}): string => new URLSearchParams({ from, to, ...extra }).toString();

export const insightsApi = {
  summary: async (from: string, to: string) => (await api<{ data: Summary }>(`/insights/summary?${range(from, to)}`)).data,
  series: async (source: string, metric: string, breakdown: string, from: string, to: string) =>
    (await api<{ data: Series }>(`/insights/series?${range(from, to, { source, metric, ...(breakdown ? { breakdown } : {}) })}`)).data,
  posts: async (from: string, to: string, network: string) =>
    (await api<{ data: PostRow[] }>(`/insights/posts?${range(from, to, { network, sort: "views", limit: "100" })}`)).data,
  whatsapp: async (from: string, to: string) => (await api<{ data: WhatsAppFigures }>(`/insights/whatsapp?${range(from, to)}`)).data,
  status: async () => (await api<{ data: InsightsStatus }>("/insights/status")).data,
  refresh: () => postOnce<{ requested_at: string }>("/insights/refresh"),
  enableTemplateFigures: (wabaId: string) =>
    postOnce<{ template_analytics: "on" }>("/insights/whatsapp/template-analytics", { waba_id: wabaId, confirm: true }),
};
