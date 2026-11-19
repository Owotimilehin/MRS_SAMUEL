/**
 * Secure connection for live forms (suite spec 07, 7.2, Phase B): whether WhatsApp holds the public half of
 * our key for each number, and a button to send it. The server only ever tells us yes or no and WhatsApp's
 * verdict; no key text reaches this screen. If the server cannot answer (an older one has no such route),
 * the card is simply not shown.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { toast } from "@admin/lib/toast.js";
import { TONE_PILL } from "../template-labels.js";
import { TemplateFailure } from "../templates-api.js";
import { flowKeys, flowsApi, type EncryptionNumber, type FlowDto } from "./flows-api.js";
import { keyStatusWording, showSecureCard } from "./form-labels.js";

export function SecureConnectionCard({ forms }: { forms: readonly FlowDto[] }): JSX.Element | null {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: flowKeys.encryption, queryFn: flowsApi.encryption, refetchOnWindowFocus: false, retry: false });
  const [asking, setAsking] = useState<EncryptionNumber | null>(null);
  const [busy, setBusy] = useState(false);

  if (!q.data || !showSecureCard(q.data.key_configured, forms)) return null;
  const state = q.data;

  async function send(n: EncryptionNumber): Promise<void> {
    setBusy(true);
    try {
      const row = await flowsApi.uploadKey(n.number_id);
      if (row.signature_status === "VALID") toast.success(`The key is in place for ${n.label}.`);
      else toast.info(row.error ?? "Sent. WhatsApp has not confirmed the key yet.");
    } catch (err) {
      toast.error(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
      setAsking(null);
      void qc.invalidateQueries({ queryKey: flowKeys.encryption });
      void qc.invalidateQueries({ queryKey: flowKeys.list });
    }
  }

  return (
    <section className="card tpl-section" aria-label="Secure connection for live forms">
      <h2 className="tpl-h">Secure connection for live forms</h2>
      {!state.key_configured ? (
        <p className="tpl-card__line" style={{ margin: 0 }}>
          The technical lead has not set up the key on the server yet.
        </p>
      ) : (
        <ul className="tpl-keys">
          {state.numbers.map((n) => {
            const w = keyStatusWording(n.signature_status);
            return (
              <li key={n.number_id}>
                <span className="tpl-keys__who">
                  <strong>{n.label}</strong>
                  <span className={TONE_PILL[w.tone]}>{w.label}</span>
                </span>
                <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => setAsking(n)}>
                  Send our key to WhatsApp
                </button>
                {n.error && (
                  <span className="tpl-note tpl-note--red tpl-keys__error" role="alert">
                    {n.error}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {asking && (
        <ConfirmModal
          title="Send our key to WhatsApp?"
          confirmLabel="Send our key to WhatsApp"
          busyLabel="Sending…"
          busy={busy}
          onConfirm={() => void send(asking)}
          onCancel={() => (busy ? undefined : setAsking(null))}
        >
          <p style={{ margin: 0 }}>Send the public half of our key to WhatsApp for {asking.label}? This is safe to repeat.</p>
        </ConfirmModal>
      )}
    </section>
  );
}
