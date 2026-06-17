/**
 * Active receipt style. Persisted per-device in localStorage (v1); the owner can
 * change it from Settings. Default is "classic" — the approved owner default.
 * A server-backed setting can replace this later without touching call sites.
 */
import type { ReceiptStyle } from "./receipt-data.js";

const KEY = "ms_receipt_style";
const STYLES: ReceiptStyle[] = ["classic", "branded", "marketing"];

export function getReceiptStyle(): ReceiptStyle {
  if (typeof localStorage === "undefined") return "classic";
  const v = localStorage.getItem(KEY);
  return STYLES.includes(v as ReceiptStyle) ? (v as ReceiptStyle) : "classic";
}

export function setReceiptStyle(style: ReceiptStyle): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, style);
}

export const RECEIPT_STYLES: { id: ReceiptStyle; label: string; hint: string }[] = [
  { id: "classic", label: "Classic Till", hint: "Traditional, compact, ultra-legible" },
  { id: "branded", label: "Branded Clean", hint: "Logo-led, airy, bold total" },
  { id: "marketing", label: "Marketing Magnet", hint: "Thank-you + 10%-off scan hook" },
];
