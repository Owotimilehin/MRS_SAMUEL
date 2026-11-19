/** Calls for /v1/social/comments (suite spec 03). */
import { api, API_BASE, ApiError, refreshAccessToken } from "@admin/lib/api.js";
import type { CommentAccount, CommentItem, ThreadDetail, ThreadSummary } from "./comments-types.js";

export const commentKeys = {
  all: ["comments"] as const,
  accounts: ["comments", "accounts"] as const,
  unread: ["comments", "unread"] as const,
  threads: (query: string) => ["comments", "threads", query] as const,
  thread: (id: string) => ["comments", "thread", id] as const,
};

const base = "/social/comments";

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Answer {
  status: number;
  body: { data?: CommentItem; error?: { code?: string; message?: string } };
}

/**
 * Anything that reaches Facebook or Instagram is sent ONCE, never retried by
 * the browser: the shared api() helper retries a 502, and a 502 here means
 * "Meta did not take it, or did not answer", which a person must read, not a
 * loop repeat. One sign-in refresh on 401 is the only second attempt.
 */
async function sendOnce(method: "POST" | "DELETE", path: string, body?: unknown): Promise<Answer> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "idempotency-key": newKey(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let res = await fetch(`${API_BASE}${base}${path}`, init).catch(() => null);
  if (res?.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}${base}${path}`, init).catch(() => null);
  }
  if (!res) throw new ApiError(0, "network_error", "We couldn't reach the server. Check your connection, then look at the comment before trying again.");
  let parsed: Answer["body"] = {};
  try {
    parsed = (await res.json()) as Answer["body"];
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed };
}

function failure(a: Answer): ApiError {
  return new ApiError(a.status, a.body.error?.code ?? "unknown", a.body.error?.message ?? `Something went wrong (${a.status}). Please try again.`);
}

/** Hide, show, delete, like: the changed comment, or an error with the server's plain words. */
async function change(method: "POST" | "DELETE", path: string): Promise<CommentItem> {
  const a = await sendOnce(method, path);
  if (a.status === 200 && a.body.data) return a.body.data;
  throw failure(a);
}

/** What a public reply or a private message answers: `ok` false means it did not go through normally (the item says how it is marked). */
export interface SendAnswer {
  ok: boolean;
  item: CommentItem;
}

async function send(path: string, body: unknown): Promise<SendAnswer> {
  const a = await sendOnce("POST", path, body);
  if ((a.status === 201 || a.status === 502) && a.body.data) return { ok: a.status === 201, item: a.body.data };
  throw failure(a);
}

const comment = (id: string) => `/comments/${encodeURIComponent(id)}`;
const thread = (id: string) => `${base}/threads/${encodeURIComponent(id)}`;

export const commentsApi = {
  accounts: async () => (await api<{ data: CommentAccount[] }>(`${base}/accounts`)).data,
  unread: async () => (await api<{ data: { threads: number } }>(`${base}/unread`)).data.threads,
  threads: async (query: string) =>
    api<{ data: ThreadSummary[]; has_more: boolean; next_before: string | null }>(`${base}/threads${query ? `?${query}` : ""}`),
  thread: async (id: string) => (await api<{ data: ThreadDetail }>(thread(id))).data,
  markRead: async (id: string) => api<{ ok: true }>(`${thread(id)}/read`, { method: "POST" }, { silentError: true }),
  update: async (id: string, patch: { assignee_id?: string | null; work_state?: "open" | "done" }) =>
    (await api<{ data: ThreadSummary }>(thread(id), { method: "PATCH", body: JSON.stringify(patch) })).data,
  resync: async (accountId: string) => api<{ ok: true }>(`${base}/sync`, { method: "POST", body: JSON.stringify({ account_id: accountId }) }),
  reply: (id: string, message: string) => send(`${comment(id)}/reply`, { message }),
  privateReply: (id: string, text: string) => send(`${comment(id)}/private-reply`, { text }),
  hide: (id: string) => change("POST", `${comment(id)}/hide`),
  unhide: (id: string) => change("POST", `${comment(id)}/unhide`),
  remove: (id: string) => change("DELETE", comment(id)),
  like: (id: string) => change("POST", `${comment(id)}/like`),
  unlike: (id: string) => change("DELETE", `${comment(id)}/like`),
};
