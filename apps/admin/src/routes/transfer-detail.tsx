import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../components/Shell.js";
import { StatHero, type StatChip } from "../components/StatHero.js";
import { api, humanizeError } from "../lib/api.js";
import { ngn, formatDateTime } from "../lib/format.js";
import { useAuthUser } from "../lib/auth.js";
import { InlineLoader } from "../components/Spinner.js";
import { toast } from "../lib/toast.js";

type TransferStatus =
  | "dispatched"
  | "in_transit"
  | "arrived"
  | "received"
  | "received_with_variance"
  | "rejected"
  | "completed"
  | "cancelled";

// NOTE: GET /transfers/:id returns item fields in snake_case (product_id,
// quantity_sent, …) even though the parent Transfer row is camelCase. Mirror
// the wire shape exactly — reading camelCase here yields undefined and crashes
// productName(undefined).slice().
interface TransferItem {
  id: string;
  product_id: string;
  variant_id?: string | null;
  size_ml?: number | null;
  // Bag lines (A2b) carry a packaging material instead of a product.
  packaging_material_id?: string | null;
  material_name?: string | null;
  quantity_sent: number;
  quantity_received: number | null;
  variance_reason: string | null;
  unit_cost_ngn: number | null;
  notes: string | null;
}
interface TransferDetail {
  id: string;
  transferNumber: string;
  factoryId: string;
  branchId: string;
  status: TransferStatus;
  dispatchedAt: string | null;
  receivedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  vehicleInfo: string | null;
  driverName: string | null;
  notes: string | null;
  createdAt: string;
  items: TransferItem[];
}
interface Branch {
  id: string;
  name: string;
}
interface Factory {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
}

const VARIANCE_REASONS = [
  { value: "short_shipped", label: "Short shipped" },
  { value: "damaged_in_transit", label: "Damaged in transit" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "extra_received", label: "Extra received" },
  { value: "count_error_at_branch", label: "Count error" },
  { value: "other_with_note", label: "Other" },
];

function statusPill(s: TransferStatus): JSX.Element {
  const map: Record<TransferStatus, [string, string]> = {
    dispatched: ["pill pill--accent", "Dispatched"],
    in_transit: ["pill pill--accent", "In transit"],
    arrived: ["pill pill--warning", "Arrived"],
    received: ["pill pill--success", "Received"],
    received_with_variance: ["pill pill--warning", "Received with variance"],
    rejected: ["pill pill--danger", "Rejected"],
    completed: ["pill pill--success", "Completed"],
    cancelled: ["pill pill--ink", "Cancelled"],
  };
  const [cls, label] = map[s];
  return <span className={cls}>{label}</span>;
}

const STAGES: Array<{ key: TransferStatus; label: string }> = [
  { key: "dispatched", label: "Sent" },
  { key: "arrived", label: "Arrived" },
  { key: "received", label: "Received" },
  { key: "completed", label: "Completed" },
];

