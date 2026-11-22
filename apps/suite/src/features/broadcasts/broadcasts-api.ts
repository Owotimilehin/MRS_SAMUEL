/** Calls for /v1/broadcasts (suite spec 14, Phase B). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";
import type {
  BroadcastAudience,
  BroadcastBlanks,
  BroadcastDetail,
  BroadcastHealth,
  BroadcastOptions,
  BroadcastRecipientRow,
  BroadcastResults,
  BroadcastRow,
  BroadcastSettings,
  BroadcastSettingsView,
} from "@ms/shared";

/** A write the server refused, or that never reached it. `reason` comes from the server's `details`. */
export class BroadcastFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: string | null,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BroadcastFailure";
  }
}

export function failureText(err: unknown): string {
  return err instanceof BroadcastFailure ? err.message : "Something went wrong. Please try again.";
}

export const broadcastKeys = {
  all: ["broadcasts"] as const,
  list: ["broadcasts", "list"] as const,
  one: (id: string) => ["broadcasts", "one", id] as const,
  audience: (id: string, group: string) => ["broadcasts", "audience", id, group] as const,
  results: (id: string) => ["broadcasts", "results", id] as const,
  recipients: (id: string, state: string) => ["broadcasts", "recipients", id, state] as const,
  options: ["broadcasts", "options"] as const,
  settings: ["broadcasts", "settings"] as const,
  health: ["broadcasts", "health"] as const,
};

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Body {
  data?: unknown;
  error?: { message?: string; details?: Record<string, unknown> & { reason?: string } };
}

/**
 * Every write is sent once and never retried by the browser (one fetch; one sign-in refresh on
 * 401 is the only repeat). Confirming a broadcast or sending a test twice must be a person's
 * decision after seeing what happened.
 */
async function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  };
  const run = () => fetch(`${API_BASE}${path}`, init).catch(() => null);
  let res = await run();
  if (res?.status === 401 && (await refreshAccessToken())) res = await run();
  if (!res) throw new BroadcastFailure(0, "We couldn't reach the server. Check your connection and try again.", null, {});
  let body: Body = {};
  try {
    body = (await res.json()) as Body;
  } catch {
    /* not json */
  }
  if (res.status >= 200 && res.status < 300 && body.data !== undefined) return body.data as T;
  const details = body.error?.details ?? {};
  const message =
    res.status === 403
      ? "You don't have permission to do that."
      : body.error?.message && body.error.message !== "invalid request"
        ? body.error.message
        : `That didn't work (${res.status}). Check what you entered and try again.`;
  throw new BroadcastFailure(res.status, message, typeof details.reason === "string" ? details.reason : null, details);
}

const one = (id: string) => `/broadcasts/${encodeURIComponent(id)}`;

export type SettingsSave = BroadcastSettings & { confirm_enable?: boolean; confirm_legal?: boolean; clear_account_block?: boolean };

export const broadcastsApi = {
  list: async () => (await api<{ data: BroadcastRow[] }>("/broadcasts?limit=100")).data,
  get: async (id: string) => (await api<{ data: BroadcastDetail }>(one(id))).data,
  options: async () => (await api<{ data: BroadcastOptions }>("/broadcasts/options")).data,
  settings: async () => (await api<{ data: BroadcastSettingsView }>("/broadcasts/settings")).data,
  health: async () => (await api<{ data: BroadcastHealth }>("/broadcasts/health")).data,
  audience: async (id: string, group = "will_send", cursor?: string | null) =>
    (await api<{ data: BroadcastAudience }>(`${one(id)}/audience?group=${encodeURIComponent(group)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).data,
  results: async (id: string) => (await api<{ data: BroadcastResults }>(`${one(id)}/results`)).data,
  recipients: async (id: string, state: string, cursor?: string | null) =>
    (
      await api<{ data: { recipients: BroadcastRecipientRow[]; next_cursor: string | null } }>(
        `${one(id)}/recipients?limit=100${state ? `&state=${encodeURIComponent(state)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
    ).data,
  /** Fetch the results spreadsheet and hand it to the browser to save. One request: every download is audited. */
  download: async (id: string): Promise<void> => {
    const run = () => fetch(`${API_BASE}${one(id)}/recipients.csv`, { credentials: "include" }).catch(() => null);
    let res = await run();
    if (res?.status === 401 && (await refreshAccessToken())) res = await run();
    if (!res) throw new BroadcastFailure(0, "We couldn't reach the server. Check your connection and try again.", null, {});
    if (!res.ok) throw new BroadcastFailure(res.status, res.status === 403 ? "You don't have permission to download this." : `The download didn't work (${res.status}).`, null, {});
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "broadcast-results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  create: (b: { name: string; phone_number_id: string; list_id: string; template_id: string }) => send<BroadcastDetail>("POST", "/broadcasts", b),
  update: (id: string, b: { name?: string; list_id?: string; template_id?: string; phone_number_id?: string; blanks?: BroadcastBlanks; scheduled_at?: string | null }) =>
    send<BroadcastDetail>("PATCH", one(id), b),
  headerUpload: (id: string, mime: string, sizeBytes: number) => send<{ upload_url: string; media_key: string }>("POST", `${one(id)}/header-upload`, { mime, size_bytes: sizeBytes }),
  test: (id: string, to: string) => send<{ message_id: string; status: string }>("POST", `${one(id)}/test`, { to }),
  confirm: (id: string, confirmCount: number, when: "now" | "scheduled") =>
    send<{ status: string; recipients: number; skipped: number }>("POST", `${one(id)}/confirm`, { confirm_count: confirmCount, when }),
  pause: (id: string) => send<{ status: string }>("POST", `${one(id)}/pause`),
  resume: (id: string, confirmCount: number) => send<{ status: string }>("POST", `${one(id)}/resume`, { confirm_count: confirmCount }),
  cancel: (id: string) => send<{ status: string; not_sent: number }>("POST", `${one(id)}/cancel`, { confirm: true }),
  remove: (id: string) => send<{ deleted: true }>("DELETE", one(id)),
  saveSettings: (b: SettingsSave) => send<BroadcastSettingsView>("PUT", "/broadcasts/settings", b),
};

/** Put the picture straight into storage with the signed address the server gave. */
export async function uploadPicture(url: string, file: File): Promise<void> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": file.type }, body: file }).catch(() => null);
  if (!res || !res.ok) throw new BroadcastFailure(0, "The picture did not upload. Check your connection and try again.", null, {});
}
