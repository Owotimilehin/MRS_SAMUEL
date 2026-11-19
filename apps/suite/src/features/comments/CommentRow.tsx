/** One comment in a thread: who, when, the text, how it is marked, and the buttons the server offers (suite spec 03, 7). */
import { Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { networkName, type SocialNetwork } from "@ms/shared";
import { listTime } from "@admin/lib/inbox-logic.js";
import { commentAuthor, commentText, privateReplyState, sendStateLine } from "./comments-logic.js";
import type { CommentItem } from "./comments-types.js";

export type RowAction = "reply" | "private" | "hide" | "unhide" | "like" | "unlike" | "delete" | "retry" | "retry-private";

export function CommentRow({
  comment: c,
  network,
  postLink,
  busy,
  canOpenChat,
  onAction,
}: {
  comment: CommentItem;
  network: SocialNetwork;
  postLink: string | null;
  busy: boolean;
  /** The Inbox is open to this person, so "Open the chat" can be offered. */
  canOpenChat: boolean;
  onAction: (action: RowAction, comment: CommentItem) => void;
}): JSX.Element {
  const name = networkName(network);
  const deleted = c.status === "deleted";
  const hidden = c.status === "hidden";
  const state = sendStateLine(c, network);
  const pr = c.private_reply ? privateReplyState(c.private_reply, listTime(c.private_reply.at)) : null;
  const a = c.actions;
  const button = (action: RowAction, label: string, danger = false) => (
    <button type="button" className={`cmt-row__btn${danger ? " is-danger" : ""}`} disabled={busy} onClick={() => onAction(action, c)}>
      {label}
    </button>
  );
  return (
    <article className={`cmt-row${c.is_root ? "" : " cmt-row--reply"}${c.from_business ? " cmt-row--ours" : ""}${deleted || hidden ? " is-muted" : ""}`}>
      <header className="cmt-row__head">
        <span className="cmt-row__author">{commentAuthor(c, network)}</span>
        <time dateTime={c.commented_at}>{listTime(c.commented_at)}</time>
        {c.edited && <span className="cmt-row__flag">Edited</span>}
        {hidden && <span className="cmt-chip cmt-chip--amber">{c.hidden_source === "suite" ? "Hidden by us" : `Hidden on ${name}`}</span>}
        {(c.like_count ?? 0) > 0 && (
          <span className="cmt-row__likes" aria-label={`${c.like_count} likes`}>
            <Heart size={12} aria-hidden /> {c.like_count}
          </span>
        )}
      </header>
      <p className={`cmt-row__text${deleted ? " is-deleted" : ""}`}>{commentText(c)}</p>
      {!c.message?.trim() && postLink && !deleted && (
        <a className="cmt-row__open" href={postLink} target="_blank" rel="noreferrer">
          Open on {name}
        </a>
      )}
      {deleted && <p className="cmt-row__note">Deleted by the customer or on {name}</p>}
      {state && (
        <p className={`cmt-row__state cmt-tone--${state.tone}`}>
          {state.text}{" "}
          {c.send_status === "failed" && (
            <button type="button" className="cmt-link" disabled={busy} onClick={() => onAction("retry", c)}>
              Try again
            </button>
          )}
        </p>
      )}
      {(a.reply || a.private_reply || a.hide || a.unhide || a.like || a.unlike || a.delete) && (
        <div className="cmt-row__actions">
          {a.reply && button("reply", "Reply")}
          {a.private_reply && !c.private_reply && button("private", "Message privately")}
          {a.hide && button("hide", "Hide")}
          {a.unhide && button("unhide", "Show again")}
          {a.like && button("like", "Like")}
          {a.unlike && button("unlike", "Unlike")}
          {a.delete && button("delete", "Delete", true)}
        </div>
      )}
      {pr && c.private_reply && (
        <div className={`cmt-private cmt-tone--${pr.tone}`}>
          <span>{pr.text}</span>{" "}
          {pr.chat && c.private_reply.conversation_id && canOpenChat && (
            <Link to="/inbox/$conversationId" params={{ conversationId: c.private_reply.conversation_id }}>
              Open the chat
            </Link>
          )}
          {pr.retry && a.private_reply && (
            <button type="button" className="cmt-link" disabled={busy} onClick={() => onAction("retry-private", c)}>
              Try again
            </button>
          )}
          {pr.hint && <div className="cmt-private__hint">{pr.hint}</div>}
        </div>
      )}
    </article>
  );
}
