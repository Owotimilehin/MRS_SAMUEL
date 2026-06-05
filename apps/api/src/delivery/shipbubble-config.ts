// Shipbubble config now lives in @ms/domain so the API and worker share it.
// Re-exported here to keep the delivery module's import paths stable.
export {
  shipbubbleConfigFromEnv,
  lagosPickupDate,
  type ShipbubbleConfig,
} from "@ms/domain";
