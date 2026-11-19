/**
 * Chat set-up (suite spec 04, section 7): the welcome text, Get started button, starter
 * questions and menu for a Facebook Page or an Instagram account. Nothing reaches
 * Meta until a person presses Publish and confirms.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { EMPTY_CHAT_SETUP, validateChatSetup, type ChatSetupConfig } from "@ms/shared";
import { chatSetupApi, chatSetupKeys, type ChatSetupView } from "./chat-setup-api.js";
import { editorStart, publishBlockedReason, sameConfig, statusStrip, lagosClock } from "./chat-setup-logic.js";
import { ChatPreview } from "./ChatPreview.js";
import { GreetingEditor } from "./GreetingEditor.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { MenuEditor } from "./MenuEditor.js";
import { PublishDialog } from "./PublishDialog.js";
import { StarterQuestionsEditor } from "./StarterQuestionsEditor.js";
import "./chat-setup.css";

export function ChatSetupPage({ accountId }: { accountId: string }): JSX.Element {
  const can = useCan();
  if (!can("channels.manage")) {
    return (
      <Frame title="Chat set-up" crumb="Channels">
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask the owner if you need to change the chat set-up.
        </div>
      </Frame>
    );
  }
  return <Loaded accountId={accountId} />;
}

function Loaded({ accountId }: { accountId: string }): JSX.Element {
  const q = useQuery({ queryKey: chatSetupKeys.view(accountId), queryFn: () => chatSetupApi.view(accountId), refetchOnWindowFocus: false });
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  return (
    <Frame title="Chat set-up" crumb="Channels">
      {notFound ? (
        <div className="empty">
          <div className="empty__title">Not found</div>
          This account has no chat set-up.
          <div style={{ marginTop: 10 }}>
            <Link to="/channels" className="btn btn--subtle btn--sm">
              Back to Channels
            </Link>
          </div>
        </div>
      ) : (
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && <Editor view={q.data} />}
        </DataState>
      )}
    </Frame>
  );
}

function Editor({ view }: { view: ChatSetupView }): JSX.Element {
  const qc = useQueryClient();
  const id = view.account.id;
  const kind = view.account.kind;
  const start = editorStart(view);
  const [local, setLocal] = useState<ChatSetupConfig | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [publishing, setPublishing] = useState<{ version: number; config: ChatSetupConfig } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [viewing, setViewing] = useState<{ version: number; config: ChatSetupConfig } | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | "discard" | "check" | null>(null);

  const config = local ?? start;
  const dirty = local !== null && !sameConfig(local, start, kind);
  const problems = validateChatSetup(config, kind);
  const switchedOff = !view.account.is_active;
  const blocked = publishBlockedReason({ view, config, problems: problems.length, now: new Date() });
  const strip = statusStrip(view, dirty);
  const nothingSetUp =
    !view.draft && !dirty && view.live !== null && sameConfig(view.live.config, EMPTY_CHAT_SETUP, kind) && view.last_publish === null;

  const put = (v: ChatSetupView): void => {
    qc.setQueryData<ChatSetupView>(chatSetupKeys.view(id), v);
  };
  const touch = (field: string): void => setTouched((t) => new Set(t).add(field));
  const onChange = (next: ChatSetupConfig): void => setLocal(next);
  const editorProps = { config, onChange, kind, disabled: switchedOff, problems, touched, onTouch: touch };

  async function saveDraft(): Promise<ChatSetupView | null> {
    setBusy("save");
    try {
      const v = await chatSetupApi.saveDraft(id, config);
      put(v);
      setLocal(null);
      return v;
    } catch {
      return null; // toast shown by api()
    } finally {
      setBusy(null);
    }
  }

  async function onPublish(): Promise<void> {
    setBusy("publish");
    try {
      let v = view;
      if (dirty || !view.draft) v = await chatSetupApi.saveDraft(id, config);
      put(v);
      setLocal(null);
      if (v.draft) setPublishing({ version: v.draft.version, config: v.draft.config });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  async function discard(): Promise<void> {
    setBusy("discard");
    try {
      if (view.draft) put(await chatSetupApi.discardDraft(id));
      setLocal(null);
      setTouched(new Set());
      setDiscardOpen(false);
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  async function check(): Promise<void> {
    setBusy("check");
    try {
      put(await chatSetupApi.refresh(id));
    } catch {
      /* toast shown by api() (including "Checked a moment ago") */
    } finally {
      setBusy(null);
    }
  }

  const retryWait = view.can_publish_at && new Date(view.can_publish_at).getTime() > Date.now() ? view.can_publish_at : null;

  return (
    <div className="cs-page">
      <p className="cs-sub">
        <strong>{view.account.label}</strong> &middot; {kind === "messenger" ? "Facebook Messenger" : "Instagram"}
      </p>

      <div className="cs-strips">
        {strip.map((s, i) => (
          <div key={i} className={`cs-strip cs-strip--${s.tone}`} role={s.tone === "bad" ? "alert" : undefined}>
            <span>{s.text}</span>
            {s.action === "check" && (
              <button type="button" className="cs-link" disabled={busy === "check"} onClick={() => void check()}>
                {busy === "check" ? "Checking…" : "Check now"}
              </button>
            )}
            {s.action === "retry" && view.last_publish && (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={switchedOff || retryWait !== null || view.live === null}
                title={retryWait ? `You can publish again at ${lagosClock(retryWait)}.` : undefined}
                onClick={() => setPublishing({ version: view.last_publish!.version, config: view.last_publish!.config })}
              >
                Try again
              </button>
            )}
          </div>
        ))}
      </div>

      {nothingSetUp && <div className="cs-note">Nothing is set up yet. Add a welcome text, questions or a menu, then publish.</div>}

      <div className="cs-grid">
        <div className="cs-editors">
          {view.supports.greeting && <GreetingEditor {...editorProps} />}
          <StarterQuestionsEditor {...editorProps} />
          <MenuEditor {...editorProps} />
          <HistoryPanel
            accountId={id}
            disabled={switchedOff}
            onView={(version, c) => setViewing({ version, config: c })}
            onRestored={() => {
              setLocal(null);
              setViewing(null);
            }}
          />
        </div>
        <div className="cs-side">
          {viewing && (
            <div className="cs-strip cs-strip--note">
              <span>Showing an earlier version.</span>
              <button type="button" className="cs-link" onClick={() => setViewing(null)}>
                Back to my draft
              </button>
            </div>
          )}
          <ChatPreview config={viewing?.config ?? config} kind={kind} accountLabel={view.account.label} />
        </div>
      </div>

      <div className="cs-bar">
        <div className="cs-bar__why" aria-live="polite">
          {blocked}
        </div>
        <div className="cs-bar__buttons">
          <button
            type="button"
            className="btn btn--subtle"
            disabled={switchedOff || busy !== null || (!dirty && !view.draft)}
            onClick={() => setDiscardOpen(true)}
          >
            Discard changes
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={switchedOff || busy !== null || !dirty || problems.length > 0}
            onClick={() => {
              void saveDraft().then((v) => {
                if (v) toast.success("Draft saved");
              });
            }}
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="btn btn--primary" disabled={blocked !== null || busy !== null} onClick={() => void onPublish()}>
            {busy === "publish" ? "Saving…" : "Publish…"}
          </button>
        </div>
      </div>

      {publishing && (
        <PublishDialog
          view={view}
          version={publishing.version}
          config={publishing.config}
          onClose={() => {
            setPublishing(null);
            setLocal(null);
          }}
        />
      )}
      {discardOpen && (
        <ConfirmModal
          title="Discard your changes?"
          confirmLabel="Discard"
          busyLabel="Discarding…"
          busy={busy === "discard"}
          onCancel={() => setDiscardOpen(false)}
          onConfirm={() => void discard()}
        >
          <p style={{ margin: 0 }}>Your draft will be replaced by what is live now.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
