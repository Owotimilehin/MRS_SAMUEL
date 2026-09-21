/**
 * One home for the WhatsApp hand-off.
 *
 * The number was copy-pasted across six files; a change of line meant finding
 * every one. Import from here instead.
 */
export const WHATSAPP_NUMBER = "2349019512246";

/** A wa.me link, optionally pre-filling the customer's first message. */
export function whatsappLink(message?: string): string {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
