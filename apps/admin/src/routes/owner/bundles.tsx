import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { Modal } from "../../components/Modal.js";
import { api, ApiError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Bundle {
  id: string;
  slug: string;
  name: string;
  priceNgn: number;
  description: string | null;
  contentsLabel: string | null;
  badge: string | null;
  imageUrl: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function naira(n: number): string {
  return `₦${n.toLocaleString("en-NG")}`;
}

export function BundlesPage(): JSX.Element {
  const [rows, setRows] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Bundle | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Bundle[] }>(`/marketing/bundles`);
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

  async function toggleActive(b: Bundle): Promise<void> {
    setBusyId(b.id);
    try {
      await api(`/marketing/bundles/${b.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !b.isActive }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(b: Bundle): Promise<void> {
    if (!window.confirm(`Delete the "${b.name}" bundle? This cannot be undone.`)) return;
    setBusyId(b.id);
    try {
      await api(`/marketing/bundles/${b.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Shell
      title="Bundles"
      crumb="Storefront"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowNew(true)}>
          + New bundle
        </button>
      }
    >
      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No bundles yet</div>
          Click "New bundle" to add a gift box / multipack to the shop page.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Price</th>
                <th>Contents</th>
                <th>Order</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>
                    {b.name} {b.badge && <span className="pill">{b.badge}</span>}
                  </td>
                  <td>{naira(b.priceNgn)}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{b.contentsLabel ?? "—"}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{b.displayOrder}</td>
                  <td>
                    {b.isActive ? <span className="pill pill--success">Active</span> : <span className="pill">Hidden</span>}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn--subtle btn--sm" style={{ marginRight: 6 }} onClick={() => setEditing(b)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={b.isActive ? "btn btn--subtle btn--sm" : "btn btn--primary btn--sm"}
                      disabled={busyId === b.id}
                      onClick={() => void toggleActive(b)}
                      style={{ marginRight: 6 }}
                    >
                      {busyId === b.id ? "…" : b.isActive ? "Hide" : "Show"}
                    </button>
                    <button type="button" className="btn btn--subtle btn--sm" disabled={busyId === b.id} onClick={() => void remove(b)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <BundleForm mode="create" onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); void load(); }} />}
      {editing && <BundleForm mode="edit" bundle={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </Shell>
  );
}

function BundleForm({ mode, bundle, onClose, onSaved }: { mode: "create" | "edit"; bundle?: Bundle; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(bundle?.name ?? "");
  const [slug, setSlug] = useState(bundle?.slug ?? "");
  const [price, setPrice] = useState(bundle ? String(bundle.priceNgn) : "");
  const [contents, setContents] = useState(bundle?.contentsLabel ?? "");
  const [badge, setBadge] = useState(bundle?.badge ?? "");
  const [description, setDescription] = useState(bundle?.description ?? "");
  const [imageUrl, setImageUrl] = useState(bundle?.imageUrl ?? "");
  const [order, setOrder] = useState(bundle ? String(bundle.displayOrder) : "0");
  const [active, setActive] = useState(bundle ? bundle.isActive : true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      name,
      price_ngn: Number(price),
      contents_label: contents || null,
      badge: badge || null,
      description: description || null,
      image_url: imageUrl || null,
      display_order: Number(order) || 0,
      is_active: active,
    };
    try {
      if (mode === "create") {
        await api(`/marketing/bundles`, { method: "POST", body: JSON.stringify({ slug, ...payload }) });
      } else if (bundle) {
        await api(`/marketing/bundles/${bundle.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title={mode === "create" ? "New bundle" : `Edit · ${bundle?.name}`} onClose={onClose} maxWidth={620}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label className="field__label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (mode === "create" && (!slug || slug === slugify(name))) setSlug(slugify(e.target.value));
            }}
            required
          />
        </div>
        <div className="field">
          <label className="field__label">Slug</label>
          <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} pattern="^[a-z0-9\-]+$" required disabled={mode === "edit"} style={{ fontFamily: "monospace" }} />
          <span className="field__hint">Locked after creation.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label className="field__label">Price (₦)</label>
            <input className="input" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field__label">Contents label</label>
            <input className="input" value={contents} onChange={(e) => setContents(e.target.value)} placeholder="6 × 330ml" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
          <div className="field">
            <label className="field__label">Badge (optional)</label>
            <input className="input" value={badge} onChange={(e) => setBadge(e.target.value)} placeholder="Most loved" />
          </div>
          <div className="field">
            <label className="field__label">Order</label>
            <input className="input" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="field__label">Description</label>
          <textarea className="textarea" rows={2} maxLength={600} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Image URL (optional)</label>
          <input className="input" type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (visible on the shop page)
        </label>
        {error && <div className="field__error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create bundle" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}
