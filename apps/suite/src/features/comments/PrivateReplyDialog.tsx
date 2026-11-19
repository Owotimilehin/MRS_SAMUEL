/** "Send a private message" about a comment: one message per comment (suite spec 03, 7). */
import { useState } from "react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { COMMENT_MAX, type SocialNetwork } from "@ms/shared";

export function PrivateReplyDialog({
  network,
  accountLabel,
  author,
  initialText = "",
  busy,
  onSend,
  onCancel,
}: {
  network: SocialNetwork;
  accountLabel: string;
  author: string;
  initialText?: string;
  busy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(initialText);
  const trimmed = text.trim();
  const over = trimmed.length > COMMENT_MAX;
  return (
    <ConfirmModal
      title="Send a private message"
      confirmLabel="Send message"
      busyLabel="Sending…"
      busy={busy}
      confirmDisabled={!trimmed || over}
      onConfirm={() => onSend(trimmed)}
      onCancel={onCancel}
    >
      <div className="cmt-dialog">
        <label className="cmt-label" htmlFor="cmt-private-text">
          Your message
        </label>
        <textarea
          id="cmt-private-text"
          className="input cmt-textarea"
          rows={4}
          placeholder="Write your message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <div className={`cmt-count${over ? " is-over" : ""}`}>
          {trimmed.length} / {COMMENT_MAX}
        </div>
        <p>
          This goes to {author} as a private message from <strong>{accountLabel}</strong>, with a link to their comment. You can send{" "}
          <strong>one</strong> message per comment. You can write again only after they answer.
        </p>
        {network === "instagram" && <p>If they don&apos;t follow you, it arrives in their message requests.</p>}
      </div>
    </ConfirmModal>
  );
}
