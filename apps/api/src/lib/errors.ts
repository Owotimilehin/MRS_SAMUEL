import type { ErrorCode } from "@ms/shared";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BusinessError extends AppError {}
export class SystemError extends AppError {}

/**
 * The Postgres error code (e.g. "23503" foreign key, "23505" unique, "23514"
 * check) from a failed query. Drizzle wraps driver errors in DrizzleQueryError,
 * so the code is usually on `.cause`; older call sites looked only at `.code`
 * and silently missed it.
 */
export function pgErrorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
