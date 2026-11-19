/**
 * Sound and desktop alerts for new customer messages.
 *
 * Framework-free so the hook stays small. Two per-device choices live in
 * localStorage (sound, desktop pop-ups); *which* chats alert is the per-user
 * level saved on the server, shared with the phone app.
 *
 * Browsers only let a page play sound after the person has clicked or typed on
 * it once, and only show desktop pop-ups after they have said yes. Both are
 * handled here: the sound is "unlocked" on the first click, and pop-ups are
 * asked for from the settings dialog (a button press), never on page load.
 */

const LS_SOUND = "ms_inbox_sound";
const LS_DESKTOP = "ms_inbox_desktop";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export const soundEnabled = (): boolean => readFlag(LS_SOUND, true);
export const setSoundEnabled = (on: boolean): void => writeFlag(LS_SOUND, on);
/** The person's own switch. A pop-up also needs the browser's permission. */
export const desktopEnabled = (): boolean => readFlag(LS_DESKTOP, true);
export const setDesktopEnabled = (on: boolean): void => writeFlag(LS_DESKTOP, on);

// ── Sound ────────────────────────────────────────────────────────────────────

let audio: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    audio = null;
  }
  return audio;
}

/**
 * Call once at start-up. The first click or key press anywhere wakes the audio
 * engine, so a later alert can be heard even when the tab is in the background.
 */
export function unlockSoundOnFirstGesture(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = (): void => {
    const ctx = audioContext();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    off();
  };
  const off = (): void => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return off;
}

/** Can the sound be heard right now? False until the person has clicked once. */
export function soundReady(): boolean {
  return audioContext()?.state === "running";
}

/**
 * Two rising notes, about half a second. Made in the browser, so there is no
 * sound file to load. Different from the single falling note of a new online
 * order, so staff can tell them apart by ear.
 */
export function playMessageSound(): boolean {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  try {
    const now = ctx.currentTime;
    for (const [freq, at] of [
      [660, 0],
      [880, 0.16],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + at);
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.3, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.32);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Desktop pop-ups ──────────────────────────────────────────────────────────

export type DesktopState = "unsupported" | "ask" | "on" | "blocked";

/** Where the browser stands on pop-ups for this site. */
export function desktopState(): DesktopState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "on";
  if (Notification.permission === "denied") return "blocked";
  return "ask";
}

/** Ask the browser. Must be called from a button press. */
export async function askForDesktop(): Promise<DesktopState> {
  if (desktopState() === "unsupported") return "unsupported";
  try {
    await Notification.requestPermission();
  } catch {
    /* older Safari: the answer still lands in Notification.permission */
  }
  return desktopState();
}

export interface MessageAlert {
  conversationId: string;
  title: string;
  body: string;
}

/**
 * Show a desktop pop-up. One per conversation: a second message replaces the
 * first instead of stacking. Clicking it brings the tab forward and opens the chat.
 */
export function showDesktopAlert(a: MessageAlert, onOpen: (conversationId: string) => void): boolean {
  if (desktopState() !== "on") return false;
  try {
    const n = new Notification(a.title, {
      body: a.body,
      tag: `inbox-${a.conversationId}`,
      icon: "/brand-logo.png",
    });
    n.onclick = () => {
      window.focus();
      onOpen(a.conversationId);
      n.close();
    };
    return true;
  } catch {
    // Android Chrome only allows pop-ups from a service worker; the sound and
    // the on-screen banner still tell staff.
    return false;
  }
}
