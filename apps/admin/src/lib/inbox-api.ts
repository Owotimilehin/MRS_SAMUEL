/**
 * Typed calls for the unified inbox, built on the shared `api()` wrapper (which
 * adds idempotency keys, retries, token refresh and friendly error toasts).
 * Query keys all start with "inbox" so a reconnect can refetch everything.
 */
import { api, ApiError, humanizeError } from "./api.js";
import { toast } from "./toast.js";
import type {
  CatalogueSendable,
  ChatOrderList,
  ContactInfo,
  ContactSearchHit,
  ConversationDetail,
  ConversationPage,
  EraseResult,
  FlowActionResult,
  FlowResponseAction,
  InboxFlow,
  InboxMe,
  InboxTeamLite,
  InboxTemplate,
  NotifyLevel,
  PlaceChatOrderInput,
  PlacedChatOrder,
  QuickReply,
  ReminderRow,
  StaffMember,
  TimelinePage,
} from "./inbox-types.js";

export const inboxKeys = {
  all: ["inbox"] as const,
  me: ["inbox", "me"] as const,
  staff: ["inbox", "staff"] as const,
  teams: ["inbox", "teams"] as const,
  lists: ["inbox", "conversations"] as const,
  /** The inbox's own paged list (useInfiniteQuery). Its cache holds { pages, pageParams }. */
  list: (f: ConversationFilters) => ["inbox", "conversations", f] as const,
  /**
   * One plain page of conversations (useQuery), for screens such as Overview and Tasks.
   * Must never equal `list`: the two cache shapes differ, and the inbox crashed reading
   * a plain page as a paged one ("reading 'length'"). Still under `lists`, so
   * invalidating `lists` refreshes both.
   */
  listFirstPage: (f: ConversationFilters) => ["inbox", "conversations", f, "first-page"] as const,
  conversation: (id: string) => ["inbox", "conversation", id] as const,
  timeline: (id: string) => ["inbox", "timeline", id] as const,
  contact: (customerId: string) => ["inbox", "contact", customerId] as const,
  templates: ["inbox", "templates"] as const,
  quickReplies: ["inbox", "quick-replies"] as const,
  unread: ["inbox", "unread"] as const,
  notifyLevel: ["inbox", "notify-level"] as const,
  /** Forms that can be sent (spec 07). With a conversation, "live" is for that chat's WhatsApp account. */
  flows: ["inbox", "flows"] as const,
  flowsFor: (conversationId: string) => ["inbox", "flows", conversationId] as const,
  // Selling in chat (suite spec 08).
  catalogueSendable: ["inbox", "catalogue-sendable"] as const,
  chatOrders: (conversationId: string) => ["inbox", "chat-orders", conversationId] as const,
  // Tasks and reminders (suite spec 15).
  reminders: ["inbox", "reminders"] as const,
  reminderList: (f: ReminderFilter) => ["inbox", "reminders", f] as const,
  remindersDue: ["inbox", "reminders", "due-count"] as const,
  replyTarget: ["inbox", "reply-target"] as const,
};

/** Which reminders to list (suite spec 15). */
export type ReminderFilter =
  | { view: "due" | "upcoming" | "everyone" | "done" }
  | { conversationId: string }
  | { customerId: string };

export interface ReminderInput {
  note: string;
  due_at: string;
  assignee_id?: string;
  conversation_id?: string;
  customer_id?: string;
}

export interface ConversationFilters {
  status: "open" | "pending" | "snoozed" | "closed" | "all";
  view: "mine" | "unassigned" | "team" | "all";
  number?: string;
  label?: string;
  q?: string;
  /** Only chats from this channel (spec 02). */
  channel?: "whatsapp" | "messenger" | "instagram";
  /** Only conversations with messages; call-only ones are left out (the suite keeps calls separate). */
  chatsOnly?: boolean;
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
      `/inbox/conversations${qs({ status: f.status, view: f.view, number: f.number, label: f.label, q: f.q, channel: f.channel, chats_only: f.chatsOnly ? "1" : undefined, before })}`,
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
  sendTemplate: (
    id: string,
    t: {
      name: string;
      language: string;
      params: string[];
      /** The blank in a text heading. */
      header_param?: string;
      /** The uploaded picture, video or document for the heading. */
      header_media?: { media_key: string; media_token: string; mime: string; filename?: string };
      /** The end of the link for each link button with a blank. */
      button_params?: { index: number; text: string }[];
    },
  ) => postMessage(id, { type: "template", ...t }),

