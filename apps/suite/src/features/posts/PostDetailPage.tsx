/**
 * One post (suite spec 09, 7.5): what was written, who approved it, what happened on
 * each network, and what a person can do next. Every action that changes something
 * public, or could cause a second post, asks first.
 */
import { useCallback, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { toast } from "@admin/lib/toast.js";
import { networkName } from "@ms/shared";
import { ConfirmPostDialog } from "./ConfirmPostDialog.js";
import { NetworkIcon, ProblemList } from "./PostPreview.js";
import { postsApi, postsKeys, type PostJson, type PostTargetJson } from "./posts-api.js";
import { lagosDayTime, placeName, shownCaption, statusLabel, statusTone, targetLine } from "./posts-logic.js";
import "./posts.css";

/** A small ask-first dialog with its own two button labels. */
function Ask({
  title,
  children,
  stay,
  go,
  danger = false,
  busy,
  onStay,
  onGo,
}: {
  title: string;
  children: ReactNode;
  stay: string;
  go: string;
  danger?: boolean;
  busy: boolean;
  onStay: () => void;
  onGo: () => void;
}): JSX.Element {
  return (
    <Modal title={title} onClose={busy ? () => {} : onStay} maxWidth={480}>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
      <div className="po-buttons">
        <button type="button" className="btn btn--subtle" onClick={onStay} disabled={busy}>
          {stay}
        </button>
        <button type="button" className={danger ? "btn btn--danger" : "btn btn--primary"} onClick={onGo} disabled={busy}>
          {busy ? "Working…" : go}
        </button>
      </div>
    </Modal>
  );
}

type Asking =
  | { kind: "cancel" }
  | { kind: "delete" }
  | { kind: "takedown"; target: PostTargetJson; refused: string | null }
  | { kind: "again"; target: PostTargetJson }
  | { kind: "edit"; target: PostTargetJson; initial: string; error: string | null };

/**
 * "Edit text" for a post that is out on Facebook. The text lives in here, so typing does not
 * redraw the page behind the dialog (the shared Modal moves the focus when its owner redraws).
 */
function EditTextDialog({
  initial,
  error,
  busy,
  onClose,
  onSave,
}: {
  initial: string;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (text: string) => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  return (
    <Modal title="Edit text" onClose={onClose} maxWidth={560}>
      <div style={{ display: "grid", gap: 10 }}>
        <textarea className="textarea" rows={6} maxLength={5000} aria-label="Text on Facebook" value={text} onChange={(e) => setText(e.target.value)} />
        <p className="po-fine">This changes the text on Facebook straight away. Pictures cannot be changed.</p>
        {error && <div className="po-strip po-strip--bad">{error}</div>}
      </div>
      <div className="po-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || text.trim() === ""} onClick={() => onSave(text)}>
          {busy ? "Saving…" : "Save to Facebook"}
        </button>
      </div>
    </Modal>
  );
}

export function PostDetailPage({ postId }: { postId: string }): JSX.Element {
  const q = useQuery({
    queryKey: postsKeys.one(postId),
    queryFn: () => postsApi.one(postId),
    // No live stream for posts (ruling 9.2.12): refresh every 5 seconds while something is going out.
    refetchInterval: (query) =>
      query.state.data?.targets.some((t) => t.status === "pending" || t.status === "publishing") && query.state.data.status === "publishing" ? 5_000 : false,
  });
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  return (
    <Frame title="Post" crumb="Posts">
      {notFound ? (
        <div className="empty">
          <div className="empty__title">This post no longer exists.</div>
          <Link to="/posts" className="btn btn--subtle btn--sm">
            Back to posts
          </Link>
        </div>
      ) : (
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && <Loaded post={q.data} />}
        </DataState>
      )}
    </Frame>
  );
}

function Loaded({ post }: { post: PostJson }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<null | "now" | "schedule">(null);
  // Stable, so the dialogs' focus handling is not restarted each time this page redraws.
  const closeAsking = useCallback(() => setAsking(null), []);
  const closeApproving = useCallback(() => setApproving(null), []);
  const accounts = useQuery({ queryKey: postsKeys.accounts, queryFn: postsApi.accounts, refetchOnWindowFocus: false });
  const schedulingEnabled = accounts.data?.scheduling_enabled ?? false;

  const put = (p: PostJson): void => {
    qc.setQueryData(postsKeys.one(p.id), p);
    void qc.invalidateQueries({ queryKey: ["posts", "list"] });
  };
  /** Run one action; api() shows its own error toast. */
  async function run(action: () => Promise<PostJson>, done?: string): Promise<boolean> {
    setBusy(true);
    try {
      put(await action());
      if (done) toast.success(done);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function takeDown(target: PostTargetJson, manual: boolean): Promise<void> {
    setBusy(true);
    try {
      put(await postsApi.takeDown(post.id, target.id, manual));
      toast.success(manual ? "Marked as taken down." : `Taken down from ${networkName(target.network)}.`);
      setAsking(null);
    } catch (err) {
      // Show the server's reason in the dialog, with the way out: "I removed it myself".
      setAsking({ kind: "takedown", target, refused: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function saveText(target: PostTargetJson, text: string): Promise<void> {
    setBusy(true);
    try {
      put(await postsApi.editPublished(post.id, target.id, text));
      toast.success("Saved to Facebook.");
      setAsking(null);
    } catch (err) {
      setAsking({ kind: "edit", target, initial: text, error: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft(): Promise<void> {
    setBusy(true);
    try {
      await postsApi.remove(post.id);
      void qc.invalidateQueries({ queryKey: ["posts", "list"] });
      toast.success("Draft deleted.");
      void navigate({ to: "/posts" });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  const nothingOut = !post.targets.some((t) => ["publishing", "published", "unknown", "removed"].includes(t.status));
  const editable = ["draft", "scheduled", "missed", "failed"].includes(post.status) && nothingOut;
  const blocked = post.targets.some((t) => t.problems.some((p) => p.blocking));

  function actions(t: PostTargetJson): ReactNode {
    const name = networkName(t.network);
    // A draft's targets are "pending" too, but nothing is going out: no actions and no spinner there.
    switch (t.status) {
      case "published":
        if (!t.external_id) {
          return (
            <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => void takeDown(t, true)}>
              I removed it myself
            </button>
          );
        }
        return (
          <>
            {t.permalink && (
              <a className="btn btn--subtle" href={t.permalink} target="_blank" rel="noreferrer">
                View on {name}
              </a>
            )}
            {t.network === "facebook" && t.external_kind === "post" && (
              <button
                type="button"
                className="btn btn--subtle"
                disabled={busy}
                onClick={() => setAsking({ kind: "edit", target: t, initial: shownCaption(post.kind, post.caption, t.caption_override), error: null })}
              >
                Edit text
              </button>
            )}
            <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setAsking({ kind: "takedown", target: t, refused: null })}>
              Take down
            </button>
          </>
        );
      case "failed":
        return (
          <>
            {post.approved_at && post.status !== "draft" && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void run(() => postsApi.retry(post.id, t.id, post.content_hash), "Trying again now.")}
              >
                Try again
              </button>
            )}
            {editable && (
              <Link to="/posts/$postId/edit" params={{ postId: post.id }} className="btn btn--subtle">
                Edit post
              </Link>
            )}
          </>
        );
      case "unknown":
        return (
          <>
            <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => void run(() => postsApi.check(post.id, t.id))}>
              Check again
            </button>
            <button
              type="button"
              className="btn btn--subtle"
              disabled={busy}
              onClick={() => void run(() => postsApi.resolve(post.id, t.id, "posted"), "Marked as posted.")}
            >
              It is there
            </button>
            <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setAsking({ kind: "again", target: t })}>
              It is not there — post it again
            </button>
          </>
        );
      default:
        return null;
    }
  }

  const goingOut = post.status === "publishing";

  return (
    <div className="po-page">
      <section className="card po-block">
        <div className="po-target__head">
          <span className={`po-tone po-tone--${statusTone(post.status)}`}>{statusLabel(post.status)}</span>
          {post.status === "scheduled" && post.scheduled_at && <span>Goes out {lagosDayTime(post.scheduled_at, true)}</span>}
          {post.status === "missed" && post.scheduled_at && <span>Was due {lagosDayTime(post.scheduled_at, true)}</span>}
        </div>
        <p className="po-fine" style={{ fontSize: 13 }}>
          {post.created_by ? `Created by ${post.created_by.name}` : "Created in the suite"}
          {post.approved_by && post.approved_at ? ` · Approved by ${post.approved_by.name}, ${lagosDayTime(post.approved_at, true)}` : ""}
        </p>
        {post.status_note && <div className="po-strip po-strip--warn">{post.status_note}</div>}

        <div className="po-target__actions">
          {post.status === "draft" && (
            <>
              <Link to="/posts/$postId/edit" params={{ postId: post.id }} className="btn btn--primary">
                Edit
              </Link>
              <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setAsking({ kind: "delete" })}>
                Delete draft
              </button>
            </>
          )}
          {post.status === "scheduled" && (
            <>
              <Link to="/posts/$postId/edit" params={{ postId: post.id }} className="btn btn--subtle">
                Change
              </Link>
              <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => setAsking({ kind: "cancel" })}>
                Cancel schedule
              </button>
            </>
          )}
          {post.status === "missed" && (
            <>
              <button type="button" className="btn btn--primary" disabled={busy || blocked} onClick={() => setApproving("now")}>
                Post now…
              </button>
              <button type="button" className="btn btn--subtle" disabled={busy || blocked || !schedulingEnabled} onClick={() => setApproving("schedule")}>
                Pick a new time…
              </button>
              <Link to="/posts/$postId/edit" params={{ postId: post.id }} className="btn btn--subtle">
                Edit post
              </Link>
            </>
          )}
        </div>
        {post.status === "missed" && !schedulingEnabled && (
          <p className="po-fine">Scheduling is switched off. The owner can turn it on in Posts → Settings.</p>
        )}
      </section>

      <section className="card po-block">
        <h2 className="po-h">What was written</h2>
        {post.caption.trim() !== "" ? <div className="po-exact">{post.caption}</div> : <p className="po-fine">No text.</p>}
        {post.kind === "link" && post.link_url && (
          <p className="po-fine" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
            Link: <strong>{post.link_url}</strong>
          </p>
        )}
        {post.media.length > 0 && (
          <div className="po-thumbs">
            {post.media.map((m, i) =>
              m.preview_url && m.mime.startsWith("image/") ? (
                <a key={m.key} href={m.preview_url} target="_blank" rel="noreferrer">
                  <img src={m.preview_url} alt={m.alt_text ?? `Picture ${i + 1}`} />
                </a>
              ) : m.preview_url ? (
                <a key={m.key} className="po-thumb" href={m.preview_url} target="_blank" rel="noreferrer">
                  Video
                </a>
              ) : (
                <div key={m.key} className="po-thumb">
                  {m.mime.startsWith("video/") ? "Video" : i + 1}
                </div>
              ),
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="po-h">Where it goes</h2>
        {post.targets.map((t) => {
          const own = t.caption_override !== null && post.kind !== "story";
          const waiting = t.status === "pending" || t.status === "publishing";
          return (
            <div key={t.id} className="po-target">
              <div className="po-target__head">
                <NetworkIcon network={t.network} />
                <span>
                  {networkName(t.network)} — {t.account_label}
                </span>
              </div>
              <div>
                {waiting && !goingOut ? (
                  <span className="po-fine" style={{ fontSize: 13 }}>
                    {post.status === "scheduled" ? "Waiting for its time." : "Not sent yet."}
                  </span>
                ) : (
                  <span>
                    {waiting && <span className="po-spin" aria-hidden="true" />} {targetLine(t)}
                  </span>
                )}
              </div>
              {own && (
                <div>
                  <p className="po-fine">Text on {networkName(t.network)}:</p>
                  <div className="po-exact">{t.caption_override}</div>
                </div>
              )}
              {(t.status === "pending" || t.status === "failed") && <ProblemList problems={t.problems} />}
              <div className="po-target__actions">{actions(t)}</div>
            </div>
          );
        })}
      </section>

      {asking?.kind === "cancel" && (
        <Ask
          title="Cancel schedule"
          stay="Keep it scheduled"
          go="Cancel schedule"
          busy={busy}
          onStay={() => setAsking(null)}
          onGo={() => void run(() => postsApi.cancel(post.id), "The post is back in your drafts.").then(() => setAsking(null))}
        >
          <p style={{ margin: 0 }}>Stop this post going out? It will go back to your drafts.</p>
        </Ask>
      )}
      {asking?.kind === "delete" && (
        <Ask title="Delete draft" stay="Keep it" go="Delete draft" danger busy={busy} onStay={() => setAsking(null)} onGo={() => void deleteDraft()}>
          <p style={{ margin: 0 }}>Delete this draft? This cannot be undone.</p>
        </Ask>
      )}
      {asking?.kind === "takedown" && (
        <Ask
          title="Take down"
          stay="Keep it"
          go="Take down"
          danger
          busy={busy}
          onStay={() => setAsking(null)}
          onGo={() => void takeDown(asking.target, false)}
        >
          <p style={{ margin: 0 }}>
            Take this post down from {networkName(asking.target.network)}? Its comments and likes go with it. This cannot be undone.
          </p>
          {asking.refused && (
            <>
              <div className="po-strip po-strip--bad">{asking.refused}</div>
              <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => void takeDown(asking.target, true)}>
                I removed it myself
              </button>
            </>
          )}
        </Ask>
      )}
      {asking?.kind === "again" && (
        <Ask
          title="Post it again?"
          stay="Go back"
          go="Post it again"
          danger
          busy={busy}
          onStay={() => setAsking(null)}
          onGo={() => void run(() => postsApi.resolve(post.id, asking.target.id, "not_posted"), "Posting it again now.").then(() => setAsking(null))}
        >
          <p style={{ margin: 0 }}>
            Only do this after looking at the {placeName(asking.target.network)}. If the post is already there, this will post it a second time.
          </p>
        </Ask>
      )}
      {asking?.kind === "edit" && (
        <EditTextDialog
          initial={asking.initial}
          error={asking.error}
          busy={busy}
          onClose={closeAsking}
          onSave={(text) => void saveText(asking.target, text)}
        />
      )}

      {approving && (
        <ConfirmPostDialog
          post={post}
          mode={approving}
          onClose={closeApproving}
          onReload={async () => {
            try {
              const fresh = await postsApi.one(post.id);
              put(fresh);
              return fresh;
            } catch {
              return null;
            }
          }}
          onDone={(done, when) => {
            setApproving(null);
            put(done);
            toast.success(when === "now" ? "Your post is going out now." : `Scheduled for ${done.scheduled_at ? lagosDayTime(done.scheduled_at) : "later"}.`);
          }}
        />
      )}
    </div>
  );
}
