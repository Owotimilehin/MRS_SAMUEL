import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";

interface Product {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  current_price_ngn?: number | null;
}

interface ProductsResponse { data: Product[] }

export function ProductsPage() {
  const qc = useQueryClient();
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => api<ProductsResponse>("/products").then((r) => r.data),
  });
  const [showAdd, setShowAdd] = useState(false);

  return (
    <Shell title="Products">
      <div className="flex justify-between items-end mb-6">
        <p style={{ color: "var(--ms-ink-3)" }}>
          {products.data?.length ?? 0} flavors in the catalog
        </p>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 rounded-full text-white text-sm font-semibold"
          style={{ background: "var(--ms-ink)" }}
        >
          + New product
        </button>
      </div>

      {showAdd && (
        <AddForm
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["products"] });
            setShowAdd(false);
          }}
        />
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
                Name
              </th>
              <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Category
              </th>
              <th className="text-left px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Ingredients
              </th>
              <th className="text-right px-4 py-2 font-semibold uppercase tracking-wide text-xs">
                Price
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {products.data?.map((p) => (
              <ProductRow
                key={p.id}
                product={p}
                onPriceUpdated={() => qc.invalidateQueries({ queryKey: ["products"] })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function ProductRow({ product: p, onPriceUpdated }: { product: Product; onPriceUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState<number>(p.current_price_ngn ?? 0);
  const publish = useMutation({
    mutationFn: () =>
      api(`/products/${p.id}/prices`, {
        method: "POST",
        body: JSON.stringify({ price_ngn: price }),
      }),
    onSuccess: () => {
      setEditing(false);
      onPriceUpdated();
    },
  });

  return (
    <tr style={{ borderTop: "1px solid var(--ms-divider)" }}>
      <td className="px-4 py-3">
        <div className="font-semibold">{p.name}</div>
        <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
          {p.slug}
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className="text-xs font-semibold px-2 py-1 rounded-full"
          style={{
            background:
              p.category === "special"
                ? "rgba(255,90,166,0.15)"
                : p.category === "punch"
                  ? "rgba(255,196,52,0.18)"
                  : "var(--ms-green-100)",
            color:
              p.category === "special"
                ? "#a02440"
                : p.category === "punch"
                  ? "#7a5a0a"
                  : "var(--ms-green-900)",
          }}
        >
          {p.category}
        </span>
      </td>
      <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
        {p.ingredients.join(" · ")}
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">
        {editing ? (
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(Number(e.target.value))}
            className="w-28 px-2 py-1 text-right border rounded"
            style={{ borderColor: "var(--ms-border)" }}
          />
        ) : (
          ngn(p.current_price_ngn ?? null)
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-2 py-1"
              style={{ color: "var(--ms-ink-3)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => publish.mutate()}
              disabled={publish.isPending || price <= 0}
              className="text-xs px-3 py-1 rounded-full text-white font-semibold"
              style={{ background: "var(--ms-green-500)" }}
            >
              {publish.isPending ? "..." : "Publish"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setPrice(p.current_price_ngn ?? 0);
              setEditing(true);
            }}
            className="text-xs"
            style={{ color: "var(--ms-green-700)" }}
          >
            Edit price
          </button>
        )}
      </td>
    </tr>
  );
}

function AddForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    category: "regular" as Product["category"],
    ingredients: "",
    initial_price_ngn: 2500,
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api("/products", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          category: form.category,
          ingredients: form.ingredients
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          initial_price_ngn: form.initial_price_ngn,
        }),
      }),
    onSuccess: onCreated,
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        create.mutate();
      }}
      className="mb-6 p-4 grid gap-3"
      style={{
        background: "var(--ms-surface)",
        border: "1px solid var(--ms-border)",
        borderRadius: 14,
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            required
            value={form.name}
            onChange={(e) =>
              setForm({
                ...form,
                name: e.target.value,
                slug:
                  form.slug ||
                  e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
              })
            }
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Slug">
          <input
            required
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            pattern="[a-z0-9-]+"
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
        <Field label="Category">
          <select
            value={form.category}
            onChange={(e) =>
              setForm({ ...form, category: e.target.value as Product["category"] })
            }
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          >
            <option value="regular">Regular</option>
            <option value="special">Special</option>
            <option value="punch">Punch</option>
          </select>
        </Field>
        <Field label="Initial price (₦)">
          <input
            type="number"
            required
            value={form.initial_price_ngn}
            onChange={(e) =>
              setForm({ ...form, initial_price_ngn: Number(e.target.value) })
            }
            className="w-full px-3 py-2 border rounded-md"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </Field>
      </div>
      <Field label="Ingredients (comma-separated)">
        <input
          value={form.ingredients}
          onChange={(e) => setForm({ ...form, ingredients: e.target.value })}
          placeholder="Carrot, Pawpaw, Orange, Pineapple"
          className="w-full px-3 py-2 border rounded-md"
          style={{ borderColor: "var(--ms-border)" }}
        />
      </Field>

      {error && (
        <p className="text-sm" style={{ color: "var(--ms-danger)" }}>
          {error}
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 border rounded-full text-sm"
          style={{ borderColor: "var(--ms-border)" }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={create.isPending}
          className="px-4 py-2 rounded-full text-white text-sm font-semibold"
          style={{ background: "var(--ms-green-500)" }}
        >
          {create.isPending ? "Saving..." : "Save product"}
        </button>
      </div>
    </form>
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
