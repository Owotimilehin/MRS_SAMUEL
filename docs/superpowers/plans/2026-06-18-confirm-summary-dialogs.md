# Confirmation Summary Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a read-only summary confirm dialog before a transfer is sent and before a production run is completed.

**Architecture:** A reusable `ConfirmModal` component wraps the existing accessible `Modal`, adding a scrollable summary body and a pinned Cancel/Confirm footer. The two flows render flow-specific summary content as children and pass their existing action functions to `onConfirm`. No API, schema, routing, or validation changes.

**Tech Stack:** React 18, TypeScript, TanStack Router, Vitest + @testing-library/react (jsdom), existing CSS utility classes (`btn`, `card`, `--line`, etc.).

## Global Constraints

- Admin app only (`apps/admin`). No changes to api/worker/packages.
- TypeScript strict — all functions keep explicit return types as in surrounding code.
- Import sibling modules with the `.js` extension (project convention, e.g. `./Modal.js`).
- Reuse existing CSS classes; no new global CSS. Colours via CSS vars (`var(--line)`, etc.).
- Quality gates that must stay green: `pnpm --filter @ms/admin typecheck`, `pnpm --filter @ms/admin lint`, `pnpm --filter @ms/admin test`.

---

### Task 1: `ConfirmModal` component (test-first)

**Files:**
- Create: `apps/admin/src/components/ConfirmModal.tsx`
- Test: `apps/admin/src/components/ConfirmModal.test.tsx`

**Interfaces:**
- Consumes: `Modal` from `./Modal.js` (props `title`, `onClose`, `children`, `maxWidth`).
- Produces:
  ```ts
  interface ConfirmModalProps {
    title: string;
    children: React.ReactNode;
    confirmLabel: string;
    busyLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;             // default false
    tone?: "primary" | "danger"; // default "primary"
    maxWidth?: number;           // default 560
  }
  export function ConfirmModal(props: ConfirmModalProps): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/components/ConfirmModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmModal } from "./ConfirmModal.js";

describe("ConfirmModal", () => {
  it("renders title, summary children, and confirm label", () => {
    render(
      <ConfirmModal
        title="Send transfer"
        confirmLabel="Send transfer"
        busyLabel="Sending…"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        <div>Summary body</div>
      </ConfirmModal>,
    );
    expect(screen.getByRole("heading", { name: "Send transfer" })).toBeInTheDocument();
    expect(screen.getByText("Summary body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send transfer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("fires onConfirm and onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        title="t" confirmLabel="Go" busyLabel="…"
        onConfirm={onConfirm} onCancel={onCancel}
      >
        <div>x</div>
      </ConfirmModal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows busyLabel and disables both buttons when busy", () => {
    render(
      <ConfirmModal
        title="t" confirmLabel="Go" busyLabel="Working…" busy
        onConfirm={() => {}} onCancel={() => {}}
      >
        <div>x</div>
      </ConfirmModal>,
    );
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test -- ConfirmModal`
Expected: FAIL — cannot resolve `./ConfirmModal.js` / `ConfirmModal is not defined`.

- [ ] **Step 3: Write the component**

Create `apps/admin/src/components/ConfirmModal.tsx`:

```tsx
import type { ReactNode } from "react";
import { Modal } from "./Modal.js";

interface ConfirmModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  tone?: "primary" | "danger";
  maxWidth?: number;
}

/**
 * A confirm dialog built on the shared Modal: a scrollable summary body with a
 * pinned Cancel/Confirm footer. The footer never scrolls out of view, so long
 * summaries stay confirmable on small screens; Modal itself caps the card to the
 * viewport so it never overflows on large ones.
 */
export function ConfirmModal({
  title,
  children,
  confirmLabel,
  busyLabel,
  onConfirm,
  onCancel,
  busy = false,
  tone = "primary",
  maxWidth = 560,
}: ConfirmModalProps): JSX.Element {
  return (
    <Modal title={title} onClose={onCancel} maxWidth={maxWidth}>
      <div style={{ maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>{children}</div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 14,
          paddingTop: 14,
          borderTop: "1px solid var(--line)",
        }}
      >
        <button type="button" className="btn btn--subtle" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={tone === "danger" ? "btn btn--danger" : "btn btn--primary"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test -- ConfirmModal`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/ConfirmModal.tsx apps/admin/src/components/ConfirmModal.test.tsx
