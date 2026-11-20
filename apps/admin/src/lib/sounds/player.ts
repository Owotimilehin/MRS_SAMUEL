/**
 * Plays the sounds people chose: a new-message alert, a looping ring for an
 * incoming call, and previews in the settings.
 *
 * One shared audio engine (AudioContext) for the whole tab. Browsers keep it
 * silent until the person has clicked or typed on the page once; see
 * unlockSoundOnFirstGesture in inbox-notify.ts.
 *
 * Anything that goes wrong (no Web Audio, the uploaded file is missing or
 * unreadable) falls back to a built-in tone, never to silence-with-an-error.
 */
import { loadCustomSound } from "./custom.js";
import { CUSTOM_TONE, currentPrefs, STANDARD_RING, type SoundChoice, type SoundKind } from "./prefs.js";
import { DEFAULT_TONE_ID, findTone, scheduleTone, toneOrDefault, type Tone } from "./tones.js";

/** The tone used when a call ring cannot use the chosen sound. */
const FALLBACK_RING_ID = "classic-ring";
/** Stop ringing on our own after this long, in case the call's end is never heard. */
const RING_SAFETY_MS = 90_000;
/** The phone system's standard ring (as loaded by the Twilio Voice SDK 2.x). */
const STANDARD_RING_URL = "https://sdk.twilio.com/js/client/sounds/releases/1.0.0/incoming.mp3";

let audio: AudioContext | null = null;

/** The tab's shared audio engine, created on first use. Null if the browser has none. */
export function audioContext(): AudioContext | null {
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

function wake(ctx: AudioContext): void {
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

// ── Uploaded sounds, decoded once ────────────────────────────────────────────

const decoded = new Map<SoundKind, Promise<AudioBuffer | null>>();

/** Forget the decoded copy of a person's own sound (after they change or remove it). */
export function forgetCustomSound(kind: SoundKind): void {
  decoded.delete(kind);
}

function customBuffer(ctx: AudioContext, kind: SoundKind): Promise<AudioBuffer | null> {
  let p = decoded.get(kind);
  if (!p) {
    p = loadCustomSound(kind)
      .then((s) => (s ? decodeAudio(ctx, s.data.slice(0)) : null))
      .catch(() => null);
    decoded.set(kind, p);
    // A failure is not remembered: the next alert tries again.
    void p.then((b) => {
      if (!b) decoded.delete(kind);
    });
  }
  return p;
}

/** decodeAudioData, in both its promise and older callback forms. */
export function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === "function") p.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Playing once ─────────────────────────────────────────────────────────────

/** A little mixer channel per sound, so a preview can be cut off. */
function bus(ctx: AudioContext, gain = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = gain;
  g.connect(ctx.destination);
  return g;
}

function playTone(ctx: AudioContext, tone: Tone, volume: number, out: AudioNode): void {
  scheduleTone(ctx, out, tone, ctx.currentTime + 0.01, volume);
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer, volume: number, out: AudioNode, loop = false): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  const g = ctx.createGain();
  g.gain.value = Math.min(1, Math.max(0, volume));
  src.connect(g);
  g.connect(out);
  src.start();
  return src;
}

/** Play a choice once on `out`. Uploaded sounds that fail fall back to `fallbackId`. */
function playChoice(ctx: AudioContext, kind: SoundKind, choice: SoundChoice, out: AudioNode, fallbackId: string): void {
  const volume = choice.volume / 100;
  if (choice.tone === CUSTOM_TONE) {
    void customBuffer(ctx, kind).then((buf) => {
      try {
        if (buf) playBuffer(ctx, buf, volume, out);
        else playTone(ctx, toneOrDefault(fallbackId), volume, out);
      } catch {
        /* nothing more we can do */
      }
    });
    return;
  }
  const tone = findTone(choice.tone) ?? toneOrDefault(fallbackId);
  playTone(ctx, tone, volume, out);
}

/**
 * The new-message alert, with this person's chosen sound and volume.
 * Returns false when this browser cannot play sound at all.
 */
export function playMessageAlert(): boolean {
  const ctx = audioContext();
  if (!ctx) return false;
  wake(ctx);
  try {
    playChoice(ctx, "message", currentPrefs().message, ctx.destination, DEFAULT_TONE_ID);
    return true;
  } catch {
    return false;
  }
}

// ── Previews (settings) ──────────────────────────────────────────────────────

let previewStop: (() => void) | null = null;

export function stopPreview(): void {
  const stop = previewStop;
  previewStop = null;
  try {
    stop?.();
  } catch {
    /* already stopped */
  }
}

