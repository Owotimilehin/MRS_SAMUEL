import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
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
  const [tab, setTab] = useState<"expenses" | "pnl">("expenses");
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
        api<{ data: Pnl }>(`/reports/pnl?month=${month}`),
      ]);
      setExpenses(ex.data);
      setPnl(p.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          <button
            type="button"
            className={tab === "pnl" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("pnl")}
          >
            P&L
          </button>
        </div>
      }
    >
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
        {tab === "expenses" && (
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
        {tab === "pnl" && (
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
        {tab === "expenses" && canWrite && (
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
      ) : tab === "expenses" ? (
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
      ) : (
        <PnlPanel pnl={pnl} />
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
      setError(err instanceof Error ? err.message : String(err));
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
        style={{
          width: "100%",
          maxWidth: 520,
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
