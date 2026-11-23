import { describe, expect, it } from "vitest";
import { DEFAULT_TONE_ID, findTone, scheduleTone, toneLength, toneOrDefault, TONES } from "./tones.js";

describe("built-in tones", () => {
  it("offers eight tones with unique ids and plain names", () => {
    expect(TONES).toHaveLength(8);
    expect(new Set(TONES.map((t) => t.id)).size).toBe(TONES.length);
    expect(TONES.map((t) => t.name)).toEqual([
      "Two notes",
      "Chime",
      "Bell",
      "Marimba",
      "Soft pulse",
      "Classic ring",
      "Digital",
      "Bright",
    ]);
  });

  it("keeps today's sound as the default, note for note", () => {
    const t = findTone(DEFAULT_TONE_ID)!;
    expect(t.name).toBe("Two notes");
    expect(t.notes.map((n) => [n.freq, n.at, n.dur, n.peak ?? 0.3, n.wave ?? "sine"])).toEqual([
      [660, 0, 0.3, 0.3, "sine"],
      [880, 0.16, 0.3, 0.3, "sine"],
    ]);
  });

  it("every tone is short, audible and leaves a pause before it rings again", () => {
    for (const t of TONES) {
      expect(t.notes.length).toBeGreaterThan(0);
      const len = toneLength(t);
      expect(len).toBeGreaterThan(0.1);
      expect(len).toBeLessThan(2.5);
      expect(t.ringEvery).toBeGreaterThan(len);
      for (const n of t.notes) {
        expect(n.freq).toBeGreaterThan(20);
        expect(n.freq).toBeLessThan(20_000);
        expect(n.peak ?? 0.3).toBeLessThanOrEqual(0.4);
      }
    }
  });

  it("falls back to the default for an unknown id", () => {
    expect(toneOrDefault("nope").id).toBe(DEFAULT_TONE_ID);
    expect(toneOrDefault("bell").id).toBe("bell");
  });
});

describe("scheduleTone", () => {
  /** A stand-in audio context that records what would be played. */
  function fakeCtx() {
    const started: { freq: number; at: number; type: string }[] = [];
    const peaks: number[] = [];
    const ctx = {
      createGain: () => {
        let first = true;
        return {
          gain: {
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: (v: number) => {
              if (first) peaks.push(v);
              first = false;
            },
          },
          connect: () => undefined,
        };
      },
      createOscillator: () => {
        const o = {
          type: "sine",
          freq: 0,
          frequency: { setValueAtTime: (v: number) => (o.freq = v) },
          connect: () => undefined,
          start: (at: number) => started.push({ freq: o.freq, at, type: o.type }),
          stop: () => undefined,
        };
        return o;
      },
    };
    return { ctx: ctx as unknown as BaseAudioContext, started, peaks };
  }

  it("plays each note at the right time and scales by volume", () => {
    const { ctx, started, peaks } = fakeCtx();
    const end = scheduleTone(ctx, {} as AudioNode, toneOrDefault("two-notes"), 10, 0.5);
    expect(started).toEqual([
      { freq: 660, at: 10, type: "sine" },
      { freq: 880, at: 10.16, type: "sine" },
    ]);
    expect(peaks).toEqual([0.15, 0.15]);
    expect(end).toBeCloseTo(10.46);
  });

  it("adds overtones for a bell", () => {
    const { ctx, started } = fakeCtx();
    scheduleTone(ctx, {} as AudioNode, toneOrDefault("bell"), 0, 1);
    expect(started.map((s) => Math.round(s.freq))).toEqual([880, 2429, 4752]);
  });

  it("never sends a zero to an exponential ramp, even at volume 0", () => {
    const { ctx, peaks } = fakeCtx();
    scheduleTone(ctx, {} as AudioNode, toneOrDefault("chime"), 0, 0);
    expect(peaks.length).toBeGreaterThan(0);
    expect(peaks.every((p) => p > 0)).toBe(true);
  });
});