/**
 * Let the person hear a choice before (or after) saving it. Calls ring twice.
 * Only one preview plays at a time. Must follow a click (browsers' sound rule).
 */
export function previewSound(kind: SoundKind, choice: SoundChoice): void {
  stopPreview();
  if (choice.tone === STANDARD_RING) {
    try {
      const el = new Audio(STANDARD_RING_URL);
      el.volume = Math.min(1, Math.max(0, choice.volume / 100));
      void el.play().catch(() => undefined);
      const t = setTimeout(() => el.pause(), 6000);
      previewStop = () => {
        clearTimeout(t);
        el.pause();
      };
    } catch {
      /* no audio element support */
    }
    return;
  }
  const ctx = audioContext();
  if (!ctx) return;
  wake(ctx);
  const out = bus(ctx);
  const fallback = kind === "call" ? FALLBACK_RING_ID : DEFAULT_TONE_ID;
  try {
    playChoice(ctx, kind, choice, out, fallback);
  } catch {
    /* ignore */
  }
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (kind === "call" && choice.tone !== CUSTOM_TONE) {
    const tone = findTone(choice.tone) ?? toneOrDefault(fallback);
    timers.push(
      setTimeout(() => {
        try {
          playChoice(ctx, kind, choice, out, fallback);
        } catch {
          /* ignore */
        }
      }, tone.ringEvery * 1000),
    );
  }
  // A long uploaded sound is cut off after a while; the person can press Stop sooner.
  timers.push(setTimeout(stopPreview, 12_000));
  previewStop = () => {
    timers.forEach(clearTimeout);
    try {
      out.disconnect();
    } catch {
      /* ignore */
    }
  };
}

// ── Ringing for an incoming call ─────────────────────────────────────────────

/** Should the phone system play its own standard ring (i.e. we play nothing)? */
export function usesStandardRing(): boolean {
  return currentPrefs().call.tone === STANDARD_RING;
}

let ringToken = 0;
let ringStop: (() => void) | null = null;

/** Render a built-in tone, with its pause, into a buffer that can loop seamlessly. */
async function renderRing(ctx: AudioContext, tone: Tone, volume: number): Promise<AudioBuffer | null> {
  const Offline =
    typeof window === "undefined"
      ? undefined
      : (window.OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext);
  if (!Offline) return null;
  try {
    const rate = ctx.sampleRate || 44_100;
    const off = new Offline(1, Math.ceil(tone.ringEvery * rate), rate);
    scheduleTone(off, off.destination, tone, 0, volume);
    return await off.startRendering();
  } catch {
    return null;
  }
}

/**
 * Start ringing with the chosen call sound, looping until stopRinging().
 * Does nothing when the person kept the standard ring (the phone system
 * plays that itself). Safe to call twice.
 */
export function startRinging(): void {
  stopRinging();
  const choice = currentPrefs().call;
  if (choice.tone === STANDARD_RING) return;
  const ctx = audioContext();
  if (!ctx) return;
  wake(ctx);
  const token = ++ringToken;
  const volume = choice.volume / 100;
  const out = bus(ctx);
  let interval: ReturnType<typeof setInterval> | null = null;
  const safety = setTimeout(stopRinging, RING_SAFETY_MS);
  ringStop = () => {
    clearTimeout(safety);
    if (interval) clearInterval(interval);
    try {
      out.disconnect();
    } catch {
      /* ignore */
    }
  };

  void (async () => {
    let tone = findTone(choice.tone) ?? toneOrDefault(FALLBACK_RING_ID);
    if (choice.tone === CUSTOM_TONE) {
      const own = await customBuffer(ctx, "call");
      if (token !== ringToken) return; // stopped while we were getting ready
      if (own) {
        try {
          playBuffer(ctx, own, volume, out, true);
          return;
        } catch {
          /* fall back to the built-in ring below */
        }
      }
      tone = toneOrDefault(FALLBACK_RING_ID);
    }
    const buffer = await renderRing(ctx, tone, volume);
    if (token !== ringToken) return; // stopped while we were getting ready
    try {
      if (buffer) {
        playBuffer(ctx, buffer, 1, out, true);
        return;
      }
    } catch {
      /* fall back to timed repeats */
    }
    const once = (): void => {
      try {
        playTone(ctx, tone, volume, out);
      } catch {
        /* ignore */
      }
    };
    once();
    interval = setInterval(once, tone.ringEvery * 1000);
  })();
}

/** Stop the ring (call answered, declined, cancelled, or ended). Safe to call any time. */
export function stopRinging(): void {
  ringToken++;
  const stop = ringStop;
  ringStop = null;
  try {
    stop?.();
  } catch {
    /* already stopped */
  }
}
