import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useAuthUser } from "../../lib/auth.js";

const CATEGORIES: Array<{ code: string; label: string }> = [
  { code: "raw_materials", label: "Raw materials" },
  { code: "packaging", label: "Packaging" },
  { code: "utilities", label: "Utilities" },
  { code: "transport", label: "Transport" },
  { code: "salaries", label: "Salaries" },
  { code: "rent", label: "Rent" },
  { code: "marketing", label: "Marketing" },
  { code: "equipment", label: "Equipment" },
  { code: "regulatory", label: "Regulatory" },
  { code: "other_with_note", label: "Other (specify)" },
];
const labelFor = (code: string): string =>
  CATEGORIES.find((c) => c.code === code)?.label ?? code;

interface Expense {
  id: string;
  expense_date: string;
  category_code: string;
  amount_ngn: number;
  vendor_id: string | null;
  vendor_name: string | null;
  description: string | null;
  reason_note: string | null;
  receipt_url: string | null;
  deleted_at: string | null;
}

interface Pnl {
  month: string;
  revenue_ngn: number;
  refunds_ngn: number;
  net_revenue_ngn: number;
  expenses_total_ngn: number;
  expenses_by_category: Array<{ category_code: string; label: string; amount_ngn: number }>;
  expense_count: number;
  net_ngn: number;
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const fromD = new Date(Date.UTC(y!, m! - 1, 1));
  const toD = new Date(Date.UTC(y!, m!, 0));
  return { from: fromD.toISOString().slice(0, 10), to: toD.toISOString().slice(0, 10) };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function BookkeepingPage(): JSX.Element {
  const user = useAuthUser();
  const canWrite = user.capabilities.includes("expenses.write");
  const canFinance = user.capabilities.includes("finance.view");
  const [tab, setTab] = useState<"expenses" | "pnl" | "recurring">("expenses");
  // If finance is off and somehow on the pnl tab, fall back to expenses.
  const activeTab = !canFinance && tab === "pnl" ? "expenses" : tab;
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function loadAll(): Promise<void> {
    setLoading(true);
    try {
      const { from, to } = monthBounds(month);
      const [ex, p] = await Promise.all([
        api<{ data: Expense[]; pagination: { total: number } }>(
          `/expenses?from=${from}&to=${to}&page_size=200`,
        ),
        canFinance ? api<{ data: Pnl }>(`/reports/pnl?month=${month}`) : Promise.resolve(null),
      ]);
      setExpenses(ex.data);
      if (p) setPnl(p.data);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const filteredTotal = useMemo(
    () => expenses.reduce((s, e) => s + e.amount_ngn, 0),
    [expenses],
  );

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Delete this expense? It's recoverable from the audit log.")) return;
    await api(`/expenses/${id}`, { method: "DELETE" });
    setExpenses((rows) => rows.filter((r) => r.id !== id));
    setFlash("Deleted");
    setTimeout(() => setFlash(null), 2500);
  }

  const marginPct = pnl && pnl.net_revenue_ngn > 0
    ? Math.round((pnl.net_ngn / pnl.net_revenue_ngn) * 100)
    : 0;

  return (
    <Shell
      title="Bookkeeping"
      actions={
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={tab === "expenses" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("expenses")}
          >
            Expenses
          </button>
          {canFinance && (
            <button
              type="button"
              className={tab === "pnl" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
              onClick={() => setTab("pnl")}
            >
              P&L
            </button>
          )}
          <button
            type="button"
            className={tab === "recurring" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("recurring")}
          >
            Recurring
          </button>
        </div>
      }
    >
      <StatHero
        eyebrow="Finance"
        title="Bookkeeping"
        sub={canFinance ? `Revenue, expenses and profit for ${month}.` : `Expense records for ${month}.`}
        loading={loading}
        chips={
          canFinance
            ? [
                { label: "Revenue", value: pnl ? ngn(pnl.net_revenue_ngn) : "—" },
                { label: "Expenses", value: pnl ? ngn(pnl.expenses_total_ngn) : "—" },
                { label: "Profit", value: pnl ? ngn(pnl.net_ngn) : "—", tone: pnl ? (pnl.net_ngn >= 0 ? "good" : "danger") : "default" },
                { label: "Margin", value: pnl ? `${marginPct}%` : "—" },
              ]
            : []
        }
      />
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ◀
        </button>
        <strong style={{ minWidth: 120, textAlign: "center" }}>{month}</strong>
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ▶
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setMonth(new Date().toISOString().slice(0, 7))}
        >
          Today
        </button>
        <div style={{ flex: 1 }} />
        {activeTab === "expenses" && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={() => {
              const { from, to } = monthBounds(month);
              window.open(`/v1/expenses?from=${from}&to=${to}&format=csv`, "_blank");
            }}
            style={{ marginRight: 6 }}
          >
            ⬇ CSV
          </button>
        )}
        {activeTab === "pnl" && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={() => {
              window.open(`/v1/reports/pnl?month=${month}&format=csv`, "_blank");
            }}
            style={{ marginRight: 6 }}
          >
            ⬇ CSV
          </button>
        )}
        {activeTab === "expenses" && canWrite && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setShowAdd(true)}
          >
            + Add expense
          </button>
        )}
      </div>

      {loading ? (
        <InlineLoader />
      ) : activeTab === "expenses" ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Vendor</th>
                  <th>Description</th>
                  <th className="table__num">Amount</th>
                  <th>Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ color: "var(--ink-soft)", padding: 18 }}>
                      No expenses in this month yet.
                    </td>
                  </tr>
                ) : (
                  expenses.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDate(e.expense_date)}</td>
                      <td>{labelFor(e.category_code)}</td>
                      <td>{e.vendor_name ?? "—"}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{e.description ?? "—"}</td>
                      <td className="table__num" style={{ fontWeight: 700 }}>
                        {ngn(e.amount_ngn)}
                      </td>
                      <td>
                        {e.receipt_url ? (
                          <a href={e.receipt_url} target="_blank" rel="noreferrer" title="Open receipt">
                            📎
                          </a>
                        ) : (
                          ""
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {canWrite && (
                          <>
                            <button
                              type="button"
                              className="btn btn--subtle btn--sm"
                              onClick={() => setEditTarget(e)}
                              style={{ marginRight: 4 }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--subtle btn--sm"
                              onClick={() => void handleDelete(e.id)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 12 }}>
            Filtered total:{" "}
            <strong style={{ color: "var(--ink)" }}>{ngn(filteredTotal)}</strong> ·{" "}
            {expenses.length} entr{expenses.length === 1 ? "y" : "ies"}.
          </p>
        </>
      ) : activeTab === "pnl" ? (
        <PnlPanel pnl={pnl} />
      ) : (
        <RecurringPanel canWrite={canWrite} />
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
        <ExpenseModal
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
            await loadAll();
          }}
        />
      )}
    </Shell>
  );
}

