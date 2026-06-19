/**
 * FIFO costing for packaging consumed by sales. Pure, costing-only — it never
 * touches the physical stock ledger. Layers are purchase lots (oldest first);
 * `priorUnits` is how many units were already consumed before the target day
 * (the queue offset); `dayUnits` is consumed on the day being costed. Units
 * beyond all layer capacity are costed at `fallbackUnitCostNgn` (the most
 * recent purchase price), matching the owner's "pick up the last recorded unit
 * price once stock runs out" rule.
 */
export interface CostLayer {
  quantity: number;
  unitCostNgn: number;
}

export interface FifoResult {
  costNgn: number;
  unitsFromLayers: number;
  unitsFallback: number;
}

export function allocateFifo(
  layers: readonly CostLayer[],
  priorUnits: number,
  dayUnits: number,
  fallbackUnitCostNgn: number,
): FifoResult {
  let skip = Math.max(0, priorUnits);
  let remaining = Math.max(0, dayUnits);
  let costNgn = 0;
  let unitsFromLayers = 0;

  for (const layer of layers) {
    if (remaining === 0) break;
    let avail = layer.quantity;
    // Burn down the prior-consumed offset against this layer first.
    if (skip > 0) {
      const burned = Math.min(skip, avail);
      skip -= burned;
      avail -= burned;
    }
    if (avail === 0) continue;
    const take = Math.min(avail, remaining);
    costNgn += take * layer.unitCostNgn;
    unitsFromLayers += take;
    remaining -= take;
  }

  const unitsFallback = remaining;
  costNgn += unitsFallback * fallbackUnitCostNgn;
  return { costNgn, unitsFromLayers, unitsFallback };
}
