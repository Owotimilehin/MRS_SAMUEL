/**
 * Typed calls for the unified inbox, built on the shared `api()` wrapper (which
 * adds idempotency keys, retries, token refresh and friendly error toasts).
 * Query keys all start with "inbox" so a reconnect can refetch everything.
 */
import { api, ApiError, humanizeError } from "./api.js";
import { toast } from "./toast.js";
import type {
  ContactInfo,
  ConversationDetail,
  ConversationPage,
  InboxMe,
  InboxTeamLite,
  InboxTemplate,
  QuickReply,
  StaffMember,
  TimelineItem,
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
};

export interface ConversationFilters {
  status: "open" | "pending" | "closed" | "all";
  view: "mine" | "unassigned" | "team" | "all";
  number?: string;
  label?: string;
  q?: string;
}

/**
 * POST a message. A send WhatsApp refuses comes back as 502 with the failed
 * message in the body (it still shows in the timeline, in red), so give that
 * its own wording instead of the generic gateway error.
 */
async function postMessage(id: string, payload: Record<string, unknown>): Promise<unknown> {
  try {
    return await api(`/inbox/conversations/${id}/messages`, { method: "POST", body: JSON.stringify(payload) }, { silentError: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) {
      toast.error("WhatsApp didn't accept that message. It's marked in red in the chat.");
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
  staff: async () => (await api<{ data: StaffMember[] }>("/inbox/staff")).data,
  teams: async () => (await api<{ data: InboxTeamLite[] }>("/inbox/teams")).data,

  conversations: (f: ConversationFilters, before?: string) =>
    api<ConversationPage>(
      `/inbox/conversations${qs({ status: f.status, view: f.view, number: f.number, label: f.label, q: f.q, before })}`,
    ),
  conversation: async (id: string) => (await api<{ data: ConversationDetail }>(`/inbox/conversations/${id}`)).data,
  timeline: async (id: string) => (await api<{ data: TimelineItem[] }>(`/inbox/conversations/${id}/timeline`)).data,

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
};

/** Plain link (cookies ride along) — the browser downloads the CSV. */
export const CONTACTS_CSV_URL = "/v1/inbox/export/contacts.csv";
