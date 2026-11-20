/**
 * A person's own sound: an MP3 or WAV file they upload, one for messages and
 * one for calls.
 *
 * Kept in this browser only (IndexedDB), never sent to the server. Every
 * storage call is wrapped: if the browser refuses (private mode, storage
 * full, very old browser), the caller gets null and plays the default tone.
 */
import type { SoundKind } from "./prefs.js";

export const MAX_BYTES = 1024 * 1024; // 1 MB
export const MAX_SECONDS = 30;

const ACCEPTED_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg-3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
]);

/** For the file picker. */
export const ACCEPT_ATTR = ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav";

export interface CustomSound {
  name: string;
  type: string;
  /** Seconds. */
  duration: number;
  data: ArrayBuffer;
}

export type CheckResult = { ok: true } | { ok: false; error: string };

/** Type and size, checked before reading the file. */
export function checkFileBasics(file: { name: string; type: string; size: number }): CheckResult {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const typeOk = ACCEPTED_TYPES.has(file.type.toLowerCase());
  // Some systems send no type at all; then go by the file name.
  const extOk = ext === "mp3" || ext === "wav";
  if (!(typeOk || (file.type === "" && extOk))) {
    return { ok: false, error: "That file isn't an MP3 or WAV sound. Choose an MP3 or WAV file." };
  }
  if (file.size === 0) return { ok: false, error: "That file is empty. Choose another one." };
  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `That file is ${mb} MB. The limit is 1 MB. Try a shorter clip.` };
  }
  return { ok: true };
}

/** Length, checked after the browser has decoded the sound. */
export function checkDuration(seconds: number): CheckResult {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, error: "We couldn't play that file. It may be damaged. Try another one." };
  }
  // A little leeway for encoders that pad the end.
  if (seconds > MAX_SECONDS + 0.05) {
    return {
      ok: false,
      error: `That sound is ${Math.round(seconds)} seconds long. The limit is ${MAX_SECONDS} seconds. Try a shorter clip.`,
    };
  }
  return { ok: true };
}

/**
 * Check a chosen file fully: type, size, then that it really decodes as
 * audio and is short enough. `decode` is the browser's decodeAudioData (passed
 * in so this can be tested without a browser).
 */
export async function validateAudioFile(
  file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  decode: (data: ArrayBuffer) => Promise<{ duration: number }>,
): Promise<{ ok: true; sound: CustomSound } | { ok: false; error: string }> {
  const basics = checkFileBasics(file);
  if (!basics.ok) return basics;
  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch {
    return { ok: false, error: "We couldn't read that file. Try again, or choose another one." };
  }
  let duration: number;
  try {
    // decodeAudioData may take ownership of the buffer it is given: decode a copy.
    duration = (await decode(data.slice(0))).duration;
  } catch {
    return { ok: false, error: "We couldn't play that file. It may be damaged or not really an MP3 or WAV. Try another one." };
  }
  const len = checkDuration(duration);
  if (!len.ok) return len;
  return { ok: true, sound: { name: file.name, type: file.type || "audio/mpeg", duration, data } };
}

// ── Storage (IndexedDB) ──────────────────────────────────────────────────────

const DB_NAME = "ms_sounds";
const STORE = "custom";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE);
        } catch {
          /* already there */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = op(tx.objectStore(STORE));
          let result: T | null = null;
          req.onsuccess = () => {
            result = (req.result as T | undefined) ?? null;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(mode === "readonly" ? result : (true as T));
          };
          tx.onerror = () => {
            db.close();
            resolve(null);
          };
          tx.onabort = () => {
            db.close();
            resolve(null);
          };
        } catch {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          resolve(null);
        }
      }),
  );
}

function isCustomSound(v: unknown): v is CustomSound {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<CustomSound>;
  return typeof s.name === "string" && typeof s.duration === "number" && s.data instanceof ArrayBuffer;
}

/** The person's own sound for this kind, or null (none saved, or storage unavailable). */
export async function loadCustomSound(kind: SoundKind): Promise<CustomSound | null> {
  try {
    const v = await run<unknown>("readonly", (s) => s.get(kind));
    return isCustomSound(v) ? v : null;
  } catch {
    return null;
  }
}

/** Save it. Returns false if this browser would not store it. */
export async function saveCustomSound(kind: SoundKind, sound: CustomSound): Promise<boolean> {
  try {
    return (await run<boolean>("readwrite", (s) => s.put(sound, kind))) === true;
  } catch {
    return false;
  }
}

export async function removeCustomSound(kind: SoundKind): Promise<boolean> {
  try {
    return (await run<boolean>("readwrite", (s) => s.delete(kind))) === true;
  } catch {
    return false;
  }
}
