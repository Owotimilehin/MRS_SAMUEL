import { describe, expect, it } from "vitest";
import { checkDuration, checkFileBasics, loadCustomSound, MAX_BYTES, saveCustomSound, validateAudioFile } from "./custom.js";

function file(name: string, type: string, size: number) {
  return { name, type, size, arrayBuffer: async () => new ArrayBuffer(size) };
}
const decodesTo = (duration: number) => async () => ({ duration });

describe("checking an uploaded sound", () => {
  it("accepts MP3 and WAV, by type or (when the type is missing) by name", () => {
    expect(checkFileBasics(file("ring.mp3", "audio/mpeg", 1000)).ok).toBe(true);
    expect(checkFileBasics(file("ring.wav", "audio/wav", 1000)).ok).toBe(true);
    expect(checkFileBasics(file("ring.wav", "audio/x-wav", 1000)).ok).toBe(true);
    expect(checkFileBasics(file("RING.MP3", "", 1000)).ok).toBe(true);
  });

  it("refuses other files with a plain-English reason", () => {
    for (const f of [file("song.ogg", "audio/ogg", 1000), file("pic.png", "image/png", 1000), file("ring.mp3.exe", "", 1000)]) {
      const r = checkFileBasics(f);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/MP3 or WAV/);
    }
  });

  it("refuses files over 1 MB, and empty files", () => {
    expect(checkFileBasics(file("a.mp3", "audio/mpeg", MAX_BYTES)).ok).toBe(true);
    expect(checkFileBasics(file("a.mp3", "audio/mpeg", 2.4 * 1024 * 1024))).toEqual({
      ok: false,
      error: "That file is 2.4 MB. The limit is 1 MB. Try a shorter clip.",
    });
    expect(checkFileBasics(file("a.mp3", "audio/mpeg", 0)).ok).toBe(false);
  });

  it("allows up to 30 seconds", () => {
    expect(checkDuration(30).ok).toBe(true);
    expect(checkDuration(30.03).ok).toBe(true);
    expect(checkDuration(45.2)).toEqual({
      ok: false,
      error: "That sound is 45 seconds long. The limit is 30 seconds. Try a shorter clip.",
    });
    expect(checkDuration(0).ok).toBe(false);
    expect(checkDuration(Number.NaN).ok).toBe(false);
  });

  it("decodes the file to check it really is audio, and its length", async () => {
    const ok = await validateAudioFile(file("ring.mp3", "audio/mpeg", 500), decodesTo(4.5));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sound).toMatchObject({ name: "ring.mp3", type: "audio/mpeg", duration: 4.5 });

    expect((await validateAudioFile(file("ring.mp3", "audio/mpeg", 500), decodesTo(31))).ok).toBe(false);

    const broken = await validateAudioFile(file("ring.mp3", "audio/mpeg", 500), async () => {
      throw new Error("EncodingError");
    });
    expect(broken).toEqual({
      ok: false,
      error: "We couldn't play that file. It may be damaged or not really an MP3 or WAV. Try another one.",
    });
  });

  it("does not decode a file that already failed the type or size check", async () => {
    let decoded = false;
    const r = await validateAudioFile(file("a.ogg", "audio/ogg", 10), async () => {
      decoded = true;
      return { duration: 1 };
    });
    expect(r.ok).toBe(false);
    expect(decoded).toBe(false);
  });
});

describe("storing an uploaded sound", () => {
  it("gives up quietly (null / false) where the browser has no storage", async () => {
    // Tests run in Node, which has no IndexedDB: the same path as a locked-down browser.
    expect(await loadCustomSound("call")).toBeNull();
    expect(await saveCustomSound("call", { name: "a.mp3", type: "audio/mpeg", duration: 1, data: new ArrayBuffer(1) })).toBe(false);
  });
});
