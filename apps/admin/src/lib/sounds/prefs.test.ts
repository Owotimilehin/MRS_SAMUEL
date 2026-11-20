import { describe, expect, it } from "vitest";
import { CUSTOM_TONE, DEFAULT_PREFS, loadPrefs, parsePrefs, saveChoice, STANDARD_RING, type PrefsStorage } from "./prefs.js";

function memoryStorage(): PrefsStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("sound choices", () => {
  it("defaults to today's sounds: two notes for messages, the standard ring for calls", () => {
    expect(DEFAULT_PREFS).toEqual({
      message: { tone: "two-notes", volume: 100 },
      call: { tone: STANDARD_RING, volume: 100 },
    });
    expect(loadPrefs(memoryStorage())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it("saves and reads back each kind separately", () => {
    const s = memoryStorage();
    saveChoice("message", { tone: "bell", volume: 40 }, s);
    saveChoice("call", { tone: "marimba", volume: 75 }, s);
    expect(loadPrefs(s)).toEqual({ message: { tone: "bell", volume: 40 }, call: { tone: "marimba", volume: 75 } });
    saveChoice("call", { tone: CUSTOM_TONE, volume: 75 }, s);
    expect(loadPrefs(s).message).toEqual({ tone: "bell", volume: 40 });
    expect(loadPrefs(s).call.tone).toBe(CUSTOM_TONE);
  });

  it("ignores rubbish: bad JSON, unknown tones, out-of-range volume", () => {
    expect(parsePrefs("{not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("42")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ message: { tone: "kazoo", volume: 250 }, call: { tone: "bell", volume: -5 } }))).toEqual({
      message: { tone: "two-notes", volume: 100 },
      call: { tone: "bell", volume: 0 },
    });
    expect(parsePrefs(JSON.stringify({ message: { tone: "bell", volume: "loud" } })).message).toEqual({ tone: "bell", volume: 100 });
  });

  it("only allows the standard ring for calls", () => {
    expect(parsePrefs(JSON.stringify({ message: { tone: STANDARD_RING, volume: 50 } })).message.tone).toBe("two-notes");
    expect(saveChoice("message", { tone: STANDARD_RING, volume: 50 }, memoryStorage()).message.tone).toBe("two-notes");
  });

  it("does not throw when storage refuses", () => {
    const broken: PrefsStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(saveChoice("message", { tone: "chime", volume: 60 }, broken).message).toEqual({ tone: "chime", volume: 60 });
  });
});
