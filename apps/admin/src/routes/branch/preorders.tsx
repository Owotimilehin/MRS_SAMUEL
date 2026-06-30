import { useEffect, useMemo, useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";
import { useAuthUser } from "../../lib/auth.js";
import { buildReceiptFromOrder } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";
import { BranchTabs } from "../../components/BranchTabs.js";

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

// A single searchable haystack across every recorded field of a preorder:
// order number, customer name/phone, channel, target day, total, and each
// item's flavour + size. Lowercased so the search box is case-insensitive.
function haystack(o: Preorder): string {
  return [
    o.order_number,
    o.customer_name ?? "",
    o.customer_phone ?? "",
    o.channel,
    o.scheduled_delivery_at ? formatDateTime(o.scheduled_delivery_at) : "",
    formatDateTime(o.created_at_local),
    String(o.total_ngn),
    ngn(o.total_ngn),
    itemsSummary(o.items),
  ]
    .join(" ")
    .toLowerCase();
}

export function BranchPreordersPage({ branchId }: { branchId: string }): JSX.Element {
  const [rows, setRows] = useState<Preorder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fulfilling, setFulfilling] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const authUser = useAuthUser();

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Preorder[] }>(`/branches/${branchId}/preorders`);
      setRows(res.data);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function printPreorder(o: Preorder): Promise<void> {
    setPrintingId(o.id);
    try {
      const branch = await fetchBranchInfo(o.branch_id);
      const receipt = buildReceiptFromOrder({
        style: getReceiptStyle(),
        orderNumber: o.order_number,
        createdAtIso: o.created_at_local,
        branch,
        servedBy: (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " "),
        channel: o.channel,
        payment: "prepaid",
        items: o.items.map((i) => ({
          name: i.name ?? "Item",
          sizeMl: i.size_ml,
          quantity: i.quantity,
          unitPriceNgn: i.unit_price_ngn,
          lineTotalNgn: i.unit_price_ngn * i.quantity,
        })),
        subtotalNgn: o.total_ngn,
        totalNgn: o.total_ngn,
        isPreorder: true,
        ...(o.scheduled_delivery_at ? { fulfilIso: o.scheduled_delivery_at } : {}),
      });
      await printAndToast(receipt);
    } finally {
      setPrintingId(null);
    }
  }

  async function fulfil(o: Preorder): Promise<void> {
    if (!window.confirm(`Fulfil ${o.order_number}? This deducts stock now and hands the order over.`)) {
      return;
    }
    setFulfilling(o.id);
    try {
      await api(`/branches/${branchId}/preorders/${o.id}/fulfil`, { method: "PATCH" }, { silentError: true });
      toast.success(`${o.order_number} fulfilled`);
      await load();
    } catch (err) {
      const msg = humanizeError(err);
      toast.error(
        /unfulfillable|not enough stock/i.test(msg)
          ? `Not enough stock to fulfil ${o.order_number} yet — produce/transfer more first.`
          : msg,
      );
    } finally {
      setFulfilling(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((o) => haystack(o).includes(q));
  }, [rows, search]);

  const total = useMemo(() => filtered.reduce((sum, r) => sum + r.total_ngn, 0), [filtered]);

  return (
    <BranchShell branchId={branchId} title="Preorders">
      <StatHero
        eyebrow="Branch"
        title="Preorders"
        sub="Prepaid orders awaiting production at this branch. Producing deducts stock; delivery orders then go out for delivery."
        loading={loading}
        chips={[
          { label: "Awaiting", value: rows.length, tone: rows.length > 0 ? "danger" : "good" },
          { label: "Cans", value: rows.reduce((s, r) => s + r.items.reduce((n, i) => n + i.quantity, 0), 0) },
          { label: "Prepaid", value: ngn(rows.reduce((s, r) => s + r.total_ngn, 0)) },
        ]}
      />
      <BranchTabs items={[
        { to: "/branch/online-orders", label: "Online", cap: "sales.view" },
        { to: "/branch/preorders", label: "Preorders", cap: "pos.preorder" },
      ]} />

      <input
        className="input"
        placeholder="Search order #, name, phone, flavour, date…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ margin: "14px 0" }}
      />

      {loading ? (
        <InlineLoader />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="empty__title">{rows.length === 0 ? "No preorders waiting" : "No matches"}</div>
          {rows.length === 0
            ? "Paid preorders that haven't been produced yet show up here."
            : "Try a different order number, name, phone, or flavour."}
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
              {filtered.map((o) => (
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
                  <td className="table__num" style={{ fontWeight: 700 }}>{ngn(o.total_ngn)}</td>
                  <td className="table__num">
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={printingId === o.id}
                      onClick={() => void printPreorder(o)}
                      style={{ marginRight: 6 }}
                      title="Print receipt"
                    >
                      {printingId === o.id ? "…" : "🖨"}
                    </button>
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
            {filtered.length} preorder{filtered.length === 1 ? "" : "s"} · {ngn(total)} prepaid
          </p>
        </div>
      )}
    </BranchShell>
  );
}
