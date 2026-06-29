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
- **Sort key:** 650ml stock only. `availableBySize["650ml"] > 0` decides the
  bucket. 330ml stock is irrelevant to ordering.
- **Tiebreak:** Keep original order within each bucket (stable two-bucket split).
- **No-650ml-variant products:** treated as out-of-stock for ordering (sink to
  the bottom bucket), consistent with "650ml stock only".
- **Scope:** Home best-sellers + specials grids, `/juices` full listing, and the
  "You might also like" related strip on the juice detail page.

## Design

### 1. Shared pure helper

Add to `apps/customer/src/lib/stock-summary.ts` (existing home of stock-derivation
logic):

```ts
/** Stable two-bucket sort: products with 650ml in stock first (original order
 *  preserved), then the rest (original order preserved). Returns a new array. */
export function sortByStock650(products: Product[]): Product[] {
  const inStock: Product[] = [];
  const rest: Product[] = [];
  for (const p of products) {
    ((p.availableBySize["650ml"] ?? 0) > 0 ? inStock : rest).push(p);
  }
  return [...inStock, ...rest];
}
```

- Pure; does not mutate the input (safe with loader data and React state).
- Missing 650ml variant → `availableBySize["650ml"]` is `undefined` → `?? 0` →
  bottom bucket.

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

- in-stock-650 products surface above out-of-stock ones
- original order preserved within each bucket
- product with no 650ml variant sinks to the bottom
- empty input and single-element input handled

## Out of scope / unchanged

Card visuals, per-size stock lines, "Special" badge, ingredient/category filters,
the StockBanner, and the catalog API. This change is purely ordering.
