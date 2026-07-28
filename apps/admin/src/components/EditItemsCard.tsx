import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, humanizeError } from "../lib/api.js";
import { ngn } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { FlavourMedia } from "./FlavourMedia.js";
import { ConfirmModal } from "./ConfirmModal.js";

export interface EditableSaleItem {
  id: string;
  productId: string;
  variantId?: string | null;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
  sizeMl?: number | null;
}

interface EditItemsCardProps {
  branchId: string;
  saleId: string;
  status: string;
  channel: string;
  items: EditableSaleItem[];
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
  productsById: Record<string, { name: string; slug: string }>;
  canEdit: boolean;
  onSaved: () => void;
  /** Extra totals rows (e.g. Payaza fee breakdown) rendered inside the same grid. */
  children?: ReactNode;
}

// Statuses past the point where the goods are already gone / the order is dead
// — mirrors the server's UNEDITABLE_ITEM_STATUSES in apps/api/src/routes/sales.ts.
const UNEDITABLE_STATUSES = new Set([
  "handed_over",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "failed",
]);

interface CatalogVariant {
  id: string;
  size_ml: number;
  sku: string;
  is_active: boolean;
  current_price_ngn: number | null;
}
interface CatalogEntry {
  productId: string;
  productName: string;
  slug: string;
  variantId: string;
  sizeMl: number;
  priceNgn: number;
}
interface DraftLine {
  productId: string;
  variantId: string;
  quantity: number;
}

/**
 * Fetch the sellable catalog (flavour × active size, current price) the same
 * way the Products admin page does: list + per-product detail fan-out. This is
 * the REST equivalent of till/lib/sellables.ts (which reads the POS's local
 * Dexie mirror) — order-detail has no Dexie context, so it goes straight to
 * the API instead.
 */
async function loadCatalog(): Promise<CatalogEntry[]> {
  const list = await api<{ data: Array<{ id: string; name: string; slug: string; isActive?: boolean }> }>(
    "/products",
  );
  const entries: CatalogEntry[] = [];
  await Promise.all(
    list.data
      .filter((p) => p.isActive !== false)
      .map(async (p) => {
        try {
          const res = await api<{ data: { variants: CatalogVariant[] } }>(`/products/${p.id}`);
          for (const v of res.data.variants) {
            if (!v.is_active || v.current_price_ngn == null) continue;
            entries.push({
              productId: p.id,
              productName: p.name,
              slug: p.slug,
              variantId: v.id,
              sizeMl: v.size_ml,
              priceNgn: v.current_price_ngn,
            });
          }
        } catch {
          /* skip a product whose detail fetch fails — the rest of the catalog still works */
        }
      }),
  );
  entries.sort((a, b) => a.productName.localeCompare(b.productName) || a.sizeMl - b.sizeMl);
  return entries;
}

/**
 * Editable Items card for the online-order detail pages. Read-only by default
 * (matches the page's existing items table); "Edit items" swaps in quantity
 * inputs, a remove button per line, and an add-line picker (flavour + size,
 * priced from the CURRENT catalog — the server reprices every line the same
 * way). Saving PATCHes the full desired line set; a paid order whose total
 * changes is gated behind a delta-confirm + manual-reconcile note, either
 * pre-empted locally or triggered by the server's 409 reconcile_required.
 */
