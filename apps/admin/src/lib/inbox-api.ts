/**
 * Typed calls for the unified inbox, built on the shared `api()` wrapper (which
 * adds idempotency keys, retries, token refresh and friendly error toasts).
 * Query keys all start with "inbox" so a reconnect can refetch everything.
 */
import { api, ApiError, humanizeError } from "./api.js";
import { toast } from "./toast.js";
import type {
  ContactInfo,
  ContactSearchHit,
  ConversationDetail,
  ConversationPage,
  EraseResult,
  InboxMe,
  InboxTeamLite,
  InboxTemplate,
  NotifyLevel,
  QuickReply,
  StaffMember,
  TimelinePage,
} from "./inbox-types.js";

export const inboxKeys = {
  all: ["inbox"] as const,
  me: ["inbox", "me"] as const,
  staff: ["inbox", "staff"] as const,
  teams: ["inbox", "teams"] as const,
  lists: ["inbox", "conversations"] as const,
  list: (f: ConversationFilters) => ["inbox", "conversations", f] as const,
  conversation: (id: string) => ["inbox", "conversation", id] as const,
  timeline: (id: string) => ["inbox", "timeline", id] as const,
  contact: (customerId: string) => ["inbox", "contact", customerId] as const,
  templates: ["inbox", "templates"] as const,
  quickReplies: ["inbox", "quick-replies"] as const,
  unread: ["inbox", "unread"] as const,
  notifyLevel: ["inbox", "notify-level"] as const,
};

export interface ConversationFilters {
  status: "open" | "pending" | "closed" | "all";
  view: "mine" | "unassigned" | "team" | "all";
  number?: string;
  label?: string;
  q?: string;
}

/**
 * POST a message. A send that fails comes back as 502 with the failed message
 * in the body (it still shows in the timeline: red when WhatsApp refused it,
 * amber when WhatsApp never answered), so give that its own wording instead of
 * the generic gateway error.
 */
