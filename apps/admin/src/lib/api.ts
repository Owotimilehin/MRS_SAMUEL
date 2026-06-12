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

interface ZodIssue {
  path?: (string | number)[];
  message?: string;
  code?: string;
  validation?: string;
  type?: string;
  minimum?: number;
  inclusive?: boolean;
  expected?: string;
  received?: string;
}

// Plain-English names for the fields a shop owner actually sees, so a rejected
// form reads like a person wrote it — never "slug" or "price_ngn".
const FIELD_LABELS: Record<string, string> = {
  name: "name",
  slug: "web address",
  category: "category",
  price_ngn: "price",
  size_ml: "can size",
  shelf_life_hours: "shelf life",
  display_order: "display order",
  ingredients: "ingredients",
  image_url: "image",
  bottle_asset_id: "bottle image",
  cluster_asset_id: "cluster image",
  fruit_asset_id: "fruit image",
  "palette.surface": "background colour",
  "palette.accent": "accent colour",
  "palette.text": "text colour",
  email: "email address",
  phone: "phone number",
  amount_ngn: "amount",
  quantity: "quantity",
};

function fieldLabel(path: (string | number)[] | undefined): string {
  if (!path || path.length === 0) return "one of the details";
  const joined = path.join(".");
  if (FIELD_LABELS[joined]) return FIELD_LABELS[joined];
  const last = String(path[path.length - 1] ?? "");
  if (FIELD_LABELS[last]) return FIELD_LABELS[last];
  return last.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "one of the details";
}

// Map a single Zod issue to a friendly phrase that completes "<field> ...".
function constraintPhrase(iss: ZodIssue): string {
  const msg = (iss.message ?? "").toLowerCase();
  if (iss.validation === "regex") return "can only use lowercase letters, numbers and dashes";
  if (iss.validation === "uuid") return "needs to be picked from the list";
  if (iss.validation === "email") return "doesn't look like a valid email address";
  if (iss.validation === "url") return "needs to be a valid link";
  if (iss.code === "too_small") {
    if (iss.type === "string") return iss.minimum === 1 ? "is required" : `needs at least ${iss.minimum} characters`;
    if (iss.type === "number") return iss.minimum === 0 && iss.inclusive === false ? "must be more than zero" : `must be at least ${iss.minimum}`;
    return "is too short";
  }
  if (iss.code === "too_big") return "is too long";
  if (iss.code === "invalid_type") {
    if (iss.received === "undefined" || iss.received === "null" || msg === "required") return "is required";
    if (iss.expected === "number") return "must be a number";
    return "isn't filled in correctly";
  }
  if (iss.code === "invalid_enum_value") return "isn't one of the allowed choices";
  if (iss.code === "invalid_string") return "isn't in the right format";
  return "needs another look";
}

/**
 * Turn a Zod `validation_failed` body into a sentence a non-technical user can
 * act on. The API returns a generic "invalid request" plus `details.issues`
 * (raw Zod issues); we translate each to "<friendly field> <friendly reason>".
 */
function describeValidation(code: string | undefined, details: Record<string, unknown> | undefined): string | null {
  if (code !== "validation_failed" || !details) return null;
  const issues = details.issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  // De-dupe by field so "name is required; name is required" can't happen.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const iss of issues as ZodIssue[]) {
    const phrase = `${fieldLabel(iss.path)} ${constraintPhrase(iss)}`;
    if (!seen.has(phrase)) {
      seen.add(phrase);
      parts.push(phrase);
    }
  }
  const body = parts.join("; ");
  return parts.length === 1
    ? `Please check this: ${body}.`
    : `Please check a few details: ${body}.`;
}

/** Friendly fallbacks for non-validation failures, keyed by error code. */
function describeByCode(code: string, status: number, serverMessage: string | undefined): string {
  switch (code) {
    case "internal_error":
      return "Something went wrong on our end. Please try again in a moment.";
    case "network_error":
      return "We couldn't reach the server. Check your connection and try again.";
    case "service_unavailable":
      return "That feature isn't available right now. Please try again later.";
    case "unauthorized":
      return "Your session has expired. Please sign in again.";
    case "forbidden":
      return "You don't have permission to do that. Ask an owner if you need access.";
    case "not_found":
      // A server message is usually specific ("product not found"); keep it.
      return serverMessage ?? "We couldn't find that — it may have been removed.";
    default:
      // Business rules (conflicts, stock limits) already read like a human
      // wrote them — keep the server's wording rather than flattening it.
      return serverMessage ?? `Something went wrong (${status}). Please try again.`;
  }
}

/** Best-effort friendly message for any caught value, for use at call sites. */
export function humanizeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) {
      return "We couldn't reach the server. Check your connection and try again.";
    }
  }
  return "Something went wrong. Please try again.";
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

// Gateway/transient statuses worth retrying — these show up while the API is
// restarting (nginx can't reach the upstream yet) or briefly overloaded.
const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);
const MAX_ATTEMPTS = 4;

/**
 * Wait before the next retry. If the device is offline, park until it comes
 * back (capped) instead of burning attempts against a dead connection — so a
 * dropped wifi resumes the moment it reconnects. Otherwise back off with jitter.
 */
function waitBeforeRetry(attempt: number): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false && typeof window !== "undefined") {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        window.removeEventListener("online", done);
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      window.addEventListener("online", done, { once: true });
    });
  }
  const base = 300 * 2 ** (attempt - 1); // 300ms, 600ms, 1200ms
  return new Promise((r) => setTimeout(r, base + Math.random() * 200));
}

/**
 * Admin API call with built-in ruggedness: connection drops, server restarts
 * and gateway errors (502/503/504) are retried with backoff instead of failing
 * the user. Retrying writes is safe because every mutation carries a stable
 * Idempotency-Key (generated once, reused across attempts), so the server
 * dedupes a request that actually landed. The friendly error only surfaces if
 * every attempt is exhausted.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  // Set ONCE so every retry reuses the same key — the server replays the stored
  // result instead of applying the mutation twice.
  if (isMutation && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", uuid());
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS;

    let res: Response;
    try {
      res = await fetch(API_BASE + path, { ...init, credentials: "include", headers });
    } catch {
      // Network/DNS/offline — fetch rejects before any response.
      if (last) throw new ApiError(0, "network_error", describeByCode("network_error", 0, undefined));
      await waitBeforeRetry(attempt);
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status) && !last) {
      await waitBeforeRetry(attempt);
      continue;
    }

    if (!res.ok) {
      let body: ErrorBody = {};
      try { body = (await res.json()) as ErrorBody; } catch { /* not json */ }
      const code = body.error?.code ?? "unknown";
      const message =
        describeValidation(code, body.error?.details) ??
        describeByCode(code, res.status, body.error?.message);
      throw new ApiError(res.status, code, message, body.error?.details);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // Unreachable (the loop either returns or throws), but satisfies the compiler.
  throw new ApiError(0, "network_error", describeByCode("network_error", 0, undefined));
}
