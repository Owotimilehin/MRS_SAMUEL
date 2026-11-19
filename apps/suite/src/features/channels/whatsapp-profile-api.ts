/** Calls for /v1/whatsapp-profile (suite spec 05). */
import { api, API_BASE, refreshAccessToken } from "@admin/lib/api.js";
import type { WaProfileFields } from "@ms/shared";

export interface WaNumberRow {
  id: string;
  label: string;
  e164: string | null;
  is_active: boolean;
}

/** The profile as the server sends it: the six fields, plus Meta's picture address (shown on this page only, never kept). */
export interface WaProfileJson extends WaProfileFields {
  profile_picture_url: string | null;
}

export interface WaStatusJson {
  display_phone_number: string | null;
  display_name: string | null;
  name_status: string | null;
  pending_name: string | null;
  pending_name_status: string | null;
  quality_rating: string | null;
  status: string | null;
  code_verification_status: string | null;
  messaging_limit: string | null;
  /** null = WhatsApp did not tell us */
  pin_enabled: boolean | null;
  /** null = WhatsApp did not tell us */
  official_account: boolean | null;
}

export interface WaProfileView {
  number: { id: string; label: string; e164: string | null; waba_id: string | null };
  profile: WaProfileJson;
  status: WaStatusJson;
  photo_upload_ready: boolean;
  manager_url: string;
}

export interface WaSaveAnswer {
  profile: WaProfileJson;
  /** Field names the save changed. */
  changed: (keyof WaProfileFields)[];
  /** Field names where WhatsApp now shows something other than what was sent. */
  mismatch: (keyof WaProfileFields)[];
}

/** A save or upload that did not return 200. */
export class WaSaveFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The profile changed on WhatsApp since it was opened (409); `current` is what it holds now. */
    public readonly changedElsewhere: boolean,
    public readonly current: WaProfileJson | null,
  ) {
    super(message);
    this.name = "WaSaveFailure";
  }
}

export const waProfileKeys = {
  list: ["channels", "wa-profile"] as const,
  one: (id: string) => ["channels", "wa-profile", id] as const,
};

const base = (id: string) => `/whatsapp-profile/${encodeURIComponent(id)}`;

function newKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface ErrBody {
  data?: unknown;
  error?: { message?: string; details?: { reason?: string; current?: WaProfileJson } };
}

/**
 * A write is sent once and never retried by the browser (rule 11): the shared api() helper retries a 502,
 * and a repeated write must be a person's decision after reading what WhatsApp now holds.
 */
async function sendOnce<T>(path: string, init: RequestInit): Promise<T> {
  const run = () => fetch(`${API_BASE}${path}`, { ...init, credentials: "include" }).catch(() => null);
  let res = await run();
  if (res?.status === 401 && (await refreshAccessToken())) res = await run();
  if (!res) throw new WaSaveFailure(0, "We couldn't reach the server. Check your connection and try again.", false, null);
  let body: ErrBody = {};
  try {
    body = (await res.json()) as ErrBody;
  } catch {
    /* not json */
  }
  if (res.status === 200 && body.data !== undefined) return body.data as T;
  throw new WaSaveFailure(
    res.status,
    body.error?.message ?? `Something went wrong (${res.status}). Please try again.`,
    body.error?.details?.reason === "changed_elsewhere",
    body.error?.details?.current ?? null,
  );
}

export const waProfileApi = {
  list: async () => (await api<{ data: WaNumberRow[] }>("/whatsapp-profile")).data,
  get: async (id: string) => (await api<{ data: WaProfileView }>(base(id))).data,
  save: (id: string, profile: WaProfileFields, expected: WaProfileFields) =>
    sendOnce<WaSaveAnswer>(base(id), {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": newKey() },
      body: JSON.stringify({ profile, expected }),
    }),
  /** Sends the picture itself as the body, with its own content type. */
  uploadPhoto: (id: string, file: File) =>
    sendOnce<{ profile_picture_url: string | null }>(`${base(id)}/photo`, {
      method: "POST",
      headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) },
      body: file,
    }),
};
