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
