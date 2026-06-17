/**
 * Direct printer transport via WebUSB. Lets the admin app send raw ESC/POS
 * bytes straight to the Xprinter XP-80T without the OS print dialog.
 *
 * Windows note: Chrome's WebUSB can only claim the device if its driver is
 * WinUSB (use Zadig once to switch the XP-80T from the vendor print driver).
 * The Tauri desktop build avoids this entirely by printing natively — it can
 * reuse `composeReceipt()` and ship the same bytes over a native USB handle.
 *
 * We keep the API tiny and defensive: every call degrades to a clear thrown
 * Error the caller can surface as a toast.
 */

// --- Minimal WebUSB typings (avoids pulling @types/w3c-web-usb) ---
interface USBEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: string;
}
interface USBAlternateInterface {
  interfaceClass: number;
  endpoints: USBEndpoint[];
}
interface USBInterface {
  interfaceNumber: number;
  alternate: USBAlternateInterface;
}
interface USBConfiguration {
  interfaces: USBInterface[];
}
interface USBDevice {
  productName?: string;
  manufacturerName?: string;
  configuration: USBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
}
interface USB {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(opts: { filters: Array<Record<string, number>> }): Promise<USBDevice>;
}
type NavigatorWithUsb = Navigator & { usb?: USB };

const PRINTER_CLASS = 0x07; // USB printer class

export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as NavigatorWithUsb).usb;
}

function usb(): USB {
  const u = (navigator as NavigatorWithUsb).usb;
  if (!u) throw new Error("This browser doesn't support direct USB printing. Use Chrome or the desktop app.");
  return u;
}

/** Prompt the user to pick + grant access to a USB printer. Persisted by Chrome. */
export async function requestPrinter(): Promise<USBDevice> {
  // Empty filter list with a catch-all so the user sees every device; the
  // printer class isn't always advertised by cheap thermal units.
  return usb().requestDevice({ filters: [] });
}

/** The previously-granted printer, if any (no prompt). */
export async function getKnownPrinter(): Promise<USBDevice | null> {
  if (!isWebUsbSupported()) return null;
  const devices = await usb().getDevices();
  return devices[0] ?? null;
}

/** Find the first bulk OUT endpoint, preferring a printer-class interface. */
function findOut(device: USBDevice): { interfaceNumber: number; endpoint: number } {
  const cfg = device.configuration;
  if (!cfg) throw new Error("Printer has no active configuration.");
  const ordered = [...cfg.interfaces].sort(
    (a, b) =>
      (b.alternate.interfaceClass === PRINTER_CLASS ? 1 : 0) -
      (a.alternate.interfaceClass === PRINTER_CLASS ? 1 : 0),
  );
  for (const itf of ordered) {
    const out = itf.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (out) return { interfaceNumber: itf.interfaceNumber, endpoint: out.endpointNumber };
  }
  throw new Error("Couldn't find a printable interface on this device.");
}

/** Send raw bytes to the printer. Opens, claims, transfers, then releases. */
export async function printBytes(device: USBDevice, bytes: Uint8Array): Promise<void> {
  await device.open();
  try {
    if (!device.configuration) await device.selectConfiguration(1);
    const { interfaceNumber, endpoint } = findOut(device);
    await device.claimInterface(interfaceNumber);
    try {
      // Chunk to stay well under typical bulk transfer limits.
      const CHUNK = 16 * 1024;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        await device.transferOut(endpoint, bytes.slice(i, i + CHUNK));
      }
    } finally {
      await device.releaseInterface(interfaceNumber).catch(() => {});
    }
  } finally {
    await device.close().catch(() => {});
  }
}

/**
 * Load an image URL and convert to a packed 1-bpp raster for ESC/POS GS v 0.
 * Scales to `targetWidth` dots (multiple of 8; 80mm printable ≈ 576 dots).
 * Browser-only (uses canvas). Returns null if conversion isn't possible.
 */
export async function loadLogoRaster(
  url: string,
  targetWidth = 384,
): Promise<{ mono: Uint8Array; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
  if (!img || !img.width) return null;

  const width = targetWidth - (targetWidth % 8);
  const height = Math.round((img.height / img.width) * width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const widthBytes = width / 8;
  const mono = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3] ?? 0;
      const lum = 0.299 * (data[idx] ?? 0) + 0.587 * (data[idx + 1] ?? 0) + 0.114 * (data[idx + 2] ?? 0);
      // Black pixel = bit set. Treat transparent as white.
      const black = alpha > 64 && lum < 128;
      if (black) mono[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { mono, width, height };
}