export function TransferDetailPage({ transferId }: { transferId: string }): JSX.Element {
  const user = useAuthUser();
  const [data, setData] = useState<TransferDetail | null>(null);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [receipt, setReceipt] = useState<
    Array<{
      item_id: string;
      quantity_received: number;
      variance_reason: string;
      variance_note: string;
      sent: number;
    }>
  >([]);
  // Owner variance settlement: per-line where the gap (sent - received) lands.
  const [settlements, setSettlements] = useState<Record<string, "factory" | "branch" | "loss">>({});
  const [showPerLine, setShowPerLine] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [t, f, b, p] = await Promise.all([
        api<{ data: TransferDetail }>(`/transfers/${transferId}`),
        api<{ data: Factory[] }>(`/factories`),
        api<{ data: Branch[] }>(`/branches`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setData(t.data);
      setFactories(f.data);
      setBranches(b.data);
      setProducts(p.data);
      setReceipt(
        t.data.items.map((i) => ({
          item_id: i.id,
          quantity_received: i.quantity_received ?? i.quantity_sent,
          variance_reason: i.variance_reason ?? "",
          variance_note: "",
          sent: i.quantity_sent,
        })),
      );
      // Default every varianced product line to settle on the factory.
      const defaults: Record<string, "factory" | "branch" | "loss"> = {};
      for (const i of t.data.items) {
        if (i.packaging_material_id == null && i.quantity_received != null && i.quantity_received !== i.quantity_sent) {
          defaults[i.id] = "factory";
        }
      }
      setSettlements(defaults);
      setShowPerLine(false);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId]);

  async function action(path: string, body?: unknown): Promise<void> {
    setActing(true);
    try {
      const init: RequestInit = { method: "PATCH" };
      if (body !== undefined) init.body = JSON.stringify(body);
      await api(path, init);
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  /** Settle the variance per owner choice and approve the transfer. */
  async function settleAndApprove(all?: "factory" | "loss"): Promise<void> {
    const lines = (data?.items ?? []).filter(
      (i) => i.packaging_material_id == null && i.quantity_received != null && i.quantity_received !== i.quantity_sent,
    );
    const body = {
      settlements: lines.map((i) => ({
        item_id: i.id,
        settle: all ?? settlements[i.id] ?? "factory",
      })),
    };
    await action(`/transfers/${transferId}/approve`, body);
  }

  async function submitReceipt(e: FormEvent): Promise<void> {
    e.preventDefault();
    const missingReason = receipt.find((d) => d.quantity_received !== d.sent && !d.variance_reason);
    if (missingReason) {
      return;
    }
    const missingNote = receipt.find(
      (d) =>
        d.quantity_received !== d.sent &&
        d.variance_reason === "other_with_note" &&
        !d.variance_note.trim(),
    );
    if (missingNote) {
      return;
    }
    setActing(true);
    try {
      await api(`/transfers/${transferId}/receive`, {
        method: "PATCH",
        body: JSON.stringify({
          items: receipt.map((d) => ({
            item_id: d.item_id,
            quantity_received: Number(d.quantity_received),
            variance_reason: d.quantity_received === d.sent ? undefined : d.variance_reason,
            variance_note:
              d.quantity_received !== d.sent && d.variance_reason === "other_with_note"
                ? d.variance_note.trim()
                : undefined,
          })),
        }),
      });
      toast.success("Receipt recorded");
      setReceiving(false);
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  async function adjustCount(
    it: TransferItem,
    side: "sent" | "received",
  ): Promise<void> {
    const current = side === "sent" ? it.quantity_sent : it.quantity_received ?? 0;
    const raw = window.prompt(`New ${side} quantity for this line (currently ${current})`);
    if (raw === null) return;
    const nextQty = Number(raw);
    if (!Number.isFinite(nextQty) || nextQty < 0) {
      return;
    }
    const reason = window.prompt("Reason for the correction (visible in audit log)");
    if (!reason || reason.trim().length < 3) {
      return;
    }
    setActing(true);
    try {
      await api(`/transfers/${transferId}/items/${it.id}/adjust`, {
        method: "PATCH",
        body: JSON.stringify({ side, new_quantity: nextQty, reason: reason.trim() }),
      });
      toast.success(`Count adjusted (${side})`);
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  async function reject(): Promise<void> {
    const reason = window.prompt("Reason for rejection?");
    if (!reason) return;
    await action(`/transfers/${transferId}/reject`, { reason });
  }

  const factoryName = (id: string): string => factories.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  const productName = (id: string | null | undefined): string =>
    id ? (products.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "—";

  // Action availability
  const canArrive = data && (data.status === "dispatched" || data.status === "in_transit");
  const canReceive = data?.status === "arrived";
  const canApprove = data?.status === "received_with_variance" && user.role === "owner";

  // Stage progress (STAGES indices: 0 Sent, 1 Arrived, 2 Received, 3 Completed)
  const stageIndex = (() => {
    if (!data) return -1;
    if (data.status === "completed" || data.status === "received") return 3;
    if (data.status === "received_with_variance") return 2.5;
    if (data.status === "arrived") return 1;
    if (data.status === "dispatched" || data.status === "in_transit") return 0;
    return -1;
  })();

  return (
    <Shell
      title={data?.transferNumber ?? "Transfer"}
      actions={
        <Link to="/transfers" className="btn btn--subtle btn--sm">
          ← All transfers
        </Link>
      }
    >
      {(() => {
        const totalCans = data
          ? data.items.reduce((sum, it) => sum + it.quantity_sent, 0)
          : 0;
        const route =
          data && factories.length > 0 && branches.length > 0
            ? `${factories.find((f) => f.id === data.factoryId)?.name ?? data.factoryId.slice(0, 6)} → ${branches.find((b) => b.id === data.branchId)?.name ?? data.branchId.slice(0, 6)}`
            : "—";
        const hasVariance = data?.status === "received_with_variance";
        const chips: StatChip[] = [];
        chips.push({ label: "Cans", value: data ? totalCans : "—" });
        chips.push({ label: "Route", value: data ? route : "—" });
        chips.push({ label: "Status", value: data?.status ?? "—" });
        if (hasVariance) {
          chips.push({ label: "Variance", value: "Flagged", tone: "warn" });
        } else {
          chips.push({ label: "Variance", value: data ? "None" : "—" });
        }
        return (
          <StatHero
            eyebrow="Products"
            title={data?.transferNumber ?? "Transfer"}
            sub={data ? `Created ${formatDateTime(data.createdAt)}` : "Loading…"}
            loading={loading}
            chips={chips}
          />
        );
      })()}

      {loading || !data ? (
        <InlineLoader />
      ) : (
        <>
          <section className="card" style={{ marginBottom: 18 }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <div>
                <h2 className="t-h2">{factoryName(data.factoryId)} → {branchName(data.branchId)}</h2>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                  Created {formatDateTime(data.createdAt)}
                </div>
              </div>
              {statusPill(data.status)}
            </header>

            {/* Stage progress */}
            <ol
              style={{
                listStyle: "none",
                margin: "0 0 18px",
                padding: 0,
                display: "grid",
                gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`,
                gap: 6,
              }}
            >
              {STAGES.map((stage, idx) => {
                const done = idx <= Math.floor(stageIndex);
                const current = Math.floor(stageIndex) === idx;
                return (
                  <li
                    key={stage.key}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: done ? "var(--surface-soft)" : "transparent",
                      border: current ? "1.5px solid var(--accent)" : "1px solid var(--line)",
                      color: done ? "var(--ink)" : "var(--ink-soft)",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: done ? "var(--accent)" : "var(--ink-soft)" }}>
                      Step {idx + 1}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>{stage.label}</div>
                  </li>
                );
              })}
            </ol>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <Field label="Driver" value={data.driverName ?? "—"} />
              <Field label="Vehicle" value={data.vehicleInfo ?? "—"} />
              <Field label="Dispatched" value={data.dispatchedAt ? formatDateTime(data.dispatchedAt) : "—"} />
              <Field label="Received" value={data.receivedAt ? formatDateTime(data.receivedAt) : "—"} />
            </div>

            {data.rejectReason && (
              <div
                className="card"
                style={{
                  marginTop: 14,
                  background: "rgba(220,38,38,0.06)",
                  borderColor: "rgba(220,38,38,0.25)",
                  color: "var(--danger)",
                }}
              >
                <strong>Rejected:</strong> {data.rejectReason}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
              {canArrive && (
                <>
                  <button
                    type="button"
                    className="btn btn--subtle"
                    disabled={acting}
                    onClick={() => void reject()}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={acting}
                    onClick={() => void action(`/transfers/${transferId}/arrive`)}
                  >
                    Mark arrived
                  </button>
                </>
              )}
              {canReceive && !receiving && (
                <button type="button" className="btn btn--primary" onClick={() => setReceiving(true)}>
                  Open receipt form
                </button>
              )}
              {canApprove && (
                <div style={{ display: "grid", gap: 10, width: "100%" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={acting}
                      onClick={() => void settleAndApprove("factory")}
                    >
                      Adopt → return to factory
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={acting}
                      onClick={() => void settleAndApprove("loss")}
                    >
                      Ignore (write off as loss)
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={acting}
                      onClick={() => setShowPerLine((v) => !v)}
                    >
                      {showPerLine ? "Hide per-flavour" : "Check per flavour"}
                    </button>
                  </div>
                  {showPerLine && (
                    <div className="table-wrap" style={{ border: 0 }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Flavour</th>
                            <th>Sent</th>
                            <th>Received</th>
                            <th>Gap</th>
                            <th>Settle</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data?.items ?? [])
                            .filter(
                              (i) =>
                                i.packaging_material_id == null &&
                                i.quantity_received != null &&
                                i.quantity_received !== i.quantity_sent,
                            )
                            .map((i) => {
                              const gap = i.quantity_sent - (i.quantity_received ?? 0);
                              return (
                                <tr key={i.id}>
                                  <td>
                                    {productName(i.product_id)}
                                    {i.size_ml ? ` ${i.size_ml}ml` : ""}
                                  </td>
                                  <td>{i.quantity_sent}</td>
                                  <td>{i.quantity_received}</td>
                                  <td>{gap > 0 ? `-${gap}` : `+${-gap}`}</td>
                                  <td>
                                    <select
                                      className="input"
                                      value={settlements[i.id] ?? "factory"}
                                      onChange={(e) =>
                                        setSettlements((prev) => ({
                                          ...prev,
                                          [i.id]: e.target.value as "factory" | "branch" | "loss",
                                        }))
                                      }
                                    >
                                      <option value="factory">Factory (still at factory)</option>
                                      <option value="branch">Branch (miscounted)</option>
                                      <option value="loss">Loss (write off)</option>
                                    </select>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                      <button
                        type="button"
                        className="btn btn--primary"
                        style={{ marginTop: 10 }}
                        disabled={acting}
                        onClick={() => void settleAndApprove()}
                      >
                        Settle &amp; approve
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 12 }}>Items</h2>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Sent</th>
                    <th className="table__num">Received</th>
                    <th className="table__num">Unit cost</th>
                    <th>Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {receiving
                    ? receipt.map((d, idx) => (
                        <tr key={d.item_id}>
                          <td>
                            {data.items[idx]?.material_name
                              ? `🛍 ${data.items[idx]!.material_name}`
                              : productName(data.items[idx]?.product_id ?? "")}
                            {data.items[idx]?.size_ml != null && (
                              <span style={{ color: "var(--ink-soft)", fontSize: 12, marginLeft: 4 }}>
                                · {data.items[idx]!.size_ml}ml
                              </span>
                            )}
                          </td>
                          <td className="table__num">{d.sent}</td>
                          <td>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              style={{ width: 100, textAlign: "right" }}
                              value={d.quantity_received}
                              onChange={(e) =>
                                setReceipt((s) =>
                                  s.map((row, i) =>
                                    i === idx
                                      ? { ...row, quantity_received: Number(e.target.value) }
                                      : row,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="table__num">
                            {data.items[idx]?.unit_cost_ngn != null ? ngn(data.items[idx]!.unit_cost_ngn!) : "—"}
                          </td>
                          <td>
                            {d.quantity_received !== d.sent ? (
                              <>
                                <select
                                  className="select"
                                  value={d.variance_reason}
                                  onChange={(e) =>
                                    setReceipt((s) =>
                                      s.map((row, i) =>
                                        i === idx ? { ...row, variance_reason: e.target.value } : row,
                                      ),
                                    )
                                  }
                                >
                                  <option value="">Pick reason…</option>
                                  {VARIANCE_REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                                {d.variance_reason === "other_with_note" && (
                                  <textarea
                                    className="textarea"
                                    rows={2}
                                    placeholder="Describe what happened (required)"
                                    value={d.variance_note}
                                    style={{ marginTop: 6, width: "100%" }}
                                    onChange={(e) =>
                                      setReceipt((s) =>
                                        s.map((row, i) =>
                                          i === idx
                                            ? { ...row, variance_note: e.target.value }
                                            : row,
                                        ),
                                      )
                                    }
                                  />
                                )}
                              </>
                            ) : (
                              <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>matches</span>
                            )}
                          </td>
                        </tr>
                      ))
                    : data.items.map((it) => {
                        const ownerCanAdjust =
                          user.role === "owner" &&
                          ["received", "received_with_variance", "completed"].includes(
                            data.status,
                          );
                        return (
                          <tr key={it.id}>
                            <td>
                              {it.material_name ? `🛍 ${it.material_name}` : productName(it.product_id)}
                              {it.size_ml != null && (
                                <span style={{ color: "var(--ink-soft)", fontSize: 12, marginLeft: 4 }}>
                                  · {it.size_ml}ml
                                </span>
                              )}
                            </td>
                            <td className="table__num">{it.quantity_sent}</td>
                            <td className="table__num" style={{ fontWeight: 700 }}>
                              {it.quantity_received ?? "—"}
                            </td>
                            <td className="table__num">
                              {it.unit_cost_ngn != null ? ngn(it.unit_cost_ngn) : "—"}
                            </td>
                            <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                              <div>
                                {it.variance_reason ?? (it.quantity_received != null ? "matches" : "—")}
                              </div>
                              {ownerCanAdjust && (
                                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                  <button
                                    type="button"
                                    className="btn btn--subtle btn--sm"
                                    disabled={acting}
                                    onClick={() => void adjustCount(it, "sent")}
                                  >
                                    Adjust sent
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--subtle btn--sm"
                                    disabled={acting}
                                    onClick={() => void adjustCount(it, "received")}
                                  >
                                    Adjust received
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>

            {receiving && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button type="button" className="btn btn--subtle" onClick={() => setReceiving(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={acting}
                  onClick={(e) => void submitReceipt(e as unknown as FormEvent)}
                >
                  {acting ? "Submitting…" : "Submit receipt"}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card card--soft" style={{ padding: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}
