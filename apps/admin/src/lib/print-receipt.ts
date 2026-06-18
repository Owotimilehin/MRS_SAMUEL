/**
 * High-level "print this receipt" entry point used by the POS modal and the
 * reprint buttons. Resolves a granted USB printer (prompting once if needed),
 * renders the logo to raster, composes the ESC/POS stream, and sends it.
 *
 * Returns a result the caller turns into a toast — never throws past here.
 */
import { composeReceipt } from "./receipt-escpos.js";
import { renderReceiptHtml } from "./receipt-html.js";
import type { ReceiptData } from "./receipt-data.js";
import {
  getKnownPrinter,
  requestPrinter,
  printBytes,
  loadLogoRaster,
  isWebUsbSupported,
} from "./printer.js";

const LOGO_URL = "/receipt-logo.png";

/**
 * Print through the normal Windows/OS print path via a hidden iframe. This is
 * the universal fallback — it works whenever the printer is installed in the
 * OS (which it already is), so it sidesteps the WebUSB "Access denied" that
 * Windows throws when its own driver owns the device. Shows the OS print
 * dialog; resolves once we've handed the document to the browser to print.
 */
function printViaBrowser(data: ReceiptData): Promise<PrintResult> {
  if (typeof document === "undefined") {
    return Promise.resolve({ ok: false, message: "Printing isn't available on this device." });
  }
  const html = renderReceiptHtml(data);
  return new Promise<PrintResult>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    let settled = false;
    const finish = (result: PrintResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      // Leave the iframe long enough for the print dialog to read it.
      window.setTimeout(() => iframe.remove(), 1500);
    };
    iframe.onload = (): void => {
      const win = iframe.contentWindow;
      if (!win) {
        finish({ ok: false, message: "Couldn't open the print view." });
        return;
      }
      // Give the logo/QR images a moment to settle before printing.
      window.setTimeout(() => {
        try {
          win.focus();
          win.print();
          finish({ ok: true, message: "Receipt sent to Windows printing — confirm the print dialog." });
        } catch (e) {
          finish({ ok: false, message: `Couldn't print: ${e instanceof Error ? e.message : String(e)}` });
        }
      }, 350);
    };
    // srcdoc resolves root-relative asset URLs against the admin origin.
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

/** WebUSB failures where the device was never opened — safe to OS-print instead. */
function isClaimFailure(msg: string): boolean {
  return /access denied|denied|security|not ?found|no device|unable to claim|claim|open|networkerror|the device/i.test(
    msg,
  );
}

// Cache the converted logo for the session — conversion is the slow part.
let logoCache: Awaited<ReturnType<typeof loadLogoRaster>> | undefined;

export interface PrintResult {
  ok: boolean;
  message: string;
}

/**
 * @param promptIfNeeded when true (a user click), we may show the USB picker.
 *        Pass false for any non-gesture call (WebUSB requires a user gesture to
 *        prompt).
 */
export async function printReceipt(
  data: ReceiptData,
  opts: { promptIfNeeded?: boolean; openDrawer?: boolean } = {},
): Promise<PrintResult> {
  // No WebUSB at all (Safari/Firefox, or USB blocked) → go straight to the
  // OS print path so the user still gets a receipt.
  if (!isWebUsbSupported()) {
    return printViaBrowser(data);
  }
  try {
    let device = await getKnownPrinter();
    if (!device) {
      if (!opts.promptIfNeeded) {
        // No granted printer and we can't prompt without a gesture — fall back
        // to OS printing so an auto-print after a sale still produces a receipt.
        return printViaBrowser(data);
      }
      device = await requestPrinter();
    }

    if (logoCache === undefined) {
      logoCache = await loadLogoRaster(LOGO_URL).catch(() => null);
    }
    const bytes = composeReceipt(data, {
      ...(logoCache ? { logo: logoCache } : {}),
      ...(opts.openDrawer ? { openDrawer: true } : {}),
    });
    await printBytes(device, bytes);
    return { ok: true, message: "Receipt sent to printer." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The user explicitly cancelled the chooser — don't override their intent.
    if (/no device selected|cancel/i.test(msg)) {
      return { ok: false, message: "Printer selection cancelled." };
    }
    // Windows held the printer via its own driver (the classic "Access denied"
    // on USBDevice.open), or the device wasn't claimable — print via the OS
    // instead. Nothing was sent over USB yet at this stage, so no double print.
    if (isClaimFailure(msg)) {
      return printViaBrowser(data);
    }
    return { ok: false, message: `Couldn't print: ${msg}` };
  }
}
