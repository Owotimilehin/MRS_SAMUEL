/**
 * RFC 4122 v4-shaped id for idempotency keys and the device id. Uses
 * crypto.randomUUID when the JS engine has it, otherwise Math.random (fine for
 * these uses: they only need to be unique, not secret).
 * Same approach as apps/admin/src/lib/api.ts `uuid()`.
 */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
