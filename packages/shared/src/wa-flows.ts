/**
 * WhatsApp Flows: the registry of in-chat forms (suite spec 07, section 5.2). On screen a Flow is
 * always called a "form". The Flow JSON itself lives in packages/domain (meta/flows/definitions);
 * this file holds what every app needs to name a form, send it and draw its answers. Browser-safe.
 */

export type FlowKey = "delivery_address" | "bulk_order" | "complaint" | "pickup_request" | "delivery_slot";
export type FlowFieldKind = "text" | "phone" | "choice" | "multi" | "date" | "longtext";
export interface FlowField {
  name: string;
  label: string;
  kind: FlowFieldKind;
  /** For choice and multi: id -> title. */
  options?: Record<string, string>;
}
export interface FlowDef {
  key: FlowKey;
  title: string;
  description: string;
  metaName: string;
  categories: string[];
  /** The button text on the message. */
  cta: string;
  defaultMessage: string;
  entryScreen: string;
  usesEndpoint: boolean;
  phase: "A" | "B";
  /** Conversation label added when an answer arrives. */
  label: string;
  fields: FlowField[];
}

/** Limits of the message that carries the form button (spec 3.4). */
export const FLOW_MESSAGE_LIMITS = { body: 1024, footer: 60, cta: 30 } as const;

export const DELIVERY_AREAS: Record<string, string> = {
  lekki: "Lekki",
  ajah: "Ajah",
  victoria_island: "Victoria Island",
  ikoyi: "Ikoyi",
  lagos_island: "Lagos Island",
  surulere: "Surulere",
  yaba: "Yaba",
  ikeja: "Ikeja",
  maryland: "Maryland",
  gbagada: "Gbagada",
  magodo: "Magodo",
  festac: "Festac",
  other: "Somewhere else in Lagos",
};

export const WA_FLOWS: readonly FlowDef[] = [
  {
    key: "delivery_address",
    title: "Delivery address",
    description: "Asks for the receiver's name and phone, the street, the area and a landmark.",
    metaName: "ms_delivery_address",
    categories: ["OTHER"],
    cta: "Add address",
    defaultMessage: "Please tap the button and fill in your delivery address. It takes about a minute.",
    entryScreen: "ADDRESS",
    usesEndpoint: false,
    phase: "A",
    label: "delivery-address",
    fields: [
      { name: "receiver_name", label: "Receiver", kind: "text" },
      { name: "receiver_phone", label: "Phone", kind: "phone" },
      { name: "street", label: "House and street", kind: "text" },
      { name: "area", label: "Area", kind: "choice", options: DELIVERY_AREAS },
      { name: "landmark", label: "Landmark", kind: "text" },
      { name: "note", label: "Note for the rider", kind: "longtext" },
    ],
  },
  {
    key: "bulk_order",
    title: "Bulk-order enquiry",
    description: "Asks what the order is for, how many bottles, when it is needed and how to reach them.",
    metaName: "ms_bulk_order",
    categories: ["LEAD_GENERATION"],
    cta: "Start enquiry",
    defaultMessage: "Planning an event or a large order? Tap the button and tell us what you need. We will reply with a quote.",
    entryScreen: "DETAILS",
    usesEndpoint: false,
    phase: "A",
    label: "bulk-order",
    fields: [
      {
        name: "occasion",
        label: "Occasion",
        kind: "choice",
        options: { event: "Party or event", office: "Office or staff", resale: "To sell in my shop", other: "Something else" },
      },
      { name: "quantity", label: "Bottles", kind: "text" },
      { name: "needed_by", label: "Needed by", kind: "date" },
      { name: "contact_name", label: "Name", kind: "text" },
      { name: "location", label: "Delivery area", kind: "text" },
      { name: "details", label: "More details", kind: "longtext" },
    ],
  },
  {
    key: "complaint",
    title: "Report a problem",
    description: "Asks what went wrong, the order number if they have it, and what they would like us to do.",
    metaName: "ms_complaint",
    categories: ["CUSTOMER_SUPPORT"],
    cta: "Report a problem",
    defaultMessage: "We are sorry something went wrong. Tap the button and tell us what happened so we can put it right.",
    entryScreen: "PROBLEM",
    usesEndpoint: false,
    phase: "A",
    label: "complaint",
    fields: [
      {
        name: "problem_type",
        label: "Problem",
        kind: "choice",
        options: {
          late: "Order arrived late",
          wrong: "Wrong or missing item",
          quality: "Taste or quality",
          damaged: "Damaged or leaking",
          payment: "Payment problem",
          other: "Something else",
        },
      },
      { name: "order_number", label: "Order number", kind: "text" },
      { name: "what_happened", label: "What happened", kind: "longtext" },
      {
        name: "wanted",
        label: "They would like",
        kind: "choice",
        options: { replace: "A replacement", refund: "A refund", call: "A call from us", just_saying: "Just letting you know" },
      },
    ],
  },
  {
    key: "pickup_request",
    title: "Pickup request",
    description: "Asks which day and time of day they would like to collect, and who is coming.",
    metaName: "ms_pickup_request",
    categories: ["APPOINTMENT_BOOKING"],
    cta: "Choose pickup time",
    defaultMessage: "Tap the button to tell us when you would like to collect your order.",
    entryScreen: "PICKUP",
    usesEndpoint: false,
    phase: "A",
    label: "pickup",
    fields: [
      { name: "order_number", label: "Order number", kind: "text" },
      { name: "pickup_date", label: "Pickup day", kind: "date" },
      {
        name: "pickup_time",
        label: "Time of day",
        kind: "choice",
        options: { morning: "Morning, 9am to 12pm", afternoon: "Afternoon, 12pm to 4pm", evening: "Evening, 4pm to 7pm" },
      },
      { name: "collector_name", label: "Collected by", kind: "text" },
    ],
  },
  {
    key: "delivery_slot",
    title: "Delivery time",
    description: "Shows only the days and times we still have room for, and books the one they pick.",
    metaName: "ms_delivery_slot",
    categories: ["APPOINTMENT_BOOKING"],
    cta: "Choose a time",
    defaultMessage: "Tap the button to choose a delivery time. You will only see times we still have room for.",
    entryScreen: "PICK_DAY",
    usesEndpoint: true,
    phase: "B",
    label: "delivery-slot",
    // The `day` and `slot` keys are stored with the answer but not shown.
    fields: [{ name: "slot_label", label: "Delivery time", kind: "text" }],
  },
];

