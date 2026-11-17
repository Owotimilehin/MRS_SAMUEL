/**
 * Browser phone for the unified inbox (Twilio Voice SDK).
 *
 * The SDK is ~400 KB, so it is only imported (dynamically) for people with
 * calls.answer or calls.outbound. The Device and any live call live at module
 * level, NOT in a component: every page renders its own <Shell>, and a call
 * must survive moving between pages.
 *
 * Contract (apps/api/src/routes/voice.ts, mounted at /v1/inbox/voice):
 *   GET  /token                 → { data: { token, identity, ttl } }
 *   POST /presence {available}  → heartbeat every 30s while available
 *   POST /calls/:ref/accepted   → ref = customParameters.callId (fallback CallSid);
 *                                  409 = someone else answered first
 *   Outbound: device.connect({ params: { To, callerNumberId } })
 */
import { create } from "zustand";
import type { Call, Device } from "@twilio/voice-sdk";
import { api, ApiError, humanizeError } from "./api.js";
import { toast } from "./toast.js";

const HEARTBEAT_MS = 30_000;
const AVAILABLE_KEY = "ms_inbox_available";

export type VoiceStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

export interface IncomingInfo {
  from: string;
  ref: string;
}

export interface ActiveInfo {
  direction: "in" | "out";
  who: string;
  /** Business number id the call is on, when known (outbound). */
  numberId?: string;
  state: "connecting" | "ringing" | "open";
  startedAt: number | null;
  muted: boolean;
}

interface VoiceState {
  status: VoiceStatus;
  message: string | null;
  available: boolean;
  canAnswer: boolean;
  canCall: boolean;
  incoming: IncomingInfo | null;
  active: ActiveInfo | null;
}