function PnlPanel({ pnl }: { pnl: Pnl | null }): JSX.Element {
  if (!pnl) return <InlineLoader />;
  const max = pnl.expenses_by_category.reduce((m, r) => Math.max(m, r.amount_ngn), 0);
  const netPositive = pnl.net_ngn >= 0;
  return (
    <>
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 18 }}
      >
        <BigCard label="Revenue" value={ngn(pnl.net_revenue_ngn)} />
        <BigCard label="Expenses" value={ngn(pnl.expenses_total_ngn)} />
        <BigCard
          label="Net"
          value={ngn(pnl.net_ngn)}
          tone={netPositive ? "var(--success)" : "var(--danger)"}
        />
      </div>
      <section className="card">
        <h2 className="t-h2" style={{ marginBottom: 12 }}>
          Expenses by category
        </h2>
        {pnl.expenses_by_category.length === 0 ? (
          <div className="empty">No expenses this month.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {pnl.expenses_by_category.map((row) => {
              const pct = max > 0 ? Math.round((row.amount_ngn / max) * 100) : 0;
              const share =
                pnl.expenses_total_ngn > 0
                  ? Math.round((row.amount_ngn / pnl.expenses_total_ngn) * 100)
                  : 0;
              return (
                <div
                  key={row.category_code}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "180px 1fr 140px",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{row.label}</div>
                  <div
                    style={{
                      background: "var(--surface-soft)",
                      height: 18,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <div style={{ width: `${pct}%`, height: "100%", background: "var(--grad)" }} />
                  </div>
                  <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {ngn(row.amount_ngn)}{" "}
                    <span style={{ color: "var(--ink-soft)" }}>({share}%)</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function BigCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}): JSX.Element {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 800,
          marginTop: 4,
          color: tone ?? "var(--ink)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ExpenseModal({
  target,
  onClose,
  onSaved,
}: {
  target: Expense | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [expenseDate, setExpenseDate] = useState(
    target?.expense_date ?? new Date().toISOString().slice(0, 10),
  );
  const [categoryCode, setCategoryCode] = useState(target?.category_code ?? "raw_materials");
  const [amount, setAmount] = useState<number>(target?.amount_ngn ?? 0);
  const [vendor, setVendor] = useState(target?.vendor_name ?? "");
  const [vendorId, setVendorId] = useState<string | null>(target?.vendor_id ?? null);
  const [vendorOptions, setVendorOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [description, setDescription] = useState(target?.description ?? "");
  const [reasonNote, setReasonNote] = useState(target?.reason_note ?? "");
  const [receiptKey, setReceiptKey] = useState<string | null>(target?.receipt_url ?? null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced vendor search as the owner types.
  useEffect(() => {
    if (vendorId && vendor && vendorOptions.find((o) => o.id === vendorId)?.name === vendor) {
      // Selection still matches; no search.
      return;
    }
    const q = vendor.trim();
    if (q.length === 0) {
      setVendorOptions([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ data: Array<{ id: string; name: string }> }>(`/vendors?q=${encodeURIComponent(q)}`)
        .then((r) => setVendorOptions(r.data))
        .catch(() => setVendorOptions([]));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor]);

  async function handleReceiptFile(file: File): Promise<void> {
    setUploadingReceipt(true);
    setError(null);
    try {
      const presign = await api<{ data: { upload_url: string; object_key: string } }>(
        `/expenses/presign-upload`,
        {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
          }),
        },
      );
      const put = await fetch(presign.data.upload_url, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`upload failed: ${put.status}`);
      setReceiptKey(presign.data.object_key);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setUploadingReceipt(false);
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (categoryCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    if (amount <= 0) {
      setError("Amount must be greater than 0");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // If the user typed a vendor name but didn't pick a record AND it doesn't
      // exactly match an existing option, create the vendor first so we always
      // attach a structured vendor_id when there is text.
      let effectiveVendorId = vendorId;
      const typed = vendor.trim();
      if (!effectiveVendorId && typed.length > 0) {
        const exact = vendorOptions.find((o) => o.name.toLowerCase() === typed.toLowerCase());
        if (exact) {
          effectiveVendorId = exact.id;
        } else {
          const created = await api<{ data: { id: string } }>(`/vendors`, {
            method: "POST",
            body: JSON.stringify({ name: typed }),
          });
          effectiveVendorId = created.data.id;
        }
      }
      const payload = {
        expense_date: expenseDate,
        category_code: categoryCode,
        amount_ngn: Math.round(amount),
        vendor_id: effectiveVendorId ?? null,
        vendor_name: effectiveVendorId ? undefined : (typed || undefined),
        description: description.trim() || undefined,
        reason_note: reasonNote.trim() || undefined,
        receipt_url: receiptKey ?? undefined,
      };
      if (target) {
        await api(`/expenses/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/expenses`, { method: "POST", body: JSON.stringify(payload) });
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
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          background: "var(--shell)",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">{target ? "Edit expense" : "Add expense"}</h2>
        </header>
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div className="field">
            <label className="field__label" htmlFor="ex-date">
              Date
            </label>
            <input
              id="ex-date"
              className="input"
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ex-cat">
              Category
            </label>
            <select
              id="ex-cat"
              className="select"
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ex-amt">
              Amount (₦)
            </label>
            <input
              id="ex-amt"
              className="input"
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              style={{ textAlign: "right" }}
              required
            />
          </div>
          <div className="field" style={{ position: "relative" }}>
            <label className="field__label" htmlFor="ex-vendor">
              Vendor (optional)
            </label>
            <input
              id="ex-vendor"
              className="input"
              value={vendor}
              onChange={(e) => {
                setVendor(e.target.value);
                setVendorId(null);
                setVendorOpen(true);
              }}
              onFocus={() => setVendorOpen(true)}
              onBlur={() => setTimeout(() => setVendorOpen(false), 150)}
              placeholder="Search or type a new vendor"
              autoComplete="off"
            />
            {vendorOpen && vendorOptions.length > 0 && (
              <div
                className="card"
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  marginTop: 4,
                  padding: 0,
                  maxHeight: 200,
                  overflowY: "auto",
                  zIndex: 10,
                  boxShadow: "var(--shadow-float)",
                }}
              >
                {vendorOptions.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setVendor(o.name);
                      setVendorId(o.id);
                      setVendorOpen(false);
                    }}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            )}
            {vendor.trim() && !vendorId && !vendorOptions.some((o) => o.name.toLowerCase() === vendor.trim().toLowerCase()) && (
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
                ↳ Will create new vendor “{vendor.trim()}” on save.
              </div>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ex-desc">
              Description (optional)
            </label>
            <input
              id="ex-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {categoryCode === "other_with_note" && (
            <div className="field">
              <label className="field__label" htmlFor="ex-note">
                Notes
              </label>
              <textarea
                id="ex-note"
                className="textarea"
                rows={2}
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Describe what this expense is for"
              />
            </div>
          )}
          <div className="field">
            <label className="field__label">Receipt photo (optional)</label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleReceiptFile(file);
              }}
              disabled={uploadingReceipt}
            />
            {uploadingReceipt && (
              <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>Uploading…</span>
            )}
            {receiptKey && !uploadingReceipt && (
              <span style={{ color: "var(--success)", fontSize: 13 }}>📎 Attached</span>
            )}
          </div>
          {error && <div className="field__error">{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button
              type="button"
              className="btn btn--subtle"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || uploadingReceipt}
            >
              {submitting ? "Saving…" : target ? "Save changes" : "Add expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface Recurring {
  id: string;
  category_code: string;
  amount_ngn: number;
  vendor_name: string | null;
  description: string | null;
  reason_note: string | null;
  day_of_month: number;
  starts_on: string;
  ends_on: string | null;
  active: boolean;
}

function RecurringPanel({ canWrite }: { canWrite: boolean }): JSX.Element {
  const [rows, setRows] = useState<Recurring[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Recurring | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Recurring[] }>(`/expenses/recurring`);
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

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Delete this recurring schedule?")) return;
    await api(`/expenses/recurring/${id}`, { method: "DELETE" });
    setRows((vs) => vs.filter((v) => v.id !== id));
  }

  async function toggleActive(r: Recurring): Promise<void> {
    await api(`/expenses/recurring/${r.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !r.active }),
    });
    setRows((vs) => vs.map((v) => (v.id === r.id ? { ...v, active: !v.active } : v)));
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: 0 }}>
          Schedules that the worker materialises into a real expense each month on the matching day.
        </p>
        {canWrite && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowAdd(true)}>
            + Add schedule
          </button>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">No recurring schedules yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Category</th>
                <th>Vendor</th>
                <th className="table__num">Amount</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.day_of_month}</td>
                  <td>{labelFor(r.category_code)}</td>
                  <td>{r.vendor_name ?? "—"}</td>
                  <td className="table__num" style={{ fontWeight: 700 }}>{ngn(r.amount_ngn)}</td>
                  <td>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        onClick={() => void toggleActive(r)}
                      >
                        {r.active ? "On" : "Off"}
                      </button>
                    ) : r.active ? "On" : "Off"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {canWrite && (
                      <>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          onClick={() => setEditTarget(r)}
                          style={{ marginRight: 4 }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          onClick={() => void handleDelete(r.id)}
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

      {(showAdd || editTarget) && (
        <RecurringModal
          target={editTarget}
          onClose={() => {
            setShowAdd(false);
            setEditTarget(null);
          }}
          onSaved={async () => {
            setShowAdd(false);
            setEditTarget(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function RecurringModal({
  target,
  onClose,
  onSaved,
}: {
  target: Recurring | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [categoryCode, setCategoryCode] = useState(target?.category_code ?? "rent");
  const [amount, setAmount] = useState<number>(target?.amount_ngn ?? 0);
  const [vendor, setVendor] = useState(target?.vendor_name ?? "");
  const [description, setDescription] = useState(target?.description ?? "");
  const [reasonNote, setReasonNote] = useState(target?.reason_note ?? "");
  const [dayOfMonth, setDayOfMonth] = useState<number>(target?.day_of_month ?? 1);
  const [startsOn, setStartsOn] = useState(target?.starts_on ?? new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(target?.ends_on ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (categoryCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    if (amount <= 0) {
      setError("Amount must be greater than 0");
      return;
    }
    if (dayOfMonth < 1 || dayOfMonth > 31) {
      setError("Day must be 1–31");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        category_code: categoryCode,
        amount_ngn: Math.round(amount),
        vendor_name: vendor.trim() || undefined,
        description: description.trim() || undefined,
        reason_note: reasonNote.trim() || undefined,
        day_of_month: dayOfMonth,
        starts_on: startsOn,
        ends_on: endsOn || null,
      };
      if (target) {
        await api(`/expenses/recurring/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/expenses/recurring`, { method: "POST", body: JSON.stringify(payload) });
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
          <h2 className="t-h2">{target ? "Edit recurring schedule" : "Add recurring schedule"}</h2>
        </header>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label className="field__label" htmlFor="rec-cat">Category</label>
            <select id="rec-cat" className="select" value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="rec-amt">Amount (₦)</label>
            <input id="rec-amt" className="input" type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ textAlign: "right" }} required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="rec-dom">Day of month (1–31)</label>
            <input id="rec-dom" className="input" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="rec-vendor">Vendor (optional)</label>
            <input id="rec-vendor" className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="rec-desc">Description (optional)</label>
            <input id="rec-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {categoryCode === "other_with_note" && (
            <div className="field">
              <label className="field__label" htmlFor="rec-note">Notes</label>
              <textarea id="rec-note" className="textarea" rows={2} value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="field">
              <label className="field__label" htmlFor="rec-start">Starts on</label>
              <input id="rec-start" className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="rec-end">Ends on (optional)</label>
              <input id="rec-end" className="input" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
          </div>
          {error && <div className="field__error">{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Saving…" : target ? "Save changes" : "Add schedule"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
