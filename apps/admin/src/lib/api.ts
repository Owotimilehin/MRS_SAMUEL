/**
 * Tiny fetch wrapper for the admin UI.
 * - Threads cookies (the session is HTTP-only)
 * - Auto-attaches an Idempotency-Key for every mutation
 * - Throws an Error with the server-provided message on non-2xx
 */
export const API_BASE = "/v1";

/** crypto.randomUUID() requires a secure context (HTTPS or localhost). In
 *  plain-HTTP previews it throws — fall back to a Math.random RFC4122-shaped
 *  uuid so idempotency keys stay valid. Production runs over HTTPS so the
 *  native path is used. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (isMutation && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", uuid());
  }

  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    let body: ErrorBody = {};
    try { body = (await res.json()) as ErrorBody; } catch { /* not json */ }
    throw new ApiError(
      res.status,
      body.error?.code ?? "unknown",
      body.error?.message ?? `request failed (${res.status})`,
      body.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
