import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { InlineLoader } from "../../components/Spinner.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { dayRangeLabel } from "../../lib/date-labels.js";
import { lagosToday } from "../../lib/biz-date.js";
import { downloadCsv } from "../../lib/csv.js";
import {
  periodRange,
  sortStaffRows,
  staffCsvRows,
  roleLabel,
  type PeriodPreset,
  type StaffRow,
  type StaffSortKey,
} from "../../lib/staff-stock.js";

interface StaffReport {
  from: string;
  to: string;
  rows: StaffRow[];
  totals: {
    orders: number;
    bottles: number;
    gross_ngn: number;
    refunds_ngn: number;
    net_ngn: number;
    avg_order_ngn: number;
    short_count: number;
    short_total_ngn: number;
  };
}

interface Branch {
  id: string;
  name: string;
}

const PRESETS: Array<{ key: Exclude<PeriodPreset, "custom">; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
];

const COLUMNS: Array<{ key: StaffSortKey; label: string; numeric?: boolean; title?: string }> = [
  { key: "name", label: "Staff member" },
  { key: "branch_name", label: "Branch" },
  { key: "orders", label: "Orders", numeric: true },
  { key: "bottles", label: "Bottles", numeric: true },
  { key: "net_ngn", label: "Net sales", numeric: true, title: "Sales minus refunds given in this period on their sales" },
  { key: "refunds_ngn", label: "Refunds", numeric: true },
  { key: "avg_order_ngn", label: "Average sale", numeric: true },
  { key: "short_count", label: "Shift-ends short", numeric: true, title: "Shift-end reports they submitted where the money counted was less than expected" },
  { key: "short_total_ngn", label: "Total short", numeric: true },
];

export function StaffPage(): JSX.Element {
  const today = lagosToday();
  const [preset, setPreset] = useState<PeriodPreset>("today");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [report, setReport] = useState<StaffReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<StaffSortKey>("net_ngn");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    void api<{ data: Branch[] }>(`/branches`)
      .then((r) => setBranches(r.data))
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    if (branchId) qs.set("branch_id", branchId);
    void api<{ data: StaffReport }>(`/reports/staff?${qs.toString()}`)
      .then((r) => {
        if (cancelled) return;
        setReport(r.data);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(humanizeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, branchId]);

  const rows = useMemo(
    () => (report ? sortStaffRows(report.rows, sortKey, sortDir) : []),
    [report, sortKey, sortDir],
  );

  function choosePreset(p: Exclude<PeriodPreset, "custom">): void {
    const r = periodRange(p, lagosToday());
    setPreset(p);
    setFrom(r.from);
    setTo(r.to);
  }

  function clickSort(key: StaffSortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "branch_name" ? "asc" : "desc");
    }
  }

  function exportCsv(): void {
    if (!report || rows.length === 0) return;
    downloadCsv(`staff-sales-${report.from}-to-${report.to}`, staffCsvRows(rows));
  }

  const t = report?.totals;

  return (
    <Shell title="Staff sales" crumb="Owner">
      <StatHero
        eyebrow="Staff"
        title="Sales per staff member"
        sub={`Who rang each sale, ${dayRangeLabel(from, to)} (Lagos time). Online orders with no staff are shown on their own line.`}
        loading={loading && !report}
        chips={
          t
            ? [
                { label: "Net sales", value: ngn(t.net_ngn) },
                { label: "Orders", value: t.orders },
                { label: "Bottles", value: t.bottles },
                { label: "Total short", value: ngn(t.short_total_ngn), tone: t.short_total_ngn > 0 ? "danger" : "good" },
              ]
            : []
        }
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`btn btn--sm ${preset === p.key ? "btn--primary" : "btn--subtle"}`}
            aria-pressed={preset === p.key}
            onClick={() => choosePreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={`btn btn--sm ${preset === "custom" ? "btn--primary" : "btn--subtle"}`}
          aria-pressed={preset === "custom"}
          onClick={() => setPreset("custom")}
        >
          Custom
        </button>
        {preset === "custom" && (
          <>
            <input
              type="date"
              className="input"
              style={{ width: 160, flex: "1 1 140px", maxWidth: 180 }}
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From"
            />
            <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>to</span>
            <input
              type="date"
              className="input"
              style={{ width: 160, flex: "1 1 140px", maxWidth: 180 }}
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To"
            />
          </>
        )}
        <select
          className="input"
          style={{ width: 180, flex: "0 1 180px" }}
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          aria-label="Branch"
        >
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          style={{ marginLeft: "auto" }}
          onClick={exportCsv}
          disabled={!report || rows.length === 0}
        >
          Export CSV
        </button>
      </div>

      {error && (
        <div className="card" style={{ color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !report ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">No sales or shift-end reports in this period.</div>
      ) : (
        <div className="table-wrap" style={{ overflowX: "auto", opacity: loading ? 0.6 : 1 }}>
          <table className="table">
            <thead>
              <tr>
                {COLUMNS.map((col) => {
                  const active = col.key === sortKey;
                  return (
                    <th
                      key={col.key}
                      style={{ textAlign: col.numeric ? "right" : "left" }}
                      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                      title={col.title}
                    >
                      <button
                        type="button"
                        onClick={() => clickSort(col.key)}
                        style={{
                          background: "none",
                          border: 0,
                          padding: 0,
                          font: "inherit",
                          letterSpacing: "inherit",
                          textTransform: "inherit",
                          color: active ? "var(--ink)" : "inherit",
                          cursor: "pointer",
                        }}
                      >
                        {col.label}
                        {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.user_id ?? "online"}|${r.branch_id}`}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    {r.user_id && (
                      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                        {roleLabel(r.role)}
                        {r.email && r.email !== r.name ? ` · ${r.email}` : ""}
                      </div>
                    )}
                  </td>
                  <td>{r.branch_name}</td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>{r.orders}</td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>{r.bottles}</td>
                  <td className="tabular-nums" style={{ textAlign: "right", fontWeight: 700 }}>{ngn(r.net_ngn)}</td>
                  <td className="tabular-nums" style={{ textAlign: "right", color: "var(--ink-soft)" }}>
                    {r.refunds_ngn > 0 ? ngn(r.refunds_ngn) : "—"}
                  </td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>{r.orders > 0 ? ngn(r.avg_order_ngn) : "—"}</td>
                  <td className="tabular-nums" style={{ textAlign: "right" }}>
                    {r.closes_submitted > 0 ? `${r.short_count} of ${r.closes_submitted}` : "—"}
                  </td>
                  <td
                    className="tabular-nums"
                    style={{ textAlign: "right", color: r.short_total_ngn > 0 ? "var(--danger)" : "var(--ink-soft)" }}
                  >
                    {r.short_total_ngn > 0 ? ngn(r.short_total_ngn) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12 }}>
        Net sales = paid sales they rang up, minus refunds given in this period on their sales. &ldquo;Shift-ends
        short&rdquo; counts the end-of-shift reports they submitted where the money counted was below what the till
        expected.
      </p>
    </Shell>
  );
}
