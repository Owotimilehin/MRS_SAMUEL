import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type Palette = { surface: string; accent: string; text: string };
export type IngredientDetail = { name: string; benefit: string };
export type AssetKind = "bottle" | "cluster" | "fruit";

export interface MediaAsset {
  id: string;
  kind: string;
  name: string;
  url: string;
  objectKey: string | null;
}

/** Marketing/visual content a flavour carries on the storefront. */
export interface ProductContent {
  tagline: string;
  story: string;
  pairing: string;
  note: string;
  benefits: string[];
  bestFor: string[];
  ingredientDetails: IngredientDetail[];
  palette: Palette | null;
  bottleAssetId: string | null;
  clusterAssetId: string | null;
  fruitAssetId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Relative luminance (sRGB) → pick a near-black or near-white reading colour
 *  so text stays legible on whatever surface the owner chooses. */
export function deriveTextColour(surfaceHex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(surfaceHex.trim());
  if (!m?.[1]) return "#2a1a0a";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.5 ? "#2a1a0a" : "#fdf7ee";
}

const DEFAULT_PALETTE: Palette = { surface: "#fdecd2", accent: "#e85d1c", text: "#3a1a05" };

// ─────────────────────────────────────────────────────────────────────────────
// Two-colour picker (primary = surface, secondary = accent; text auto-derived)
// ─────────────────────────────────────────────────────────────────────────────

export function PalettePicker({
  value,
  onChange,
}: {
  value: Palette | null;
  onChange: (p: Palette) => void;
}): JSX.Element {
  const p = value ?? DEFAULT_PALETTE;
  function set(part: Partial<Palette>): void {
    const next = { ...p, ...part };
    next.text = deriveTextColour(next.surface);
    onChange(next);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <ColourField
          label="Primary (background)"
          value={p.surface}
          onChange={(v) => set({ surface: v })}
        />
        <ColourField
          label="Secondary (accent)"
          value={p.accent}
          onChange={(v) => set({ accent: v })}
        />
      </div>
      {/* Live preview of how the flavour card will read */}
      <div
        style={{
          borderRadius: 12,
          padding: "16px 18px",
          background: p.surface,
          color: p.text,
          border: "1px solid var(--line)",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15 }}>Aa — flavour card preview</div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>Body text auto-tuned for contrast.</div>
        <span
          style={{
            display: "inline-block",
            marginTop: 10,
            padding: "5px 12px",
            borderRadius: 999,
            background: p.accent,
            color: deriveTextColour(p.accent),
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Add to cart
        </span>
      </div>
    </div>
  );
}

function ColourField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 44,
            height: 38,
            padding: 0,
            border: "1px solid var(--line)",
            borderRadius: 8,
            background: "none",
            cursor: "pointer",
          }}
          aria-label={label}
        />
        <input
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern="^#[0-9a-fA-F]{6}$"
          style={{ fontFamily: "monospace" }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Media-library asset picker (pick from the pool or upload)
// ─────────────────────────────────────────────────────────────────────────────

export function AssetPicker({
  kind,
  label,
  value,
  onChange,
}: {
  kind: AssetKind;
  label: string;
  value: string | null;
  onChange: (assetId: string | null, url: string | null) => void;
}): JSX.Element {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: MediaAsset[] }>(`/media?kind=${kind}`);
      setAssets(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function onUpload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // 1) presign → 2) PUT bytes to R2 → 3) record asset row
      const pres = await api<{ data: { upload_url: string; object_key: string } }>(
        `/media/upload-url`,
        {
          method: "POST",
          body: JSON.stringify({
            kind,
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
          }),
        },
      );
      await fetch(pres.data.upload_url, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      const created = await api<{ data: MediaAsset }>(`/media`, {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: file.name,
          url: pres.data.object_key, // public URL resolution handled server-side later
          object_key: pres.data.object_key,
        }),
      });
      await load();
      onChange(created.data.id, created.data.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /service_unavailable|not configured/i.test(msg)
          ? "Image upload isn't configured yet (R2 keys missing). Pick from the library for now."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {loading ? (
        <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Loading library…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
            gap: 8,
          }}
        >
          {assets.map((a) => {
            const selected = a.id === value;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onChange(selected ? null : a.id, selected ? null : a.url)}
                title={a.name}
                style={{
                  aspectRatio: "1",
                  borderRadius: 10,
                  border: selected ? "2px solid var(--accent)" : "1px solid var(--line)",
                  background: "var(--surface-2, #f6f5f2)",
                  padding: 4,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <img
                  src={a.url}
                  alt={a.name}
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? "Uploading…" : "Upload new"}
        </button>
        {value && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={() => onChange(null, null)}
          >
            Clear
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="field__error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// String-list editor (benefits / best-for chips)
// ─────────────────────────────────────────────────────────────────────────────

export function ListEditor({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder?: string;
  onChange: (items: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  function add(): void {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  }
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {items.map((it, i) => (
          <span key={i} className="pill" style={{ display: "inline-flex", gap: 6 }}>
            {it}
            <button
              type="button"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              style={{ border: "none", background: "none", cursor: "pointer", color: "inherit" }}
              aria-label={`Remove ${it}`}
            >
              ✕
            </button>
          </span>
        ))}
        {items.length === 0 && (
          <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>None yet</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn--subtle btn--sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingredient-detail editor (name + benefit pairs)
// ─────────────────────────────────────────────────────────────────────────────

export function IngredientDetailEditor({
  items,
  onChange,
}: {
  items: IngredientDetail[];
  onChange: (items: IngredientDetail[]) => void;
}): JSX.Element {
  function update(i: number, patch: Partial<IngredientDetail>): void {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  return (
    <div className="field">
      <label className="field__label">Ingredient details (name → benefit)</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((it, i) => (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8 }}
          >
            <input
              className="input"
              value={it.name}
              placeholder="Carrot"
              onChange={(e) => update(i, { name: e.target.value })}
            />
            <input
              className="input"
              value={it.benefit}
              placeholder="Beta-carotene for clear skin…"
              onChange={(e) => update(i, { benefit: e.target.value })}
            />
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              aria-label="Remove ingredient"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          style={{ alignSelf: "flex-start" }}
          onClick={() => onChange([...items, { name: "", benefit: "" }])}
        >
          + Add ingredient
        </button>
      </div>
    </div>
  );
}

/** Map ProductContent → the snake_case payload the PATCH/POST endpoints accept. */
export function contentToPayload(c: ProductContent): Record<string, unknown> {
  return {
    tagline: c.tagline || undefined,
    story: c.story || undefined,
    pairing: c.pairing || undefined,
    note: c.note || undefined,
    benefits: c.benefits,
    best_for: c.bestFor,
    ingredient_details: c.ingredientDetails.filter((i) => i.name.trim() && i.benefit.trim()),
    palette: c.palette,
    bottle_asset_id: c.bottleAssetId,
    cluster_asset_id: c.clusterAssetId,
    fruit_asset_id: c.fruitAssetId,
  };
}