git commit -m "feat(admin): reusable ConfirmModal with scrollable body + pinned footer"
```

---

### Task 2: Confirm dialog before sending a transfer

**Files:**
- Modify: `apps/admin/src/routes/transfers.tsx` (the `CreateTransferModal` component, ~lines 252-648)

**Interfaces:**
- Consumes: `ConfirmModal` from Task 1; existing `availableFor`, `sizeLabel`, props `factories`, `branches`, `products`, `bags`, and state `factoryId`, `branchId`, `vehicle`, `driver`, `items`, `submitting`, `error`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

At the top of `apps/admin/src/routes/transfers.tsx`, after the existing component imports (e.g. after the `InlineLoader` import on line 7), add:

```tsx
import { ConfirmModal } from "../components/ConfirmModal.js";
```

- [ ] **Step 2: Add confirm state**

Inside `CreateTransferModal`, next to the other `useState` calls (after `const [stockLoading, setStockLoading] = useState(false);`), add:

```tsx
  const [showConfirm, setShowConfirm] = useState(false);
```

- [ ] **Step 3: Split `submit` into validate-then-review and `doSubmit`**

Replace the entire existing `async function submit(e: FormEvent): Promise<void> { ... }` (lines ~347-389) with the following two functions. `submit` now validates and opens the review; `doSubmit` performs the original POST:

```tsx
  function submit(e: FormEvent): void {
    e.preventDefault();
    if (items.length === 0 || !factoryId || !branchId) return;
    const overSent = items.find(
      (it) => it.kind === "product" && it.quantity_sent > availableFor(it.product_id, it.variant_id),
    );
    if (overSent) {
      const pName = products.find((p) => p.id === overSent.product_id)?.name ?? "flavour";
      setError(`Only ${availableFor(overSent.product_id, overSent.variant_id)} of ${pName} in stock at this factory.`);
      return;
    }
    setError(null);
    setShowConfirm(true);
  }

  async function doSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/transfers`, {
        method: "POST",
        body: JSON.stringify({
          factory_id: factoryId,
          branch_id: branchId,
          vehicle_info: vehicle || undefined,
          driver_name: driver || undefined,
          items: items.map((it) =>
            it.kind === "bag"
              ? {
                  packaging_material_id: it.packaging_material_id,
                  quantity_sent: Number(it.quantity_sent),
                  unit_cost_ngn: it.unit_cost_ngn ? Number(it.unit_cost_ngn) : undefined,
                }
              : {
                  product_id: it.product_id,
                  variant_id: it.variant_id || undefined,
                  quantity_sent: Number(it.quantity_sent),
                  unit_cost_ngn: it.unit_cost_ngn ? Number(it.unit_cost_ngn) : undefined,
                },
          ),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
      setShowConfirm(false);
    }
  }
```

- [ ] **Step 4: Render the confirm dialog**

Immediately before the final closing `</div>` of the create-modal card — i.e. right after the closing `</form>` tag (line ~645) and before the two `</div>` that close the card and backdrop — insert:

```tsx
        {showConfirm && (
          <ConfirmModal
            title="Confirm transfer"
            confirmLabel="Send transfer"
            busyLabel="Sending…"
            busy={submitting}
            onCancel={() => setShowConfirm(false)}
            onConfirm={() => void doSubmit()}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                {factories.find((f) => f.id === factoryId)?.name ?? "Factory"}
                <span style={{ color: "var(--ink-soft)" }}> → </span>
                {branches.find((b) => b.id === branchId)?.name ?? "Branch"}
              </div>
              {(vehicle || driver) && (
                <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                  {vehicle && <span>Vehicle: {vehicle}</span>}
                  {vehicle && driver && <span> · </span>}
                  {driver && <span>Driver: {driver}</span>}
                </div>
              )}
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="table__num">Quantity</th>
                      <th className="table__num">Unit cost (₦)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx}>
                        <td>
                          {it.kind === "bag"
                            ? `🛍 ${bags.find((b) => b.id === it.packaging_material_id)?.name ?? "Bag"}`
                            : `${products.find((p) => p.id === it.product_id)?.name ?? "Flavour"} · ${sizeLabel(
                                stock.find((s) => s.variant_id === it.variant_id)?.size_ml ?? null,
                              )}`}
                        </td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {Number(it.quantity_sent).toLocaleString()}
                        </td>
                        <td className="table__num">{it.unit_cost_ngn ? Number(it.unit_cost_ngn).toLocaleString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                <span>{items.reduce((sum, it) => sum + Number(it.quantity_sent), 0).toLocaleString()} total</span>
              </div>
            </div>
          </ConfirmModal>
        )}
```

