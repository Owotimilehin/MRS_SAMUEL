/**
 * "Check before posting" (suite spec 09, 7.4; foundation rule 7). Shows exactly what
 * each network will get, then sends the content hash of what it showed, so the server
 * can refuse if the post changed in the meantime. Nothing is sent to the server until
 * the person ticks the box and presses the button.
 *
 * Built on Modal, not ConfirmModal, because the cancel button reads "Go back" and
 * ConfirmModal's is fixed as "Cancel".
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { ApiError } from "@admin/lib/api.js";
import { networkName } from "@ms/shared";
import { postsApi, type PostJson } from "./posts-api.js";
import { isoToLagosInput, lagosDayTime, lagosInputToIso, scheduleBounds, shownCaption } from "./posts-logic.js";
import { NetworkIcon } from "./PostPreview.js";

export function ConfirmPostDialog({
  post,
  mode,
  initialTime,
  onClose,
  onDone,
  onReload,
}: {
  /** The saved post being confirmed. Its content_hash is what gets approved. */
  post: PostJson;
  mode: "now" | "schedule";
  /** A datetime-local value in Lagos time to start the picker on. */
  initialTime?: string;
  onClose: () => void;
  onDone: (post: PostJson, when: "now" | "schedule") => void;
  /** The server said the post changed: fetch it again and return the fresh version to show. */
  onReload: () => Promise<PostJson | null>;
}): JSX.Element {
  const [shown, setShown] = useState(post);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const bounds = scheduleBounds(new Date());
  const [time, setTime] = useState(() => {
    if (initialTime && initialTime >= bounds.min && initialTime <= bounds.max) return initialTime;
    // Default: tomorrow at 9:00 am, Lagos time.
    const tomorrow = isoToLagosInput(new Date(Date.now() + 86_400_000).toISOString()).slice(0, 10);
    return `${tomorrow}T09:00`;
  });
  const iso = mode === "schedule" ? lagosInputToIso(time) : "";
  const timeOk = mode === "now" || (iso !== "" && time >= bounds.min && time <= bounds.max);

  async function go(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const done = await postsApi.approve(shown.id, {
        when: mode,
        ...(mode === "schedule" ? { scheduled_at: iso } : {}),
        content_hash: shown.content_hash,
      });
      onDone(done, mode);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
      setMessage(text);
      if (err instanceof ApiError && err.status === 409 && err.details?.reason === "changed") {
        // Show the new version; the person must read it and tick the box again.
        const fresh = await onReload();
        if (fresh) setShown(fresh);
        setTicked(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Check before posting" onClose={onClose} maxWidth={720}>
      <div className="po-confirm">
        <p style={{ margin: 0 }}>This will be public. Please read it as a customer would.</p>
        {message && <div className="po-strip po-strip--bad">{message}</div>}
        {shown.targets.map((t) => {
          const text = shownCaption(shown.kind, shown.caption, t.caption_override);
          return (
            <div key={t.id} className="po-confirm__block">
              <div className="po-target__head">
                <NetworkIcon network={t.network} />
                <strong>
                  {networkName(t.network)} — {t.account_label}
                </strong>
              </div>
              {text !== "" ? <div className="po-exact">{text}</div> : <p className="po-fine">No text.</p>}
              {shown.media.length > 0 && (
                <div className="po-thumbs">
                  {shown.media.map((m, i) =>
                    m.preview_url && m.mime.startsWith("image/") ? (
                      <img key={m.key} src={m.preview_url} alt={m.alt_text ?? `Picture ${i + 1}`} />
                    ) : (
                      <div key={m.key} className="po-thumb" title={m.mime.startsWith("video/") ? "Video" : `Picture ${i + 1}`}>
                        {m.mime.startsWith("video/") ? "Video" : i + 1}
                      </div>
                    ),
                  )}
                </div>
              )}
              {shown.kind === "link" && t.network === "facebook" && (
                <p className="po-fine" style={{ overflowWrap: "anywhere" }}>
                  Link: <strong>{shown.link_url}</strong>
                </p>
              )}
            </div>
          );
        })}

        {mode === "now" ? (
          <p style={{ margin: 0 }}>
            Goes out: <strong>now</strong>
          </p>
        ) : (
          <div className="po-block">
            <label className="field">
              <span className="field__label">Day and time (Lagos time)</span>
              <input
                className="input"
                type="datetime-local"
                value={time}
                min={bounds.min}
                max={bounds.max}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            {timeOk ? (
              <p style={{ margin: 0 }}>
                Goes out: <strong>{lagosDayTime(iso, true)}</strong>
              </p>
            ) : (
              <p className="field__error">Pick a time at least 10 minutes from now and within the next 90 days.</p>
            )}
          </div>
        )}

        <label className="po-check">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span>I have read this and it is ready to go out.</span>
        </label>
      </div>
      <div className="po-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Go back
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void go()} disabled={busy || !ticked || !timeOk}>
          {mode === "now" ? (busy ? "Posting…" : "Post now") : busy ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </Modal>
  );
}
