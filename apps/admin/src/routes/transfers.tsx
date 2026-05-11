import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../components/Shell.js";
import { api } from "../lib/api.js";
import { formatDateTime } from "../lib/format.js";

interface Transfer {
  id: string;
  transferNumber: string;
  status:
    | "draft"
    | "dispatched"
    | "in_transit"
    | "arrived"
    | "received"
    | "received_with_variance"
    | "rejected"
    | "completed"
    | "cancelled";
  factoryId: string;
  branchId: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  items?: Array<{
    id: string;
    productId: string;
    quantitySent: number;
    quantityReceived: number | null;
    varianceReason: string | null;
  }>;
}
interface Product { id: string; name: string }
interface Branch { id: string; name: string }
interface Factory { id: string; name: string }

const STATUS_LABEL: Record<Transfer["status"], { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "var(--ms-ink-3)" },
  dispatched: { label: "Dispatched", tone: "var(--ms-orange)" },
  in_transit: { label: "In transit", tone: "var(--ms-orange)" },
  arrived: { label: "Arrived", tone: "var(--ms-warn)" },
  received: { label: "Received", tone: "var(--ms-green-700)" },
  received_with_variance: { label: "Variance review", tone: "var(--ms-danger)" },
  rejected: { label: "Rejected", tone: "var(--ms-danger)" },
  completed: { label: "Completed", tone: "var(--ms-green-700)" },
  cancelled: { label: "Cancelled", tone: "var(--ms-ink-3)" },
};

