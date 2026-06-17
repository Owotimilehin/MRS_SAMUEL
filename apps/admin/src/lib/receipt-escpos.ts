/**
 * Compose a `ReceiptData` into an ESC/POS byte stream for the XP-80T.
 *
 * Layout follows the approved "Classic Till" mock (the owner-default). Other
 * styles tweak emphasis/order but share this skeleton; `data.style` switches the
 * header treatment. The logo is optional raster (loaded + converted by the
 * transport layer) — without it we fall back to a bold text wordmark so a
 * receipt still prints if image conversion is unavailable.
 */
import { EscPos, money } from "./escpos.js";
import type { ReceiptData } from "./receipt-data.js";
import { sizeMlLabel } from "./receipt-data.js";

export interface RasterLogo {
  mono: Uint8Array;
  width: number;
  height: number;
}

const QR_TARGET = "https://mrssamuel.com";
const IG = "@Mrs_samuelfruitjuice";
const WHATSAPP = "WhatsApp 0901 951 2246";

export function composeReceipt(
  data: ReceiptData,
  opts: { logo?: RasterLogo; openDrawer?: boolean } = {},
): Uint8Array {
  const p = new EscPos().init();

  // --- Header ---
  p.align("center");
  if (opts.logo) {
    p.rasterImage(opts.logo.mono, opts.logo.width, opts.logo.height).feed(1);
  } else {
    p.bold(true).size(2, 2).line("MRS. SAMUEL").size(1, 1).line("FRUIT JUICE").bold(false);
  }
  p.line(data.branchName);
  if (data.branchAddress) p.line(data.branchAddress);
  if (data.branchPhone) p.line(`Tel ${data.branchPhone}`);
  p.rule();

  // --- Meta ---
  p.align("left");
  const metaLabel =
    data.kind === "return" ? "RETURN" : data.kind === "preorder" ? "PREORDER" : "RECEIPT";
  p.row(metaLabel, data.receiptNo);
  p.row("DATE", data.dateLabel);
  p.row("SERVED BY", data.servedBy);
  if (data.kind !== "return") {
    p.row("CHANNEL", data.channelLabel);
    p.row("PAYMENT", data.paymentLabel);
  }
  if (data.fulfilLabel) p.row("FULFIL", data.fulfilLabel);
  p.rule();

  // --- Items ---
  for (const l of data.lines) {
    const size = l.sizeMl != null ? ` ${sizeMlLabel(l.sizeMl)}` : "";
    p.row(`${l.qty} ${l.name}${size}`, money(l.lineNgn, true));
    p.line(`   @ ${money(l.unitNgn, true)}`);
  }
  p.rule();

  // --- Totals ---
  p.row("Subtotal", money(data.subtotalNgn, true));
  p.bold(true);
  if (data.kind === "return") {
    p.row("REFUND", money(data.refundNgn ?? data.totalNgn));
    p.bold(false);
    if (data.refundReason) p.line(`Reason: ${data.refundReason}`);
  } else {
    if (data.style === "branded") {
      // Branded style emphasises the total with a double-height line.
      p.align("center").size(1, 2).line(`TOTAL  ${money(data.totalNgn)}`).size(1, 1).align("left");
    } else {
      p.row("TOTAL", money(data.totalNgn));
    }
    p.bold(false);
    if (data.cashNgn != null) {
      p.row("Cash", money(data.cashNgn, true));
      p.row("Change", money(data.changeNgn ?? 0, true));
    }
  }
  p.rule();

  // --- QR → landing page (marketing) ---
  p.align("center");
  p.qr(QR_TARGET, 6).feed(1);
  if (data.style === "marketing") {
    p.bold(true).line("Scan for 10% off your next order").bold(false);
  } else {
    p.line("Scan to order fresh again");
  }
  p.line("mrssamuel.com");
  p.rule();

  // --- Footer / socials ---
  if (data.kind !== "return") p.line("Thank you! Keep chilled - drink fresh");
  p.line(IG);
  p.line(WHATSAPP);
  p.line("mrssamuel.com");

  if (opts.openDrawer) p.kickDrawer();
  p.cut();
  return p.toBytes();
}
