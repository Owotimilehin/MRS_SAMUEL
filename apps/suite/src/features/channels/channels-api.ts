/** Calls for /v1/channels (suite spec 01). */
import { api } from "@admin/lib/api.js";
import type { ChannelKind } from "@ms/shared";

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  label: string;
  e164: string | null;
  external_id: string | null;
  page_external_id: string | null;
  /** The Page name, or the Instagram username without "@". */
  external_name: string | null;
  /** Phone lines only: voice | whatsapp | both. */
  channels: "voice" | "whatsapp" | "both";
  default_team_id: string | null;
  team_name: string | null;
  hours_profile_id: string | null;
  hours_profile_name: string | null;
  is_active: boolean;
  open_conversations: number;
  /** Spec 02: when Meta was last told to send this Page's messages to us (absent on older servers). */
  webhook_subscribed_at?: string | null;
  /** Spec 02: why messages on this channel are not coming in or going out, in plain words. */
  problem_text?: string | null;
  problem_at?: string | null;
}

export interface NamedOption {
  id: string;
  name: string;
}

export interface ChannelList {
  data: ChannelRow[];
  /** Active teams, for "Team for new chats". */
  teams: NamedOption[];
  /** Opening-hours profiles, for "Opening hours". */
  hours_profiles: NamedOption[];
}

export interface AvailablePage {
  page_id: string;
  name: string;
  can_message: boolean;
  messenger_connected: boolean;
  instagram: { id: string; username: string | null; connected: boolean } | null;
}

export interface ConnectInput {
  page_id: string;
  messenger: boolean;
  instagram: boolean;
  label_messenger?: string;
  label_instagram?: string;
  default_team_id: string | null;
  hours_profile_id: string | null;
}

export interface CheckResult {
  ok: boolean;
  problem: string | null;
  external_name: string | null;
}

export const channelKeys = {
  list: ["channels"] as const,
  available: ["channels", "available"] as const,
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const channelsApi = {
  list: () => api<ChannelList>("/channels"),
  available: async () => (await api<{ data: AvailablePage[] }>("/channels/available")).data,
  lookUp: async (pageId: string) =>
    (await api<{ data: AvailablePage }>(`/channels/available/${encodeURIComponent(pageId)}`)).data,
  /** The dialog shows the server's sentence itself, so no toast. */
  connect: async (b: ConnectInput) =>
    (await api<{ data: ChannelRow[] }>("/channels/connect", json("POST", b), { silentError: true })).data,
  update: async (id: string, b: { label?: string; default_team_id?: string | null; hours_profile_id?: string | null; is_active?: boolean }) =>
    (await api<{ data: ChannelRow }>(`/channels/${id}`, json("PATCH", b))).data,
  check: async (id: string) => (await api<{ data: CheckResult }>(`/channels/${id}/check`, { method: "POST" })).data,
};