Note: `submit` is now synchronous (returns `void`). The form's `onSubmit={submit}` already accepts this; no change needed at the `<form>` tag. The submit button keeps its existing label/disabled logic.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean. (If lint flags `submit` no longer needing `async`, it has already been removed above.)

- [ ] **Step 6: Manual smoke (dev server)**

Run `pnpm --filter @ms/admin dev`, open Transfers → **+ Send transfer**, add a product line and a bag, click **Send transfer**. Expected: confirm dialog lists factory→branch, both lines, and correct totals; **Cancel** returns to the form with data intact; **Confirm** posts and closes both dialogs. Resize the window narrow with many lines — the item table scrolls inside the dialog while Cancel/Confirm stay visible.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/transfers.tsx
git commit -m "feat(admin): summary confirm dialog before sending a transfer"
```

---

### Task 3: Confirm dialog before completing a production run

**Files:**
- Modify: `apps/admin/src/routes/factory/run-detail.tsx`

**Interfaces:**
- Consumes: `ConfirmModal` from Task 1; existing `complete()`, `acting`, `run`, `totalBottles`, `factoryName`, `productName`, `sizeLabel`, `formatDate`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

At the top of `apps/admin/src/routes/factory/run-detail.tsx`, after the `toast` import (line 9), add:

```tsx
import { ConfirmModal } from "../../components/ConfirmModal.js";
```

- [ ] **Step 2: Add confirm state**

Inside `RunDetailPage`, after `const [acting, setActing] = useState(false);` (line 49), add:

```tsx
  const [showConfirm, setShowConfirm] = useState(false);
```

- [ ] **Step 3: Point the Complete button at the dialog**

Change the existing complete button's handler (line ~162) from:

```tsx
                  onClick={() => void complete()}
```

to:

```tsx
                  onClick={() => setShowConfirm(true)}
```

Leave `complete()` and the `acting` disabled/label logic unchanged.

- [ ] **Step 4: Render the confirm dialog**

Inside the `{loading || !run ? (...) : ( <> ... </> )}` block, immediately before the closing `</>` (after the closing `</section>` of the Items card, line ~202), insert:

```tsx
          {showConfirm && (
            <ConfirmModal
              title="Complete production run"
              confirmLabel="Complete run"
              busyLabel="Completing…"
              busy={acting}
              onCancel={() => setShowConfirm(false)}
              onConfirm={async () => {
                await complete();
                setShowConfirm(false);
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {factoryName(run.factoryId)} · {formatDate(run.runDate)}
                </div>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Size</th>
                        <th className="table__num">Quantity</th>
                        <th>Batch code</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.items.map((it) => (
                        <tr key={it.id}>
                          <td>{productName(it.productId)}</td>
                          <td style={{ color: "var(--ink-soft)" }}>{sizeLabel(it.sizeMl)}</td>
                          <td className="table__num" style={{ fontWeight: 700 }}>
                            {it.quantityProduced.toLocaleString()}
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: 13 }}>{it.batchCode ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                  <span>{run.items.length} line{run.items.length === 1 ? "" : "s"}</span>
                  <span>{totalBottles.toLocaleString()} bottles</span>
                </div>
                <div style={{ color: "var(--danger)", fontSize: 13 }}>
                  Completing posts these bottles to the factory ledger and can't be undone.
                </div>
              </div>
            </ConfirmModal>
          )}
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 6: Manual smoke (dev server)**

Open a draft run's detail page, click **Complete run · post to ledger**. Expected: dialog shows factory · date, the items, total bottles, and the irreversible warning; **Cancel** closes with no change; **Confirm** completes the run (toast fires, status flips to Completed, dialog and button disappear). Narrow viewport with many items — items scroll inside the dialog, footer stays pinned.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/factory/run-detail.tsx
git commit -m "feat(admin): summary confirm dialog before completing a production run"
```

---

## Self-Review Notes

- **Spec coverage:** ConfirmModal (Task 1) ✓; transfer flow with validation preserved + summary + totals (Task 2) ✓; run flow with totals + irreversible warning (Task 3) ✓; scrollable body + pinned footer baked into ConfirmModal (Task 1) ✓; error handling unchanged (transfer `error` state, run `toast`) ✓.
- **Stacking:** transfer ConfirmModal is mounted after the create form within the same `zIndex:50` backdrop and rendered later in the tree, so it paints above the create modal — matches spec.
- **Type consistency:** `ConfirmModalProps` names used identically in Tasks 2/3; `sizeLabel` in transfers takes `number | null` and is fed `size_ml ?? null`; run uses its own `sizeLabel(it.sizeMl)`.
