/**
 * High-level "print this receipt" entry point used by the POS modal and the
 * reprint buttons. Resolves a granted USB printer (prompting once if needed),
 * renders the logo to raster, composes the ESC/POS stream, and sends it.
 *
 * Returns a result the caller turns into a toast — never throws past here.
 */
import { composeReceipt } from "./receipt-escpos.js";
import type { ReceiptData } from "./receipt-data.js";
import {
  getKnownPrinter,
  requestPrinter,
  printBytes,
  loadLogoRaster,
  isWebUsbSupported,
} from "./printer.js";

const LOGO_URL = "/receipt-logo.png";

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
  if (!isWebUsbSupported()) {
    return {
      ok: false,
      message: "Direct printing needs Chrome or the desktop app on this device.",
    };
  }
  try {
    let device = await getKnownPrinter();
    if (!device) {
      if (!opts.promptIfNeeded) {
        return { ok: false, message: "No printer connected yet. Tap Print to choose one." };
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
    // User cancelled the chooser, or the device wasn't claimable.
    const msg = err instanceof Error ? err.message : String(err);
    if (/no device selected|cancel/i.test(msg)) {
      return { ok: false, message: "Printer selection cancelled." };
    }
    return { ok: false, message: `Couldn't print: ${msg}` };
  }
}
