import { describe, it, expect } from "vitest";
import { EscPos, money, PAPER_COLS } from "./escpos.js";

describe("EscPos encoder", () => {
  it("init emits ESC @", () => {
    expect(Array.from(new EscPos().init().toBytes())).toEqual([0x1b, 0x40]);
  });

  it("align center emits ESC a 1", () => {
    const b = Array.from(new EscPos().align("center").toBytes());
    expect(b).toEqual([0x1b, 0x61, 1]);
  });

  it("line appends a newline", () => {
    const b = Array.from(new EscPos().line("AB").toBytes());
    expect(b).toEqual([0x41, 0x42, 0x0a]);
  });

  it("row pads label and value to full paper width", () => {
    const out = new EscPos().row("Total", "NGN 100").toBytes();
    // strip trailing newline, decode to string
    const text = String.fromCharCode(...Array.from(out).slice(0, -1));
    expect(text.length).toBe(PAPER_COLS);
    expect(text.startsWith("Total")).toBe(true);
    expect(text.endsWith("NGN 100")).toBe(true);
  });

  it("rule fills the whole width", () => {
    const out = new EscPos().rule("-").toBytes();
    const text = String.fromCharCode(...Array.from(out).slice(0, -1));
    expect(text).toBe("-".repeat(PAPER_COLS));
  });

  it("qr emits the four GS ( k blocks and embeds the data", () => {
    const bytes = Array.from(new EscPos().qr("https://mrssamuel.com", 6).toBytes());
    // GS ( k = 0x1d 0x28 0x6b appears 4 times (model, size, ecc, store, print => actually 5)
    let count = 0;
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x1d && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b) count++;
    }
    expect(count).toBe(5);
    // data bytes present
    const ascii = String.fromCharCode(...bytes.filter((b) => b >= 32 && b < 127));
    expect(ascii).toContain("https://mrssamuel.com");
  });

  it("kickDrawer emits ESC p pulse", () => {
    const b = Array.from(new EscPos().kickDrawer().toBytes());
    expect(b.slice(0, 3)).toEqual([0x1b, 0x70, 0x00]);
  });

  it("cut feeds then emits GS V", () => {
    const b = Array.from(new EscPos().cut().toBytes());
    expect(b.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });
});

describe("money", () => {
  it("formats with NGN prefix and grouping", () => {
    expect(money(14000)).toBe("NGN 14,000");
  });
  it("bare omits the prefix", () => {
    expect(money(14000, true)).toBe("14,000");
  });
});
