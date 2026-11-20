/**
 * Which sound each person chose, for this device only (kept in localStorage).
 *
 * Two separate choices: the sound for a new message, and the ring for an
 * incoming call. Each is a built-in tone, the person's own uploaded file
 * ("custom"), or — for calls only — the phone system's standard ring.
 * Nothing stored, or something unreadable, means the defaults: the same
 * sounds everyone heard before choices existed.
 */
import { DEFAULT_TONE_ID, findTone } from "./tones.js";

export type SoundKind = "message" | "call";

/** The phone system's own ring (Twilio's). The default for calls. */
export const STANDARD_RING = "standard";
/** The person's own uploaded file for this kind. */
export const CUSTOM_TONE = "custom";

export interface SoundChoice {
  /** A tone id from TONES, CUSTOM_TONE, or (calls only) STANDARD_RING. */
  tone: string;
  /** 0–100. */
  volume: number;
}

export type SoundPrefs = Record<SoundKind, SoundChoice>;

export const DEFAULT_PREFS: SoundPrefs = {
  message: { tone: DEFAULT_TONE_ID, volume: 100 },
  call: { tone: STANDARD_RING, volume: 100 },
};

const LS_KEY = "ms_sound_prefs";
/** Fired on window when the choices change in this tab. */
export const PREFS_EVENT = "ms-sound-prefs";

function validTone(kind: SoundKind, tone: unknown): tone is string {
  if (typeof tone !== "string") return false;
  if (tone === CUSTOM_TONE) return true;
  if (tone === STANDARD_RING) return kind === "call";
  return findTone(tone) !== undefined;
}

function cleanChoice(kind: SoundKind, raw: unknown): SoundChoice {
  const def = DEFAULT_PREFS[kind];
  if (!raw || typeof raw !== "object") return { ...def };
  const r = raw as { tone?: unknown; volume?: unknown };
  const volume =
    typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.round(Math.min(100, Math.max(0, r.volume))) : def.volume;
  return { tone: validTone(kind, r.tone) ? r.tone : def.tone, volume };
}

/** Turn whatever was stored into safe choices. Never throws. */
export function parsePrefs(stored: string | null): SoundPrefs {
  if (!stored) return { message: { ...DEFAULT_PREFS.message }, call: { ...DEFAULT_PREFS.call } };
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    raw = null;
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { message: cleanChoice("message", obj.message), call: cleanChoice("call", obj.call) };
}

/** Kept when storage refuses to save, so the choice still works on this page. */
let memory: SoundPrefs | null = null;

/** Where choices are kept. Swappable in tests. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(storage: PrefsStorage | null = defaultStorage()): SoundPrefs {
  try {
    return parsePrefs(storage?.getItem(LS_KEY) ?? null);
  } catch {
    return parsePrefs(null);
  }
}

/** Save one kind's choice. Returns the full, cleaned choices now in force. */
export function saveChoice(
  kind: SoundKind,
  choice: SoundChoice,
  storage: PrefsStorage | null = defaultStorage(),
): SoundPrefs {
  const next = { ...(memory ?? loadPrefs(storage)), [kind]: cleanChoice(kind, choice) };
  try {
    if (!storage) throw new Error("no storage");
    storage.setItem(LS_KEY, JSON.stringify(next));
    memory = null;
  } catch {
    /* private mode or full: the choice lasts for this page only */
    memory = next;
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next }));
    } catch {
      /* very old browser: listeners just re-read later */
    }
  }
  return next;
}

/** The choices in force right now (stored, or held in memory if storage failed). */
export function currentPrefs(): SoundPrefs {
  return memory ?? loadPrefs();
}

/** Run `fn` whenever the choices change in this tab or another tab. Returns a stop function. */
export function onPrefsChange(fn: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key === LS_KEY) fn();
  };
  window.addEventListener(PREFS_EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}
