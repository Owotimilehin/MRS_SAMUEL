import * as SecureStore from "expo-secure-store";
import { uuid } from "./uuid";

/**
 * A stable id for this install, sent as `x-device-id` on login and refresh so
 * the server's session row (and audit log) can tell this phone apart from the
 * admin web app. Stored in the keychain/keystore, so it survives app updates.
 */
const KEY = "ms_device_id";
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id: string | null = null;
  try {
    id = await SecureStore.getItemAsync(KEY);
  } catch {
    /* keystore unavailable: fall through to a fresh id */
  }
  if (!id) {
    id = uuid();
    try {
      await SecureStore.setItemAsync(KEY, id);
    } catch {
      /* not fatal: the id just won't be remembered */
    }
  }
  cached = id;
  return id;
}
