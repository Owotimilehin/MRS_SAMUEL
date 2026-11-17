import Constants from "expo-constants";

/** API origin from app.config.ts `extra.apiBaseUrl` (env EXPO_PUBLIC_API_BASE_URL). */
function readApiBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: unknown } | undefined;
  const raw = typeof extra?.apiBaseUrl === "string" && extra.apiBaseUrl ? extra.apiBaseUrl : "https://api.mrssamuel.com";
  return raw.replace(/\/+$/, "");
}

export const API_BASE_URL = readApiBaseUrl();
/** Every route lives under /v1. */
export const API_ROOT = `${API_BASE_URL}/v1`;

/** Expo project id, needed to mint an Expo push token. */
export function easProjectId(): string | undefined {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return fromExtra ?? Constants.easConfig?.projectId ?? undefined;
}

/** How often lists and open conversations refresh while the app is in front. */
export const POLL_MS = 10_000;
