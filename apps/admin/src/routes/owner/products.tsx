import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Modal } from "../../components/Modal.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import {
  PalettePicker,
  AssetPicker,
  ListEditor,
  IngredientDetailEditor,
  contentToPayload,
  type ProductContent,
} from "../../components/ProductEditor.js";

interface Variant {
  id: string;
  size_ml: number;
  sku: string;
  is_active: boolean;
  current_price_ngn: number | null;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  sizeMl: number | null;
  shelfLifeHours: number;
  displayOrder: number;
  deletedAt: string | null;
  current_price_ngn?: number | null;
  variants?: Variant[];
}

interface VariantDraft {
  size_ml: string;
  price_ngn: string;
}

// Web-address (slug) helpers. The API only accepts lowercase letters, numbers
// and dashes, so we normalise as the owner types — they can paste a flavour
// name and still end up with a valid address, never a baffling "invalid request".
// `slugifyName` is for auto-deriving from the name (trims stray dashes);
// `slugifyLive` is for the slug field itself (keeps a trailing dash so the owner
// can keep typing the next word).
const slugifyName = (v: string): string =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const slugifyLive = (v: string): string => v.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

export function ProductsPage(): JSX.Element {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [priceFor, setPriceFor] = useState<ProductRow | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const list = await api<{ data: ProductRow[] }>(`/products`);
      const detailed = await Promise.all(
        list.data.map((p) =>
          api<{ data: ProductRow }>(`/products/${p.id}`).then((r) => r.data).catch(() => p),
        ),
      );
      setRows(detailed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Shell
      title="Products"
      crumb="Owner"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          + New flavour
        </button>
      }
    >
      <div className="page-head ed-rise">
        <div className="page-head__titles">
          <div className="page-head__eyebrow">Catalogue</div>
          <h1 className="page-head__title">Products</h1>
          <p className="page-head__sub">Flavours, sizes and pricing.</p>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No flavours yet</div>
          Add your first flavour to start selling.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Flavour</th>
                <th>Category</th>
                <th>Ingredients</th>
                <th>Cans &amp; prices</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{p.slug}</div>
                  </td>
                  <td>
                    <span
                      className={
                        p.category === "special"
                          ? "pill pill--accent"
                          : p.category === "punch"
                            ? "pill pill--grad"
                            : "pill"
                      }
                    >
                      {p.category}
                    </span>
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {p.ingredients.length > 0 ? p.ingredients.join(", ") : "—"}
                  </td>
                  <td>
                    {p.variants && p.variants.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {p.variants.map((v) => (
                          <div
                            key={v.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              fontSize: 13,
                            }}
                          >
                            <span style={{ color: "var(--ink-soft)" }}>{v.size_ml}ml</span>
                            <span
                              className="tabular-nums"
                              style={{
                                fontWeight: 700,
                                color: v.current_price_ngn == null ? "var(--danger)" : "inherit",
                              }}
                            >
                              {v.current_price_ngn != null ? ngn(v.current_price_ngn) : "no price"}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: "var(--ink-soft)" }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <Link
                      to="/owner/products/$productId"
                      params={{ productId: p.id }}
                      className="btn btn--subtle btn--sm"
                      style={{ marginRight: 6 }}
                    >
                      Open
                    </Link>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={() => setPriceFor(p)}
                      disabled={!p.variants || p.variants.length === 0}
                    >
                      Update prices
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} title="New flavour" maxWidth={680}>
          <CreateForm
            onSaved={() => {
              setShowCreate(false);
              void load();
            }}
          />
        </Modal>
      )}
      {priceFor && priceFor.variants && (
        <Modal
          onClose={() => setPriceFor(null)}
          title={`Update prices · ${priceFor.name}`}
        >
          <PricesForm
            productId={priceFor.id}
            variants={priceFor.variants}
            onError={(msg) => setError(msg)}
            onSaved={async () => {
              setPriceFor(null);
              await load();
            }}
          />
        </Modal>
      )}
    </Shell>
  );
}

function CreateForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Once the owner edits the address by hand, stop auto-deriving it from the name.
  const [slugEdited, setSlugEdited] = useState(false);
  const [category, setCategory] = useState<"regular" | "special" | "punch">("regular");
  const [shelfHours, setShelfHours] = useState("48");
  const [ingredients, setIngredients] = useState("");
  // Full storefront content — same fields as the Edit screen, so a flavour can
  // be created complete in one go instead of "create then edit".
  const [content, setContent] = useState<ProductContent>({
    tagline: "",
    story: "",
    pairing: "",
    note: "",
    benefits: [],
    bestFor: [],
    ingredientDetails: [],
    palette: null,
    bottleAssetId: null,
    clusterAssetId: null,
    fruitAssetId: null,
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Default to the two house sizes; owner can adjust, add, or remove.
  const [variants, setVariants] = useState<VariantDraft[]>([
    { size_ml: "330", price_ngn: "2500" },
    { size_ml: "650", price_ngn: "3500" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setC(patch: Partial<ProductContent>): void {
    setContent((c) => ({ ...c, ...patch }));
  }

  function updateVariant(i: number, patch: Partial<VariantDraft>): void {
    setVariants((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function addVariant(): void {
    setVariants((vs) => [...vs, { size_ml: "", price_ngn: "" }]);
  }
  function removeVariant(i: number): void {
    setVariants((vs) => (vs.length <= 1 ? vs : vs.filter((_, idx) => idx !== i)));
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const parsed: { size_ml: number; price_ngn: number }[] = [];
    const seen = new Set<number>();
    for (const v of variants) {
      const sz = Number(v.size_ml);
      const pr = Number(v.price_ngn);
      if (!Number.isFinite(sz) || sz <= 0) {
        setError(`Size "${v.size_ml}" is invalid.`);
        return;
      }
      if (!Number.isFinite(pr) || pr <= 0) {
        setError(`Price "${v.price_ngn}" is invalid.`);
        return;
      }
      if (seen.has(sz)) {
        setError(`Duplicate size ${sz}ml.`);
        return;
      }
      seen.add(sz);
      parsed.push({ size_ml: sz, price_ngn: pr });
    }

    setSubmitting(true);
    try {
      await api(`/products`, {
        method: "POST",
        body: JSON.stringify({
          name,
          slug,
          category,
          ingredients: ingredients
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          shelf_life_hours: Number(shelfHours) || 48,
          display_order: 0,
          variants: parsed,
          image_url: imageUrl ?? undefined,
          ...contentToPayload(content),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label className="field__label">Name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugifyName(e.target.value));
          }}
          required
        />
      </div>
      <div className="field">
        <label className="field__label">Web address (slug)</label>
        <input
          className="input"
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(slugifyLive(e.target.value));
          }}
          pattern="^[a-z0-9\-]+$"
          required
        />
        <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "4px 0 0" }}>
          Lowercase letters, numbers and dashes only — this is the link customers see.
        </p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
        <div className="field">
          <label className="field__label">Shelf (h)</label>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            value={shelfHours}
            onChange={(e) => setShelfHours(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label">Can sizes &amp; prices</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {variants.map((v, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="Size (ml)"
                value={v.size_ml}
                onChange={(e) => updateVariant(i, { size_ml: e.target.value })}
                required
              />
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="Price (₦)"
                value={v.price_ngn}
                onChange={(e) => updateVariant(i, { price_ngn: e.target.value })}
                required
              />
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                onClick={() => removeVariant(i)}
                disabled={variants.length <= 1}
                aria-label="Remove size"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={addVariant}
            style={{ alignSelf: "flex-start" }}
          >
            + Add another size
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field__label">Ingredients (comma-separated)</label>
        <input
          className="input"
          value={ingredients}
          onChange={(e) => setIngredients(e.target.value)}
          placeholder="orange, ginger"
        />
      </div>

      <div className="field">
        <label className="field__label">Tagline</label>
        <input
          className="input"
          value={content.tagline}
          onChange={(e) => setC({ tagline: e.target.value })}
          placeholder="A short line for the flavour card"
        />
      </div>

      {/* Everything the storefront page shows — optional, collapsed by default so
          a quick create stays quick, but available without a second trip to Edit. */}
      <details className="card" style={{ padding: 0 }}>
        <summary
          style={{ cursor: "pointer", padding: "12px 14px", fontWeight: 700, fontSize: 14 }}
        >
          Story, benefits &amp; images (optional)
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 14px 14px" }}>
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
              placeholder="The story behind this flavour…"
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field__label">Pairing</label>
              <input
                className="input"
                value={content.pairing}
                onChange={(e) => setC({ pairing: e.target.value })}
                placeholder="Goes well with…"
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
        </div>
      </details>
      {error && <div className="field__error">{error}</div>}
      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? "Saving…" : "Create flavour"}
      </button>
    </form>
  );
}

function PricesForm({
  productId,
  variants,
  onSaved,
  onError,
}: {
  productId: string;
  variants: Variant[];
  onSaved: () => Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      variants.map((v) => [v.id, v.current_price_ngn != null ? String(v.current_price_ngn) : ""]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    // Publish only the variants whose price changed (skip unchanged + blank).
    const changes = variants
      .map((v) => {
        const draftStr = drafts[v.id] ?? "";
        const draft = Number(draftStr);
        if (!Number.isFinite(draft) || draft <= 0) return null;
        if (v.current_price_ngn === draft) return null;
        return { variant_id: v.id, price_ngn: draft };
      })
      .filter((x): x is { variant_id: string; price_ngn: number } => x != null);

    try {
      for (const ch of changes) {
        await api(`/products/${productId}/prices`, {
          method: "POST",
          body: JSON.stringify(ch),
        });
      }
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError) onError(err.message);
      else onError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: 0 }}>
        Publishing a new price for a size closes its existing price (sets <code>valid_to</code>) and
        starts a fresh row. Historical sale lines keep their original snapshot.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {variants.map((v) => (
          <div
            key={v.id}
            style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ fontWeight: 700 }}>{v.size_ml}ml</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              value={drafts[v.id] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
              placeholder={v.current_price_ngn != null ? String(v.current_price_ngn) : "Set price"}
              required
            />
          </div>
        ))}
      </div>
      <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
        {submitting ? "Publishing…" : "Publish changes"}
      </button>
    </form>
  );
}
