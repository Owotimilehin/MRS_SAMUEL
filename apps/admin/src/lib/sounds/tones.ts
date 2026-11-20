/**
 * The built-in tones staff can pick for a new message or an incoming call.
 *
 * Every tone is made in the browser with the Web Audio API from a short list
 * of notes, so there is no sound file to load and nothing copyrighted.
 * "Two notes" is the sound the inbox has always played; it stays the default.
 *
 * A note is a sine/triangle/square wave (plus optional overtones) that rises
 * quickly to its peak and then fades away over `dur` seconds.
 */

export interface ToneNote {
  /** Pitch in hertz. */
  freq: number;
  /** Start, in seconds from the start of the tone. */
  at: number;
  /** How long the note lasts, including its fade, in seconds. */
  dur: number;
  wave?: OscillatorType;
  /** Loudest point, 0–1, before the person's volume is applied. */
  peak?: number;
  /** Seconds to reach the peak. */
  attack?: number;
  /** Extra overtones: [multiple of freq, loudness relative to the note]. */
  partials?: readonly (readonly [number, number])[];
}

export interface Tone {
  id: string;
  name: string;
  notes: readonly ToneNote[];
  /** When ringing for a call, the tone starts again every this many seconds. */
  ringEvery: number;
}

/** Id of the sound the inbox played before choices existed. */
export const DEFAULT_TONE_ID = "two-notes";

export const TONES: readonly Tone[] = [
  {
    id: "two-notes",
    name: "Two notes",
    // Exactly the original sound: two rising sine notes, about half a second.
    notes: [
      { freq: 660, at: 0, dur: 0.3, peak: 0.3 },
      { freq: 880, at: 0.16, dur: 0.3, peak: 0.3 },
    ],
    ringEvery: 1.5,
  },
  {
    id: "chime",
    name: "Chime",
    notes: [
      { freq: 1318.5, at: 0, dur: 1.2, peak: 0.22, partials: [[2, 0.2]] },
      { freq: 1046.5, at: 0.22, dur: 1.2, peak: 0.22, partials: [[2, 0.2]] },
      { freq: 784, at: 0.44, dur: 1.6, peak: 0.22, partials: [[2, 0.2]] },
    ],
    ringEvery: 2.6,
  },
  {
    id: "bell",
    name: "Bell",
    notes: [
      {
        freq: 880,
        at: 0,
        dur: 2,
        peak: 0.25,
        attack: 0.005,
        partials: [
          [2.76, 0.35],
          [5.4, 0.15],
        ],
      },
    ],
    ringEvery: 2.4,
  },
  {
    id: "marimba",
    name: "Marimba",
    notes: [
      { freq: 523.25, at: 0, dur: 0.35, peak: 0.35, attack: 0.004, partials: [[4, 0.25]] },
      { freq: 659.25, at: 0.12, dur: 0.35, peak: 0.35, attack: 0.004, partials: [[4, 0.25]] },
      { freq: 783.99, at: 0.24, dur: 0.35, peak: 0.35, attack: 0.004, partials: [[4, 0.25]] },
      { freq: 1046.5, at: 0.36, dur: 0.5, peak: 0.35, attack: 0.004, partials: [[4, 0.25]] },
    ],
    ringEvery: 1.8,
  },
  {
    id: "soft-pulse",
    name: "Soft pulse",
    notes: [
      { freq: 440, at: 0, dur: 0.5, peak: 0.3, attack: 0.15 },
      { freq: 440, at: 0.55, dur: 0.5, peak: 0.3, attack: 0.15 },
    ],
    ringEvery: 2,
  },
  {
    id: "classic-ring",
    name: "Classic ring",
    // Two short bursts of the familiar 440 + 480 Hz telephone ring.
    notes: [
      { freq: 440, at: 0, dur: 0.4, peak: 0.16, attack: 0.01 },
      { freq: 480, at: 0, dur: 0.4, peak: 0.16, attack: 0.01 },
      { freq: 440, at: 0.5, dur: 0.4, peak: 0.16, attack: 0.01 },
      { freq: 480, at: 0.5, dur: 0.4, peak: 0.16, attack: 0.01 },
    ],
    ringEvery: 2.5,
  },
  {
    id: "digital",
    name: "Digital",
    notes: [
      { freq: 1200, at: 0, dur: 0.09, wave: "square", peak: 0.08, attack: 0.003 },
      { freq: 1200, at: 0.13, dur: 0.09, wave: "square", peak: 0.08, attack: 0.003 },
      { freq: 1600, at: 0.26, dur: 0.12, wave: "square", peak: 0.08, attack: 0.003 },
    ],
    ringEvery: 1.4,
  },
  {
    id: "bright",
    name: "Bright",
    notes: [
      { freq: 1046.5, at: 0, dur: 0.25, wave: "triangle", peak: 0.3 },
      { freq: 1318.5, at: 0.09, dur: 0.25, wave: "triangle", peak: 0.3 },
      { freq: 1568, at: 0.18, dur: 0.25, wave: "triangle", peak: 0.3 },
      { freq: 2093, at: 0.27, dur: 0.45, wave: "triangle", peak: 0.3 },
    ],
    ringEvery: 1.6,
  },
];

export function findTone(id: string): Tone | undefined {
  return TONES.find((t) => t.id === id);
}

/** The tone with this id, or the default when it is unknown. */
export function toneOrDefault(id: string): Tone {
  return findTone(id) ?? (findTone(DEFAULT_TONE_ID) as Tone);
}

/** Seconds from the start of the tone until its last note has faded. */
export function toneLength(tone: Tone): number {
  return tone.notes.reduce((end, n) => Math.max(end, n.at + n.dur), 0);
}

/**
 * Schedule a tone on an audio context (live or offline), starting at `start`
 * seconds on that context's clock. `volume` is 0–1 and scales every note.
 * Returns when the tone ends, on the same clock.
 */
export function scheduleTone(
  ctx: BaseAudioContext,
  destination: AudioNode,
  tone: Tone,
  start: number,
  volume: number,
): number {
  const vol = Math.min(1, Math.max(0, volume));
  for (const n of tone.notes) {
    const begin = start + n.at;
    const peak = Math.max(0.0002, (n.peak ?? 0.3) * vol);
    const attack = n.attack ?? 0.02;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.exponentialRampToValueAtTime(peak, begin + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + n.dur);
    gain.connect(destination);
    const voices: [number, number][] = [[1, 1], ...(n.partials ?? []).map(([m, a]) => [m, a] as [number, number])];
    for (const [mult, amp] of voices) {
      const osc = ctx.createOscillator();
      osc.type = n.wave ?? "sine";
      osc.frequency.setValueAtTime(n.freq * mult, begin);
      let out: AudioNode = gain;
      if (amp !== 1) {
        const g = ctx.createGain();
        g.gain.setValueAtTime(amp, begin);
        g.connect(gain);
        out = g;
      }
      osc.connect(out);
      osc.start(begin);
      osc.stop(begin + n.dur + 0.02);
    }
  }
  return start + toneLength(tone);
}
