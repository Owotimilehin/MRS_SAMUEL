/** Ads → Rules (suite spec 12, 7.11). A rule can pause an advert that has become too expensive. It can do nothing else. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { adsApi, adsKeys, type AdRule } from "./ads-api.js";
import { dateTime, ruleSentence } from "./ads-logic.js";
import { RuleDialog } from "./RuleDialog.js";

export function RulesTab({ currency }: { currency: string }): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adsKeys.rules, queryFn: adsApi.rules });
  const [editing, setEditing] = useState<AdRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdRule | null>(null);
  const [busy, setBusy] = useState(false);
  const campaigns = q.data?.campaigns ?? [];
  const nameOf = (id: string | null) => campaigns.find((c) => c.external_id === id)?.name ?? null;
  const reload = () => qc.invalidateQueries({ queryKey: adsKeys.rules });

  async function toggle(rule: AdRule): Promise<void> {
    try {
      await adsApi.updateRule(rule.id, { is_active: !rule.is_active });
      await reload();
    } catch (e) {
      toast.error(humanizeError(e));
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    try {
      await adsApi.deleteRule(deleting.id);
      setDeleting(null);
      await reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ads-card">
      {q.data && !q.data.rules_enabled ? <div className="ads-strip ads-strip--warn">Rules are switched off. The owner can turn them on in Settings.</div> : null}
      <div className="ads-actions" style={{ justifyContent: "space-between" }}>
        <p className="ads-fine">Rules can only pause. Nothing turns an advert on by itself.</p>
        <button type="button" className="btn btn--primary btn--sm" disabled={!q.data?.manage_enabled} onClick={() => setEditing("new")}>
          New rule
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data?.data.length ?? 0) === 0}
        emptyTitle="No rules yet"
        emptyHint="A rule can pause an advert when each chat costs more than you are willing to pay."
      >
        {(q.data?.data ?? []).map((r) => (
          <div key={r.id} className="ads-row">
            <div className="ads-row__text">
              <span className="ads-row__label">{r.name}</span>
              <span>{ruleSentence(r, nameOf(r.scope_campaign_external_id))}</span>
              <span className="ads-sub">
                Last checked {r.last_evaluated_at ? dateTime(r.last_evaluated_at) : "never"} · Last paused something{" "}
                {r.last_fired_at ? dateTime(r.last_fired_at) : "never"}
              </span>
            </div>
            <div className="ads-actions">
              <label className="ads-switch">
                <input type="checkbox" checked={r.is_active} disabled={!q.data?.manage_enabled} onChange={() => void toggle(r)} aria-label={`Rule ${r.name} is on`} />
              </label>
              <button type="button" className="btn btn--subtle btn--sm" disabled={!q.data?.manage_enabled} onClick={() => setEditing(r)}>
                Edit
              </button>
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDeleting(r)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </DataState>
      {editing ? (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          currency={currency}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmModal title={`Delete the rule "${deleting.name}"?`} confirmLabel="Delete" busyLabel="Deleting…" onConfirm={() => void remove()} onCancel={() => setDeleting(null)} busy={busy} tone="danger">
          <p style={{ margin: 0 }}>The rule stops checking adverts. What it already did stays in the activity log.</p>
        </ConfirmModal>
      ) : null}
    </section>
  );
}
