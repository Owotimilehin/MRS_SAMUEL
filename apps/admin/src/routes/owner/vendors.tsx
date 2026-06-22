import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useAuthUser } from "../../lib/auth.js";

interface Vendor {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function VendorsPage(): JSX.Element {
  const user = useAuthUser();
  const canWrite = user.capabilities.includes("expenses.write");
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Vendor | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      const res = await api<{ data: Vendor[] }>(`/vendors?${params}`);
      setVendors(res.data);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Delete vendor? Historical expenses keep their reference.")) return;
    await api(`/vendors/${id}`, { method: "DELETE" });
    setVendors((vs) => vs.filter((v) => v.id !== id));
    setFlash("Deleted");
    setTimeout(() => setFlash(null), 2500);
  }

  const activeVendors = vendors.filter((v) => v.deleted_at === null).length;
  const withContact = vendors.filter((v) => v.phone !== null || v.email !== null).length;

  return (
    <Shell
      title="Vendors"
      actions={
        canWrite ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowAdd(true)}>
            + Add vendor
          </button>
        ) : null
      }
    >
      <StatHero
        eyebrow="Finance"
        title="Vendors"
        sub="Supplier directory for expenses and purchases."
        loading={loading}
        chips={[
          { label: "Vendors", value: vendors.length },
          { label: "Active", value: activeVendors },
          { label: "With contact", value: withContact },
        ]}
      />
      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <input
          className="input"
          placeholder="Search by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 360 }}
        />
      </div>

      {loading ? (
        <InlineLoader />
      ) : vendors.length === 0 ? (
        <div className="empty">No vendors yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id}>
                  <td style={{ fontWeight: 600 }}>{v.name}</td>
                  <td>{v.phone ?? "—"}</td>
                  <td>{v.email ?? "—"}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{v.notes ?? "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {canWrite && (
                      <>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          onClick={() => setEditTarget(v)}
                          style={{ marginRight: 4 }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          onClick={() => void handleDelete(v.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {flash && (
        <div
          className="card"
          style={{
            borderColor: "rgba(16,185,129,0.35)",
            color: "var(--success)",
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 60,
          }}
        >
          {flash}
        </div>
      )}

      {(showAdd || editTarget) && (
        <VendorModal
          target={editTarget}
          onClose={() => {
            setShowAdd(false);
            setEditTarget(null);
          }}
          onSaved={async () => {
            setShowAdd(false);
            setEditTarget(null);
            setFlash("Saved");
            setTimeout(() => setFlash(null), 2500);
            await load();
          }}
        />
      )}
    </Shell>
  );
}

function VendorModal({
  target,
  onClose,
  onSaved,
}: {
  target: Vendor | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(target?.name ?? "");
  const [phone, setPhone] = useState(target?.phone ?? "");
  const [email, setEmail] = useState(target?.email ?? "");
  const [notes, setNotes] = useState(target?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      if (target) {
        await api(`/vendors/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/vendors`, { method: "POST", body: JSON.stringify(payload) });
      }
      await onSaved();
    } catch (err) {
      setError(humanizeError(err));
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
        style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "var(--shell)", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">{target ? "Edit vendor" : "Add vendor"}</h2>
        </header>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label className="field__label" htmlFor="v-name">Name</label>
            <input id="v-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="v-phone">Phone</label>
            <input id="v-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="v-email">Email</label>
            <input id="v-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="v-notes">Notes</label>
            <textarea id="v-notes" className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <div className="field__error">{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Saving…" : target ? "Save changes" : "Add vendor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
