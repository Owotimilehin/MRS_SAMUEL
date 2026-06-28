// Re-export the canonical delivery-schedule helpers from the shared package.
// The old local window/scheduledIso/WINDOWS definitions are removed — use this
// single source of truth everywhere in the customer app.
export {
  orderSchedule,
  scheduledIso,
  WINDOWS,
  availableWindows,
} from "@ms/shared";
export type { DeliveryWindow } from "@ms/shared";
