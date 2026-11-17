import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, UserRound } from "lucide-react";
import type { Capability } from "@ms/shared";
import { Shell } from "../../components/Shell.js";
import { DataState } from "../../components/DataState.js";
import { Modal } from "../../components/Modal.js";
import { ConversationList } from "../../components/inbox/ConversationList.js";
import { ConversationHeader } from "../../components/inbox/ConversationHeader.js";
import { Timeline, TypingLine } from "../../components/inbox/Timeline.js";
import { Composer } from "../../components/inbox/Composer.js";
import { ContactPanel } from "../../components/inbox/ContactPanel.js";
import "../../components/inbox/inbox.css";
import { useAuthUser } from "../../lib/auth.js";
import { ApiError, humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import { CONTACTS_CSV_URL, inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { applyEarlierPage, applyNewestPage, inboxTabsFor, staffLabel, type InboxTabKey, type LoadedTimeline } from "../../lib/inbox-logic.js";
import { useInboxEvents } from "../../lib/inbox-stream.js";
import { useInboxUi } from "../../lib/inbox-ui.js";
import type { InboxEvent } from "../../lib/inbox-types.js";

const TYPING_SHOW_MS = 6000;

/** The unified inbox: conversation list, open chat, contact panel. */
export function InboxPage({ conversationId }: { conversationId?: string }): JSX.Element {
  const user = useAuthUser();
  const can = useCallback((c: string) => user.capabilities.includes(c as Capability), [user.capabilities]);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, staleTime: 60_000 });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, staleTime: 5 * 60_000, enabled: me.isSuccess });
  const teams = useQuery({ queryKey: inboxKeys.teams, queryFn: inboxApi.teams, staleTime: 5 * 60_000, enabled: me.isSuccess });

  const tabs = useMemo(() => inboxTabsFor(user.capabilities, me.data?.team_ids ?? []), [user.capabilities, me.data?.team_ids]);
  const ui = useInboxUi();
  const activeTab: InboxTabKey = tabs.some((t) => t.key === ui.tab) ? ui.tab : "mine";
  const [contactOpen, setContactOpen] = useState(false);
  const [typing, setTyping] = useState<{ convId: string; name: string; until: number } | null>(null);

  const conv = useQuery({
    queryKey: inboxKeys.conversation(conversationId ?? ""),
    queryFn: () => inboxApi.conversation(conversationId!),
    enabled: !!conversationId && me.isSuccess,
  });
  // The cache holds everything loaded so far (newest page + any earlier pages
  // the person asked for). A refetch only fetches the newest page and folds it
  // in, so live updates never throw the earlier pages away.
  const timeline = useQuery({
    queryKey: inboxKeys.timeline(conversationId ?? ""),
    queryFn: async (): Promise<LoadedTimeline> => {
      const key = inboxKeys.timeline(conversationId!);
      const page = await inboxApi.timeline(conversationId!);
      return applyNewestPage(qc.getQueryData<LoadedTimeline>(key), page);
    },
    enabled: !!conversationId && me.isSuccess,
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadEarlier = useCallback(async () => {
    if (!conversationId) return;
    const key = inboxKeys.timeline(conversationId);
    const before = qc.getQueryData<LoadedTimeline>(key)?.nextBefore;
    if (!before) return;
    setLoadingEarlier(true);
    try {
      const page = await inboxApi.timeline(conversationId, before);
      qc.setQueryData<LoadedTimeline>(key, (prev) => applyEarlierPage(prev, page));
    } catch (err) {
      toast.error(`Couldn't load earlier messages: ${humanizeError(err)}`);
    } finally {
      setLoadingEarlier(false);
    }
  }, [conversationId, qc]);

  // ── Mark read on open (and when new messages arrive while it's on screen) ──
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markRead = useCallback(
    (id: string) => {
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        void inboxApi
          .markRead(id)
          .then(() => qc.invalidateQueries({ queryKey: inboxKeys.lists }))
          .catch(() => undefined);
      }, 400);
    },
    [qc],
  );
  useEffect(() => {
    if (conversationId && me.isSuccess) markRead(conversationId);
    setContactOpen(false);
  }, [conversationId, me.isSuccess, markRead]);

  // ── Live updates ──
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLists = useCallback(() => {
    if (listTimer.current) return;
    listTimer.current = setTimeout(() => {
      listTimer.current = null;
      void qc.invalidateQueries({ queryKey: inboxKeys.lists });
      void qc.invalidateQueries({ queryKey: inboxKeys.unread });
    }, 500);
  }, [qc]);

  const onEvent = useCallback(
    (e: InboxEvent) => {
      const open = conversationId && e.conversationId === conversationId;
      switch (e.event) {
        case "reconnected":
          void qc.invalidateQueries({ queryKey: inboxKeys.all });
          return;
        case "session.ended":
          void qc.invalidateQueries({ queryKey: inboxKeys.me });
          return;
        case "conversation.typing": {
          if (!open || !e.id || e.id === me.data?.user_id) return;
          const who = staffLabel(staff.data?.find((s) => s.id === e.id)?.name, "A colleague");
          setTyping({ convId: e.conversationId!, name: who, until: Date.now() + TYPING_SHOW_MS });
          return;
        }
        case "message.created":
          refreshLists();
          if (open) {
            void qc.invalidateQueries({ queryKey: inboxKeys.timeline(conversationId) });
            void qc.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
            setTyping(null);
            if (document.visibilityState === "visible") markRead(conversationId);
          }
          return;
        case "conversation.updated":
          refreshLists();
          if (open) void qc.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
          return;
        case "call.ringing":
          refreshLists();
          return;
        case "message.status":
        case "note.created":
        case "call.updated":
        case "recording.processed":
          if (open) void qc.invalidateQueries({ queryKey: inboxKeys.timeline(conversationId) });
          if (e.event === "call.updated") refreshLists();
          return;
        default:
          return;
      }
    },
    [conversationId, me.data?.user_id, staff.data, qc, refreshLists, markRead],
  );
  useInboxEvents(onEvent, me.isSuccess);

  // Expire the typing line.
  useEffect(() => {
    if (!typing) return;
    const t = setTimeout(() => setTyping(null), Math.max(0, typing.until - Date.now()));
    return () => clearTimeout(t);
  }, [typing]);

  const afterChange = useCallback(() => {
    if (!conversationId) return;
    void qc.invalidateQueries({ queryKey: inboxKeys.timeline(conversationId) });
    void qc.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
    refreshLists();
  }, [conversationId, qc, refreshLists]);

  // The customer's inbox history is gone: forget it and go back to the list.
  const afterErase = useCallback(() => {
    setContactOpen(false);
    if (conversationId) {
      qc.removeQueries({ queryKey: inboxKeys.timeline(conversationId) });
      qc.removeQueries({ queryKey: inboxKeys.conversation(conversationId) });
    }
    void navigate({ to: "/inbox" }).then(() => qc.invalidateQueries({ queryKey: inboxKeys.all }));
  }, [conversationId, navigate, qc]);

  // The chats now belong to another contact: reload so the panel shows them.
  const afterMerge = useCallback(() => {
    setContactOpen(false);
    void qc.invalidateQueries({ queryKey: inboxKeys.all });
  }, [qc]);

  // Make the three panes fill the screen exactly, whatever the top bar's height
  // (it wraps on phones), and leave the strip at the bottom free for the call pill.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const hasGrid = !!me.data;
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const fit = (): void => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const body = el.closest<HTMLElement>(".app-body");
      const pad = body ? parseFloat(getComputedStyle(body).paddingBottom) || 0 : 0;
      el.style.setProperty("--ibx-top", `${Math.round(top)}px`);
      el.style.setProperty("--ibx-pad", `${Math.round(pad)}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    const head = document.querySelector(".app-head");
    const ro = typeof ResizeObserver !== "undefined" && head ? new ResizeObserver(fit) : null;
    if (ro && head) ro.observe(head);
    return () => {
      window.removeEventListener("resize", fit);
      ro?.disconnect();
    };
  }, [hasGrid]);

  const forbidden = me.error instanceof ApiError && me.error.status === 403;
  const typingName = typing && typing.convId === conversationId ? typing.name : null;

  return (
    <Shell
      title="Inbox"
      actions={
        can("inbox.export") ? (
          <a className="btn btn--subtle btn--sm" href={CONTACTS_CSV_URL} download title="Download every contact as a spreadsheet (CSV)">
            <Download size={14} /> Export contacts
          </a>
        ) : undefined
      }
    >
      {forbidden ? (
        <div className="empty">
          <div className="empty__title">No inbox access</div>
          Ask an owner to give you access to the inbox.
        </div>
      ) : (
        <DataState loading={me.isLoading} error={me.error} onRetry={() => void me.refetch()}>
          {me.data && (
            <div ref={gridRef} className={`ibx${conversationId ? " has-open" : ""}`}>
              <section className="ibx__pane ibx-list-pane" aria-label="Conversations">
                <ConversationList
                  me={me.data}
                  tabs={tabs}
                  tab={activeTab}
                  onTab={ui.setTab}
                  number={ui.number}
                  onNumber={ui.setNumber}
                  label={ui.label}
                  onLabel={ui.setLabel}
                  selectedId={conversationId ?? null}
                  onSelect={(row) => void navigate({ to: "/inbox/$conversationId", params: { conversationId: row.id } })}
                />
              </section>

              <section className="ibx__pane ibx-main-pane" aria-label="Conversation">
                {!conversationId ? (
                  <div className="ibx__empty-main" style={{ flex: 1 }}>
                    <div>
                      <div className="empty__title">Pick a conversation</div>
                      WhatsApp chats and phone calls with each customer appear together here.
                    </div>
                  </div>
                ) : conv.isLoading || (timeline.isLoading && !timeline.data) ? (
                  <DataState loading error={null} onRetry={() => undefined}>
                    {null}
                  </DataState>
                ) : conv.error || !conv.data ? (
                  <div style={{ padding: 16 }}>
                    <DataState
                      loading={false}
                      error={conv.error ?? new Error("not found")}
                      onRetry={() => void conv.refetch()}
                    >
                      {null}
                    </DataState>
                    <button type="button" className="btn btn--ghost btn--sm ibx-back" onClick={() => void navigate({ to: "/inbox" })}>
                      ← Back to conversations
                    </button>
                  </div>
                ) : (
                  <>
                    <ConversationHeader
                      conv={conv.data}
                      meId={me.data.user_id}
                      staff={staff.data ?? []}
                      teams={teams.data ?? []}
                      can={can}
                      onBack={() => void navigate({ to: "/inbox" })}
                      onChanged={afterChange}
                      onShowContact={() => {
                        // The side panel is already visible on wide screens (same width as inbox.css).
                        if (window.matchMedia?.("(max-width: 1439px)").matches) setContactOpen(true);
                      }}
                    />
                    {timeline.error ? (
                      <div style={{ flex: 1 }}>
                        <DataState loading={false} error={timeline.error} onRetry={() => void timeline.refetch()}>
                          {null}
                        </DataState>
                      </div>
                    ) : (
                      <Timeline
                        key={conversationId}
                        items={timeline.data?.items ?? []}
                        canDownload={can("recordings.download")}
                        canDeleteRecordings={can("recordings.delete")}
                        hasMore={!!timeline.data?.hasMore && !!timeline.data.nextBefore}
                        loadingEarlier={loadingEarlier}
                        onLoadEarlier={() => void loadEarlier()}
                        onChanged={afterChange}
                      />
                    )}
                    <TypingLine name={typingName} />
                    <Composer conv={conv.data} can={can} onSent={afterChange} />
                  </>
                )}
              </section>

              <aside className={`ibx__pane ibx-side-pane ibx-side${conv.data?.customer ? "" : " ibx-side--empty"}`} aria-label="Contact">
                {conv.data?.customer ? (
                  <ContactPanel
                    customerId={conv.data.customer.id}
                    currentConversationId={conv.data.id}
                    can={can}
                    onErased={afterErase}
                    onMerged={afterMerge}
                  />
                ) : (
                  <div>
                    <UserRound size={22} aria-hidden style={{ margin: "0 auto 6px", display: "block" }} />
                    <div className="empty__title">Contact details</div>
                    The customer's name, notes and other chats show here.
                  </div>
                )}
              </aside>
            </div>
          )}
        </DataState>
      )}
      {contactOpen && conv.data?.customer && (
        <Modal title="Contact" onClose={() => setContactOpen(false)}>
          <div style={{ display: "grid", gap: 14 }}>
            <ContactPanel
                    customerId={conv.data.customer.id}
                    currentConversationId={conv.data.id}
                    can={can}
                    onErased={afterErase}
                    onMerged={afterMerge}
                  />
          </div>
        </Modal>
      )}
    </Shell>
  );
}
