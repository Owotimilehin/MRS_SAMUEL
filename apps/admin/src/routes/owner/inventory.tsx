import { Fragment, useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useAuthUser } from "../../lib/auth.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { StatHero } from "../../components/StatHero.js";

// Inventory groups carry a product name but no slug — derive one so FlavourMedia
// can resolve the right bottle.
const slugify = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Per-variant stock row as returned by /stock/factory/:id and /reports/branch-stock.
interface StockRow {
  product_id: string;
  variant_id: string | null;
  balance: number;
}
interface BranchStockRow extends StockRow {
  branch_id: string;
}
interface Product {
  id: string;
  name: string;
  category: string;
}
interface Variant {
  id: string;
  product_id: string;
  size_ml: number;
}
interface Branch {
  id: string;
  name: string;
}
interface Factory {
  id: string;
  name: string;
}
// One displayed line: a flavour at a specific can size, or its legacy
// "unassigned" (NULL-variant) bucket that predates per-size tracking.
interface GridRow {
  productId: string;
  productName: string;
  variantId: string | null;
  label: string;
  sizeLabel: string;
  unassigned: boolean;
}
interface AdjustTarget {
  locationType: "factory" | "branch";
  locationId: string;
  locationName: string;
  productId: string;
  variantId: string | null;
  label: string;
  currentQty: number;
}

const REASONS: Array<{ value: string; label: string }> = [
  { value: "physical_recount", label: "Physical recount" },
  { value: "damaged", label: "Damaged" },
  { value: "spoilage", label: "Spoilage" },
  { value: "theft", label: "Theft / loss" },
  { value: "found", label: "Found extra" },
  { value: "opening_balance", label: "Opening balance" },
  { value: "other_with_note", label: "Other (specify)" },
];