async function postMessage(id: string, payload: Record<string, unknown>): Promise<unknown> {
  try {
    return await api(`/inbox/conversations/${id}/messages`, { method: "POST", body: JSON.stringify(payload) }, { silentError: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) {
      // The body is the failed message itself, which api() doesn't hand back, so
      // we can't tell "refused" (red) from "no answer" (amber) here — the chat shows which.
      toast.error("That message didn't go through normally. Check how it's marked in the chat before sending again.");
    } else {
      toast.error(humanizeError(err));
    }
    throw err;
  }
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const inboxApi = {
  me: async () => (await api<{ data: InboxMe }>("/inbox/me")).data,
  unread: async () =>
    (await api<{ data: { messages: number; conversations: number } }>("/inbox/unread")).data,
  notifyLevel: async () => (await api<{ data: { level: NotifyLevel } }>("/inbox/notifications")).data.level,
  setNotifyLevel: async (level: NotifyLevel) =>
    (await api<{ data: { level: NotifyLevel } }>("/inbox/notifications", { method: "PUT", body: JSON.stringify({ level }) })).data.level,
  staff: async () => (await api<{ data: StaffMember[] }>("/inbox/staff")).data,
  teams: async () => (await api<{ data: InboxTeamLite[] }>("/inbox/teams")).data,

  conversations: (f: ConversationFilters, before?: string) =>
    api<ConversationPage>(
      `/inbox/conversations${qs({ status: f.status, view: f.view, number: f.number, label: f.label, q: f.q, before })}`,
    ),
  conversation: async (id: string) => (await api<{ data: ConversationDetail }>(`/inbox/conversations/${id}`)).data,
  /**
   * One page of the timeline, oldest → newest. No `before` = the newest items
   * (the server's default is 100); pass a page's `next_before` for the one before it.
   */
  timeline: async (id: string, before?: string, limit?: number): Promise<TimelinePage> => {
    const res = await api<Partial<TimelinePage> & { data: TimelinePage["data"] }>(
      `/inbox/conversations/${id}/timeline${qs({ before, limit: limit ? String(limit) : undefined })}`,
    );
    return { data: res.data, has_more: res.has_more === true, next_before: res.next_before ?? null };
  },

  markRead: (id: string) =>
    api(`/inbox/conversations/${id}/read`, { method: "POST" }, { silentError: true }),
  typing: (id: string) =>
    api(`/inbox/conversations/${id}/typing`, { method: "POST" }, { silentError: true }),

  sendText: (id: string, body: string) => postMessage(id, { type: "text", body }),
  sendMedia: (
    id: string,
    m: {
      type: "image" | "document" | "audio" | "video";
      media_key: string;
      media_token: string;
      mime: string;
      filename?: string;
      caption?: string;
    },
  ) => postMessage(id, m),
  sendTemplate: (id: string, t: { name: string; language: string; params: string[] }) =>
    postMessage(id, { type: "template", ...t }),

  addNote: (id: string, body: string) =>
    api(`/inbox/conversations/${id}/notes`, { method: "POST", body: JSON.stringify({ body }) }),

  patchConversation: (
    id: string,
    patch: { assignee_id?: string | null; team_id?: string | null; status?: "open" | "pending" | "closed"; labels?: string[] },
  ) => api<{ data: unknown }>(`/inbox/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  /**
   * Presign, then PUT the bytes straight to storage. Returns the key and the
   * one-time media_token the send call must echo back (proves this user uploaded it).
   */
  upload: async (
    file: File,
  ): Promise<{ object_key: string; media_token: string; kind: "image" | "document" | "audio" | "video" }> => {
    const contentType = file.type || "application/octet-stream";
    const res = await api<{
      data: { upload_url: string; object_key: string; media_token: string; kind: "image" | "document" | "audio" | "video" };
    }>(
      "/inbox/uploads",
      { method: "POST", body: JSON.stringify({ filename: file.name, content_type: contentType, size_bytes: file.size }) },
    );
    const put = await fetch(res.data.upload_url, { method: "PUT", body: file, headers: { "content-type": contentType } });
    if (!put.ok) throw new Error("The file didn't upload. Check your connection and try again.");
    return { object_key: res.data.object_key, media_token: res.data.media_token, kind: res.data.kind };
  },

  mediaUrl: async (messageId: string, download = false) =>
    (await api<{ data: { url: string; mime: string | null } }>(`/inbox/messages/${messageId}/media${download ? "?download=1" : ""}`)).data,
  recordingUrl: async (recordingId: string, download = false) =>
    (await api<{ data: { url: string } }>(`/inbox/recordings/${recordingId}/url${download ? "?download=1" : ""}`)).data.url,

  /** Permanently removes the audio, transcript and summary (recordings.delete). */
  deleteRecording: (recordingId: string) => api<{ ok: true }>(`/inbox/recordings/${recordingId}`, { method: "DELETE" }),

  templates: async () => (await api<{ data: InboxTemplate[] }>("/inbox/templates")).data,
  syncTemplates: async () => (await api<{ data: { synced: number } }>("/inbox/templates/sync", { method: "POST" })).data,
  quickReplies: async () => (await api<{ data: QuickReply[] }>("/inbox/quick-replies")).data,
  createQuickReply: (b: { title: string; body: string }) =>
    api("/inbox/quick-replies", { method: "POST", body: JSON.stringify(b) }),
  updateQuickReply: (id: string, b: { title?: string; body?: string }) =>
    api(`/inbox/quick-replies/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteQuickReply: (id: string) => api(`/inbox/quick-replies/${id}`, { method: "DELETE" }),

  contact: async (customerId: string) => (await api<{ data: ContactInfo }>(`/inbox/contacts/${customerId}`)).data,
  patchContact: (customerId: string, b: { name?: string; notes?: string | null }) =>
    api(`/inbox/contacts/${customerId}`, { method: "PATCH", body: JSON.stringify(b) }),
  searchContacts: async (q: string) =>
    (await api<{ data: ContactSearchHit[] }>(`/inbox/contacts/search${qs({ q })}`)).data,
  /** Permanently removes this customer's chats, calls, recordings and notes (inbox.erase). Orders stay. */
  eraseContact: async (customerId: string, confirmPhone: string) =>
    (
      await api<{ data: EraseResult }>(`/inbox/contacts/${customerId}/erase`, {
        method: "POST",
        body: JSON.stringify({ confirm_phone: confirmPhone }),
      })
    ).data,
  /** Moves this contact's chats and calls onto another contact (inbox.erase). */
  mergeContact: async (customerId: string, intoCustomerId: string) =>
    (
      await api<{ data: { moved_conversations: number } }>(`/inbox/contacts/${customerId}/merge`, {
        method: "POST",
        body: JSON.stringify({ into_customer_id: intoCustomerId }),
      })
    ).data,
};

/** Plain link (cookies ride along) — the browser downloads the CSV. */
export const CONTACTS_CSV_URL = "/v1/inbox/export/contacts.csv";
