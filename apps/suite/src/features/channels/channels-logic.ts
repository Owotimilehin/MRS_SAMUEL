/**
 * Pure rules for the Channels page (suite spec 01, section 7), kept apart from
 * React so they can be tested.
 */
import { prettyPhone } from "@admin/lib/inbox-logic.js";
import type { ChannelRow } from "./channels-api.js";

type RowFacts = Pick<ChannelRow, "kind" | "channels" | "e164" | "external_name">;

/** The "Used for" column. */
export function usedForText(row: Pick<RowFacts, "kind" | "channels">): string {
  switch (row.kind) {
    case "messenger":
      return "Facebook Messenger";
    case "instagram":
      return "Instagram messages";
    case "phone":
    default:
      if (row.channels === "voice") return "Calls only";
      if (row.channels === "whatsapp") return "WhatsApp only";
      return "WhatsApp and calls";
  }
}

/** The grey line under the channel's name. */
export function secondLine(row: RowFacts): string {
  switch (row.kind) {
    case "messenger":
      return `Facebook Page: ${row.external_name ?? ""}`.trim();
    case "instagram":
      return `Instagram: @${row.external_name ?? ""}`;
    case "phone":
    default:
      return prettyPhone(row.e164);
  }
}

/** The read-only line in the edit dialog. */
export function connectedToText(row: Pick<RowFacts, "kind" | "external_name">): string {
  return row.kind === "instagram"
    ? `Connected to Instagram: @${row.external_name ?? ""}`
    : `Connected to Facebook Page: ${row.external_name ?? ""}`;
}

// ── Connect dialog ───────────────────────────────────────────────────────────

export type ConnectKind = "messenger" | "instagram";

/** What is ticked in the connect dialog. Only one Page per run. */
export interface ConnectSelection {
  pageId: string | null;
  messenger: boolean;
  instagram: boolean;
  labels: Record<ConnectKind, string>;
}

export const DEFAULT_CONNECT_LABELS: Record<ConnectKind, string> = { messenger: "Facebook Page", instagram: "Instagram" };

export function emptySelection(): ConnectSelection {
  return { pageId: null, messenger: false, instagram: false, labels: { ...DEFAULT_CONNECT_LABELS } };
}

/** Tick or untick a box. Ticking a box on another Page unticks the first Page's boxes. */
export function toggleBox(sel: ConnectSelection, pageId: string, kind: ConnectKind, on: boolean): ConnectSelection {
  const base = sel.pageId === pageId ? sel : { ...sel, pageId, messenger: false, instagram: false };
  const next = { ...base, [kind]: on };
  if (!next.messenger && !next.instagram) return { ...next, pageId: null };
  return next;
}

/** The Connect button works once a box is ticked and every ticked box has a name (1 to 60 characters). */
export function connectReady(sel: ConnectSelection): boolean {
  if (!sel.pageId || (!sel.messenger && !sel.instagram)) return false;
  const ok = (label: string): boolean => label.trim().length > 0 && label.trim().length <= 60;
  return (!sel.messenger || ok(sel.labels.messenger)) && (!sel.instagram || ok(sel.labels.instagram));
}

/** "Connected: Facebook and Instagram." */
export function connectedToast(labels: readonly string[]): string {
  return `Connected: ${labels.join(" and ")}.`;
}