export function EditItemsCard({
  branchId,
  saleId,
  status,
  channel,
  items,
  subtotalNgn,
  deliveryFeeNgn,
  totalNgn,
  productsById,
  canEdit,
  onSaved,
  children,
}: EditItemsCardProps): JSX.Element {
  const legacyMissingVariant = items.some((it) => !it.variantId);
  const editable =
    canEdit && !UNEDITABLE_STATUSES.has(status) && ["online", "phone"].includes(channel) && !legacyMissingVariant;

  const [editing, setEditing] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [addKey, setAddKey] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [pendingReconcile, setPendingReconcile] = useState<
    { previousTotal: number; newTotal: number; delta: number } | null
  >(null);
  const [reconcileAck, setReconcileAck] = useState(false);
  const [reconcileNote, setReconcileNote] = useState("");
  const [reconcileBusy, setReconcileBusy] = useState(false);

  useEffect(() => {
    if (!editing || catalog || catalogLoading) return;
    setCatalogLoading(true);
    setCatalogError(null);
    void loadCatalog()
      .then(setCatalog)
      .catch((err) => setCatalogError(humanizeError(err)))
      .finally(() => setCatalogLoading(false));
  }, [editing, catalog, catalogLoading]);

  const catalogByVariant = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const e of catalog ?? []) m.set(e.variantId, e);
    return m;
  }, [catalog]);

  function startEdit(): void {
    setDraft(
      items
        .filter((it) => it.variantId)
        .map((it) => ({ productId: it.productId, variantId: it.variantId!, quantity: it.quantity })),
    );
    setAddKey("");
    setAddQty("1");
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit(): void {
    setEditing(false);
    setSaveError(null);
  }

  function setQtyFor(variantId: string, quantity: number): void {
    setDraft((d) => d.map((l) => (l.variantId === variantId ? { ...l, quantity: Math.max(1, Math.floor(quantity || 1)) } : l)));
  }

  function removeLine(variantId: string): void {
    setDraft((d) => d.filter((l) => l.variantId !== variantId));
  }

  function addLine(): void {
    if (!addKey) return;
    const entry = catalogByVariant.get(addKey);
    if (!entry) return;
    const qty = Math.max(1, Math.floor(Number(addQty) || 1));
    setDraft((d) => {
      const existing = d.find((l) => l.variantId === entry.variantId);
      if (existing) {
        return d.map((l) => (l.variantId === entry.variantId ? { ...l, quantity: l.quantity + qty } : l));
      }
      return [...d, { productId: entry.productId, variantId: entry.variantId, quantity: qty }];
    });
    setAddKey("");
    setAddQty("1");
  }

  // Every draft line priced from the current catalog — mirrors the server's
  // reprice-on-save behaviour so the preview matches what Save will produce.
  const missingFromCatalog = catalog != null && draft.some((l) => !catalogByVariant.has(l.variantId));
  const previewSubtotal = draft.reduce((sum, l) => sum + (catalogByVariant.get(l.variantId)?.priceNgn ?? 0) * l.quantity, 0);
  const previewTotal = previewSubtotal + deliveryFeeNgn;

  async function doSave(reconciled?: boolean, note?: string): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      await api(
        `/branches/${branchId}/sales/${saleId}/items`,
        {
          method: "PATCH",
          body: JSON.stringify({
            items: draft.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })),
            ...(reconciled ? { reconciled: true, reconcileNote: note } : {}),
          }),
        },
        { silentError: true },
      );
      setEditing(false);
      setPendingReconcile(null);
      setReconcileAck(false);
      setReconcileNote("");
      toast.success("Items updated.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === "reconcile_required" && err.details) {
        const previousTotal = Number(err.details.previous_total_ngn ?? totalNgn);
        const newTotal = Number(err.details.new_total_ngn ?? previewTotal);
        setPendingReconcile({ previousTotal, newTotal, delta: newTotal - previousTotal });
      } else {
        const msg = humanizeError(err);
        setSaveError(msg);
        toast.error(msg);
      }
    } finally {
      setSaving(false);
      setReconcileBusy(false);
    }
  }

  function handleSaveClick(): void {
    if (draft.length === 0) {
      setSaveError("Add at least one item.");
      return;
    }
    if (missingFromCatalog) {
      setSaveError("One or more items are no longer available — remove them to save.");
      return;
    }
    // Belt-and-suspenders: pre-empt the server's reconcile gate for a paid
    // order whose total is about to change, so the operator sees the delta
    // dialog immediately instead of after a round trip.
    if (status === "paid" && previewTotal !== totalNgn) {
      setPendingReconcile({ previousTotal: totalNgn, newTotal: previewTotal, delta: previewTotal - totalNgn });
      return;
    }
    void doSave();
  }

  function confirmReconcile(): void {
    setReconcileBusy(true);
    void doSave(true, reconcileNote.trim());
  }

  const gridStyle = {
    marginTop: 18,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    maxWidth: 320,
    marginLeft: "auto",
  } as const;

  return (
    <>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 0 8px" }}>
        <h3 style={{ fontSize: 14, fontWeight: 700 }}>Items</h3>
        {editable && !editing && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={startEdit} style={{ fontSize: 12 }}>
            ✎ Edit items
          </button>
        )}
      </header>

      {!editing ? (
        <>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Size</th>
                  <th className="table__num">Qty</th>
                  <th className="table__num">Unit</th>
                  <th className="table__num">Line</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const p = productsById[it.productId];
                  return (
                    <tr key={it.id}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                          <FlavourMedia size="chip" product={{ slug: p?.slug }} />
                          <span style={{ fontWeight: 600 }}>{p?.name ?? `${it.productId.slice(0, 8)}…`}</span>
                        </span>
                      </td>
                      <td>{it.sizeMl ? `${it.sizeMl}ml` : "—"}</td>
                      <td className="table__num">{it.quantity}</td>
                      <td className="table__num">{ngn(it.unitPriceNgn)}</td>
                      <td className="table__num" style={{ fontWeight: 700 }}>
                        {ngn(it.lineTotalNgn)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={gridStyle}>
            <span style={{ color: "var(--ink-soft)" }}>Subtotal</span>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{ngn(subtotalNgn)}</span>
            <span style={{ color: "var(--ink-soft)" }}>Delivery</span>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{ngn(deliveryFeeNgn)}</span>
            <span style={{ fontWeight: 700 }}>Total</span>
            <span className="tabular-nums" style={{ textAlign: "right", fontWeight: 800, fontSize: 18 }}>
              {ngn(totalNgn)}
            </span>
            {children}
          </div>
        </>
      ) : (
        <div>
          {catalogLoading && !catalog && (
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading current prices…</p>
          )}
          {catalogError && <p style={{ fontSize: 13, color: "var(--danger)" }}>{catalogError}</p>}

          {catalog && (
            <>
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Size</th>
                      <th className="table__num">Qty</th>
                      <th className="table__num">Unit</th>
                      <th className="table__num">Line</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.map((l) => {
                      const entry = catalogByVariant.get(l.variantId);
                      const p = productsById[l.productId];
                      return (
                        <tr key={l.variantId}>
                          <td>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                              <FlavourMedia size="chip" product={{ slug: entry?.slug ?? p?.slug }} />
                              <span style={{ fontWeight: 600 }}>{entry?.productName ?? p?.name ?? "Item"}</span>
                            </span>
                          </td>
                          <td>{entry ? `${entry.sizeMl}ml` : "—"}</td>
                          <td className="table__num">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              value={l.quantity}
                              onChange={(e) => setQtyFor(l.variantId, Number(e.target.value))}
                              aria-label="Quantity"
                              style={{ width: 64, textAlign: "right" }}
                            />
                          </td>
                          <td className="table__num">{entry ? ngn(entry.priceNgn) : "unavailable"}</td>
                          <td className="table__num" style={{ fontWeight: 700 }}>
                            {entry ? ngn(entry.priceNgn * l.quantity) : "—"}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => removeLine(l.variantId)}
                              aria-label="Remove line"
                              style={{ color: "var(--danger)" }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                <select
                  className="input"
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                >
                  <option value="">Add a flavour + size…</option>
                  {catalog.map((c) => (
                    <option key={c.variantId} value={c.variantId}>
                      {c.productName} — {c.sizeMl}ml — {ngn(c.priceNgn)}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  aria-label="Add quantity"
                  style={{ width: 64, textAlign: "right" }}
                  className="input"
                />
                <button type="button" className="btn btn--subtle btn--sm" disabled={!addKey} onClick={addLine}>
                  + Add
                </button>
              </div>

              <div style={gridStyle}>
                <span style={{ color: "var(--ink-soft)" }}>Subtotal</span>
                <span className="tabular-nums" style={{ textAlign: "right" }}>{ngn(previewSubtotal)}</span>
                <span style={{ color: "var(--ink-soft)" }}>Delivery</span>
                <span className="tabular-nums" style={{ textAlign: "right" }}>{ngn(deliveryFeeNgn)}</span>
                <span style={{ fontWeight: 700 }}>Total (preview)</span>
                <span className="tabular-nums" style={{ textAlign: "right", fontWeight: 800, fontSize: 18 }}>
                  {ngn(previewTotal)}
                </span>
              </div>

              {saveError && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{saveError}</p>}

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={saving || draft.length === 0 || missingFromCatalog}
                  onClick={handleSaveClick}
                >
                  {saving ? "Saving…" : "Save items"}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {pendingReconcile && (
        <ConfirmModal
          title="Confirm amount before saving"
          confirmLabel="Save & confirm"
          busyLabel="Saving…"
          busy={reconcileBusy}
          confirmDisabled={!reconcileAck || reconcileNote.trim() === ""}
          onCancel={() => {
            setPendingReconcile(null);
            setReconcileAck(false);
            setReconcileNote("");
          }}
          onConfirm={confirmReconcile}
        >
          <p style={{ fontSize: 14, marginBottom: 12 }}>
            This order was already paid <strong>{ngn(pendingReconcile.previousTotal)}</strong>. The edited items
            total <strong>{ngn(pendingReconcile.newTotal)}</strong> —{" "}
            {pendingReconcile.delta > 0 ? (
              <>the customer now owes an extra <strong>{ngn(pendingReconcile.delta)}</strong>.</>
            ) : (
              <>the customer is owed back <strong>{ngn(Math.abs(pendingReconcile.delta))}</strong>.</>
            )}{" "}
            Saving does <strong>not</strong> move any money automatically.
          </p>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={reconcileAck}
              onChange={(e) => setReconcileAck(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>I have collected / refunded this amount manually.</span>
          </label>
          <textarea
            className="input"
            rows={3}
            placeholder="Note — how the difference was settled (e.g. collected ₦500 by transfer)"
            value={reconcileNote}
            onChange={(e) => setReconcileNote(e.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 14 }}
          />
        </ConfirmModal>
      )}
    </>
  );
}
