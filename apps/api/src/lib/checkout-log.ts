import { z } from "zod";

/** The lifecycle stages of a single "Place order" press. Rows for one press
 *  share an `attempt_id`. */
export const CHECKOUT_STAGES = [
  "pressed",
  "validation_failed",
  "order_created",
  "order_failed",
  "payment_paid",
  "payment_redirect",
  "payment_closed",
  "payment_failed",
] as const;
export type CheckoutStage = (typeof CHECKOUT_STAGES)[number];

const STATUS_BY_STAGE: Record<CheckoutStage, "info" | "ok" | "error" | "abandoned"> = {
  pressed: "info",
  validation_failed: "error",
  order_created: "ok",
  order_failed: "error",
  payment_paid: "ok",
  payment_redirect: "info",
  payment_closed: "abandoned",
  payment_failed: "error",
};

export function statusForStage(stage: CheckoutStage): "info" | "ok" | "error" | "abandoned" {
  return STATUS_BY_STAGE[stage];
}

const FAILURE_STAGES = new Set<CheckoutStage>([
  "validation_failed",
  "order_failed",
  "payment_failed",
]);

/** Failure stages trigger a Telegram alert. */
export function isFailureStage(stage: CheckoutStage): boolean {
  return FAILURE_STAGES.has(stage);
}

const str = (max: number) => z.string().max(max);

/** Request body for POST /v1/public/telemetry/checkout. Unauthenticated, so
 *  every field is length-capped and the shape is strict. */
export const checkoutLogSchema = z.object({
  attempt_id: str(100).min(1),
  stage: z.enum(CHECKOUT_STAGES),
  order_number: str(60).optional(),
  customer: z
    .object({
      name: str(200).optional(),
      phone: str(60).optional(),
      email: str(200).optional(),
      address: str(500).optional(),
      state: str(100).optional(),
    })
    .optional(),
  delivery_window: str(40).optional(),
  scheduled_for: str(60).optional(),
  items: z
    .array(
      z.object({
        variant_id: str(60),
        name: str(200),
        size: str(40),
        qty: z.number().int(),
      }),
    )
    .max(50)
    .optional(),
  total_ngn: z.number().int().nonnegative().optional(),
  error_message: str(1000).optional(),
  response: z.record(z.unknown()).optional(),
});
export type CheckoutLogBody = z.infer<typeof checkoutLogSchema>;
