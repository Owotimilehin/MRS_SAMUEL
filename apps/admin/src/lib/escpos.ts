/**
 * ESC/POS byte encoder for the Xprinter XP-80T (80mm, USB, ESC/POS).
 *
 * Produces the raw command stream a thermal printer understands, so the app can
 * drive the printer DIRECTLY (over WebUSB in the browser, or natively in the
 * Tauri desktop shell) instead of going through the OS print dialog.
 *
 * 80mm paper at Font A is 48 characters wide. Everything here is pure and
 * synchronous so it is trivially unit-testable; the transport (WebUSB) lives in
 * `printer.ts`.
 */

export const PAPER_COLS = 48;

const ESC = 0x1b;
const GS = 0x1d;

/** Fluent builder that accumulates ESC/POS bytes. */
export class EscPos {
  private chunks: number[] = [];

  /** CP437/Latin-1 byte encoding. Non-encodable chars (e.g. ₦) are dropped by
   *  callers via `money()`; here we map by char code, replacing >255 with '?'. */
  private encodeText(s: string): number[] {
    const out: number[] = [];
    for (const ch of s) {
      const code = ch.codePointAt(0) ?? 63;
      out.push(code <= 0xff ? code : 63 /* '?' */);
    }
    return out;
  }

  raw(bytes: number[]): this {
    this.chunks.push(...bytes);
    return this;
  }

  /** ESC @ — reset to power-on defaults. */
  init(): this {
    return this.raw([ESC, 0x40]);
  }

  /** ESC a n — 0 left, 1 center, 2 right. */
  align(a: "left" | "center" | "right"): this {
    const n = a === "center" ? 1 : a === "right" ? 2 : 0;
    return this.raw([ESC, 0x61, n]);
  }

  /** ESC E n — emphasized (bold) on/off. */
  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** GS ! n — character size. width/height are 1..8 multipliers. */
  size(width: number, height: number): this {
    const w = Math.max(1, Math.min(8, width)) - 1;
    const h = Math.max(1, Math.min(8, height)) - 1;
    return this.raw([GS, 0x21, (w << 4) | h]);
  }

  /** Write text (no newline). */
  text(s: string): this {
    return this.raw(this.encodeText(s));
  }

  /** Write text then newline. */
  line(s = ""): this {
    return this.text(s).raw([0x0a]);
  }

  /** Feed n blank lines. */
  feed(n = 1): this {
    return this.raw([ESC, 0x64, Math.max(0, Math.min(255, n))]);
  }

  /** A full-width divider, e.g. dashes. */
  rule(char = "-"): this {
    return this.line(char.repeat(PAPER_COLS));
  }

  /**
   * Two-column row: left label, right value, padded to PAPER_COLS. Truncates the
   * left side if the row would overflow so the value stays right-aligned.
   */
  row(left: string, right: string): this {
    const space = PAPER_COLS - right.length;
    let l = left;
    if (l.length > space - 1) l = l.slice(0, Math.max(0, space - 1));
    const pad = Math.max(1, PAPER_COLS - l.length - right.length);
    return this.line(l + " ".repeat(pad) + right);
  }

  /**
   * GS ( k — print a native QR code. The XP-80T renders this on-device, so no
   * raster conversion is needed. `size` is the module size (1..16).
   */
  qr(data: string, size = 6): this {
    const store = this.encodeText(data);
    const len = store.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    // Model 2
    this.raw([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
    // Module size
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.max(1, Math.min(16, size))]);
    // Error correction level M
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]);
    // Store data
    this.raw([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...store]);
    // Print
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return this;
  }

  /**
   * GS v 0 — raster bit image (used for the logo). `mono` is a packed 1-bpp
   * bitmap, MSB-first, `widthBytes = ceil(width/8)` bytes per row, `1` = black.
   */
  rasterImage(mono: Uint8Array, width: number, height: number): this {
    const widthBytes = Math.ceil(width / 8);
    const xL = widthBytes & 0xff;
    const xH = (widthBytes >> 8) & 0xff;
    const yL = height & 0xff;
    const yH = (height >> 8) & 0xff;
    this.raw([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    this.raw(Array.from(mono));
    return this;
  }

  /** ESC p — kick the cash drawer (pin 0, on/off pulse). */
  kickDrawer(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  /** GS V 66 — feed and partial cut. */
  cut(): this {
    return this.feed(3).raw([GS, 0x56, 0x42, 0x00]);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/**
 * Format an integer-NGN amount for thermal output. The ₦ glyph is not in the
 * printer's character set, so we use "NGN" (or omit when `bare`). Returns e.g.
 * "NGN 14,000" or "14,000".
 */
export function money(n: number, bare = false): string {
  const grouped = Math.round(n).toLocaleString("en-NG");
  return bare ? grouped : `NGN ${grouped}`;
}