function readAvailable(): boolean {
  try {
    return localStorage.getItem(AVAILABLE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeAvailable(v: boolean): void {
  try {
    localStorage.setItem(AVAILABLE_KEY, v ? "1" : "0");
  } catch {
    /* private mode — fine, it just won't be remembered */
  }
}

export const useVoice = create<VoiceState>(() => ({
  status: "idle",
  message: null,
  available: readAvailable(),
  canAnswer: false,
  canCall: false,
  incoming: null,
  active: null,
}));

const set = useVoice.setState;
const get = useVoice.getState;

let device: Device | null = null;
let codecs: Call.Codec[] = [];
let initPromise: Promise<void> | null = null;
let incomingCall: Call | null = null;
let activeCall: Call | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

async function fetchToken(): Promise<string> {
  const res = await api<{ data: { token: string; identity: string; ttl: number } }>("/inbox/voice/token");
  return res.data.token;
}

function beat(available: boolean): void {
  void api("/inbox/voice/presence", { method: "POST", body: JSON.stringify({ available }) }, { silentError: true }).catch(
    () => undefined,
  );
}

function startHeartbeat(): void {
  if (heartbeat) return;
  beat(true);
  heartbeat = setInterval(() => beat(true), HEARTBEAT_MS);
}
function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** Load the SDK and create the Device once per tab. Safe to call repeatedly. */
export function initVoice(opts: { canAnswer: boolean; canCall: boolean }): Promise<void> {
  set({ canAnswer: opts.canAnswer, canCall: opts.canCall });
  if (!opts.canAnswer && !opts.canCall) return Promise.resolve();
  if (initPromise) return initPromise;
  set({ status: "loading", message: null });
  initPromise = (async () => {
    try {
      const sdk = await import("@twilio/voice-sdk");
      codecs = [sdk.Call.Codec.Opus, sdk.Call.Codec.PCMU];
      const token = await fetchToken();
      const d = new sdk.Device(token, {
        codecPreferences: codecs,
        closeProtection: "You are on a call. Leaving this page will hang up.",
        tokenRefreshMs: 60_000,
      });
      d.on("tokenWillExpire", () => {
        void fetchToken()
          .then((t) => d.updateToken(t))
          .catch(() => set({ message: "Couldn't renew the phone connection. Refresh the page if calls stop." }));
      });
      d.on("error", (err: { message?: string; code?: number }) => {
        // 31205/20104 = expired token; the refresh above normally prevents it.
        set({ message: err?.message ? `Phone problem: ${err.message}` : "Phone problem — try refreshing the page." });
      });
      d.on("incoming", onIncoming);
      device = d;
      set({ status: "ready" });
      if (opts.canAnswer && get().available) await goAvailable();
    } catch (err) {
      initPromise = null;
      if (err instanceof ApiError && (err.status === 503 || err.code === "service_unavailable")) {
        set({ status: "unavailable", message: "Phone calls aren't set up on this system yet." });
      } else {
        set({ status: "error", message: humanizeError(err) });
      }
    }
  })();
  return initPromise;
}

async function goAvailable(): Promise<void> {
  if (!device) return;
  try {
    if (device.state !== "registered") await device.register();
    startHeartbeat();
  } catch (err) {
    set({ message: `Couldn't switch on incoming calls: ${humanizeError(err)}` });
  }
}

export async function setAvailable(available: boolean): Promise<void> {
  writeAvailable(available);
  set({ available });
  if (!get().canAnswer) return;
  if (available) {
    if (!device) await initVoice({ canAnswer: get().canAnswer, canCall: get().canCall });
    await goAvailable();
  } else {
    stopHeartbeat();
    beat(false);
    if (device && device.state === "registered") await device.unregister().catch(() => undefined);
  }
}

// ── Incoming ────────────────────────────────────────────────────────────────

function onIncoming(call: Call): void {
  if (activeCall || incomingCall) {
    // Already busy: let another colleague take it.
    call.reject();
    return;
  }
  incomingCall = call;
  const ref = call.customParameters.get("callId") || call.parameters.CallSid || "";
  set({ incoming: { from: call.parameters.From ?? "Unknown caller", ref } });
  const clear = (): void => {
    if (incomingCall === call) {
      incomingCall = null;
      set({ incoming: null });
    }
  };
  call.on("cancel", clear);
  call.on("reject", clear);
  call.on("disconnect", clear);
  call.on("error", clear);
}

export async function acceptIncoming(): Promise<void> {
  const call = incomingCall;
  const info = get().incoming;
  if (!call || !info) return;
  incomingCall = null;
  set({ incoming: null });
  call.accept();
  trackActive(call, { direction: "in", who: info.from, state: "connecting", startedAt: null, muted: false });
  if (!info.ref) return;
  try {
    await api(`/inbox/voice/calls/${encodeURIComponent(info.ref)}/accepted`, { method: "POST" }, { silentError: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Someone else answered first — quietly drop our leg.
      call.disconnect();
      return;
    }
    toast.info("Call connected, but we couldn't record who answered it.");
  }
}

export function declineIncoming(): void {
  const call = incomingCall;
  incomingCall = null;
  set({ incoming: null });
  call?.reject();
}

// ── Outbound ────────────────────────────────────────────────────────────────

export async function startCall(opts: { to: string; numberId: string; who: string }): Promise<void> {
  if (activeCall) {
    toast.error("You're already on a call. Hang up first.");
    return;
  }
  if (!device) await initVoice({ canAnswer: get().canAnswer, canCall: true });
  if (!device) {
    toast.error(get().message ?? "The phone isn't ready yet. Try again in a moment.");
    return;
  }
  try {
    const call = await device.connect({ params: { To: opts.to, callerNumberId: opts.numberId } });
    trackActive(call, { direction: "out", who: opts.who, numberId: opts.numberId, state: "connecting", startedAt: null, muted: false });
    call.on("ringing", () => patchActive(call, { state: "ringing" }));
  } catch (err) {
    toast.error(`Couldn't start the call: ${humanizeError(err)}`);
  }
}

// ── In-call ─────────────────────────────────────────────────────────────────

function patchActive(call: Call, patch: Partial<ActiveInfo>): void {
  if (activeCall !== call) return;
  const cur = get().active;
  if (cur) set({ active: { ...cur, ...patch } });
}

function trackActive(call: Call, info: ActiveInfo): void {
  activeCall = call;
  set({ active: info });
  call.on("accept", () => patchActive(call, { state: "open", startedAt: Date.now() }));
  call.on("mute", (muted: boolean) => patchActive(call, { muted }));
  const end = (): void => {
    if (activeCall === call) {
      activeCall = null;
      set({ active: null });
    }
  };
  call.on("disconnect", end);
  call.on("cancel", end);
  call.on("reject", end);
  call.on("error", (e: { message?: string }) => {
    if (e?.message) toast.error(`Call problem: ${e.message}`);
  });
}

export function hangUp(): void {
  activeCall?.disconnect();
}

export function toggleMute(): void {
  if (!activeCall) return;
  activeCall.mute(!activeCall.isMuted());
}

export function sendDigits(digits: string): void {
  activeCall?.sendDigits(digits);
}