/** Keys stored with a delivery-slot answer that the card does not show. */
export const FLOW_HIDDEN_KEYS: Record<string, readonly string[]> = { delivery_slot: ["day", "slot"] };

export function flowDef(key: string): FlowDef | null {
  return WA_FLOWS.find((f) => f.key === key) ?? null;
}

/** The name at Meta for a version of a form: version 2 and above get `_v<version>`. */
export function flowMetaName(def: FlowDef, version: number): string {
  return version > 1 ? `${def.metaName}_v${version}` : def.metaName;
}

/** "2026-11-20" -> "Fri 20 Nov 2026". Anything else comes back unchanged. */
export function formatFlowDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return value;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** What a stored answer looks like on the card, by the kind of question. Always plain text. */
export function formatFlowValue(kind: FlowFieldKind | "other", value: unknown, options?: Record<string, string>): string {
  const one = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  };
  if (kind === "multi") {
    const list = Array.isArray(value) ? value : [value];
    return list
      .map((v) => one(v))
      .filter((s) => s.trim() !== "")
      .map((s) => options?.[s] ?? s)
      .join(", ");
  }
  if (Array.isArray(value)) return value.map((v) => one(v)).filter((s) => s !== "").join(", ");
  const text = one(value);
  if (kind === "choice") return options?.[text] ?? text;
  if (kind === "date") return formatFlowDate(text);
  if (kind === "longtext") return text;
  return text.trim();
}

export interface FlowCardRow {
  label: string;
  value: string;
  kind: FlowFieldKind | "other";
}

/**
 * The rows of an answer card (spec 5.6): registry fields first, in order, when they have a value;
 * then any other keys as "Other: {key}". Never shows flow_token or flow_key. An unknown form lists
 * every key; an answer that could not be read (`_raw`) shows one row, "Answer".
 */
export function flowCardRows(flowKey: string, data: Record<string, unknown>): { title: string; rows: FlowCardRow[] } {
  const def = flowDef(flowKey);
  const rows: FlowCardRow[] = [];
  const skip = new Set<string>(["flow_token", "flow_key", ...(FLOW_HIDDEN_KEYS[flowKey] ?? [])]);
  const filled = (v: string): boolean => v.trim() !== "";
  for (const f of def?.fields ?? []) {
    skip.add(f.name);
    if (!(f.name in data)) continue;
    const value = formatFlowValue(f.kind, data[f.name], f.options);
    if (filled(value)) rows.push({ label: f.label, value, kind: f.kind });
  }
  for (const [key, raw] of Object.entries(data)) {
    if (skip.has(key)) continue;
    const value = formatFlowValue("other", raw);
    if (!filled(value)) continue;
    if (key === "_raw") rows.push({ label: "Answer", value, kind: "longtext" });
    else rows.push({ label: def ? `Other: ${key}` : key, value, kind: "other" });
  }
  return { title: def?.title ?? "Form", rows };
}

/** The address line saved to a contact from a delivery-address answer (spec 5.7). Max 500 characters. */
export function flowAddressLine(data: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const street = s(data.street);
  const areaId = s(data.area);
  const area = DELIVERY_AREAS[areaId] ?? areaId;
  const landmark = s(data.landmark);
  const head = [street, area].filter(Boolean).join(", ");
  const line = `${head}${head ? "." : ""}${landmark ? `${head ? " " : ""}Landmark: ${landmark}` : ""}`;
  return line.slice(0, 500);
}

// ── Management screen states (spec 5.8) ──────────────────────────────────────

export type FlowState =
  | "not_created"
  | "draft_invalid"
  | "draft_ready"
  | "live"
  | "live_update_waiting"
  | "retired"
  | "blocked"
  | "throttled";

export function flowState(row: { status: string; validationErrors: readonly unknown[]; codeIsNewer: boolean } | null): FlowState {
  if (!row) return "not_created";
  switch (row.status.toUpperCase()) {
    case "PUBLISHED":
      return row.codeIsNewer ? "live_update_waiting" : "live";
    case "DEPRECATED":
      return "retired";
    case "BLOCKED":
      return "blocked";
    case "THROTTLED":
      return "throttled";
    default:
      return row.validationErrors.length > 0 ? "draft_invalid" : "draft_ready";
  }
}
