import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BRANCH_EXPENSE_CATEGORIES,
  BRANCH_EXPENSE_CATEGORY_LABEL,
  BRANCH_EXPENSE_DESCRIPTION_MAX,
  BRANCH_EXPENSE_DESCRIPTION_MIN,
  BRANCH_EXPENSE_MAX_AGE_DAYS,
  BRANCH_EXPENSE_MAX_NGN,
  branchExpenseDateProblem,
  lagosDate,
  mondayOf,
  shiftDays,
  type BranchExpenseCategory,
} from "@ms/shared";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero, type StatChip } from "../../components/StatHero.js";
import { InlineLoader } from "../../components/Spinner.js";
import { api, humanizeError } from "../../lib/api.js";
import { useAuthUser } from "../../lib/auth.js";
import { ngn, formatDate } from "../../lib/format.js";
import { toast } from "../../lib/toast.js";

interface SpendRow {
  id: string;
  expense_date: string;
  category_code: string;
  amount_ngn: number;
  description: string | null;
  created_at: string;
  recorded_by_name: string | null;
}

const CATEGORY_LABEL: Record<string, string> = BRANCH_EXPENSE_CATEGORY_LABEL;

/**
 * Shop spending: the small money paid out at the branch (ice, fuel, a rider,
 * cleaning). Logged here, it shows in the owner's Bookkeeping under this branch.
 */
