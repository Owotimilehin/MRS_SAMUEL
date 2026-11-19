/** The public reply box under a thread (suite spec 03, 7). Pressing the button only opens the confirm dialog. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COMMENT_MAX } from "@ms/shared";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";

export function ReplyBox({
  text,
  onChange,
  replyingTo,
  onClearTarget,
  onSubmit,
  disabled,
  canUseSavedReplies,
}: {
  text: string;
  onChange: (text: string) => void;
  /** Set when a reply (not the first comment) is being answered. */
  replyingTo: string | null;
  onClearTarget: () => void;
  onSubmit: () => void;
  disabled: boolean;
  /** Saved replies come from the Inbox, so only for people who have it. */
  canUseSavedReplies: boolean;
}): JSX.Element {
  const [showSaved, setShowSaved] = useState(false);
  const saved = useQuery({ queryKey: inboxKeys.quickReplies, queryFn: inboxApi.quickReplies, enabled: canUseSavedReplies && showSaved, retry: false });
  const trimmed = text.trim();
  const over = trimmed.length > COMMENT_MAX;
  return (
    <div className="cmt-reply">
      {replyingTo && (
        <div className="cmt-reply__to">
          Replying to {replyingTo}{" "}
          <button type="button" className="cmt-link" onClick={onClearTarget}>
            Cancel
          </button>
        </div>
      )}
      <label className="cmt-visually-hidden" htmlFor="cmt-reply-text">
        Public reply
      </label>
      <textarea
        id="cmt-reply-text"
        className="input cmt-textarea"
        rows={3}
        placeholder="Write a public reply…"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      <div className="cmt-reply__row">
        {canUseSavedReplies && (
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setShowSaved((v) => !v)} aria-expanded={showSaved}>
            Saved replies
          </button>
        )}
        <span className={`cmt-count${over ? " is-over" : ""}`}>
          {trimmed.length} / {COMMENT_MAX}
        </span>
        <button type="button" className="btn btn--primary btn--sm" onClick={onSubmit} disabled={disabled || !trimmed || over}>
          Reply publicly
        </button>
      </div>
      {showSaved && canUseSavedReplies && (
        <ul className="cmt-saved">
          {saved.isLoading && <li className="cmt-saved__note">Loading…</li>}
          {saved.data?.length === 0 && <li className="cmt-saved__note">No saved replies yet. Add them in Settings.</li>}
          {(saved.data ?? []).map((q) => (
            <li key={q.id}>
              <button
                type="button"
                className="cmt-saved__item"
                onClick={() => {
                  onChange(q.body);
                  setShowSaved(false);
                }}
              >
                <strong>{q.title}</strong>
                <span>{q.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
