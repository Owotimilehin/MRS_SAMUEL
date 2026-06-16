import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { StatHero } from "../../components/StatHero.js";

interface BranchRow {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  managerUserId: string | null;
  deliveryZones: Array<{ name: string; fee_ngn: number }>;
  opensAt: string | null;
  closesAt: string | null;
}

export function BranchesPage(): JSX.Element {
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: BranchRow[] }>(`/branches`);
      setRows(res.data);
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

  const totalZones = rows.reduce((sum, b) => sum + b.deliveryZones.length, 0);

  return (
    <Shell
      title="Branches"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          + New branch
        </button>
      }
    >
      <StatHero
        eyebrow="Admin"
        title="Branches"
        sub="Physical locations running the daily till."
        loading={loading}
        chips={[
          { label: "Branches", value: rows.length },
          { label: "Delivery zones", value: totalZones },
        ]}
      />

      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No branches yet</div>
          Add your first branch to start running the daily till.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 16,
          }}
        >
          {rows.map((b) => (
            <Link
              key={b.id}
              to="/owner/branches/$branchId"
              params={{ branchId: b.id }}
              className="card card--hoverable"
              style={{ textDecoration: "none", color: "inherit", display: "block" }}
            >
              <header style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontWeight: 700, fontSize: 16, margin: 0 }}>{b.name}</h3>
                <span className="pill pill--ink">{b.code}</span>
              </header>
              <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12, minHeight: 36 }}>
                {b.address ?? "No address set"}
                {b.phone && (
                  <>
                    <br />
                    📞 {b.phone}
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {b.opensAt && b.closesAt && (
                  <span className="pill">
                    🕐 {b.opensAt.slice(0, 5)}–{b.closesAt.slice(0, 5)}
                  </span>
                )}
                <span className="pill">{b.deliveryZones.length} zones</span>
              </div>
              {b.deliveryZones.length > 0 && (
                <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 13 }}>
                  {b.deliveryZones.slice(0, 4).map((z) => (
                    <li
                      key={z.name}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "4px 0",
                        borderTop: "1px solid var(--line)",
                      }}
                    >
                      <span>{z.name}</span>
                      <span className="tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {ngn(z.fee_ngn)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateBranchModal
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </Shell>
  );
}

function CreateBranchModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [opensAt, setOpensAt] = useState("08:00");
  const [closesAt, setClosesAt] = useState("21:00");
  const [zones, setZones] = useState<Array<{ name: string; fee_ngn: number }>>([]);
  const [zoneName, setZoneName] = useState("");
  const [zoneFee, setZoneFee] = useState("1500");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addZone(): void {
    if (!zoneName.trim()) return;
    setZones((zs) => [...zs, { name: zoneName.trim(), fee_ngn: Number(zoneFee) }]);
    setZoneName("");
    setZoneFee("1500");
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/branches`, {
        method: "POST",
        body: JSON.stringify({
          name,
          code,
          address: address || undefined,
          phone: phone || undefined,
          delivery_zones: zones,
          opens_at: opensAt,
          closes_at: closesAt,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 520, maxHeight: "calc(100vh - 32px)", overflow: "auto", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}
        >
          <h2 className="t-h2">New branch</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 22, cursor: "pointer", color: "var(--ink-soft)" }}
          >
            ×
          </button>
        </header>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field__label">Name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!code) {
                    setCode(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]+/g, "_")
                        .replace(/^_|_$/g, ""),
                    );
                  }
                }}
                required
              />
            </div>
            <div className="field">
              <label className="field__label">Code</label>
              <input
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]+/g, ""))}
                pattern="^[A-Z0-9_\-]+$"
                required
              />
            </div>
          </div>
          <div className="field">
            <label className="field__label">Address</label>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field__label">Phone</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label className="field__label">Opens</label>
              <input
                className="input"
                type="time"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label">Closes</label>
              <input
                className="input"
                type="time"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label className="field__label">Delivery zones</label>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8 }}>
              <input
                className="input"
                placeholder="Zone name"
                value={zoneName}
                onChange={(e) => setZoneName(e.target.value)}
              />
              <input
                className="input"
                type="number"
                placeholder="Fee"
                value={zoneFee}
                onChange={(e) => setZoneFee(e.target.value)}
              />
              <button type="button" className="btn btn--subtle btn--sm" onClick={addZone}>
                Add
              </button>
            </div>
            {zones.length > 0 && (
              <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", fontSize: 13 }}>
                {zones.map((z, i) => (
                  <li
                    key={`${z.name}-${i}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "4px 0",
                      borderTop: "1px solid var(--line)",
                    }}
                  >
                    <span>{z.name}</span>
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="tabular-nums">{ngn(z.fee_ngn)}</span>
                      <button
                        type="button"
                        onClick={() => setZones((zs) => zs.filter((_, idx) => idx !== i))}
                        style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-soft)" }}
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <div className="field__error">{error}</div>}
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? "Saving…" : "Create branch"}
          </button>
        </form>
      </div>
    </div>
  );
}