  /** Forms the composer can offer (spec 07). */
  flows: async (conversationId?: string) =>
    (await api<{ data: InboxFlow[] }>(`/inbox/flows${qs({ conversation_id: conversationId })}`)).data,
  /**
   * Send a form into the chat. No toast for a refusal (409 window closed or form
   * not live, 403, 400): the picker shows the server's message itself. A 502 is a
   * send that reached the timeline as failed or unconfirmed, worded as for any message.
   */
  sendFlow: async (id: string, f: { flow_key: string; message?: string; test?: boolean }): Promise<unknown> => {
    try {
      return await api(`/inbox/conversations/${id}/flows`, { method: "POST", body: JSON.stringify(f) }, { silentError: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        toast.error("That message didn't go through normally. Check how it's marked in the chat before sending again.");
      }
      throw err;
    }
  },
  /** Mark a form answer handled or not, copy it to the notes, or save its address to the contact. */
  flowResponseAction: async (responseId: string, action: FlowResponseAction) =>
    (
      await api<{ data: FlowActionResult }>(`/inbox/flow-responses/${responseId}/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      })
    ).data,

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
    /** When given, the server checks the file against that conversation's channel (spec 02). */
    conversationId?: string,
  ): Promise<{ object_key: string; media_token: string; kind: "image" | "document" | "audio" | "video" }> => {
    const contentType = file.type || "application/octet-stream";
    const res = await api<{
      data: { upload_url: string; object_key: string; media_token: string; kind: "image" | "document" | "audio" | "video" };
    }>(
      "/inbox/uploads",
      {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          content_type: contentType,
          size_bytes: file.size,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        }),
      },
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
  /**
   * Permanently removes this customer's chats, calls, recordings, notes and
   * channel identities (inbox.erase). Orders stay. `confirm` is the phone,
   * username, name or the word DELETE (see eraseConfirmTarget).
   */
  eraseContact: async (customerId: string, confirm: string) =>
    (
      await api<{ data: EraseResult }>(`/inbox/contacts/${customerId}/erase`, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      })
    ).data,
  /** Moves this contact's chats and calls onto another contact (inbox.erase). */
  mergeContact: async (customerId: string, intoCustomerId: string) =>
    (
      await api<{ data: { moved_conversations: number; moved_identities?: number } }>(`/inbox/contacts/${customerId}/merge`, {
        method: "POST",
        body: JSON.stringify({ into_customer_id: intoCustomerId }),
      })
    ).data,

  // ── Selling in chat (suite spec 08) ──
  /** What can be sent from the catalogue. `catalog_id` is null when nothing is connected (not an error). */
  catalogueSendable: async () => (await api<{ data: CatalogueSendable }>("/catalogue/sendable")).data,
  /** One product, or a product list for two to thirty. */
  sendProducts: (id: string, retailerIds: string[], text?: string) =>
    postMessage(id, { type: "product", retailer_ids: retailerIds, ...(text ? { text } : {}) }),
  /** The whole menu. */
  sendCatalogue: (id: string, text?: string) => postMessage(id, { type: "catalogue", ...(text ? { text } : {}) }),
  /** Carts this customer sent in this chat, newest first, at the shop's own prices. */
  chatOrders: (conversationId: string) => api<ChatOrderList>(`/inbox/chat-orders${qs({ conversation_id: conversationId })}`),
  /** Ask "delivery or pickup?" with two buttons. The caller shows what happened. */
  askChatOrder: (id: string) => api(`/inbox/chat-orders/${id}/ask`, { method: "POST" }, { silentError: true }),
  /** One click: create the shop order from the cart and send the OPay link. Safe to repeat: one cart is one order. */
  placeChatOrder: async (id: string, b: PlaceChatOrderInput) =>
    (await api<{ data: PlacedChatOrder }>(`/inbox/chat-orders/${id}/place`, { method: "POST", body: JSON.stringify(b) }, { silentError: true })).data,
  sendPaymentLink: async (id: string) =>
    (await api<{ data: { order_number: string; payment_link: string | null; warning?: string } }>(`/inbox/chat-orders/${id}/payment-link`, { method: "POST" })).data,
  cancelChatOrder: (id: string) => api(`/inbox/chat-orders/${id}/cancel`, { method: "POST" }),

  // ── Tasks and reminders (suite spec 15) ──
  snooze: (conversationId: string, until: Date) =>
    api(`/inbox/tasks/snooze/${conversationId}`, { method: "POST", body: JSON.stringify({ until: until.toISOString() }) }),
  unsnooze: (conversationId: string) => api(`/inbox/tasks/snooze/${conversationId}`, { method: "DELETE" }),
  reminders: async (f: ReminderFilter) => {
    const q =
      "view" in f ? qs({ view: f.view }) : "conversationId" in f ? qs({ conversation_id: f.conversationId }) : qs({ customer_id: f.customerId });
    return (await api<{ data: ReminderRow[] }>(`/inbox/tasks/reminders${q}`)).data;
  },
  remindersDue: async () => (await api<{ data: { due: number } }>("/inbox/tasks/reminders/count")).data.due,
  addReminder: (b: ReminderInput) => api<{ data: unknown }>("/inbox/tasks/reminders", { method: "POST", body: JSON.stringify(b) }),
  updateReminder: (id: string, b: { note?: string; due_at?: string; assignee_id?: string; done?: boolean }) =>
    api<{ data: unknown }>(`/inbox/tasks/reminders/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteReminder: (id: string) => api(`/inbox/tasks/reminders/${id}`, { method: "DELETE" }),
  replyTarget: async () =>
    (await api<{ data: { target_minutes: number | null; late: number; longest_minutes: number | null } }>("/inbox/tasks/reply-target")).data,
};

/** Plain link (cookies ride along) — the browser downloads the CSV. */
export const CONTACTS_CSV_URL = "/v1/inbox/export/contacts.csv";
