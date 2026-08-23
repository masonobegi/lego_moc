/**
 * What to buy DIFFERENTLY.
 *
 * The original and optimized Wanted Lists are both complete inventories. If you
 * have already ordered the model, or you only want to see what actually moved,
 * comparing two 300-line lists by eye is not a reasonable thing to ask of
 * anybody. This produces the difference between them.
 *
 * Why it is computed by re-counting, not from the change list
 * -----------------------------------------------------------
 * The obvious implementation - walk the enabled candidates and emit
 * "12x Red becomes 12x Black" - is wrong, and wrong in a way that looks right.
 *
 * A candidate is a change to one LDraw LINE. Lots are aggregates of many lines.
 * When twelve hidden red 2x4 bricks become black and the model already contained
 * four black 2x4 bricks, the truth is:
 *
 *     3001 / Red     12  ->   0    (-12)
 *     3001 / Black    4  ->  16    (+12)
 *
 * There is no "12 red became 12 black" lot anywhere in the resulting order. The
 * user buys sixteen black bricks in one lot, not twelve in one and four in
 * another, and if two different candidates both target black the naive version
 * emits two overlapping rows that double-count.
 *
 * So the delta is the difference between two INVENTORIES, counted the same way
 * the Wanted Lists count them. That makes it correct by construction for
 * merges, splits, partial enablement, mold swaps that change the part id, and
 * lots that fall to zero.
 */

import { colorName } from '../ldraw/colors';
import type { PartInstance } from '../ldraw/types';
import type { PriceBook } from '../pricing/priceEngine';
import type { Condition } from '../pricing/types';

export type DeltaAction =
  | 'buy_more'
  | 'buy_new'
  | 'buy_fewer'
  | 'no_longer_needed';

export const DELTA_ACTION_LABELS: Record<DeltaAction, string> = {
  buy_new: 'Buy - not in the original list',
  buy_more: 'Buy more',
  buy_fewer: 'Buy fewer',
  no_longer_needed: 'No longer needed',
};

export interface InventoryDeltaLot {
  readonly partId: string;
  readonly partDescription: string;
  readonly colorId: number;
  readonly colorName: string;
  readonly originalQuantity: number;
  readonly optimizedQuantity: number;
  /** optimized minus original. Never zero: unchanged lots are not included. */
  readonly difference: number;
  readonly action: DeltaAction;
  readonly unitPrice: number | null;
  readonly originalLineTotal: number | null;
  readonly optimizedLineTotal: number | null;
  /**
   * optimized line total minus original line total. NEGATIVE means this lot got
   * cheaper. Null when the part has no price estimate.
   */
  readonly costDifference: number | null;
}

export interface InventoryDelta {
  /** Only lots whose quantity changed, biggest cost effect first. */
  readonly lots: readonly InventoryDeltaLot[];
  readonly piecesAdded: number;
  readonly piecesRemoved: number;
  /**
   * True when pieces added equals pieces removed.
   *
   * A recolor or a mold swap changes WHICH bricks you buy, never HOW MANY. If
   * this is ever false, the optimizer has added or lost pieces, which would be a
   * serious bug - so it is computed and surfaced rather than assumed.
   */
  readonly pieceCountConserved: boolean;
  /** Total pieces in the model, unchanged by definition. */
  readonly totalPieces: number;
  readonly lotsAdded: number;
  readonly lotsRemoved: number;
  readonly lotsChanged: number;
  /**
   * Net estimated part-cost change across the whole delta: negative means the
   * optimized order is cheaper. This is the SAME figure as the headline saving
   * (with the sign flipped), not a separate one - the removed lots and the added
   * lots are both in it.
   */
  readonly estimatedCostDifference: number;
  /** Lots in the delta with no price estimate, so not in the figure above. */
  readonly unpricedLotCount: number;
  readonly currency: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function countLots(instances: readonly PartInstance[]): Map<string, { partId: string; colorId: number; quantity: number }> {
  const counts = new Map<string, { partId: string; colorId: number; quantity: number }>();
  for (const instance of instances) {
    const key = `${instance.partId}|${instance.colorId}`;
    const existing = counts.get(key);
    if (existing) existing.quantity++;
    else counts.set(key, { partId: instance.partId, colorId: instance.colorId, quantity: 1 });
  }
  return counts;
}

export interface InventoryDeltaInput {
  readonly originalInstances: readonly PartInstance[];
  readonly optimizedInstances: readonly PartInstance[];
  readonly prices: PriceBook;
  readonly condition: Condition;
  readonly currency: string;
  /** partId -> human description, where known. Falls back to the part id. */
  readonly descriptions?: ReadonlyMap<string, string>;
}

export function buildInventoryDelta(input: InventoryDeltaInput): InventoryDelta {
  const original = countLots(input.originalInstances);
  const optimized = countLots(input.optimizedInstances);

  const keys = new Set([...original.keys(), ...optimized.keys()]);
  const lots: InventoryDeltaLot[] = [];

  let piecesAdded = 0;
  let piecesRemoved = 0;
  let estimatedCostDifference = 0;
  let unpricedLotCount = 0;

  for (const key of keys) {
    const before = original.get(key);
    const after = optimized.get(key);
    const originalQuantity = before?.quantity ?? 0;
    const optimizedQuantity = after?.quantity ?? 0;
    const difference = optimizedQuantity - originalQuantity;
    if (difference === 0) continue;

    const partId = (before ?? after)!.partId;
    const colorId = (before ?? after)!.colorId;

    if (difference > 0) piecesAdded += difference;
    else piecesRemoved += -difference;

    const quote = input.prices.get(partId, colorId, input.condition);
    const unitPrice = quote?.unitPrice ?? null;
    const originalLineTotal = unitPrice === null ? null : round2(unitPrice * originalQuantity);
    const optimizedLineTotal = unitPrice === null ? null : round2(unitPrice * optimizedQuantity);
    const costDifference =
      originalLineTotal === null || optimizedLineTotal === null
        ? null
        : round2(optimizedLineTotal - originalLineTotal);

    if (costDifference === null) unpricedLotCount++;
    else estimatedCostDifference += costDifference;

    const action: DeltaAction =
      difference > 0
        ? originalQuantity === 0
          ? 'buy_new'
          : 'buy_more'
        : optimizedQuantity === 0
          ? 'no_longer_needed'
          : 'buy_fewer';

    lots.push({
      partId,
      partDescription: input.descriptions?.get(partId) ?? partId,
      colorId,
      colorName: colorName(colorId),
      originalQuantity,
      optimizedQuantity,
      difference,
      action,
      unitPrice,
      originalLineTotal,
      optimizedLineTotal,
      costDifference,
    });
  }

  // Biggest money first, then biggest quantity change, then a stable tiebreak.
  lots.sort(
    (a, b) =>
      (a.costDifference ?? 0) - (b.costDifference ?? 0) ||
      Math.abs(b.difference) - Math.abs(a.difference) ||
      a.partId.localeCompare(b.partId) ||
      a.colorId - b.colorId,
  );

  return {
    lots,
    piecesAdded,
    piecesRemoved,
    pieceCountConserved: piecesAdded === piecesRemoved,
    totalPieces: input.originalInstances.length,
    lotsAdded: lots.filter((l) => l.action === 'buy_new').length,
    lotsRemoved: lots.filter((l) => l.action === 'no_longer_needed').length,
    lotsChanged: lots.length,
    estimatedCostDifference: round2(estimatedCostDifference),
    unpricedLotCount,
    currency: input.currency,
  };
}
