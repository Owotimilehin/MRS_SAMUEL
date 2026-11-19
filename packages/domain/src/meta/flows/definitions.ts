/**
 * The Flow JSON of every built-in form (suite spec 07, section 5.1). Forms are files in the
 * repository, changed by pull request; nothing here is edited from a screen. `flowJsonText` is the
 * exact text sent to Meta, and `flowJsonHash` its SHA-256, so "the form in the code is newer than
 * the one at WhatsApp" is a comparison of two hashes.
 */
import crypto from "node:crypto";
import type { FlowKey } from "@ms/shared";
import bulkOrder from "./definitions/bulk-order.flow.json" with { type: "json" };
import complaint from "./definitions/complaint.flow.json" with { type: "json" };
import deliveryAddress from "./definitions/delivery-address.flow.json" with { type: "json" };
import pickupRequest from "./definitions/pickup-request.flow.json" with { type: "json" };

const DEFINITIONS: Partial<Record<FlowKey, unknown>> = {
  delivery_address: deliveryAddress,
  bulk_order: bulkOrder,
  complaint,
  pickup_request: pickupRequest,
};

/** Keys that have a JSON file in this build. */
export function flowKeysWithJson(): FlowKey[] {
  return Object.keys(DEFINITIONS) as FlowKey[];
}

/** The parsed definition, or null when this build has no file for the key. */
export function flowJson(key: string): Record<string, unknown> | null {
  const def = (DEFINITIONS as Record<string, unknown>)[key];
  return def && typeof def === "object" ? (def as Record<string, unknown>) : null;
}

/** The exact text uploaded to Meta: a stable, two-space JSON rendering of the file. */
export function flowJsonText(key: string): string {
  const def = flowJson(key);
  if (!def) throw new Error(`no Flow JSON for form "${key}"`);
  return JSON.stringify(def, null, 2);
}

/** SHA-256 (hex) of flowJsonText. */
export function flowJsonHash(key: string): string {
  return crypto.createHash("sha256").update(flowJsonText(key), "utf8").digest("hex");
}

/** The "version" the file declares (for example "7.3"). */
export function flowJsonVersion(key: string): string | null {
  const v = flowJson(key)?.version;
  return typeof v === "string" ? v : null;
}
