/**
 * Fetch wrapper for the Mrs Samuel API, modelled on apps/admin/src/lib/api.ts.
 *
 * Auth is the same cookie session the admin web app uses: POST /v1/auth/login
 * sets two HttpOnly cookies (`ms_session`, 30 min, path /; `ms_refresh`, 30
 * days, path /v1/auth). React Native's fetch keeps cookies in the native cookie
 * store (NSHTTPCookieStorage on iOS, the CookieManager-backed jar on Android)
 * and sends them back with `credentials: "include"`. JavaScript never sees the
 * tokens. On a 401 we POST /v1/auth/refresh once (shared by concurrent calls)
 * and retry.
 *
 * Every mutation carries one Idempotency-Key reused across retries, so a retry
 * after a dropped connection can't send a WhatsApp message twice.
 */
import { API_ROOT } from "./config";
import { getDeviceId } from "./device-id";
import { uuid } from "./uuid";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

function friendly(code: string, status: number, serverMessage: string | undefined): string {
  switch (code) {
    case "internal_error":
      return "Something went wrong on our end. Please try again in a moment.";
    case "network_error":
      return "We couldn't reach the server. Check your connection and try again.";
    case "service_unavailable":
      return serverMessage ?? "That feature isn't available right now. Please try again later.";
    case "unauthorized":
      return "Your session has expired. Please sign in again.";
    case "forbidden":
      return serverMessage && !serverMessage.startsWith("missing capability")
        ? serverMessage
        : "You don't have permission to do that. Ask an owner if you need access.";
    case "validation_failed":
      return serverMessage && serverMessage !== "invalid request" ? serverMessage : "Please check the details and try again.";
    default:
      return serverMessage ?? `Something went wrong (${status}). Please try again.`;
  }
}

export function humanizeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && /network request failed|failed to fetch/i.test(err.message)) {
    return "We couldn't reach the server. Check your connection and try again.";
  }
  return "Something went wrong. Please try again.";
}

const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);
const MAX_ATTEMPTS = 3;

/** Called when the session is dead (refresh failed): the app returns to login. */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_ROOT}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "x-device-id": await getDeviceId() },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One refresh shared by every caller that hit a 401 at the same moment (the refresh token rotates). */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Don't try a refresh on 401 (used by the auth calls themselves). */
  noRefresh?: boolean;
}

/** Call `/v1${path}`. Throws ApiError with a plain-English message on failure. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const isMutation = method !== "GET";
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-device-id": await getDeviceId(),
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (isMutation) headers["idempotency-key"] = uuid();
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  let refreshed = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    let res: Response;
    try {
      res = await fetch(`${API_ROOT}${path}`, { method, headers, body, credentials: "include" });
    } catch {
      if (last) throw new ApiError(0, "network_error", friendly("network_error", 0, undefined));
      await wait(400 * 2 ** (attempt - 1) + Math.random() * 200);
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status) && !last) {
      await wait(400 * 2 ** (attempt - 1) + Math.random() * 200);
      continue;
    }

    if (res.status === 401 && !refreshed && !opts.noRefresh && !path.startsWith("/auth/")) {
      refreshed = true;
      if (await refreshSession()) {
        attempt--; // the refresh doesn't use up a retry
        continue;
      }
      onSessionExpired?.();
    }

    if (!res.ok) {
      let errBody: ErrorBody = {};
      try {
        errBody = (await res.json()) as ErrorBody;
      } catch {
        /* not JSON */
      }
      const code = errBody.error?.code ?? (res.status === 401 ? "unauthorized" : "unknown");
      throw new ApiError(res.status, code, friendly(code, res.status, errBody.error?.message), errBody.error?.details);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new ApiError(0, "network_error", friendly("network_error", 0, undefined));
}
