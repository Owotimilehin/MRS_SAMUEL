export const ErrorCode = {
  // Auth
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  InvalidCredentials: "invalid_credentials",
  AccountLocked: "account_locked",
  // Validation
  ValidationFailed: "validation_failed",
  // Idempotency
  IdempotencyKeyReused: "idempotency_key_reused",
  IdempotencyInFlight: "idempotency_in_flight",
  // Rate limit
  RateLimited: "rate_limited",
  // Generic
  NotFound: "not_found",
  Conflict: "conflict",
  Internal: "internal_error",
  ServiceUnavailable: "service_unavailable"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
