// apps/customer/src/lib/api/client.ts
import { API_BASE } from "./config";

export class ApiError extends Error {
  readonly name = "ApiError";
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /**
   * Serialize to a JSON string suitable for re-throwing as a plain Error
   * across the TanStack server-function RPC boundary, which strips custom
   * Error subclasses. Pair with {@link asApiError} on the client.
   */
  serialize(): string {
    return JSON.stringify({ __apiError: { code: this.code, message: this.message, status: this.status } });
  }
}

/**
 * Recover an ApiError from an unknown caught value. Handles both a real
 * ApiError (same realm) and the serialized form produced by
 * {@link ApiError.serialize} after it crosses a server-function boundary
 * (where the prototype and custom fields are otherwise lost). Returns null
 * when the value is not an API error.
 */
export function asApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as { __apiError?: { code: string; message: string; status: number } };
      if (parsed.__apiError) {
        return new ApiError(parsed.__apiError.code, parsed.__apiError.message, parsed.__apiError.status);
      }
    } catch {
      /* message was not a serialized ApiError */
    }
  }
  return null;
}

/**
 * Fetch an API endpoint and return the unwrapped `data` payload. Throws an
 * ApiError for the `{ error }` envelope or any non-2xx / non-JSON response.
 * Called from server functions only.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError("network_error", err instanceof Error ? err.message : "network error", 0);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (res.ok) return undefined as T;
    throw new ApiError("upstream_error", `API ${res.status}`, res.status);
  }

  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok || json.error) {
    const e = json.error ?? { code: "upstream_error", message: `API ${res.status}` };
    throw new ApiError(e.code, e.message, res.status);
  }
  return json.data as T;
}
