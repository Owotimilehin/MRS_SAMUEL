import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Zone {
  name: string;
  fee_ngn: number;
}
interface Branch {
  id: string;
  name: string;
  deliveryZones: Zone[];
}

export function ZonesPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editing, setEditing] = useState<{ branchId: string; zones: Zone[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Branch[] }>("/branches");
      setBranches(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startEdit(b: Branch): void {
    setEditing({ branchId: b.id, zones: [...(b.deliveryZones ?? [])] });
  }

  function updateZone(i: number, patch: Partial<Zone>): void {
    setEditing((prev) =>
      prev
        ? {
            ...prev,
            zones: prev.zones.map((z, idx) => (idx === i ? { ...z, ...patch } : z)),
          }
        : prev,
    );
  }

  function removeZone(i: number): void {
    setEditing((prev) =>
      prev ? { ...prev, zones: prev.zones.filter((_, idx) => idx !== i) } : prev,
    );
  }

  function addZone(): void {
    setEditing((prev) =>
      prev ? { ...prev, zones: [...prev.zones, { name: "", fee_ngn: 0 }] } : prev,
    );
  }

  async function save(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/branches/${editing.branchId}`, {
        method: "PATCH",
        body: JSON.stringify({ deliveryZones: editing.zones }),
      });
      setFlash("Zones saved — live on checkout within 1 minute.");
      setEditing(null);
      await load();
      window.setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell title="Delivery zones">
      {flash && (
        <div
          role="status"
          style={{
            background: "var(--success)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 12,
            marginBottom: 14,
            fontSize: 14,
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div role="alert" className="empty" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {branches.map((b) => (
            <section key={b.id} className="card">
              <header
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 14,
                }}
              >
                <h2 className="t-h2">{b.name}</h2>
                {editing?.branchId !== b.id && (
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={() => startEdit(b)}
                  >
                    Edit zones
                  </button>
                )}
              </header>

              {editing?.branchId === b.id ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {editing.zones.map((z, i) => (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "2fr 1fr auto",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <input
                        className="input"
                        placeholder="Zone name (e.g. Lekki Phase 1)"
                        value={z.name}
                        onChange={(e) => updateZone(i, { name: e.target.value })}
                      />
                      <input
                        className="input"
                        placeholder="Fee (₦)"
                        type="number"
                        min={0}
                        value={z.fee_ngn}
                        onChange={(e) =>
                          updateZone(i, { fee_ngn: Number(e.target.value) })
                        }
                      />
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        onClick={() => removeZone(i)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={addZone}
                    >
                      + Add zone
                    </button>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEditing(null)}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={save}
                      disabled={saving}
                    >
                      {saving ? "Saving…" : "Save zones"}
                    </button>
                  </div>
                </div>
              ) : (b.deliveryZones?.length ?? 0) === 0 ? (
                <p style={{ color: "var(--ink-soft)" }}>
                  No zones defined yet — add one so customers can check out.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Zone</th>
                        <th className="table__num">Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.deliveryZones.map((z, i) => (
                        <tr key={`${z.name}-${i}`}>
                          <td>{z.name}</td>
                          <td className="table__num" style={{ fontWeight: 700 }}>
                            {ngn(z.fee_ngn)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}