export function BranchExpensesPage({ branchId }: { branchId: string }): JSX.Element {
  const user = useAuthUser();
  const canLog = user.capabilities.length === 0 || user.capabilities.includes("expenses.branch_write");

  const today = lagosDate();
  const weekFrom = mondayOf(today);

  const [rows, setRows] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [category, setCategory] = useState<BranchExpenseCategory | null>(null);
  const [date, setDate] = useState(today);
  const [showDate, setShowDate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      // The list always covers this week and the last 7 days, so a back-dated
      // entry made on a Monday still shows.
      const from = [weekFrom, shiftDays(today, -BRANCH_EXPENSE_MAX_AGE_DAYS)].sort()[0]!;
      const res = await api<{ data: SpendRow[] }>(
        `/branches/${branchId}/expenses?from=${from}&to=${today}`,
      );
      setRows(res.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canLog) void load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, canLog]);

  const todayRows = useMemo(() => rows.filter((r) => r.expense_date === today), [rows, today]);
  const weekRows = useMemo(() => rows.filter((r) => r.expense_date >= weekFrom), [rows, weekFrom]);
  const sum = (list: SpendRow[]): number => list.reduce((s, r) => s + r.amount_ngn, 0);
  const olderRows = useMemo(() => rows.filter((r) => r.expense_date < weekFrom), [rows, weekFrom]);

  const chips: StatChip[] = [
    { label: "Today", value: ngn(sum(todayRows)) },
    { label: "This week", value: ngn(sum(weekRows)) },
  ];

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    const amountNgn = Number(amount.replace(/[,\s₦]/g, ""));
    if (!Number.isInteger(amountNgn) || amountNgn <= 0) {
      setFormError("Enter the amount in naira, whole numbers only.");
      return;
    }
    if (amountNgn > BRANCH_EXPENSE_MAX_NGN) {
      setFormError(`That's more than ${ngn(BRANCH_EXPENSE_MAX_NGN)}. Ask the owner to record it in Bookkeeping.`);
      return;
    }
    const description = what.trim();
    if (description.length < BRANCH_EXPENSE_DESCRIPTION_MIN) {
      setFormError("Say what it was for, e.g. \"2 bags of ice\".");
      return;
    }
    if (!category) {
      setFormError("Pick what kind of spending it was.");
      return;
    }
    const dateProblem = branchExpenseDateProblem(date);
    if (dateProblem) {
      setFormError(dateProblem);
      return;
    }
    setSaving(true);
    try {
      await api(
        `/branches/${branchId}/expenses`,
        {
          method: "POST",
          body: JSON.stringify({
            amount_ngn: amountNgn,
            category_code: category,
            description,
            expense_date: date,
          }),
        },
        { silentError: true },
      );
      toast.success(`Logged ${ngn(amountNgn)} for ${description}`);
      setAmount("");
      setWhat("");
      setCategory(null);
      setDate(today);
      setShowDate(false);
      await load();
    } catch (err) {
      setFormError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!canLog) {
    return (
      <BranchShell branchId={branchId} title="Spending">
        <div className="empty">
          <div className="empty__title">You can't log spending</div>
          Ask the owner to give you "Log the shop's small spending".
        </div>
      </BranchShell>
    );
  }

  const bigTap = { minHeight: 52, fontSize: 16 } as const;

  return (
    <BranchShell branchId={branchId} title="Spending">
      <StatHero
        eyebrow="Branch"
        title="Spending"
        sub="Money paid out at the shop: ice, fuel, a delivery rider, cleaning. The owner sees it in Bookkeeping."
        loading={loading}
        chips={chips}
      />

      <form className="card" onSubmit={(e) => void submit(e)} style={{ marginBottom: 20, display: "grid", gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: "var(--ink)" }}>Log spending</h2>

        <label className="field">
          <span className="field__label">How much? (₦)</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 3500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ ...bigTap, height: 52, fontWeight: 700 }}
            aria-label="Amount in naira"
          />
        </label>

        <label className="field">
          <span className="field__label">What was it for?</span>
          <input
            className="input"
            placeholder="e.g. 2 bags of ice"
            maxLength={BRANCH_EXPENSE_DESCRIPTION_MAX}
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            style={{ ...bigTap, height: 52 }}
          />
        </label>

        <div className="field">
          <span className="field__label">What kind?</span>
          <div role="radiogroup" aria-label="Kind of spending" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {BRANCH_EXPENSE_CATEGORIES.map((c) => {
              const on = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`btn ${on ? "btn--primary" : "btn--subtle"}`}
                  style={{ height: 48, fontSize: 14, letterSpacing: 0 }}
                  onClick={() => setCategory(c)}
                >
                  {BRANCH_EXPENSE_CATEGORY_LABEL[c]}
                </button>
              );
            })}
          </div>
        </div>

        {showDate ? (
          <label className="field">
            <span className="field__label">When?</span>
            <input
              className="input"
              type="date"
              value={date}
              min={shiftDays(today, -BRANCH_EXPENSE_MAX_AGE_DAYS)}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...bigTap, height: 52, maxWidth: 260 }}
            />
            <span className="field__hint">Up to {BRANCH_EXPENSE_MAX_AGE_DAYS} days back.</span>
          </label>
        ) : (
          <div style={{ color: "var(--ink-soft)", fontSize: 14 }}>
            Today.{" "}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginLeft: 6 }}
              onClick={() => setShowDate(true)}
            >
              It was another day
            </button>
          </div>
        )}

        {formError && <div className="field__error" role="alert" style={{ fontSize: 14 }}>{formError}</div>}

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={saving} style={{ height: 56, fontSize: 16 }}>
          {saving ? "Saving…" : "Log spending"}
        </button>
      </form>

      {loadError && (
        <div className="card" style={{ color: "var(--danger)", marginBottom: 16 }}>
          {loadError}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : (
        <>
          <SpendList title="Today" rows={todayRows} empty="Nothing logged today." />
          <SpendList
            title="Earlier this week"
            rows={weekRows.filter((r) => r.expense_date !== today)}
            empty="Nothing else this week."
          />
          {olderRows.length > 0 && <SpendList title="Last week" rows={olderRows} empty="" />}
        </>
      )}
    </BranchShell>
  );
}

function SpendList({ title, rows, empty }: { title: string; rows: SpendRow[]; empty: string }): JSX.Element {
  const total = rows.reduce((s, r) => s + r.amount_ngn, 0);
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 4px 10px" }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "var(--ink)" }}>{title}</h3>
        <span style={{ fontWeight: 700, color: "var(--ink)" }}>Total {ngn(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="card card--soft" style={{ color: "var(--ink-soft)" }}>{empty}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>What for</th>
                <th>Kind</th>
                <th>Day</th>
                <th>Logged by</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.description ?? "—"}</td>
                  <td>
                    <span className="pill">{CATEGORY_LABEL[r.category_code] ?? r.category_code}</span>
                  </td>
                  <td style={{ color: "var(--ink-soft)" }}>{formatDate(r.expense_date)}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{r.recorded_by_name ?? "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{ngn(r.amount_ngn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
