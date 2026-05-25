import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { api } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Variant {
  id: string;
  size_ml: number;
  sku: string;
  is_active: boolean;
  current_price_ngn: number | null;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  sizeMl: number | null;
  shelfLifeHours: number;
  displayOrder: number;
  imageUrl: string | null;
  isActive: boolean;
  current_price_ngn: number | null;
  variants: Variant[];
}

export function ProductDetailPage({ productId }: { productId: string }): JSX.Element {
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Product }>(`/products/${productId}`);
      setProduct(res.data);
      setDrafts(
        Object.fromEntries(
          res.data.variants.map((v) => [
            v.id,
            v.current_price_ngn != null ? String(v.current_price_ngn) : "",
          ]),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function publishPrice(variant: Variant, e: FormEvent): Promise<void> {
    e.preventDefault();
    const draftStr = drafts[variant.id] ?? "";
    const priceNgn = Number(draftStr);
    if (!Number.isFinite(priceNgn) || priceNgn <= 0) {
      setError("Enter a valid price.");
      return;
    }
    if (variant.current_price_ngn === priceNgn) {
      setError("Price unchanged.");
      return;
    }
    setPublishingId(variant.id);
    setError(null);
    try {
      await api(`/products/${productId}/prices`, {
        method: "POST",
        body: JSON.stringify({ variant_id: variant.id, price_ngn: priceNgn }),
      });
      setFlash(`New ${variant.size_ml}ml price published`);
      setTimeout(() => setFlash(null), 2500);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <Shell
      title={product?.name ?? "Flavour"}
      actions={
        <Link to="/owner/products" className="btn btn--subtle btn--sm">
          ← All flavours
        </Link>
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
      {flash && (
        <div
          className="card"
          style={{
            background: "rgba(16,185,129,0.10)",
            borderColor: "rgba(16,185,129,0.25)",
            color: "#047857",
            marginBottom: 16,
          }}
        >
          {flash}
        </div>
      )}

      {loading || !product ? (
        <InlineLoader />
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 14,
              marginBottom: 18,
            }}
          >
            <Stat label="Category" value={product.category} />
            <Stat label="Sizes" value={String(product.variants.length)} />
            <Stat
              label="From"
              value={product.current_price_ngn != null ? ngn(product.current_price_ngn) : "—"}
              tone="accent"
            />
            <Stat label="Shelf life" value={`${product.shelfLifeHours}h`} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
            <section className="card">
              <h2 className="t-h2" style={{ marginBottom: 12 }}>Details</h2>
              <Field label="Name" value={product.name} />
              <Field label="Slug" value={product.slug} mono />
              <Field
                label="Category"
                value={
                  <span
                    className={
                      product.category === "special"
                        ? "pill pill--accent"
                        : product.category === "punch"
                          ? "pill pill--grad"
                          : "pill"
                    }
                  >
                    {product.category}
                  </span>
                }
              />
              <Field
                label="Ingredients"
                value={product.ingredients.length > 0 ? product.ingredients.join(", ") : "—"}
              />
              <Field
                label="Active"
                value={
                  product.isActive ? (
                    <span className="pill pill--success">Active</span>
                  ) : (
                    <span className="pill pill--ink">Hidden</span>
                  )
                }
              />
              <Field label="Display order" value={String(product.displayOrder)} />
              <Field label="Image" value={product.imageUrl ?? "—"} mono />
            </section>

            <section className="card">
              <h2 className="t-h2" style={{ marginBottom: 4 }}>Cans &amp; prices</h2>
              <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: 0 }}>
                Each can size carries its own price. Publishing a new price closes the existing one
                (sets <code>valid_to</code>); historical sale lines keep their original snapshot.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
                {product.variants.map((v) => (
                  <form
                    key={v.id}
                    onSubmit={(e) => publishPrice(v, e)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "80px 1fr auto",
                      gap: 10,
                      alignItems: "center",
                      paddingBottom: 12,
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{v.size_ml}ml</div>
                      <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                        {v.current_price_ngn != null ? ngn(v.current_price_ngn) : "no price set"}
                      </div>
                    </div>
                    <input
                      className="input"
                      type="number"
                      inputMode="numeric"
                      value={drafts[v.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                      placeholder={
                        v.current_price_ngn != null ? String(v.current_price_ngn) : "Set price"
                      }
                      required
                    />
                    <button
                      type="submit"
                      className="btn btn--primary btn--sm"
                      disabled={publishingId === v.id || !drafts[v.id]}
                    >
                      {publishingId === v.id ? "…" : "Publish"}
                    </button>
                  </form>
                ))}
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14 }}>
                Last loaded {formatDate(new Date())}. Audit log records every change.
              </p>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: 10,
        padding: "10px 0",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <span style={{ color: "var(--ink-soft)", fontSize: 13, fontWeight: 600 }}>{label}</span>
      <span style={{ fontFamily: mono ? "monospace" : undefined, fontSize: mono ? 13 : 14 }}>
        {value}
      </span>
    </div>
  );
}
