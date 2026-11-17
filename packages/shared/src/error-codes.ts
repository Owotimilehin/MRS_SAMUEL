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
  // Edited order's recomputed total differs from what the customer already
  // paid — the client must re-submit with reconciled:true to proceed. Never
  // triggers an automatic charge or refund.
  ReconcileRequired: "reconcile_required",
  // A checkout was re-sent for an order that is no longer awaiting payment
  // (paid, cancelled or expired). The customer must start a new order.
  OrderClosed: "order_closed",
  Internal: "internal_error",
  ServiceUnavailable: "service_unavailable"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
