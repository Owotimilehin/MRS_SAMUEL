// apps/customer/src/lib/uuid.ts
/**
 * Crash-safe RFC-4122 v4 UUID generator.
 *
 * `crypto.randomUUID()` only exists on *modern* browsers in a secure context.
 * It is ABSENT (calling it throws `TypeError: crypto.randomUUID is not a
 * function`) on older Safari / Android WebView and — critically for our
 * Nigerian customers — UC Browser, Opera Mini, and older in-app (Instagram /
 * Facebook) webviews. Checkout minted the idempotency key with the native call
 * *before* any UI feedback and *outside* the try/catch, so a throw there made
 * "Place order" do NOTHING: no spinner, no error, no checkout-log entry. This
 * helper always returns a usable id: native randomUUID when it works, then a
 * getRandomValues-seeded v4, then a Math.random fallback of last resort.
 */
export function safeRandomUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to manual generation */
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
