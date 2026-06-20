/**
 * Auto-dispatch was the legacy behavior: paying for an immediate in-Lagos order
 * emitted `delivery.request` and the worker booked a ride automatically. The
 * business now books rides manually from the admin order page, so this is OFF
 * by default. Flip AUTO_DISPATCH_DELIVERY=true to restore the old flow.
 */
export function autoDispatchEnabled(): boolean {
  return process.env["AUTO_DISPATCH_DELIVERY"] === "true";
}
