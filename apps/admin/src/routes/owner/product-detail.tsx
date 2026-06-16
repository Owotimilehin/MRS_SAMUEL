import { useEffect, useState, type FormEvent } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { Modal } from "../../components/Modal.js";
import { api } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { getFlavourVisual } from "../../lib/flavour-visuals.js";
import {
  PalettePicker,
  AssetPicker,
  ListEditor,
  IngredientDetailEditor,
  contentToPayload,
  type Palette,
  type IngredientDetail,
  type ProductContent,
} from "../../components/ProductEditor.js";

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
  tagline: string | null;
  story: string | null;
  pairing: string | null;
  note: string | null;
  benefits: string[];
  bestFor: string[];
  ingredientDetails: IngredientDetail[];
  palette: Palette | null;
  bottleAssetId: string | null;
  clusterAssetId: string | null;
  fruitAssetId: string | null;
  current_price_ngn: number | null;
  variants: Variant[];
}

export function ProductDetailPage({ productId }: { productId: string }): JSX.Element {
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acting, setActing] = useState(false);
  // id → url map so we can show the cluster/fruit thumbnails (the product only
  // stores their asset ids, not urls). Best-effort; thumbnails just fall back.
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ data: { id: string; url: string }[] }>(`/media`);
        setAssetUrls(Object.fromEntries(res.data.map((a) => [a.id, a.url])));
      } catch {
        /* thumbnails are best-effort */
      }
    })();
  }, []);

  function showFlash(msg: string): void {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  }

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
      showFlash(`New ${variant.size_ml}ml price published`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingId(null);
    }
  }

  async function toggleActive(): Promise<void> {
    if (!product) return;
    setActing(true);
    setError(null);
    try {
      await api(`/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !product.isActive }),
      });
      showFlash(product.isActive ? "Flavour hidden from storefront" : "Flavour is live again");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function doDelete(): Promise<void> {
    setActing(true);
    setError(null);
    try {
      await api(`/products/${productId}`, { method: "DELETE" });
      void router.navigate({ to: "/owner/products" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActing(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Shell
      title={product?.name ?? "Flavour"}
      crumb="Owner"
      actions={
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/owner/products" className="btn btn--subtle btn--sm">
            ← All flavours
          </Link>
          {product && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setEditing(true)}
            >
              Edit details
            </button>
          )}
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
          {(() => {
            const vis = getFlavourVisual({ slug: product.slug, imageUrl: product.imageUrl, palette: product.palette });
            return (
              <section
                className="flav-hero ed-rise"
                style={{ ["--fl-surface" as string]: vis.surface, ["--fl-accent" as string]: vis.accent } as React.CSSProperties}
              >
                <FlavourMedia
                  size="hero"
                  className="flav-hero__media"
                  product={{ slug: product.slug, imageUrl: product.imageUrl, palette: product.palette }}
                />
                <div className="flav-hero__meta">
                  <span className="flav-tag" style={{ ["--fl-accent" as string]: vis.accent } as React.CSSProperties}>
                    {product.category}
                  </span>
                  <h2 className="flav-hero__name">{product.name}</h2>
                  {product.tagline ? <p className="flav-hero__tagline">{product.tagline}</p> : null}
                  <div className="flav-hero__slug">/{product.slug}</div>
                </div>
              </section>
            );
          })()}

          <div
            className="ed-rise"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
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

          <div className="l-split l-split--detail">
            <section className="card">
              <div className="card__head"><h2 className="t-h2">Details</h2></div>
              <Field label="Name" value={product.name} />
              <Field label="Slug" value={product.slug} mono />
              <Field label="Tagline" value={product.tagline ?? "—"} />
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
                label="Colour"
                value={
                  product.palette ? (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <Swatch color={product.palette.surface} title="Primary" />
                      <Swatch color={product.palette.accent} title="Secondary" />
                      <span style={{ fontSize: 12, color: "var(--ink-soft)", fontFamily: "monospace" }}>
                        {product.palette.surface} / {product.palette.accent}
                      </span>
                    </span>
                  ) : (
                    "—"
                  )
                }
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
              <Field
                label="Bottle image"
                value={
                  product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      style={{ height: 56, objectFit: "contain" }}
                    />
                  ) : (
                    "—"
                  )
                }
              />

              {/* Lifecycle: deactivate (reversible) / delete (soft) */}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn--subtle btn--sm"
                  onClick={() => void toggleActive()}
                  disabled={acting}
                >
                  {product.isActive ? "Deactivate" : "Reactivate"}
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  onClick={() => setConfirmDelete(true)}
                  disabled={acting}
                >
                  Delete flavour
                </button>
              </div>
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

          {/* The rich storefront content the create/edit forms capture. Read-only
              here; click "Edit details" to change it. */}
          <section className="card" style={{ marginTop: 18 }}>
            <div className="card__head">
              <h2 className="t-h2">Storefront content</h2>
            </div>
            <Field label="Story" value={textOrDash(product.story)} />
            <Field label="Pairing" value={textOrDash(product.pairing)} />
            <Field label="Note" value={textOrDash(product.note)} />
            <Field
              label="Benefits"
              value={product.benefits.length > 0 ? <Chips items={product.benefits} /> : "—"}
            />
            <Field
              label="Best for"
              value={product.bestFor.length > 0 ? <Chips items={product.bestFor} /> : "—"}
            />
            <Field
              label="Ingredient details"
              value={
                product.ingredientDetails.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {product.ingredientDetails.map((d, i) => (
                      <div key={i} style={{ fontSize: 13 }}>
                        <strong>{d.name}</strong>
                        {d.benefit ? <span style={{ color: "var(--ink-soft)" }}> — {d.benefit}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Images"
              value={
                <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
                  <AssetThumb
                    caption="Bottle"
                    url={
                      (product.bottleAssetId && assetUrls[product.bottleAssetId]) ||
                      product.imageUrl ||
                      undefined
                    }
                  />
                  <AssetThumb
                    caption="Cluster"
                    url={product.clusterAssetId ? assetUrls[product.clusterAssetId] : undefined}
                  />
                  <AssetThumb
                    caption="Fruit"
                    url={product.fruitAssetId ? assetUrls[product.fruitAssetId] : undefined}
                  />
                </div>
              }
            />
          </section>
        </>
      )}

      {editing && product && (
        <Modal onClose={() => setEditing(false)} title={`Edit · ${product.name}`} maxWidth={720}>
          <EditDetailsForm
            product={product}
            onSaved={async () => {
              setEditing(false);
              showFlash("Details saved");
              await load();
            }}
          />
        </Modal>
      )}

      {confirmDelete && product && (
        <Modal onClose={() => setConfirmDelete(false)} title={`Delete ${product.name}?`}>
          <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>
            This retires the flavour from the storefront and admin lists. Past customer orders that
            include it stay intact. If you only want to pause it for the season, use{" "}
            <strong>Deactivate</strong> instead — you can switch it back on later.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button
              type="button"
              className="btn btn--subtle"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void doDelete()}
              disabled={acting}
            >
              {acting ? "Deleting…" : "Delete flavour"}
            </button>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

function EditDetailsForm({
  product,
  onSaved,
}: {
  product: Product;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [ingredients, setIngredients] = useState(product.ingredients.join(", "));
  const [shelfHours, setShelfHours] = useState(String(product.shelfLifeHours));
  const [displayOrder, setDisplayOrder] = useState(String(product.displayOrder));
  const [content, setContent] = useState<ProductContent>({
    tagline: product.tagline ?? "",
    story: product.story ?? "",
    pairing: product.pairing ?? "",
    note: product.note ?? "",
    benefits: product.benefits ?? [],
    bestFor: product.bestFor ?? [],
    ingredientDetails: product.ingredientDetails ?? [],
    palette: product.palette,
    bottleAssetId: product.bottleAssetId,
    clusterAssetId: product.clusterAssetId,
    fruitAssetId: product.fruitAssetId,
  });
  const [imageUrl, setImageUrl] = useState(product.imageUrl);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setC(patch: Partial<ProductContent>): void {
    setContent((c) => ({ ...c, ...patch }));
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/products/${product.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          category,
          ingredients: ingredients.split(",").map((s) => s.trim()).filter(Boolean),
          shelf_life_hours: Number(shelfHours),
          display_order: Number(displayOrder),
          image_url: imageUrl ?? undefined,
          ...contentToPayload(content),
        }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label className="field__label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label className="field__label">Category</label>
          <select
            className="select"
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
          >
            <option value="regular">Regular</option>
            <option value="special">Special</option>
            <option value="punch">Punch</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label className="field__label">Tagline</label>
        <input
          className="input"
          value={content.tagline}
          onChange={(e) => setC({ tagline: e.target.value })}
          placeholder="Carrot, pawpaw, orange & pineapple at first light."
        />
      </div>

      <div className="field">
        <label className="field__label">Ingredients (comma-separated)</label>
        <input
          className="input"
          value={ingredients}
          onChange={(e) => setIngredients(e.target.value)}
          placeholder="Carrot, Pawpaw, Orange, Pineapple"
        />
      </div>

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
        <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 6px" }}>Colour</legend>
        <PalettePicker value={content.palette} onChange={(palette) => setC({ palette })} />
      </fieldset>

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
        <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 6px" }}>Images</legend>
        <AssetPicker
          kind="bottle"
          label="Bottle"
          value={content.bottleAssetId}
          onChange={(bottleAssetId, url) => {
            setC({ bottleAssetId });
            if (url) setImageUrl(url);
          }}
        />
        <AssetPicker
          kind="cluster"
          label="Decoration cluster"
          value={content.clusterAssetId}
          onChange={(clusterAssetId) => setC({ clusterAssetId })}
        />
        <AssetPicker
          kind="fruit"
          label="Fruit accent"
          value={content.fruitAssetId}
          onChange={(fruitAssetId) => setC({ fruitAssetId })}
        />
      </fieldset>

      <ListEditor
        label="Benefits"
        items={content.benefits}
        placeholder="Brightens skin"
        onChange={(benefits) => setC({ benefits })}
      />
      <ListEditor
        label="Best for"
        items={content.bestFor}
        placeholder="Mornings"
        onChange={(bestFor) => setC({ bestFor })}
      />
      <IngredientDetailEditor
        items={content.ingredientDetails}
        onChange={(ingredientDetails) => setC({ ingredientDetails })}
      />

      <div className="field">
        <label className="field__label">Story</label>
        <textarea
          className="input"
          rows={3}
          value={content.story}
          onChange={(e) => setC({ story: e.target.value })}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label className="field__label">Pairing</label>
          <input
            className="input"
            value={content.pairing}
            onChange={(e) => setC({ pairing: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label">Note (optional)</label>
          <input
            className="input"
            value={content.note}
            onChange={(e) => setC({ note: e.target.value })}
          />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label className="field__label">Shelf life (h)</label>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            value={shelfHours}
            onChange={(e) => setShelfHours(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label">Display order</label>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="field__error">{error}</div>}
      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? "Saving…" : "Save details"}
      </button>
    </form>
  );
}

function textOrDash(v: string | null | undefined): string {
  return v && v.trim() ? v : "—";
}

function Chips({ items }: { items: string[] }): JSX.Element {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((it, i) => (
        <span key={i} className="pill">
          {it}
        </span>
      ))}
    </div>
  );
}

function AssetThumb({ caption, url }: { caption: string; url: string | undefined }): JSX.Element {
  return (
    <div style={{ textAlign: "center" }}>
      {url ? (
        <img
          src={url}
          alt={caption}
          style={{ height: 56, width: 56, objectFit: "contain", display: "block" }}
        />
      ) : (
        <div
          style={{
            height: 56,
            width: 56,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            border: "1px dashed var(--line)",
            color: "var(--ink-soft)",
            fontSize: 18,
          }}
        >
          —
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 4 }}>{caption}</div>
    </div>
  );
}

function Swatch({ color, title }: { color: string; title: string }): JSX.Element {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        width: 18,
        height: 18,
        borderRadius: 5,
        background: color,
        border: "1px solid var(--line)",
      }}
    />
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