const sizeLabel = (ml: number): string => (ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`);
const heatKey = (locId: string, productId: string, variantId: string | null): string =>
  `${locId}|${productId}|${variantId ?? "null"}`;

export function InventoryPage(): JSX.Element {
  const user = useAuthUser();
  const isOwner = user.role === "owner";

  const [branchStock, setBranchStock] = useState<BranchStockRow[]>([]);
  const [factoryStock, setFactoryStock] = useState<Record<string, StockRow[]>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [view, setView] = useState<"branch" | "factory">("branch");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<AdjustTarget | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [bs, p, b, f] = await Promise.all([
          api<{ data: BranchStockRow[] }>(`/reports/branch-stock`),
          api<{ data: Product[] }>(`/products`),
          api<{ data: Branch[] }>(`/branches`),
          api<{ data: Factory[] }>(`/factories`),
        ]);
        if (cancelled) return;
        setBranchStock(bs.data);
        setProducts(p.data);
        setBranches(b.data);
        setFactories(f.data);

        // Variants come from each product's detail; flatten into one list so the
        // grid can show every (flavour × size) even at zero stock.
        const variantLists = await Promise.all(
          p.data.map((prod) =>
            api<{ data: { variants?: Array<{ id: string; size_ml: number }> } }>(`/products/${prod.id}`)
              .then((r) => (r.data.variants ?? []).map((v) => ({ id: v.id, product_id: prod.id, size_ml: v.size_ml })))
              .catch(() => [] as Variant[]),
          ),
        );
        if (cancelled) return;
        setVariants(variantLists.flat());

        const fs = await Promise.all(
          f.data.map((row) =>
            api<{ data: StockRow[] }>(`/stock/factory/${row.id}`).then((r) => ({ id: row.id, data: r.data })),
          ),
        );
        if (cancelled) return;
        const next: Record<string, StockRow[]> = {};
        for (const x of fs) next[x.id] = x.data;
        setFactoryStock(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const invStats = useMemo(() => {
    let cans = 0;
    let low = 0;
    let inStock = 0;
    const perSku = new Map<string, number>();
    for (const r of branchStock) {
      const k = `${r.product_id}|${r.variant_id ?? "null"}`;
      perSku.set(k, (perSku.get(k) ?? 0) + r.balance);
    }
    for (const bal of perSku.values()) {
      if (bal > 0) {
        cans += bal;
        inStock += 1;
        if (bal <= 10) low += 1;
      }
    }
    return { cans, low, inStock };
  }, [branchStock]);

  // Balance lookup keyed by (location, product, variant).
  const branchHeat = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of branchStock) m.set(heatKey(row.branch_id, row.product_id, row.variant_id), row.balance);
    return m;
  }, [branchStock]);
  const factoryHeat = useMemo(() => {
    const m = new Map<string, number>();
    for (const [fid, rows] of Object.entries(factoryStock)) {
      for (const row of rows) m.set(heatKey(fid, row.product_id, row.variant_id), row.balance);
    }
    return m;
  }, [factoryStock]);

  const variantsByProduct = useMemo(() => {
    const m = new Map<string, Variant[]>();
    for (const v of [...variants].sort((a, b) => a.size_ml - b.size_ml)) {
      const arr = m.get(v.product_id) ?? [];
      arr.push(v);
      m.set(v.product_id, arr);
    }
    return m;
  }, [variants]);

  // Products that still carry legacy NULL-bucket stock somewhere — they get an
  // extra "(unassigned — recount)" row prompting staff to count it into sizes.
  const productsWithNullStock = useMemo(() => {
    const s = new Set<string>();
    for (const r of branchStock) if (r.variant_id === null && r.balance !== 0) s.add(r.product_id);
    for (const rows of Object.values(factoryStock))
      for (const r of rows) if (r.variant_id === null && r.balance !== 0) s.add(r.product_id);
    return s;
  }, [branchStock, factoryStock]);

  const gridRows = useMemo<GridRow[]>(() => {
    const rows: GridRow[] = [];
    for (const p of products) {
      for (const v of variantsByProduct.get(p.id) ?? []) {
        rows.push({
          productId: p.id,
          productName: p.name,
          variantId: v.id,
          label: `${p.name} · ${sizeLabel(v.size_ml)}`,
          sizeLabel: sizeLabel(v.size_ml),
          unassigned: false,
        });
      }
      if (productsWithNullStock.has(p.id)) {
        rows.push({
          productId: p.id,
          productName: p.name,
          variantId: null,
          label: `${p.name} · (unassigned — recount)`,
          sizeLabel: "(unassigned — recount)",
          unassigned: true,
        });
      }
    }
    return rows;
  }, [products, variantsByProduct, productsWithNullStock]);

  // Group per-(flavour × size) rows by flavour so the grid can show a
  // flavour-level subtotal row above each flavour's size rows.
  const groupedRows = useMemo<Array<{ productId: string; productName: string; rows: GridRow[] }>>(() => {
    const order: string[] = [];
    const byProduct = new Map<string, { productId: string; productName: string; rows: GridRow[] }>();
    for (const row of gridRows) {
      let group = byProduct.get(row.productId);
      if (!group) {
        group = { productId: row.productId, productName: row.productName, rows: [] };
        byProduct.set(row.productId, group);
        order.push(row.productId);
      }
      group.rows.push(row);
    }
    return order.map((id) => byProduct.get(id)!);
  }, [gridRows]);

  function cellTone(qty: number): string {
    if (qty <= 0) return "var(--danger)";
    if (qty <= 10) return "var(--warning)";
    return "var(--ink)";
  }
  function cellBg(qty: number): string {
    if (qty <= 0) return "rgba(220,38,38,0.10)";
    if (qty <= 10) return "rgba(245,158,11,0.10)";
    if (qty <= 30) return "rgba(252,191,73,0.08)";
    return "transparent";
  }

  function applyLocal(
    locationType: "factory" | "branch",
    locationId: string,
    productId: string,
    variantId: string | null,
    newQuantity: number,
  ): void {
    if (locationType === "factory") {
      setFactoryStock((s) => {
        const rows = [...(s[locationId] ?? [])];
        const i = rows.findIndex((r) => r.product_id === productId && r.variant_id === variantId);
        if (i >= 0) rows[i] = { ...rows[i]!, balance: newQuantity };
        else rows.push({ product_id: productId, variant_id: variantId, balance: newQuantity });
        return { ...s, [locationId]: rows };
      });
    } else {
      setBranchStock((rows) => {
        const i = rows.findIndex(
          (r) => r.branch_id === locationId && r.product_id === productId && r.variant_id === variantId,
        );
        if (i >= 0) return rows.map((r, idx) => (idx === i ? { ...r, balance: newQuantity } : r));
        return [...rows, { branch_id: locationId, product_id: productId, variant_id: variantId, balance: newQuantity }];
      });
    }
  }

  async function runAdjust(payload: {
    newQuantity: number;
    reasonCode: string;
    reasonNote: string;
  }): Promise<void> {
    if (!adjustTarget) return;
    await api(`/inventory/adjust`, {
      method: "POST",
      body: JSON.stringify({
        location_type: adjustTarget.locationType,
        location_id: adjustTarget.locationId,
        reason_code: payload.reasonCode,
        reason_note: payload.reasonNote || undefined,
        items: [
          {
            product_id: adjustTarget.productId,
            variant_id: adjustTarget.variantId,
            new_quantity: payload.newQuantity,
          },
        ],
      }),
    });
    applyLocal(
      adjustTarget.locationType,
      adjustTarget.locationId,
      adjustTarget.productId,
      adjustTarget.variantId,
      payload.newQuantity,
    );
    setFlash("Adjustment recorded");
    setAdjustTarget(null);
    setTimeout(() => setFlash(null), 2500);
  }

  function openAdjust(target: AdjustTarget): void {
    if (!isOwner) return;
    setAdjustTarget(target);
  }

  function renderCell(
    locationType: "factory" | "branch",
    locationId: string,
    locationName: string,
    row: GridRow,
    qty: number,
    key: string,
  ): JSX.Element {
    const baseStyle = {
      fontWeight: 700 as const,
      color: cellTone(qty),
      background: cellBg(qty),
    };
    // The unassigned NULL bucket is adjustable too — staff can drain it
    // directly (e.g. zero it out) once its stock has been recounted into sizes.
    const clickable = isOwner;
    return (
      <td
        key={key}
        className="table__num"
        style={clickable ? { ...baseStyle, cursor: "pointer" } : baseStyle}
        onClick={
          clickable
            ? () =>
                openAdjust({
                  locationType,
                  locationId,
                  locationName,
                  productId: row.productId,
                  variantId: row.variantId,
                  label: row.label,
                  currentQty: qty,
                })
            : undefined
        }
        title={clickable ? "Click to adjust" : undefined}
      >
        {locationType === "factory" ? qty.toLocaleString() : qty}
      </td>
    );
  }

  function renderGrid(
    locationType: "factory" | "branch",
    locations: Array<{ id: string; name: string }>,
    heat: Map<string, number>,
  ): JSX.Element {
    return (
      <div className="table-wrap" style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ position: "sticky", left: 0, background: "var(--surface-sunken)" }}>Flavour · size</th>
              {locations.map((l) => (
                <th key={l.id} className="table__num">
                  {l.name}
                </th>
              ))}
              <th className="table__num">Total</th>
            </tr>
          </thead>
          <tbody>
            {groupedRows.map((group) => {
              // Per-flavour subtotal: sum each location's balance across all of
              // this flavour's size rows (including the unassigned bucket).
              const subtotalCells = locations.map((l) =>
                group.rows.reduce((sum, row) => sum + (heat.get(heatKey(l.id, row.productId, row.variantId)) ?? 0), 0),
              );
              const subtotalTotal = subtotalCells.reduce((sum, q) => sum + q, 0);
              return (
                <Fragment key={`${group.productId}|__total`}>
                  <tr>
                    <td
                      style={{
                        position: "sticky",
                        left: 0,
                        background: "var(--shell)",
                        fontWeight: 700,
                        color: "var(--ink)",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <FlavourMedia size="chip" product={{ slug: slugify(group.productName) }} />
                        {group.productName}
                      </span>
                    </td>
                    {subtotalCells.map((q, idx) => (
                      <td
                        key={locations[idx]!.id}
                        className="table__num"
                        style={{ fontWeight: 700, color: cellTone(q), background: cellBg(q) }}
                      >
                        {locationType === "factory" ? q.toLocaleString() : q}
                      </td>
                    ))}
                    <td className="table__num" style={{ fontWeight: 800, color: cellTone(subtotalTotal) }}>
                      {locationType === "factory" ? subtotalTotal.toLocaleString() : subtotalTotal}
                    </td>
                  </tr>
                  {group.rows.map((row) => {
                    const cells = locations.map((l) => heat.get(heatKey(l.id, row.productId, row.variantId)) ?? 0);
                    const total = cells.reduce((sum, q) => sum + q, 0);
                    return (
                      <tr key={`${row.productId}|${row.variantId ?? "null"}`}>
                        <td
                          style={{
                            position: "sticky",
                            left: 0,
                            background: "var(--shell)",
                            paddingLeft: 28,
                            fontWeight: row.unassigned ? 400 : 600,
                            color: row.unassigned ? "var(--ink-soft)" : "var(--ink)",
                            fontStyle: row.unassigned ? "italic" : "normal",
                          }}
                        >
                          {row.sizeLabel}
                        </td>
                        {cells.map((q, idx) =>
                          renderCell(locationType, locations[idx]!.id, locations[idx]!.name, row, q, locations[idx]!.id),
                        )}
                        <td className="table__num" style={{ fontWeight: 800, color: cellTone(total) }}>
                          {locationType === "factory" ? total.toLocaleString() : total}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Shell
      title="Inventory"
      crumb="Owner"
      actions={
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={view === "branch" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setView("branch")}
          >
            Branches
          </button>
          <button
            type="button"
            className={view === "factory" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setView("factory")}
          >
            Factories
          </button>
          {isOwner && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setBulkOpen(true)}
              style={{ marginLeft: 6 }}
            >
              Bulk adjust
            </button>
          )}
        </div>
      }
    >
      <StatHero
        eyebrow="Stock"
        title="Inventory"
        sub="On-hand stock per can size across branches and the factory."
        loading={loading}
        chips={[
          { label: "Cans on hand", value: invStats.cans.toLocaleString() },
          { label: "SKUs in stock", value: invStats.inStock },
          { label: "Low-stock SKUs", value: invStats.low, tone: invStats.low > 0 ? "danger" : "good" },
          { label: "Branches", value: branches.length },
        ]}
      />

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
      ) : view === "branch" ? (
        branches.length === 0 ? (
          <div className="empty">No branches yet.</div>
        ) : (
          renderGrid("branch", branches, branchHeat)
        )
      ) : factories.length === 0 ? (
        <div className="empty">No factories configured.</div>
      ) : (
        renderGrid("factory", factories, factoryHeat)
      )}
      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12 }}>
        Red = out of stock · amber = low (≤10) · pale = caution (≤30). Each row is one can size.
        {isOwner && " Click any cell to adjust its on-hand. An italic “(unassigned — recount)” row is legacy stock not yet counted into sizes — adjust it too once recounted."}
      </p>

      {flash && (
        <div
          className="card"
          style={{
            borderColor: "rgba(16,185,129,0.35)",
            color: "var(--success)",
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 60,
          }}
        >
          {flash}
        </div>
      )}

      {adjustTarget && (
        <AdjustModal target={adjustTarget} onClose={() => setAdjustTarget(null)} onSubmit={runAdjust} />
      )}

      {bulkOpen && (
        <BulkAdjustModal
          factories={factories}
          branches={branches}
          gridRows={gridRows}
          branchHeat={branchHeat}
          factoryHeat={factoryHeat}
          onClose={() => setBulkOpen(false)}
          onSaved={async (locType, locId, items) => {
            for (const it of items) applyLocal(locType, locId, it.productId, it.variantId, it.newQty);
            setBulkOpen(false);
            setFlash(`Bulk adjustment recorded · ${items.length} line${items.length === 1 ? "" : "s"}`);
            setTimeout(() => setFlash(null), 3000);
          }}
        />
      )}
    </Shell>
  );
}

function BulkAdjustModal({
  factories,
  branches,
  gridRows,
  branchHeat,
  factoryHeat,
  onClose,
  onSaved,
}: {
  factories: Factory[];
  branches: Branch[];
  gridRows: GridRow[];
  branchHeat: Map<string, number>;
  factoryHeat: Map<string, number>;
  onClose: () => void;
  onSaved: (
    locType: "factory" | "branch",
    locId: string,
    items: Array<{ productId: string; variantId: string | null; newQty: number }>,
  ) => Promise<void>;
}): JSX.Element {
  const [locType, setLocType] = useState<"factory" | "branch">("factory");
  const [locId, setLocId] = useState<string>(factories[0]?.id ?? branches[0]?.id ?? "");
  const [reasonCode, setReasonCode] = useState<string>("physical_recount");
  const [reasonNote, setReasonNote] = useState<string>("");
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (locType === "factory") setLocId(factories[0]?.id ?? "");
    else setLocId(branches[0]?.id ?? "");
    setOverrides({});
  }, [locType, factories, branches]);

  // Sized rows plus the unassigned bucket are all bulk-adjustable, so a bulk
  // recount can zero the unassigned bucket alongside setting sizes.
  const rows = gridRows;
  const rowKey = (r: GridRow): string => `${r.productId}|${r.variantId ?? "null"}`;

  function currentQty(r: GridRow): number {
    const heat = locType === "factory" ? factoryHeat : branchHeat;
    return heat.get(heatKey(locId, r.productId, r.variantId)) ?? 0;
  }

  const locName =
    locType === "factory"
      ? factories.find((f) => f.id === locId)?.name ?? ""
      : branches.find((b) => b.id === locId)?.name ?? "";

  async function handleSubmit(): Promise<void> {
    if (!locId) {
      setError("Pick a location");
      return;
    }
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    const items: Array<{ productId: string; variantId: string | null; newQty: number }> = [];
    for (const r of rows) {
      const newQ = overrides[rowKey(r)];
      if (newQ === undefined) continue;
      if (newQ === currentQty(r)) continue;
      if (newQ < 0) {
        setError(`Quantity for ${r.label} can't be negative`);
        return;
      }
      items.push({ productId: r.productId, variantId: r.variantId, newQty: newQ });
    }
    if (items.length === 0) {
      setError("Nothing changed — adjust at least one row");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/inventory/adjust`, {
        method: "POST",
        body: JSON.stringify({
          location_type: locType,
          location_id: locId,
          reason_code: reasonCode,
          reason_note: reasonNote.trim() || undefined,
          items: items.map((i) => ({
            product_id: i.productId,
            variant_id: i.variantId,
            new_quantity: i.newQty,
          })),
        }),
      });
      await onSaved(locType, locId, items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--shell)",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Bulk adjust</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
            Type the new on-hand for each can size that changed. Unchanged rows are skipped.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div className="field">
            <label className="field__label" htmlFor="bulk-loc-type">Location type</label>
            <select
              id="bulk-loc-type"
              className="select"
              value={locType}
              onChange={(e) => setLocType(e.target.value as "factory" | "branch")}
            >
              <option value="factory">Factory</option>
              <option value="branch">Branch</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bulk-loc-id">Location</label>
            <select id="bulk-loc-id" className="select" value={locId} onChange={(e) => setLocId(e.target.value)}>
              {(locType === "factory" ? factories : branches).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bulk-reason">Reason (applies to all)</label>
            <select id="bulk-reason" className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {reasonCode === "other_with_note" && (
          <div className="field" style={{ marginBottom: 14 }}>
            <label className="field__label" htmlFor="bulk-note">Notes</label>
            <textarea
              id="bulk-note"
              className="textarea"
              rows={2}
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Describe what happened"
            />
          </div>
        )}

        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Flavour · size</th>
                <th className="table__num">Current</th>
                <th className="table__num">New on-hand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cur = currentQty(r);
                const newQ = overrides[rowKey(r)] ?? cur;
                const changed = newQ !== cur;
                return (
                  <tr key={rowKey(r)}>
                    <td>{r.label}</td>
                    <td className="table__num" style={{ color: "var(--ink-soft)" }}>{cur}</td>
                    <td className="table__num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={newQ}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setOverrides((o) => ({ ...o, [rowKey(r)]: Number.isFinite(v) ? v : 0 }));
                        }}
                        style={{
                          width: 100,
                          textAlign: "right",
                          fontWeight: changed ? 700 : 400,
                          color: changed ? "var(--accent)" : "var(--ink)",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <div className="field__error" style={{ marginBottom: 10 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "Submitting…" : `Adjust ${locName || ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function AdjustModal({
  target,
  onClose,
  onSubmit,
}: {
  target: AdjustTarget;
  onClose: () => void;
  onSubmit: (p: { newQuantity: number; reasonCode: string; reasonNote: string }) => Promise<void>;
}): JSX.Element {
  const [newQty, setNewQty] = useState<number>(target.currentQty);
  const [reasonCode, setReasonCode] = useState<string>("physical_recount");
  const [reasonNote, setReasonNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ newQuantity: Number(newQty), reasonCode, reasonNote });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/would_go_negative|stock would go negative/i.test(msg)) {
        setError(`Can't go below 0 — ${target.locationName} currently shows ${target.currentQty}.`);
      } else {
        setError(msg);
      }
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 460, maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "var(--shell)", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Adjust {target.label}</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>at {target.locationName}</p>
        </header>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field">
            <label className="field__label">Currently</label>
            <div style={{ fontSize: 14, color: "var(--ink-soft)" }}>{target.currentQty} bottles</div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="new-on-hand">
              New on-hand
            </label>
            <input
              id="new-on-hand"
              className="input"
              type="number"
              min={0}
              autoFocus
              value={newQty}
              onChange={(e) => setNewQty(Number(e.target.value))}
              style={{ textAlign: "right" }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="adjust-reason">
              Reason
            </label>
            <select id="adjust-reason" className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {reasonCode === "other_with_note" && (
            <div className="field">
              <label className="field__label" htmlFor="adjust-note">
                Notes
              </label>
              <textarea
                id="adjust-note"
                className="textarea"
                rows={2}
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Describe what happened"
              />
            </div>
          )}

          {error && (
            <div className="field__error" style={{ marginTop: 4 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
