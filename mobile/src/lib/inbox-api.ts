/**
 * Typed calls for /v1/inbox (apps/api/src/routes/inbox.ts) and the staff voice
 * routes at /v1/inbox/voice (apps/api/src/routes/voice.ts). Mirrors
 * apps/admin/src/lib/inbox-api.ts. Query keys all start with "inbox" so a push
 * or app-focus can refetch everything at once.
 */
import { api } from "./api";
import type {
  ContactInfo,
  ConversationDetail,
  ConversationPage,
  InboxMe,
  InboxTemplate,
  NotifyLevel,
  QuickReply,
  StaffMember,
  TimelineItem,
  UploadTicket,
} from "./inbox-types";

export const inboxKeys = {
  all: ["inbox"] as const,
  me: ["inbox", "me"] as const,
  staff: ["inbox", "staff"] as const,
  lists: ["inbox", "conversations"] as const,
  list: (f: ConversationFilters) => ["inbox", "conversations", f] as const,
  conversation: (id: string) => ["inbox", "conversation", id] as const,
  timeline: (id: string) => ["inbox", "timeline", id] as const,
  contact: (customerId: string) => ["inbox", "contact", customerId] as const,
  templates: ["inbox", "templates"] as const,
  quickReplies: ["inbox", "quick-replies"] as const,
  notifications: ["inbox", "notifications"] as const,
};

export interface ConversationFilters {
  status: "open" | "closed";
  view: "mine" | "unassigned" | "team" | "all";
  number?: string;
  q?: string;
}

function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) if (v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export type SendMediaType = "image" | "document" | "audio" | "video";

export const inboxApi = {
  me: async () => (await api<{ data: InboxMe }>("/inbox/me")).data,
  staff: async () => (await api<{ data: StaffMember[] }>("/inbox/staff")).data,

  conversations: (f: ConversationFilters, before?: string) =>
    api<ConversationPage>(`/inbox/conversations${qs({ status: f.status, view: f.view, number: f.number, q: f.q, before })}`),
  conversation: async (id: string) => (await api<{ data: ConversationDetail }>(`/inbox/conversations/${id}`)).data,
  timeline: async (id: string) => (await api<{ data: TimelineItem[] }>(`/inbox/conversations/${id}/timeline`)).data,

  markRead: (id: string) => api(`/inbox/conversations/${id}/read`, { method: "POST" }),
  typing: (id: string) => api(`/inbox/conversations/${id}/typing`, { method: "POST" }),

  sendText: (id: string, body: string) =>
    api(`/inbox/conversations/${id}/messages`, { method: "POST", body: { type: "text", body } }),
  /** `media_token` comes from the /uploads response; the API returns 403 without it. */
  sendMedia: (
    id: string,
    m: { type: SendMediaType; media_key: string; media_token: string; mime: string; filename?: string; caption?: string },
  ) => api(`/inbox/conversations/${id}/messages`, { method: "POST", body: m }),
  sendTemplate: (id: string, t: { name: string; language: string; params: string[] }) =>
    api(`/inbox/conversations/${id}/messages`, { method: "POST", body: { type: "template", ...t } }),

  addNote: (id: string, body: string) => api(`/inbox/conversations/${id}/notes`, { method: "POST", body: { body } }),

  patchConversation: (
    id: string,
    patch: { assignee_id?: string | null; status?: "open" | "pending" | "closed"; labels?: string[] },
  ) => api<{ data: unknown }>(`/inbox/conversations/${id}`, { method: "PATCH", body: patch }),

  /**
   * Upload a local file (file:// or content:// uri): ask the API for a
   * presigned PUT, send the bytes straight to storage, and return what the
   * message send needs (including the media_token).
   */
  upload: async (file: { uri: string; name: string; mimeType: string; size?: number | null }): Promise<UploadTicket> => {
    // Read the local file first: the pickers don't always report a size.
    const blob = await (await fetch(file.uri)).blob();
    const size = file.size && file.size > 0 ? file.size : blob.size;
    const ticket = (
      await api<{ data: UploadTicket }>("/inbox/uploads", {
        method: "POST",
        body: { filename: file.name, content_type: file.mimeType, size_bytes: size },
      })
    ).data;
    const put = await fetch(ticket.upload_url, { method: "PUT", body: blob, headers: { "content-type": file.mimeType } });
    if (!put.ok) throw new Error("The file didn't upload. Check your connection and try again.");
    return ticket;
  },

  mediaUrl: async (messageId: string) =>
    (await api<{ data: { url: string; mime: string | null } }>(`/inbox/messages/${messageId}/media`)).data,
  recordingUrl: async (recordingId: string) =>
    (await api<{ data: { url: string } }>(`/inbox/recordings/${recordingId}/url`)).data.url,

  templates: async () => (await api<{ data: InboxTemplate[] }>("/inbox/templates")).data,
  quickReplies: async () => (await api<{ data: QuickReply[] }>("/inbox/quick-replies")).data,

  contact: async (customerId: string) => (await api<{ data: ContactInfo }>(`/inbox/contacts/${customerId}`)).data,
  patchContact: (customerId: string, b: { name?: string; notes?: string | null }) =>
    api(`/inbox/contacts/${customerId}`, { method: "PATCH", body: b }),

  // ── This phone ──
  registerDevice: (token: string, platform: "ios" | "android") =>
    api("/inbox/devices", { method: "POST", body: { token, platform } }),
  unregisterDevice: (token: string) => api("/inbox/devices", { method: "DELETE", body: { token } }),
  notificationLevel: async () => (await api<{ data: { level: NotifyLevel } }>("/inbox/notifications")).data.level,
  setNotificationLevel: async (level: NotifyLevel) =>
    (await api<{ data: { level: NotifyLevel } }>("/inbox/notifications", { method: "PUT", body: { level } })).data.level,
};

export const voiceApi = {
  token: async (platform: "ios" | "android") =>
    (await api<{ data: { token: string; identity: string; ttl: number } }>(`/inbox/voice/token?platform=${platform}`)).data,
  presence: (available: boolean) => api("/inbox/voice/presence", { method: "POST", body: { available } }),
  /** ref = the incoming call's custom parameter `callId`. 409 = someone else answered first. */
  accepted: (ref: string) => api(`/inbox/voice/calls/${encodeURIComponent(ref)}/accepted`, { method: "POST" }),
};
