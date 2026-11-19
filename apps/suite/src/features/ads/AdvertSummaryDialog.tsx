/**
 * "Check this advert before it is created" (suite spec 12, 7.10). Every line,
 * the total and the cap come from the server, worked out from the saved draft.
 * The person types the total; the server compares it with its own figure
 * again before anything is sent to Meta. The advert is created switched off.
 */
import { useState } from "react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi, type AdDraft, type DraftPreview } from "./ads-api.js";
import { capLine, parseTyped } from "./ads-logic.js";

/** The server marks the two lines that matter most with **…**. */
function Line({ text }: { text: string }): JSX.Element {
  const parts = text.split("**");
  return <li>{parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}</li>;
}

export const NEEDS_CHECK_TEXT =
  "Meta did not answer. Nothing can have been spent, because adverts are created switched off. Press Continue and we will check what was created.";

export function AdvertSummaryDialog({
  draftId,
  preview,
  currency,
  onClose,
  onResult,
}: {
  draftId: string;
  preview: DraftPreview;
  currency: string;
  onClose: () => void;
  /** Called with the draft as the server left it: created, failed or needs_check. */
  onResult: (draft: AdDraft) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = preview.cap.ok && parseTyped(typed) === preview.confirm_text;

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onResult(await adsApi.create(draftId, preview.content_hash, typed));
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
    }
  }

  return (
    <ConfirmModal
      title="Check this advert before it is created"
      confirmLabel="Create advert"
      busyLabel="Creating…"
      onConfirm={() => void create()}
      onCancel={onClose}
      busy={busy}
      confirmDisabled={!ready}
      tone="danger"
      maxWidth={640}
    >
      <div className="ads-card">
        <ul className="ads-summary">
          {preview.lines.map((l, i) => (
            <Line key={i} text={l} />
          ))}
        </ul>
        {preview.warnings.map((w) => (
          <div key={w} className="ads-strip ads-strip--warn">
            {w}
          </div>
        ))}
        <p className="ads-fine">{capLine(preview.cap, currency)}</p>
        {!preview.cap.ok ? (
          <div className="ads-strip ads-strip--bad">
            This daily budget is over your cap, so the advert could never be turned on. Lower the amount, or ask the owner to raise the cap.
          </div>
        ) : (
          <label className="field">
            <span className="field__label">Type the total ({preview.confirm_text}) to confirm</span>
            <input className="input ads-confirm-input" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
      </div>
    </ConfirmModal>
  );
}
