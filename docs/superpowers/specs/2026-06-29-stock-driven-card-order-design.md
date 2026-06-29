# 650ml stock-driven card ordering — design

**Date:** 2026-06-29
**Status:** Approved

## Problem

Product cards on the storefront always render in a fixed catalog order regardless
of stock. The owner wants bottles that are actually buyable now — specifically
those with **650ml in stock** — to surface first, so customers see what they can
get immediately at the top of every grid.

## Decisions (locked)

- **Behaviour:** Reorder only. Nothing is hidden, dimmed, or badged. All cards
  still render.
- **Sort key:** three tiers by best available stock —
  (2) 650ml in stock, (1) 650ml out but 330ml in stock, (0) nothing in stock.
- **Tiebreak:** Keep original order within each tier (stable).
- **No-650ml-variant products:** ranked by their 330ml stock — a 330ml-in-stock
  bottle (even with no 650ml variant) outranks a zero-stock 650ml bottle, but
  still sits below any 650ml-in-stock bottle.
- **Scope:** Home best-sellers + specials grids, `/juices` full listing, and the
  "You might also like" related strip on the juice detail page.

## Design

### 1. Shared pure helper

Add to `apps/customer/src/lib/stock-summary.ts` (existing home of stock-derivation
logic):

```ts
/** Stable three-tier sort, original order preserved within each tier:
 *   2 — 650ml in stock; 1 — 650ml out but 330ml in stock; 0 — nothing in stock.
 *  Returns a new array; the input is not mutated. */
export function sortByStock650(products: Product[]): Product[] {
  const rank = (p: Product): number => {
    if ((p.availableBySize["650ml"] ?? 0) > 0) return 2;
    if ((p.availableBySize["330ml"] ?? 0) > 0) return 1;
    return 0;
  };
  return [
    ...products.filter((p) => rank(p) === 2),
    ...products.filter((p) => rank(p) === 1),
    ...products.filter((p) => rank(p) === 0),
  ];
}
```

- Pure; does not mutate the input (safe with loader data and React state).
- Missing size key → `availableBySize[size]` is `undefined` → `?? 0`, so a
  product with no 650ml variant is ranked purely on its 330ml stock.

### 2. Call sites — sort BEFORE any slice

Ordering must run before `.slice()`, otherwise an in-stock bottle outside the
first N never surfaces.

- **`routes/index.tsx`** — apply to `classics` and `specials`. Critically, sort
  classics **before** the existing `.slice(0, 8)`.
- **`routes/juices.index.tsx`** — apply to the filtered `list` (after the
  category/ingredient filters, before render).
- **`routes/juices.$id.tsx`** — apply to `related` **before** `.slice(0, 3)`.

### 3. Testing

Unit test for `sortByStock650` alongside the existing node-runner tests
(e.g. `StockBanner.test.ts` style):

- 650ml-in-stock products surface above everything
- a 330ml-in-stock product (incl. no-650ml-variant) ranks above a zero-stock 650ml
- a fully out-of-stock product sinks to the bottom
- original order preserved within each tier
- empty input and single-element input handled

## Out of scope / unchanged

Card visuals, per-size stock lines, "Special" badge, ingredient/category filters,
the StockBanner, and the catalog API. This change is purely ordering.
