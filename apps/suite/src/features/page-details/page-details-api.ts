/** Calls for /v1/channels/:accountId/page (suite spec 10). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";
import type { PAGE_LIMITS, PageAddress, PageEditable, PageEditableKey } from "@ms/shared";

export interface PageSnapshot {
  id: string;
  name: string | null;
  username: string | null;
  category: string | null;
  link: string | null;
  is_published: boolean | null;
  verification_status: string | null;
  followers_count: number | null;
  picture_url: string | null;
  cover_url: string | null;
  single_line_address: string | null;
  editable: PageEditable;
}

export interface InstagramProfile {
  id: string;
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  followers_count: number | null;
  media_count: number | null;
}

export interface PageDetailsView {
  account: { id: string; label: string; kind: "messenger" | "instagram"; is_active: boolean };
  page: PageSnapshot | null;
  instagram: InstagramProfile | null;
  can_edit: boolean;
  cannot_edit_reason: "instagram" | "inactive" | "no_manage_task" | null;
  read_at: string;
  limits: typeof PAGE_LIMITS;
}

export type PageResult = "saved" | "partly_saved" | "refused" | "unknown";

export interface PageHistoryRow {
  at: string;
  by_name: string | null;
  fields: PageEditableKey[];
  before: Partial<PageEditable>;
  after: Partial<PageEditable>;
  result: PageResult;
  not_saved: PageEditableKey[];
}

export interface SaveAnswer {
  view: PageDetailsView;
  saved: PageEditableKey[];
  not_saved: PageEditableKey[];
}

/** A save that did not return 200. `view` is what Facebook holds now, when the server could read it. */
export class SaveFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly stale: boolean,
    public readonly view: PageDetailsView | null,
  ) {
    super(message);
    this.name = "SaveFailure";
  }
}

export const pageDetailsKeys = {
  all: (accountId: string) => ["channels", "page", accountId] as const,
  view: (accountId: string) => ["channels", "page", accountId, "view"] as const,
  history: (accountId: string) => ["channels", "page", accountId, "history"] as const,
};

const base = (accountId: string) => `/channels/${encodeURIComponent(accountId)}/page`;

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * A save is sent once and never retried by the browser: the shared api() helper retries a 502,
 * and a repeated save must be a person's decision, after reading what Facebook now holds.
 */
async function saveOnce(accountId: string, expected: Partial<PageEditable>, changes: Partial<PageEditable>): Promise<SaveAnswer> {
  const init: RequestInit = {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify({ confirm: true, expected, changes }),
  };
  let res = await fetch(`${API_BASE}${base(accountId)}`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}${base(accountId)}`, init).catch(() => null);
  }
  if (!res) throw new SaveFailure(0, "We couldn't reach the server. Check your connection and try again.", false, null);
  let body: {
    data?: SaveAnswer;
    error?: { message?: string; details?: { reason?: string; view?: PageDetailsView } };
  } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not json */
  }
  if (res.status === 200 && body.data) return body.data;
  throw new SaveFailure(
    res.status,
    body.error?.message ?? `Something went wrong (${res.status}). Please try again.`,
    body.error?.details?.reason === "stale",
    body.error?.details?.view ?? null,
  );
}

export type { PageAddress };

export const pageDetailsApi = {
  view: async (accountId: string, fresh = false) =>
    (await api<{ data: PageDetailsView }>(`${base(accountId)}${fresh ? "?fresh=1" : ""}`)).data,
  save: saveOnce,
  history: async (accountId: string) => (await api<{ data: PageHistoryRow[] }>(`${base(accountId)}/history`)).data,
};
