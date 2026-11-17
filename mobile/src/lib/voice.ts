/**
 * Phone calls through the Twilio Voice React Native SDK.
 *
 * Contract (apps/api/src/routes/voice.ts, mounted at /v1/inbox/voice):
 *   GET  /token?platform=ios|android → { data: { token, identity, ttl } }
 *        The token carries the Twilio push credential for this platform, so a
 *        registered phone rings even when the app is closed.
 *   POST /presence {available}       → heartbeat (fresh for 90s) while the app is open
 *   POST /calls/:ref/accepted        → ref = custom parameter `callId`; 409 = someone else answered
 *   Outbound: voice.connect(token, { params: { To, callerNumberId } })
 *
 * Ringing UI is native: CallKit on iOS, the SDK's ConnectionService /
 * full-screen notification on Android. This module keeps the live call at
 * module level (not in a component) so it survives navigation, and exposes a
 * small store for the screens.
 *
 * NEEDS A DEV BUILD: the SDK is native code and is not in Expo Go. In Expo Go
 * (or if the native module is missing) calls are reported as unavailable.
 */
import { AudioDevice, Call, CallInvite, Voice } from "@twilio/voice-react-native-sdk";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { ApiError, humanizeError } from "./api";
import { voiceApi } from "./inbox-api";
import { tokenRefreshDelayMs } from "./inbox-logic";
import { createStore, useStore } from "./store";

const AVAILABLE_KEY = "ms_calls_available";
const HEARTBEAT_MS = 30_000;

export type VoiceStatus = "off" | "starting" | "ready" | "unavailable" | "error";

export interface IncomingInfo {
  from: string;
  /** Inbox call id (custom parameter `callId`), or the CallSid as a fallback ref. */
  ref: string;
}

export interface ActiveInfo {
  direction: "in" | "out";
  who: string;
  state: "connecting" | "ringing" | "open" | "reconnecting";
  startedAt: number | null;
  muted: boolean;
  speaker: boolean;
}

interface VoiceState {
  status: VoiceStatus;
  message: string | null;
  available: boolean;
  canAnswer: boolean;
  canCall: boolean;
  incoming: IncomingInfo | null;
  active: ActiveInfo | null;
  /** One-off message for the person (e.g. "someone else answered"). */
  notice: string | null;
}

export const voiceStore = createStore<VoiceState>({
  status: "off",
  message: null,
  available: false,
  canAnswer: false,
  canCall: false,
  incoming: null,
  active: null,
  notice: null,
});
export function useVoice<S>(select: (s: VoiceState) => S): S {
  return useStore(voiceStore, select);
}

const set = voiceStore.set;
const get = voiceStore.get;

let voice: Voice | null = null;
let token: string | null = null;
let registered = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove(): void } | null = null;
let invite: CallInvite | null = null;
let activeCall: Call | null = null;

function platform(): "ios" | "android" | null {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
}

/** Create the SDK instance once. Returns null where the native module isn't present (Expo Go, web). */
function getVoice(): Voice | null {
  if (voice) return voice;
  if (!platform()) return null;
  try {
    voice = new Voice();
  } catch {
    return null;
  }
  voice.on(Voice.Event.CallInvite, onCallInvite);
  voice.on(Voice.Event.Error, (err) => {
    set({ message: err.message || "The phone line reported an error." });
  });
  voice.on(Voice.Event.Unregistered, () => {
    registered = false;
  });
  return voice;
}

/**
 * iOS: hand PushKit to the SDK as early as possible after launch, so a VoIP
 * push that woke the app is surfaced to CallKit. Call from the root layout.
 */
export function bootVoiceEarly(): void {
  if (Platform.OS !== "ios") return;
  const v = getVoice();
  v?.initializePushRegistry().catch(() => undefined);
}

async function readAvailable(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(AVAILABLE_KEY)) === "1";
  } catch {
    return false;
  }
}

async function fetchToken(): Promise<string> {
  const p = platform();
  if (!p) throw new Error("Calls only work on a phone.");
  const t = await voiceApi.token(p);
  token = t.token;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshToken(), tokenRefreshDelayMs(t.ttl));
  return t.token;
}

