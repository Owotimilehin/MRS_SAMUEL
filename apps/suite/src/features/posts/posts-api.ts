/** Calls for /v1/social (suite spec 09, section 5.8). */
import { api, API_BASE, ApiError, refreshAccessToken } from "@admin/lib/api.js";
import type { PostProblem, SocialNetwork, SocialPostKind } from "@ms/shared";

export interface PostMediaJson {
  key: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  duration_s: number | null;
  alt_text: string | null;
  /** A 10-minute link for showing the file; null when file storage is not set up. */
  preview_url: string | null;
}

export interface PostTargetJson {
  id: string;
  account_id: string | null;
  account_label: string;
  network: SocialNetwork;
  caption_override: string | null;
  status: "pending" | "publishing" | "published" | "failed" | "unknown" | "removed";
  external_id: string | null;
  external_kind: string | null;
  permalink: string | null;
  error_message: string | null;
  error_code: string | null;
  attempts: number;
  published_at: string | null;
  removed_at: string | null;
  removed_by: { id: string; name: string } | null;
  problems: PostProblem[];
}

export interface PostJson {
  id: string;
  kind: SocialPostKind;
  caption: string;
  link_url: string | null;
  media: PostMediaJson[];
  status: string;
  status_note: string | null;
  scheduled_at: string | null;
  created_by: { id: string; name: string } | null;
  approved_by: { id: string; name: string } | null;
  approved_at: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  targets: PostTargetJson[];
}

export interface PostAccount {
  id: string;
  label: string;
  network: SocialNetwork;
  quota: { used: number; total: number } | null;
}

export interface PostBody {
  kind: SocialPostKind;
  caption: string;
  link_url: string | null;
  media: {
    key: string;
    upload_token?: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    duration_s: number | null;
    alt_text: string | null;
  }[];
  targets: { account_id: string; caption_override: string | null }[];
}

export type PostListStatus = "draft" | "scheduled" | "posted" | "problems" | "all";
export interface PostListFilter {
  status: PostListStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export const postsKeys = {
  all: ["posts"] as const,
  list: (f: PostListFilter) => ["posts", "list", f] as const,
  one: (id: string) => ["posts", "one", id] as const,
  accounts: ["posts", "accounts"] as const,
  settings: ["posts", "settings"] as const,
};

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * One request, never repeated by the browser. The shared api() helper retries a 502 or
 * 504, and for a change to a post that is already public a repeat must be a person's
 * decision (as the Page details and chat set-up screens do).
 */
async function once<T>(method: "PATCH" | "DELETE", path: string, body: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify(body),
  };
  let res = await fetch(`${API_BASE}${path}`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) res = await fetch(`${API_BASE}${path}`, init).catch(() => null);
  if (!res) throw new ApiError(0, "network_error", "We couldn't reach the server. Check your connection and try again.");
  let parsed: { data?: T; error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    /* not json */
  }
  if (res.ok && parsed.data !== undefined) return parsed.data;
  throw new ApiError(
    res.status,
    parsed.error?.code ?? "error",
    parsed.error?.message ?? `Something went wrong (${res.status}). Please try again.`,
    parsed.error?.details,
  );
}

export const UPLOAD_FAILED = "Upload failed. Check your connection and try again.";

/** PUT the file straight to storage with a progress callback (0 to 100). */
function putWithProgress(url: string, file: Blob, contentType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(UPLOAD_FAILED)));
    xhr.onerror = () => reject(new Error(UPLOAD_FAILED));
    xhr.onabort = () => reject(new Error(UPLOAD_FAILED));
    xhr.send(file);
  });
}

const q = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const post = (path: string, body?: unknown, silent = false) =>
  api<{ data: PostJson }>(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, { silentError: silent }).then(
    (r) => r.data,
  );

export const postsApi = {
  accounts: () => api<{ data: PostAccount[]; scheduling_enabled: boolean }>("/social/accounts"),
  list: async (f: PostListFilter) =>
    (await api<{ data: PostJson[]; next_cursor: string | null }>(`/social/posts${q({ status: f.status, from: f.from, to: f.to, limit: f.limit })}`)).data,
  one: async (id: string) => (await api<{ data: PostJson }>(`/social/posts/${encodeURIComponent(id)}`)).data,
  create: (body: PostBody) => post("/social/posts", body),
  update: async (id: string, body: PostBody, baseUpdatedAt: string) =>
    (
      await api<{ data: PostJson }>(`/social/posts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...body, base_updated_at: baseUpdatedAt }),
      })
    ).data,
  remove: (id: string) => api<{ ok: true }>(`/social/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** The dialog shows its own message, so no toast. */
  approve: (id: string, body: { when: "now" | "schedule"; scheduled_at?: string; content_hash: string }) =>
    post(`/social/posts/${encodeURIComponent(id)}/approve`, body, true),
  cancel: (id: string) => post(`/social/posts/${encodeURIComponent(id)}/cancel`),
  retry: (id: string, tid: string, contentHash: string) => post(`/social/posts/${id}/targets/${tid}/retry`, { content_hash: contentHash }),
  check: (id: string, tid: string) => post(`/social/posts/${id}/targets/${tid}/check`),
  resolve: (id: string, tid: string, outcome: "posted" | "not_posted") =>
    post(`/social/posts/${id}/targets/${tid}/resolve`, outcome === "not_posted" ? { outcome, confirm: true } : { outcome }),
  editPublished: (id: string, tid: string, message: string) => once<PostJson>("PATCH", `/social/posts/${id}/targets/${tid}/published`, { message }),
  takeDown: (id: string, tid: string, manual: boolean) =>
    once<PostJson>("DELETE", `/social/posts/${id}/targets/${tid}/published`, manual ? { manual: true } : {}),
  settings: async () => (await api<{ data: { scheduled_enabled: boolean } }>("/social/settings")).data,
  saveSettings: async (scheduledEnabled: boolean) =>
    (await api<{ data: { scheduled_enabled: boolean } }>("/social/settings", { method: "PUT", body: JSON.stringify({ scheduled_enabled: scheduledEnabled }) }))
      .data,
  /** Ask for an upload link, then send the file to storage. Returns what the post body needs. */
  upload: async (file: Blob, filename: string, contentType: string, onProgress: (percent: number) => void) => {
    const { data } = await api<{ data: { upload_url: string; object_key: string; kind: "image" | "video"; upload_token: string } }>(
      "/social/uploads",
      { method: "POST", body: JSON.stringify({ filename, content_type: contentType, size_bytes: file.size }) },
      { silentError: true },
    );
    await putWithProgress(data.upload_url, file, contentType, onProgress);
    return { key: data.object_key, upload_token: data.upload_token };
  },
};
