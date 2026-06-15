import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface PreorderItem {
  product_id: string;
  variant_id: string | null;
  name: string | null;
  size_ml: number | null;
  quantity: number;
  unit_price_ngn: number;
}

interface Preorder {
  id: string;
  order_number: string;
  branch_id: string;
  channel: string;
  status: string;
  total_ngn: number;
  scheduled_delivery_at: string | null;
  created_at_local: string;
  customer_name: string | null;
  customer_phone: string | null;
  items: PreorderItem[];
}

const sizeLabel = (ml: number | null): string =>
  ml == null ? "" : ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`;

const itemsSummary = (items: PreorderItem[]): string =>
  items
    .map((i) => `${i.quantity}× ${i.name ?? "?"}${i.size_ml ? ` ${sizeLabel(i.size_ml)}` : ""}`)
    .join(", ");

export function PreordersPage(): JSX.Element {
  const [rows, setRows] = useState<Preorder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fulfilling, setFulfilling] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Preorder[] }>("/preorders");
      setRows(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function fulfil(o: Preorder): Promise<void> {
    if (!window.confirm(`Fulfil ${o.order_number}? This deducts stock now and hands the order onward.`)) {
      return;
    }
    setFulfilling(o.id);
    try {
      // silentError: this handler renders its own friendlier toast below, so
      // suppress the api() helper's automatic raw-message toast (otherwise a
      // blocked fulfil pops two toasts for one failure).
      await api(`/preorders/${o.id}/fulfil`, { method: "PATCH" }, { silentError: true });
      toast.success(`${o.order_number} fulfilled`);
      await load();
    } catch (err) {
      // The API returns 422 with a shortfall list when stock is still short.
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        /unfulfillable|not enough stock/i.test(msg)
          ? `Not enough stock to fulfil ${o.order_number} yet — produce/transfer more first.`
          : msg,
      );
    } finally {
      setFulfilling(null);
    }
  }

  const total = useMemo(() => rows.reduce((sum, r) => sum + r.total_ngn, 0), [rows]);

  return (
    <Shell title="Preorders" crumb="Owner">
      <div className="page-head ed-rise">
        <div className="page-head__titles">
          <div className="page-head__eyebrow">Sales</div>
          <h1 className="page-head__title">Preorders</h1>
          <p className="page-head__sub">
            Prepaid orders awaiting production. Stock is deducted when you fulfil — not before.
          </p>
        </div>
      </div>

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No preorders waiting</div>
          Paid preorders that haven&apos;t been fulfilled yet show up here.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Placed</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Target day</th>
                <th className="table__num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td style={{ fontWeight: 600 }}>{o.order_number}</td>
                  <td>{formatDateTime(o.created_at_local)}</td>
                  <td>
                    {o.customer_name ?? "Walk-up"}
                    {o.customer_phone && (
                      <span style={{ color: "var(--ink-soft)", fontSize: 12, display: "block" }}>
                        {o.customer_phone}
                      </span>
                    )}
                  </td>
                  <td style={{ maxWidth: 280 }}>{itemsSummary(o.items)}</td>
                  <td>
                    {o.scheduled_delivery_at ? (
                      formatDateTime(o.scheduled_delivery_at)
                    ) : (
                      <span style={{ color: "var(--ink-soft)" }}>—</span>
                    )}
                  </td>
                  <td className="table__num" style={{ fontWeight: 700 }}>
                    {ngn(o.total_ngn)}
                  </td>
                  <td className="table__num">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={fulfilling === o.id}
                      onClick={() => void fulfil(o)}
                    >
                      {fulfilling === o.id ? "Fulfilling…" : "Fulfil"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 12 }}>
            {rows.length} preorder{rows.length === 1 ? "" : "s"} · {ngn(total)} prepaid awaiting fulfilment
          </p>
        </div>
      )}
    </Shell>
  );
}
