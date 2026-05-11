import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";

interface Product {
  id: string;
  name: string;
  category: string;
}
interface Factory { id: string; name: string }

export function ProductionRunsPage() {
  const qc = useQueryClient();
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => api<{ data: Product[] }>("/products").then((r) => r.data),
  });
  const factories = useQuery({
    queryKey: ["factories"],
    queryFn: () => api<{ data: Factory[] }>("/factories").then((r) => r.data),
  });
  const factoryId = factories.data?.[0]?.id;
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      setSaving(true);
      setError(null);
      const items = Object.entries(counts)
        .filter(([, q]) => q > 0)
        .map(([product_id, quantity_produced]) => ({ product_id, quantity_produced }));
      if (items.length === 0) throw new Error("Enter at least one quantity");
      if (!factoryId) throw new Error("No factory found");
      const create = await api<{ data: { id: string } }>("/production-runs", {
        method: "POST",
        body: JSON.stringify({
          factory_id: factoryId,
          run_date: new Date().toISOString().slice(0, 10),
          items,
        }),
      });
      await api(`/production-runs/${create.data.id}/complete`, { method: "PATCH" });
      return create.data.id;
    },
    onSuccess: (id) => {
      setDone(id);
      setCounts({});
      qc.invalidateQueries({ queryKey: ["stock"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    onSettled: () => setSaving(false),
  });

  return (
    <Shell title="Today's production">
      <p className="mb-6" style={{ color: "var(--ms-ink-3)" }}>
        Enter how many bottles of each flavor were produced today. Saving creates and
        completes the production run, adding stock to the factory.
      </p>

      {done && (
        <div
          className="mb-4 p-3 rounded-md text-sm"
          style={{ background: "var(--ms-green-100)", color: "var(--ms-green-900)" }}
        >
          ✓ Production run saved. Factory stock updated. (Run id: {done.slice(0, 8)}…)
        </div>
      )}
      {error && (
        <div
          className="mb-4 p-3 rounded-md text-sm"
          style={{ background: "#ffe1de", color: "#8a2018" }}
        >
          {error}
        </div>
      )}

      <div
        className="overflow-hidden"
        style={{
          background: "var(--ms-surface)",
          border: "1px solid var(--ms-border)",
          borderRadius: 14,
        }}
      >
        <table className="w-full text-sm">
          <thead style={{ background: "var(--ms-surface-alt)" }}>
            <tr>
              <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Flavor
              </th>
              <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Category
              </th>
              <th className="text-right px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Bottles
              </th>
            </tr>
          </thead>
          <tbody>
            {products.data?.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                <td className="px-4 py-3 font-semibold">{p.name}</td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-3)" }}>
                  {p.category}
                </td>
                <td className="px-4 py-3 text-right">
                  <input
                    type="number"
                    min={0}
                    value={counts[p.id] ?? 0}
                    onChange={(e) =>
                      setCounts({ ...counts, [p.id]: Math.max(0, Number(e.target.value)) })
                    }
                    className="w-24 px-2 py-1 text-right border rounded tabular-nums"
                    style={{ borderColor: "var(--ms-border)" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={() => run.mutate()}
          disabled={
            saving || Object.values(counts).every((q) => q === 0)
          }
          className="px-6 py-3 rounded-full text-white font-semibold disabled:opacity-50"
          style={{ background: "var(--ms-green-500)" }}
        >
          {saving ? "Saving..." : "Save production run →"}
        </button>
      </div>
    </Shell>
  );
}
