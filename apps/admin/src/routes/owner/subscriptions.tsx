import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { Modal } from "../../components/Modal.js";
import { api, ApiError, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { StatHero } from "../../components/StatHero.js";

interface Plan {
  id: string;
  slug: string;
  name: string;
  priceNgn: number;
  period: string;
  bottlesLabel: string | null;
  description: string | null;
  perks: string[];
  popular: boolean;
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

export function SubscriptionsPage(): JSX.Element {
  const [rows, setRows] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Plan[] }>(`/marketing/subscription-plans`);
      setRows(res.data);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleActive(p: Plan): Promise<void> {
    setBusyId(p.id);
    try {
      await api(`/marketing/subscription-plans/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !p.isActive }),
      });
      await load();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: Plan): Promise<void> {
    if (!window.confirm(`Delete the "${p.name}" plan? This cannot be undone.`)) return;
    setBusyId(p.id);
    try {
      await api(`/marketing/subscription-plans/${p.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Shell
      title="Subscriptions"
      crumb="Storefront"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowNew(true)}>
          + New plan
        </button>
      }
    >
      <StatHero
        eyebrow="Marketing"
        title="Subscriptions"
        sub="Subscription plans shown on the storefront pricing page."
        loading={loading}
        chips={[
          {
            label: "Active plans",
            value: rows.filter((p) => p.isActive).length,
          },
          {
            label: "Hidden",
            value: rows.filter((p) => !p.isActive).length,
            tone: rows.filter((p) => !p.isActive).length > 0 ? "warn" : "good",
          },
          {
            label: "Listed MRR",
            value: naira(rows.filter((p) => p.isActive).reduce((sum, p) => sum + p.priceNgn, 0)),
          },
          {
            label: "Total plans",
            value: rows.length,
          },
        ]}
      />

      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No subscription plans yet</div>
          Click "New plan" to add one to the storefront subscription page.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Price</th>
                <th>Period</th>
                <th>Order</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>
                    {p.name} {p.popular && <span className="pill pill--success">Popular</span>}
                  </td>
                  <td>{naira(p.priceNgn)}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{p.period}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{p.displayOrder}</td>
                  <td>
                    {p.isActive ? (
                      <span className="pill pill--success">Active</span>
                    ) : (
                      <span className="pill">Hidden</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn--subtle btn--sm" style={{ marginRight: 6 }} onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className={p.isActive ? "btn btn--subtle btn--sm" : "btn btn--primary btn--sm"}
                      disabled={busyId === p.id}
                      onClick={() => void toggleActive(p)}
                      style={{ marginRight: 6 }}
                    >
                      {busyId === p.id ? "…" : p.isActive ? "Hide" : "Show"}
                    </button>
                    <button type="button" className="btn btn--subtle btn--sm" disabled={busyId === p.id} onClick={() => void remove(p)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <PlanForm mode="create" onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); void load(); }} />}
      {editing && <PlanForm mode="edit" plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </Shell>
  );
}

function PlanForm({ mode, plan, onClose, onSaved }: { mode: "create" | "edit"; plan?: Plan; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(plan?.name ?? "");
  const [slug, setSlug] = useState(plan?.slug ?? "");
  const [price, setPrice] = useState(plan ? String(plan.priceNgn) : "");
  const [period, setPeriod] = useState(plan?.period ?? "/week");
  const [bottles, setBottles] = useState(plan?.bottlesLabel ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [perks, setPerks] = useState((plan?.perks ?? []).join("\n"));
  const [popular, setPopular] = useState(!!plan?.popular);
  const [order, setOrder] = useState(plan ? String(plan.displayOrder) : "0");
  const [active, setActive] = useState(plan ? plan.isActive : true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      name,
      price_ngn: Number(price),
      period,
      bottles_label: bottles || null,
      description: description || null,
      perks: perks.split("\n").map((s) => s.trim()).filter(Boolean),
      popular,
      display_order: Number(order) || 0,
      is_active: active,
    };
    try {
      if (mode === "create") {
        await api(`/marketing/subscription-plans`, { method: "POST", body: JSON.stringify({ slug, ...payload }) });
      } else if (plan) {
        await api(`/marketing/subscription-plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : humanizeError(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title={mode === "create" ? "New plan" : `Edit · ${plan?.name}`} onClose={onClose} maxWidth={620}>
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
            <label className="field__label">Period</label>
            <input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="/week" required />
          </div>
        </div>
        <div className="field">
          <label className="field__label">Bottles label</label>
          <input className="input" value={bottles} onChange={(e) => setBottles(e.target.value)} placeholder="7 bottles" />
        </div>
        <div className="field">
          <label className="field__label">Description</label>
          <textarea className="textarea" rows={2} maxLength={600} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">Perks (one per line)</label>
          <textarea className="textarea" rows={4} value={perks} onChange={(e) => setPerks(e.target.value)} placeholder={"7 × 330ml weekly\nSkip any week\n5% off retail"} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, alignItems: "end" }}>
          <div className="field">
            <label className="field__label">Display order</label>
            <input className="input" type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 16, paddingBottom: 8 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" checked={popular} onChange={(e) => setPopular(e.target.checked)} /> Popular
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
            </label>
          </div>
        </div>
        {error && <div className="field__error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create plan" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}
