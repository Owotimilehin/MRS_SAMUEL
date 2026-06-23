/**
 * Render a `ReceiptData` to a standalone HTML document sized for an 80mm
 * thermal roll. This is the OS-print fallback: when direct WebUSB printing
 * isn't available (e.g. Windows holds the printer via its own driver, so
 * `USBDevice.open()` is denied), we print this through the normal Windows
 * print path — which already drives the installed XP-80T reliably.
 *
 * Pure string builder (no DOM), so it's easy to test. The transport
 * (`printViaBrowser` in print-receipt.ts) injects it into a hidden iframe.
 */
import { money } from "./escpos.js";
import type { ReceiptData } from "./receipt-data.js";
import { sizeMlLabel } from "./receipt-data.js";

const LOGO_URL = "/receipt-logo.png";
const QR_URL = "/qr.png";
const IG = "@Mrs_samuelfruitjuice";
const WHATSAPP = "WhatsApp 0901 951 2246";
const EMAIL = "info@mrssamuel.com";

/** Escape text so user-supplied values can't break the receipt markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function row(label: string, value: string): string {
  return `<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
}

export function renderReceiptHtml(data: ReceiptData): string {
  const metaLabel =
    data.kind === "return" ? "RETURN" : data.kind === "preorder" ? "PREORDER" : "RECEIPT";

  const items = data.lines
    .map((l) => {
      const size = l.sizeMl != null ? ` ${sizeMlLabel(l.sizeMl)}` : "";
      return (
        `<div class="row item"><span>${esc(`${l.qty} ${l.name}${size}`)}</span>` +
        `<span>${esc(money(l.lineNgn, true))}</span></div>` +
        `<div class="unit">@ ${esc(money(l.unitNgn, true))}</div>`
      );
    })
    .join("");

  // Branded style emphasises the total with a centered, larger line.
  const totalRow =
    data.style === "branded"
      ? `<div class="c total total--branded">TOTAL ${esc(money(data.totalNgn, true))}</div>`
      : `<div class="row total"><span>TOTAL</span><span>${esc(money(data.totalNgn, true))}</span></div>`;

  const totalsInner =
    data.kind === "return"
      ? row("REFUND", money(data.refundNgn ?? data.totalNgn, true)) +
        (data.refundReason ? `<div class="unit">Reason: ${esc(data.refundReason)}</div>` : "")
      : totalRow +
        (data.cashNgn != null
          ? row("Cash", money(data.cashNgn, true)) + row("Change", money(data.changeNgn ?? 0, true))
          : "");

  // Marketing style swaps the QR caption for a discount hook.
  const qrCaption =
    data.style === "marketing" ? "Scan for 10% off your next order" : "Scan to order fresh again";

  const footer =
    data.kind !== "return"
      ? `<div class="c">Thank you! Keep chilled - drink fresh</div>`
      : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.receiptNo)}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 80mm;
    padding: 3mm 4mm;
    font-family: "Courier New", "Cascadia Mono", monospace;
    font-size: 12px;
    line-height: 1.35;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .c { text-align: center; }
  .logo { display: block; max-width: 48mm; margin: 0 auto 2mm; }
  .wordmark { text-align: center; font-weight: 700; }
  .wordmark .big { font-size: 20px; letter-spacing: 1px; }
  .hr { border-top: 1px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
  .item { font-weight: 600; }
  .unit { padding-left: 6px; color: #000; }
  .total { font-weight: 700; font-size: 15px; margin-top: 1mm; }
  .total--branded { font-size: 19px; letter-spacing: 0.5px; margin: 2mm 0 1mm; }
  .qr { display: block; width: 28mm; height: 28mm; margin: 2mm auto 1mm; }
  .small { font-size: 11px; }
</style></head>
<body>
  <img class="logo" src="${LOGO_URL}" alt="" onerror="this.style.display='none'" />
  <div class="wordmark"><span class="big">MRS. SAMUEL</span><br/>FRUIT JUICE</div>
  <div class="c">${esc(data.branchName)}</div>
  ${data.branchAddress ? `<div class="c small">${esc(data.branchAddress)}</div>` : ""}
  ${data.branchPhone ? `<div class="c small">Tel ${esc(data.branchPhone)}</div>` : ""}
  <div class="hr"></div>
  ${row(metaLabel, data.receiptNo)}
  ${row("DATE", data.dateLabel)}
  ${row("SERVED BY", data.servedBy)}
  ${data.kind !== "return" ? row("CHANNEL", data.channelLabel) + row("PAYMENT", data.paymentLabel) : ""}
  ${data.fulfilLabel ? row("FULFIL", data.fulfilLabel) : ""}
  <div class="hr"></div>
  ${items}
  <div class="hr"></div>
  ${row("Subtotal", money(data.subtotalNgn, true))}
  ${totalsInner}
  <div class="hr"></div>
  <img class="qr" src="${QR_URL}" alt="" onerror="this.style.display='none'" />
  <div class="c small">${esc(qrCaption)}</div>
  <div class="c small">mrssamuel.com</div>
  <div class="hr"></div>
  ${footer}
  <div class="c small">${esc(IG)}</div>
  <div class="c small">${esc(WHATSAPP)}</div>
  <div class="c small">${esc(EMAIL)}</div>
</body></html>`;
}
