import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Mrs Samuel Staff: the staff phone app for the unified inbox.
 *
 * Everything that varies per build comes from environment variables (set them
 * in EAS for cloud builds, or in your shell for local `expo run:*`). None of
 * these are secrets; real secrets (APNs key, FCM service account) live in EAS
 * credentials, never here.
 *
 *   EXPO_PUBLIC_API_BASE_URL  API origin, no trailing slash. Default below. CONFIRM before release.
 *   EAS_PROJECT_ID            Expo project id (needed for Expo push tokens).
 *   APP_VARIANT               "development" | "production" (default production).
 *   GOOGLE_SERVICES_JSON      Path to google-services.json (EAS file env var). Default ./google-services.json.
 *   GOOGLE_SERVICE_INFO_PLIST Path to GoogleService-Info.plist (optional on iOS).
 */
const DEFAULT_API_BASE_URL = "https://api.mrssamuel.com";

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = process.env.APP_VARIANT === "development" ? "development" : "production";
  const isDev = variant === "development";
  // Placeholder bundle ids: confirm with the owner before creating store listings.
  const bundleId = isDev ? "com.mrssamuel.staff.dev" : "com.mrssamuel.staff";
  const projectId = process.env.EAS_PROJECT_ID;

  return {
    ...config,
    name: isDev ? "MS Staff (dev)" : "MS Staff",
    slug: "mrs-samuel-staff",
    scheme: "msstaff",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: false,
      ...(process.env.GOOGLE_SERVICE_INFO_PLIST ? { googleServicesFile: process.env.GOOGLE_SERVICE_INFO_PLIST } : {}),
      // VoIP pushes (incoming calls) must use the production APNs environment in
      // TestFlight / App Store builds, or calls silently never arrive.
      entitlements: { "aps-environment": isDev ? "development" : "production" },
      infoPlist: {
        NSMicrophoneUsageDescription: "MS Staff uses the microphone so you can talk to customers on calls.",
        NSPhotoLibraryUsageDescription: "MS Staff lets you send photos to customers on WhatsApp.",
        NSCameraUsageDescription: "MS Staff lets you take a photo to send to a customer on WhatsApp.",
        UIBackgroundModes: ["audio", "voip", "remote-notification"],
      },
    },
    android: {
      package: bundleId,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
      permissions: [
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.BLUETOOTH_CONNECT",
      ],
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-audio",
      [
        "expo-notifications",
        {
          // Must match the channelId the worker sends ("messages").
          defaultChannel: "messages",
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission: "MS Staff lets you send photos to customers on WhatsApp.",
          cameraPermission: "MS Staff lets you take a photo to send to a customer on WhatsApp.",
        },
      ],
      [
        "@twilio/voice-react-native-sdk",
        { apsEnvironment: isDev ? "development" : "production" },
      ],
      ["expo-build-properties", { android: { minSdkVersion: 24 } }],
      // Must come after the Twilio plugin: routes FCM to Twilio (calls) or Expo (messages).
      "./plugins/withFcmRouter",
    ],
    extra: {
      apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
      variant,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
