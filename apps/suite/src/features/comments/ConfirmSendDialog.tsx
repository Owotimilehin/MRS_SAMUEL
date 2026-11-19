/**
 * The confirm dialog for a public reply, hide, show again and delete (suite
 * spec 03, 7). It shows exactly what will be posted or changed, and where,
 * before anything leaves the building.
 */
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { networkName, type SocialNetwork } from "@ms/shared";
import { confirmCopy } from "./comments-logic.js";

export type ConfirmKind = "reply" | "hide" | "unhide" | "delete";

export function ConfirmSendDialog({
  kind,
  network,
  accountLabel,
  author,
  commentText,
  replyText,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: ConfirmKind;
  network: SocialNetwork;
  accountLabel: string;
  /** Who wrote the comment being answered or changed. */
  author: string;
  /** The comment being answered or changed. */
  commentText: string;
  /** The reply to post (kind "reply" only). */
  replyText?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const copy = confirmCopy(kind, network);
  return (
    <ConfirmModal
      title={copy.title}
      confirmLabel={copy.confirm}
      busyLabel={copy.busy}
      busy={busy}
      tone={copy.danger ? "danger" : "primary"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="cmt-dialog">
        {kind === "reply" ? (
          <>
            <p>
              {copy.body} It will be posted as <strong>{accountLabel}</strong> on {networkName(network)}.
            </p>
            <blockquote className="cmt-quote">{replyText}</blockquote>
            <p className="cmt-dialog__sub">
              Replying to {author}: “{commentText.slice(0, 140)}”
            </p>
          </>
        ) : (
          <>
            <p>{copy.body}</p>
            {kind === "delete" && <blockquote className="cmt-quote">{commentText}</blockquote>}
          </>
        )}
      </div>
    </ConfirmModal>
  );
}