/** Before the token expires: get a new one and re-register so incoming calls keep arriving. */
async function refreshToken(): Promise<void> {
  try {
    const fresh = await fetchToken();
    if (registered && voice) await voice.register(fresh);
  } catch (err) {
    set({ message: humanizeError(err) });
    // Try again in a minute rather than silently going deaf.
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshToken(), 60_000);
  }
}

async function syncRegistration(): Promise<void> {
  const v = voice;
  if (!v || !token) return;
  const want = get().canAnswer && get().available;
  if (want && !registered) {
    await v.register(token);
    registered = true;
  } else if (!want && registered) {
    await v.unregister(token);
    registered = false;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  if (!get().canAnswer || !get().available) return;
  const beat = (): void => {
    voiceApi.presence(true).catch(() => undefined);
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function onAppState(s: AppStateStatus): void {
  // Heartbeat only while the app is open. When closed, the phone still rings
  // through Twilio push as long as presence says "available".
  if (s === "active") startHeartbeat();
  else stopHeartbeat();
}

/**
 * Start calling for the signed-in user. Safe to call more than once.
 * `canAnswer` = calls.answer, `canCall` = calls.outbound.
 */
export async function startVoice(caps: { canAnswer: boolean; canCall: boolean }): Promise<void> {
  set({ canAnswer: caps.canAnswer, canCall: caps.canCall });
  if (!caps.canAnswer && !caps.canCall) {
    set({ status: "off" });
    return;
  }
  const v = getVoice();
  if (!v) {
    set({ status: "unavailable", message: "Calls need the installed MS Staff app (not Expo Go)." });
    return;
  }
  set({ status: "starting", message: null, available: caps.canAnswer ? await readAvailable() : false });
  try {
    await fetchToken();
    await syncRegistration();
    if (!appStateSub) appStateSub = AppState.addEventListener("change", onAppState);
    if (AppState.currentState === "active") startHeartbeat();
    if (caps.canAnswer) await voiceApi.presence(get().available);
    await recoverExisting(v);
    set({ status: "ready" });
  } catch (err) {
    set({
      status: err instanceof ApiError && err.status === 503 ? "unavailable" : "error",
      message: humanizeError(err),
    });
  }
}

/** A call accepted from the lock screen before JS was running: pick it up. */
async function recoverExisting(v: Voice): Promise<void> {
  const calls = await v.getCalls();
  const first = calls.values().next();
  if (!first.done && !activeCall) attachCall(first.value, "in", first.value.getFrom() ?? "Customer");
  const invites = await v.getCallInvites();
  const firstInvite = invites.values().next();
  if (!firstInvite.done && !invite) onCallInvite(firstInvite.value);
}

/** Sign-out: stop ringing this phone and forget the token. */
export async function stopVoice(): Promise<void> {
  stopHeartbeat();
  appStateSub?.remove();
  appStateSub = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  try {
    if (get().canAnswer) await voiceApi.presence(false);
  } catch {
    /* best effort */
  }
  try {
    if (voice && token && registered) await voice.unregister(token);
  } catch {
    /* best effort */
  }
  registered = false;
  token = null;
  set({ status: "off", canAnswer: false, canCall: false, available: false, incoming: null, message: null });
}

/** The "Available for calls" switch in Settings. */
export async function setAvailable(available: boolean): Promise<void> {
  const prev = get().available;
  set({ available });
  try {
    await voiceApi.presence(available);
    await syncRegistration();
    await SecureStore.setItemAsync(AVAILABLE_KEY, available ? "1" : "0").catch(() => undefined);
    if (available && AppState.currentState === "active") startHeartbeat();
    if (!available) stopHeartbeat();
  } catch (err) {
    set({ available: prev, message: humanizeError(err) });
    throw err;
  }
}

// ── Incoming ─────────────────────────────────────────────────────────────────

function onCallInvite(ci: CallInvite): void {
  invite = ci;
  const params = ci.getCustomParameters();
  const ref = params.callId ?? ci.getCallSid();
  set({ incoming: { from: ci.getFrom() || "Customer", ref }, notice: null });

  // Fires for both in-app Accept and the native CallKit / notification Accept.
  ci.on(CallInvite.Event.Accepted, (call) => {
    invite = null;
    set({ incoming: null });
    attachCall(call, "in", ci.getFrom() || "Customer");
    voiceApi.accepted(ref).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        set({ notice: "Someone else already answered this call." });
        call.disconnect().catch(() => undefined);
      }
    });
  });
  const clear = (): void => {
    if (invite === ci) invite = null;
    set({ incoming: null });
  };
  ci.on(CallInvite.Event.Rejected, clear);
  ci.on(CallInvite.Event.Cancelled, clear);
}

