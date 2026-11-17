/**
 * Message push notifications (WhatsApp), sent by the worker through Expo's
 * push service (apps/worker/src/jobs/inbox-push.ts): channelId "messages",
 * data { conversationId }.
 *
 * Incoming CALLS do not use this: they arrive through Twilio's own VoIP push
 * (PushKit on iOS, FCM on Android) handled by the Twilio Voice SDK (voice.ts).
 */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { easProjectId } from "./config";
import { inboxApi } from "./inbox-api";

const TOKEN_KEY = "ms_expo_push_token";
export const ANDROID_CHANNEL_ID = "messages";

// Show message pushes as banners even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function devicePlatform(): "ios" | "android" | null {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: "Messages",
    description: "New WhatsApp messages from customers",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
  });
}

export type PushRegistration = { ok: true; token: string } | { ok: false; reason: string };

/**
 * Ask for permission, get this phone's Expo push token and tell the API
 * (POST /v1/inbox/devices). Safe to call on every launch: the API upserts by
 * token and bumps last_seen_at, which also keeps this phone ringing for calls
 * when the app is closed (the API treats a phone as reachable for 12 hours
 * after its last check-in).
 */
export async function registerForPush(): Promise<PushRegistration> {
  const platform = devicePlatform();
  if (!platform) return { ok: false, reason: "Push notifications only work on a phone." };
  if (!Device.isDevice) return { ok: false, reason: "Push notifications need a real phone, not a simulator." };
  await ensureAndroidChannel();

  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: "Notifications are turned off for MS Staff in your phone's settings." };

  const projectId = easProjectId();
  if (!projectId) return { ok: false, reason: "This build has no EAS project id, so it can't get a push token." };
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

  await inboxApi.registerDevice(token, platform);
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {
    /* not fatal: sign-out falls back to asking Expo for the token again */
  }
  return { ok: true, token };
}

/** Sign-out: remove this phone's token so the next person's messages don't arrive here. */
export async function unregisterPush(): Promise<void> {
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    /* fall through */
  }
  if (!token) {
    const projectId = easProjectId();
    if (projectId && Device.isDevice) {
      try {
        token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      } catch {
        token = null;
      }
    }
  }
  if (!token) return;
  await inboxApi.unregisterDevice(token);
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