export function TransfersPage() {
  const qc = useQueryClient();
  const transfers = useQuery({
    queryKey: ["transfers"],
    queryFn: () => api<{ data: Transfer[] }>("/transfers").then((r) => r.data),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <Shell title="Stock transfers">
      <div className="flex justify-between items-end mb-6">
        <p style={{ color: "var(--ms-ink-3)" }}>
          {transfers.data?.length ?? 0} transfers
        </p>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 rounded-full text-white text-sm font-semibold"
          style={{ background: "var(--ms-ink)" }}
        >
          + New transfer
        </button>
      </div>

      {creating && (
        <CreateForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["transfers"] });
            setCreating(false);
          }}
        />
      )}

      <div
        className="overflow-hidden mb-6"
        style={{
          background: "var(--ms-surface)",
          border: "1px solid var(--ms-border)",
          borderRadius: 14,
        }}
      >
        <table className="w-full text-sm">
          <thead style={{ background: "var(--ms-surface-alt)" }}>
            <tr>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">Number</th>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">Status</th>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">Dispatched</th>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {transfers.data?.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                <td className="px-4 py-3 font-mono text-xs">{t.transferNumber}</td>
                <td className="px-4 py-3">
                  <span
                    className="text-xs font-semibold px-2 py-1 rounded-full"
                    style={{
                      background: "var(--ms-surface-alt)",
                      color: STATUS_LABEL[t.status].tone,
                    }}
                  >
                    {STATUS_LABEL[t.status].label}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                  {formatDateTime(t.dispatchedAt)}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                  {formatDateTime(t.receivedAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className="text-xs"
                    style={{ color: "var(--ms-green-700)" }}
                  >
                    Open →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <TransferDetail
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={() => qc.invalidateQueries({ queryKey: ["transfers"] })}
        />
      )}
    </Shell>
  );
}

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => api<{ data: Product[] }>("/products").then((r) => r.data),
  });
  const factories = useQuery({
    queryKey: ["factories"],
    queryFn: () => api<{ data: Factory[] }>("/factories").then((r) => r.data),
  });
  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<{ data: Branch[] }>("/branches").then((r) => r.data),
  });

  const [factoryId, setFactoryId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createAndDispatch = useMutation({
    mutationFn: async () => {
      setError(null);
      const items = Object.entries(counts)
        .filter(([, q]) => q > 0)
        .map(([product_id, quantity_sent]) => ({ product_id, quantity_sent }));
      if (items.length === 0) throw new Error("Enter at least one quantity");
      if (!factoryId || !branchId) throw new Error("Pick factory and branch");

      const created = await api<{ data: Transfer }>("/transfers", {
        method: "POST",
        body: JSON.stringify({
          factory_id: factoryId,
          branch_id: branchId,
          vehicle_info: vehicle || undefined,
          driver_name: driver || undefined,
          items,
        }),
      });
      await api(`/transfers/${created.data.id}/dispatch`, { method: "PATCH" });
    },
    onSuccess: onCreated,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Default factory/branch on first load
  if (!factoryId && factories.data?.[0]) setFactoryId(factories.data[0].id);
  if (!branchId && branches.data?.[0]) setBranchId(branches.data[0].id);

  return (
    <div
      className="mb-6 p-5"
      style={{
        background: "var(--ms-surface)",
        border: "1px solid var(--ms-border)",
        borderRadius: 14,
      }}
    >
      <h3 className="font-display text-lg font-bold mb-4">New transfer</h3>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Field label="Factory">
          <select
            value={factoryId}
            onChange={(e) => setFactoryId(e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          >
            {factories.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Destination branch">
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          >
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vehicle">
          <input
            value={vehicle}
            onChange={(e) => setVehicle(e.target.value)}
            placeholder="e.g. KJA-348-EL"
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Driver">
          <input
            value={driver}
            onChange={(e) => setDriver(e.target.value)}
            placeholder="Driver name"
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
      </div>

      <div className="text-xs uppercase tracking-wide font-semibold mb-2" style={{ color: "var(--ms-ink-3)" }}>
        Bottles to send
      </div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        {products.data?.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between p-2 rounded-md"
            style={{ background: "var(--ms-surface-alt)" }}
          >
            <span className="text-sm">{p.name}</span>
            <input
              type="number"
              min={0}
              value={counts[p.id] ?? 0}
              onChange={(e) =>
                setCounts({ ...counts, [p.id]: Math.max(0, Number(e.target.value)) })
              }
              className="w-20 px-2 py-1 text-right border rounded tabular-nums"
              style={{ borderColor: "var(--ms-border)" }}
            />
          </div>
        ))}
      </div>

      {error && (
        <p className="text-sm mb-3" style={{ color: "var(--ms-danger)" }}>
          {error}
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onClose}
          className="px-3 py-2 border rounded-full text-sm"
          style={{ borderColor: "var(--ms-border)" }}
        >
          Cancel
        </button>
        <button
          onClick={() => createAndDispatch.mutate()}
          disabled={createAndDispatch.isPending}
          className="px-4 py-2 rounded-full text-white text-sm font-semibold"
          style={{ background: "var(--ms-green-500)" }}
        >
          {createAndDispatch.isPending ? "Dispatching..." : "Save & dispatch →"}
        </button>
      </div>
    </div>
  );
}

function TransferDetail({
  id,
  onClose,
  onUpdated,
}: {
  id: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const detail = useQuery({
    queryKey: ["transfer", id],
    queryFn: () => api<{ data: Transfer }>(`/transfers/${id}`).then((r) => r.data),
  });
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => api<{ data: Product[] }>("/products").then((r) => r.data),
  });
  const productName = (productId: string) =>
    products.data?.find((p) => p.id === productId)?.name ?? productId.slice(0, 8);

  const [receiveCounts, setReceiveCounts] = useState<Record<string, number>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const arrive = useMutation({
    mutationFn: () => api(`/transfers/${id}/arrive`, { method: "PATCH" }),
    onSuccess: () => {
      detail.refetch();
      onUpdated();
    },
  });
  const receive = useMutation({
    mutationFn: () => {
      const items = (detail.data?.items ?? []).map((it) => ({
        item_id: it.id,
        quantity_received: receiveCounts[it.id] ?? it.quantitySent,
        variance_reason: reasons[it.id] || undefined,
      }));
      return api(`/transfers/${id}/receive`, {
        method: "PATCH",
        body: JSON.stringify({ items }),
      });
    },
    onSuccess: () => {
      detail.refetch();
      onUpdated();
    },
  });
  const approve = useMutation({
    mutationFn: () => api(`/transfers/${id}/approve`, { method: "PATCH" }),
    onSuccess: () => {
      detail.refetch();
      onUpdated();
    },
  });

  if (!detail.data) return null;
  const t = detail.data;
  const status = STATUS_LABEL[t.status];

  return (
    <div
      className="p-5"
      style={{
        background: "var(--ms-surface)",
        border: "1px solid var(--ms-border)",
        borderRadius: 14,
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-display text-xl font-bold">{t.transferNumber}</div>
          <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
            <span style={{ color: status.tone, fontWeight: 600 }}>{status.label}</span>
            {" · created "}{formatDateTime(t.createdAt)}
          </div>
        </div>
        <button onClick={onClose} className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
          ✕ Close
        </button>
      </div>

      <table className="w-full text-sm mb-4">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--ms-divider)" }}>
            <th className="text-left py-2 text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
              Item
            </th>
            <th className="text-right py-2 text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
              Sent
            </th>
            {t.status === "arrived" && (
              <>
                <th className="text-right py-2 text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                  Received
                </th>
                <th className="text-left pl-3 py-2 text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                  Variance reason (if any)
                </th>
              </>
            )}
            {(t.status === "received" ||
              t.status === "received_with_variance" ||
              t.status === "completed") && (
              <th className="text-right py-2 text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                Received
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {t.items?.map((it) => (
            <tr key={it.id} style={{ borderBottom: "1px solid var(--ms-divider)" }}>
              <td className="py-3">{productName(it.productId)}</td>
              <td className="py-3 text-right tabular-nums">{it.quantitySent}</td>
              {t.status === "arrived" && (
                <>
                  <td className="py-3 text-right">
                    <input
                      type="number"
                      min={0}
                      defaultValue={it.quantitySent}
                      onChange={(e) =>
                        setReceiveCounts({
                          ...receiveCounts,
                          [it.id]: Math.max(0, Number(e.target.value)),
                        })
                      }
                      className="w-20 px-2 py-1 text-right border rounded tabular-nums"
                      style={{ borderColor: "var(--ms-border)" }}
                    />
                  </td>
                  <td className="py-3 pl-3">
                    <select
                      value={reasons[it.id] ?? ""}
                      onChange={(e) => setReasons({ ...reasons, [it.id]: e.target.value })}
                      className="px-2 py-1 border rounded text-xs"
                      style={{ borderColor: "var(--ms-border)" }}
                    >
                      <option value="">—</option>
                      <option value="short_shipped">Short shipped</option>
                      <option value="damaged_in_transit">Damaged in transit</option>
                      <option value="wrong_item">Wrong item</option>
                      <option value="extra_received">Extra received</option>
                      <option value="count_error_at_branch">Count error at branch</option>
                      <option value="other_with_note">Other (note)</option>
                    </select>
                  </td>
                </>
              )}
              {(t.status === "received" ||
                t.status === "received_with_variance" ||
                t.status === "completed") && (
                <td className="py-3 text-right tabular-nums">
                  {it.quantityReceived ?? "—"}
                  {it.varianceReason && (
                    <span
                      className="text-xs ml-2"
                      style={{ color: "var(--ms-warn)" }}
                    >
                      {it.varianceReason}
                    </span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex gap-2 justify-end">
        {(t.status === "dispatched" || t.status === "in_transit") && (
          <button
            onClick={() => arrive.mutate()}
            disabled={arrive.isPending}
            className="px-4 py-2 rounded-full text-white text-sm font-semibold"
            style={{ background: "var(--ms-orange)" }}
          >
            Mark arrived
          </button>
        )}
        {t.status === "arrived" && (
          <button
            onClick={() => receive.mutate()}
            disabled={receive.isPending}
            className="px-4 py-2 rounded-full text-white text-sm font-semibold"
            style={{ background: "var(--ms-green-500)" }}
          >
            {receive.isPending ? "Submitting..." : "Submit counts →"}
          </button>
        )}
        {t.status === "received_with_variance" && (
          <button
            onClick={() => approve.mutate()}
            disabled={approve.isPending}
            className="px-4 py-2 rounded-full text-white text-sm font-semibold"
            style={{ background: "var(--ms-green-500)" }}
          >
            Approve variance
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold mb-1" style={{ color: "var(--ms-ink-2)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}