/** In-app Accept button. Claims the call first so two people can't both pick up. */
export async function acceptIncoming(): Promise<void> {
  const ci = invite;
  const info = get().incoming;
  if (!ci || !info) return;
  try {
    await voiceApi.accepted(info.ref);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      set({ incoming: null, notice: "Someone else already answered this call." });
      invite = null;
      await ci.reject().catch(() => undefined);
      return;
    }
    // Any other failure: still answer, the customer is waiting.
  }
  await ci.accept();
}

export async function declineIncoming(): Promise<void> {
  const ci = invite;
  invite = null;
  set({ incoming: null });
  await ci?.reject().catch(() => undefined);
}

// ── Outbound ─────────────────────────────────────────────────────────────────

/** Click-to-call: `to` is the customer's number (E.164), `numberId` the business number to call from. */
export async function startCall(opts: { to: string; numberId: string; who: string }): Promise<void> {
  const v = getVoice();
  if (!v || !get().canCall) throw new Error("You can't make calls from this phone.");
  if (activeCall) throw new Error("You're already on a call.");
  const t = token ?? (await fetchToken());
  set({ active: { direction: "out", who: opts.who, state: "connecting", startedAt: null, muted: false, speaker: false } });
  try {
    const call = await v.connect(t, {
      params: { To: opts.to, callerNumberId: opts.numberId },
      contactHandle: opts.who,
    });
    attachCall(call, "out", opts.who);
  } catch (err) {
    set({ active: null });
    throw err;
  }
}

// ── The live call ────────────────────────────────────────────────────────────

function attachCall(call: Call, direction: "in" | "out", who: string): void {
  activeCall = call;
  const connected = call.getState() === Call.State.Connected;
  set({
    active: {
      direction,
      who,
      state: connected ? "open" : "connecting",
      startedAt: connected ? (call.getInitialConnectedTimestamp()?.getTime() ?? Date.now()) : null,
      muted: call.isMuted() ?? false,
      speaker: false,
    },
  });
  const patch = (p: Partial<ActiveInfo>): void => {
    const a = get().active;
    if (a && activeCall === call) set({ active: { ...a, ...p } });
  };
  call.on(Call.Event.Ringing, () => patch({ state: "ringing" }));
  call.on(Call.Event.Connected, () => patch({ state: "open", startedAt: Date.now() }));
  call.on(Call.Event.Reconnecting, () => patch({ state: "reconnecting" }));
  call.on(Call.Event.Reconnected, () => patch({ state: "open" }));
  const end = (message?: string): void => {
    if (activeCall !== call) return;
    activeCall = null;
    set({ active: null, ...(message ? { notice: message } : {}) });
  };
  call.on(Call.Event.Disconnected, () => end());
  call.on(Call.Event.ConnectFailure, (err) => end(err.message || "The call couldn't connect."));
}

export async function toggleMute(): Promise<void> {
  const a = get().active;
  if (!activeCall || !a) return;
  const muted = await activeCall.mute(!a.muted);
  set({ active: { ...a, muted } });
}

export async function toggleSpeaker(): Promise<void> {
  const v = voice;
  const a = get().active;
  if (!v || !a) return;
  const { audioDevices } = await v.getAudioDevices();
  const wantType = a.speaker ? AudioDevice.Type.Earpiece : AudioDevice.Type.Speaker;
  // Prefer Bluetooth over the earpiece when turning the speaker off, if connected.
  const target =
    (a.speaker ? audioDevices.find((d) => d.type === AudioDevice.Type.Bluetooth) : undefined) ??
    audioDevices.find((d) => d.type === wantType);
  if (!target) return;
  await target.select();
  set({ active: { ...a, speaker: !a.speaker } });
}

export async function hangUp(): Promise<void> {
  await activeCall?.disconnect();
}

export function clearNotice(): void {
  set({ notice: null });
}
