/**
 * One open thread: the post, who is dealing with it, the comments, and the
 * reply box (suite spec 03, 7). Every public action goes through a confirm
 * dialog that shows what will be sent; nothing is sent twice by this screen.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { CommentRow, type RowAction } from "./CommentRow.js";
import { ConfirmSendDialog, type ConfirmKind } from "./ConfirmSendDialog.js";
import { PostCard } from "./PostCard.js";
import { PrivateReplyDialog } from "./PrivateReplyDialog.js";
import { ReplyBox } from "./ReplyBox.js";
import { commentKeys, commentsApi } from "./comments-api.js";
import { commentAuthor, commentText } from "./comments-logic.js";
import type { CommentItem } from "./comments-types.js";

type Dialog =
  | { kind: ConfirmKind; comment: CommentItem; text?: string }
  | { kind: "private"; comment: CommentItem; text?: string }
  | null;

const NOT_NORMAL = "That didn't go through normally. Check how it's marked before sending again.";

export function ThreadView({ threadId, onBack }: { threadId: string; onBack: () => void }): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: commentKeys.thread(threadId),
    queryFn: () => commentsApi.thread(threadId),
    refetchInterval: 30_000,
  });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, enabled: can("inbox.view"), staleTime: 5 * 60_000, retry: false });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);

  // A different thread: start clean.
  useEffect(() => {
    setText("");
    setTargetId(null);
    setDialog(null);
  }, [threadId]);

  // Opening a thread marks it read, once per thread opened.
  const readFor = useRef<string | null>(null);
  const loaded = q.data?.thread.id === threadId;
  const unread = q.data?.thread.unread ?? 0;
  useEffect(() => {
    if (!loaded || unread === 0 || readFor.current === threadId) return;
    readFor.current = threadId;
    void commentsApi
      .markRead(threadId)
      .then(() => qc.invalidateQueries({ queryKey: commentKeys.all }))
      .catch(() => undefined);
  }, [loaded, unread, threadId, qc]);

  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: commentKeys.all });

  const back = (
    <button type="button" className="cmt-back cmt-link" onClick={onBack}>
      ← Back to comments
    </button>
  );

  if (!q.data) {
    return (
      <div className="cmt-thread">
        {back}
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          <span />
        </DataState>
      </div>
    );
  }

  const { thread, comments } = q.data;
  const network = thread.network;
  const root = comments.find((c) => c.is_root) ?? null;
  const target = comments.find((c) => c.id === targetId) ?? root;
  const canReply = !!target?.actions.reply;

  async function run(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      setDialog(null);
    } catch (err) {
      toast.error(humanizeError(err));
      setDialog(null);
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function sendReply(comment: CommentItem, message: string): Promise<void> {
    setBusy(true);
    try {
      const answer = await commentsApi.reply(comment.id, message);
      if (answer.ok) {
        toast.success("Reply posted");
        setText("");
        setTargetId(null);
      } else {
        toast.info(NOT_NORMAL);
      }
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setDialog(null);
      setBusy(false);
      await refresh();
    }
  }

  async function sendPrivate(comment: CommentItem, message: string): Promise<void> {
    setBusy(true);
    try {
      const answer = await commentsApi.privateReply(comment.id, message);
      if (answer.ok) toast.success("Private message sent");
      else toast.info(NOT_NORMAL);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setDialog(null);
      setBusy(false);
      await refresh();
    }
  }

  function onRowAction(action: RowAction, c: CommentItem): void {
    if (action === "reply") setTargetId(c.is_root ? null : c.id);
    else if (action === "retry") {
      // The words come back into the reply box; nothing is sent until the person confirms again.
      setText(c.message ?? "");
      setTargetId(null);
    } else if (action === "private") setDialog({ kind: "private", comment: c });
    else if (action === "retry-private") setDialog({ kind: "private", comment: c, text: c.private_reply?.body ?? "" });
    else if (action === "like") void run(() => commentsApi.like(c.id), "Comment liked");
    else if (action === "unlike") void run(() => commentsApi.unlike(c.id), "Like removed");
    else setDialog({ kind: action, comment: c });
  }

  function confirmDialog(): void {
    if (!dialog || dialog.kind === "private") return;
    const c = dialog.comment;
    if (dialog.kind === "reply") void sendReply(c, dialog.text ?? "");
    else if (dialog.kind === "hide") void run(() => commentsApi.hide(c.id), "Comment hidden");
    else if (dialog.kind === "unhide") void run(() => commentsApi.unhide(c.id), "Comment shown again");
    else void run(() => commentsApi.remove(c.id), "Comment deleted");
  }

  async function patch(change: { assignee_id?: string | null; work_state?: "open" | "done" }): Promise<void> {
    setBusy(true);
    try {
      await commentsApi.update(thread.id, change);
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  // People who can be given the thread: the inbox's staff list when this person has the Inbox, else just themselves.
  const people = staff.data ? staff.data.map((s) => ({ id: s.id, name: s.id === user.id ? "Me" : s.name })) : [{ id: user.id, name: "Me" }];
  if (thread.assignee_id && !people.some((p) => p.id === thread.assignee_id)) {
    people.push({ id: thread.assignee_id, name: thread.assignee_name ?? "Someone else" });
  }

  return (
    <div className="cmt-thread">
      {back}
      {!thread.account_active && <p className="cmt-banner cmt-banner--grey">This account is switched off in Channels. Its comments can be read but not answered.</p>}
      <PostCard thread={thread} />
      <div className="cmt-thread__bar">
        <label className="cmt-assign">
          <span>Assign</span>
          <select
            className="input"
            value={thread.assignee_id ?? ""}
            disabled={busy}
            onChange={(e) => void patch({ assignee_id: e.target.value || null })}
          >
            <option value="">Nobody</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          disabled={busy}
          onClick={() => void patch({ work_state: thread.work_state === "done" ? "open" : "done" })}
        >
          {thread.work_state === "done" ? "Reopen" : "Mark as done"}
        </button>
      </div>
      <div className="cmt-thread__comments">
        {comments.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            network={network}
            postLink={thread.post.permalink_url}
            busy={busy}
            canOpenChat={can("inbox.view")}
            onAction={onRowAction}
          />
        ))}
      </div>
      {canReply && target && (
        <ReplyBox
          text={text}
          onChange={setText}
          replyingTo={target.is_root ? null : commentAuthor(target, network)}
          onClearTarget={() => setTargetId(null)}
          onSubmit={() => setDialog({ kind: "reply", comment: target, text: text.trim() })}
          disabled={busy}
          canUseSavedReplies={can("inbox.view")}
        />
      )}
      {dialog && dialog.kind !== "private" && (
        <ConfirmSendDialog
          kind={dialog.kind}
          network={network}
          accountLabel={thread.account_label}
          author={commentAuthor(dialog.comment, network)}
          commentText={commentText(dialog.comment)}
          {...(dialog.text !== undefined ? { replyText: dialog.text } : {})}
          busy={busy}
          onConfirm={confirmDialog}
          onCancel={() => !busy && setDialog(null)}
        />
      )}
      {dialog && dialog.kind === "private" && (
        <PrivateReplyDialog
          network={network}
          accountLabel={thread.account_label}
          author={commentAuthor(dialog.comment, network)}
          {...(dialog.text !== undefined ? { initialText: dialog.text } : {})}
          busy={busy}
          onSend={(message) => void sendPrivate(dialog.comment, message)}
          onCancel={() => !busy && setDialog(null)}
        />
      )}
    </div>
  );
}
