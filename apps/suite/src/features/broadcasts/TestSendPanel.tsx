/** Send a test first (suite spec 14, 7.9): the exact message to the staff member's own WhatsApp. */
import { useState } from "react";
import type { BroadcastDetail } from "@ms/shared";
import { broadcastsApi, failureText } from "./broadcasts-api.js";
import { testLine } from "./broadcasts-logic.js";

export function TestSendPanel({
  broadcastId,
  myPhone,
  test,
  disabledReason,
  onSent,
}: {
  broadcastId: string;
  myPhone: string | null;
  test: BroadcastDetail["test"];
  /** Why a test can't be sent yet (blanks not filled, no template), or null. */
  disabledReason: string | null;
  onSent: () => void;
}): JSX.Element {
  const [to, setTo] = useState(myPhone ?? test?.to ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = testLine(test);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await broadcastsApi.test(broadcastId, to.trim());
      onSent();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label className="bc-field">
        <span>Your WhatsApp number</span>
        <input className="input" inputMode="tel" autoComplete="tel" value={to} placeholder="0803 123 4567" onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="bc-row">
        <button type="button" className="btn" onClick={() => void go()} disabled={busy || !to.trim() || disabledReason !== null}>
          {busy ? "Sending…" : "Send test"}
        </button>
        {disabledReason && <span className="bc-soft">{disabledReason}</span>}
      </div>
      {error && <p className="bc-notice bc-notice--red">{error}</p>}
      {!error && line && <p className={`bc-notice ${line.tone === "danger" ? "bc-notice--red" : line.tone === "warning" ? "bc-notice--amber" : "bc-notice--green"}`}>{line.text}</p>}
    </div>
  );
}
