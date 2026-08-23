/**
 * Marketplace availability and the practicality pass.
 *
 * The question these tests protect: a substitution that is cheaper per piece is
 * not automatically worth making. If the replacement color exists in four lots
 * worldwide and the build needs sixty pieces, the saving is fictional - the
 * order gains a seller, a shipping charge and probably a minimum-order top-up.
 */

import { describe, expect, it } from 'vitest';

import {
  assessAvailability,
  availabilityAllowsChange,
  availabilityRank,
  shippingRisk,
} from '@/lib/pricing/availability';
import { applyPracticality, DEFAULT_PRACTICALITY } from '@/lib/optimizer/practicality';
import type { ProposedChange } from '@/lib/optimizer/types';
import type { PriceQuote } from '@/lib/pricing/types';

function quote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    partId: '3001',
    colorId: 0,
    condition: 'new',
    unitPrice: 0.2,
    currency: 'USD',
    source: 'bricklink',
    sourceDetail: 'BrickLink Price Guide (current items for sale, new)',
    timestamp: '2026-01-01T00:00:00.000Z',
    average: 0.22,
    quantityAverage: 0.2,
    minPrice: 0.1,
    maxPrice: 0.9,
    lotCount: 300,
    totalQuantity: 20_000,
    supplyIsLocationFiltered: true,
    supplyReflectsSoldHistory: false,
    isEstimate: true,
    notes: [],
    ...overrides,
  };
}

describe('availability classification', () => {
  it('calls a part in hundreds of lots very highly available', () => {
    const a = assessAvailability(quote({ lotCount: 400, totalQuantity: 30_000 }), 20);
    expect(a.level).toBe('VERY_HIGH');
    expect(a.sufficientForQuantity).toBe(true);
  });

  it('calls a part in four lots very poorly available', () => {
    const a = assessAvailability(quote({ lotCount: 4, totalQuantity: 9 }), 20);
    expect(a.level).toBe('VERY_LOW');
    expect(a.flags).toContain('few_lots');
    expect(a.flags).toContain('below_required_quantity');
  });

  it('judges supply against the quantity the build actually needs', () => {
    // The same listing is comfortable for a handful and thin for a bagful.
    const listing = quote({ lotCount: 80, totalQuantity: 1_200 });
    expect(assessAvailability(listing, 10).level).toBe('HIGH');
    expect(assessAvailability(listing, 10).sufficientForQuantity).toBe(true);

    const forABigBuild = assessAvailability(listing, 900);
    expect(forABigBuild.sufficientForQuantity).toBe(false);
    // Never described as comfortable when it cannot cover the order.
    expect(availabilityRank(forABigBuild.level)).toBeLessThanOrEqual(availabilityRank('LOW'));
  });

  it('never reads sold history as stock on hand', () => {
    const a = assessAvailability(
      quote({ lotCount: 500, totalQuantity: 40_000, supplyReflectsSoldHistory: true }),
      10,
    );
    expect(a.level).toBe('UNKNOWN');
    expect(a.flags).toContain('sold_history_not_stock');
    expect(a.summary).toMatch(/CHANGED HANDS/);
    expect(a.summary).toMatch(/not stock on hand/);
  });

  it('says so when the counts are worldwide rather than local', () => {
    const a = assessAvailability(quote({ supplyIsLocationFiltered: false }), 10);
    expect(a.flags).toContain('worldwide_not_local');
    expect(a.summary).toMatch(/worldwide/);
  });

  it('reports unknown rather than guessing when there is no supply data', () => {
    // This is demo mode. Inventing lot counts would make a fabricated
    // assessment look researched.
    const a = assessAvailability(quote({ source: 'demo', lotCount: null, totalQuantity: null }), 10);
    expect(a.level).toBe('UNKNOWN');
    expect(a.flags).toContain('no_supply_data');
    expect(a.summary).toMatch(/Demo data does not model/);
  });

  it('flags a price shape that one cheap lot could be dominating', () => {
    const a = assessAvailability(
      // Twelve lots, and the cheapest is a quarter of the average.
      quote({ lotCount: 12, totalQuantity: 300, minPrice: 0.05, average: 0.4 }),
      10,
    );
    expect(a.flags).toContain('single_cheap_lot_risk');
  });
});

describe('shipping risk', () => {
  const common = assessAvailability(quote({ lotCount: 400, totalQuantity: 30_000 }), 10);

  it('is low when swapping one widely stocked color for another', () => {
    expect(shippingRisk(common, common)).toBe('LOW');
  });

  it('is high when the replacement is barely stocked', () => {
    const scarce = assessAvailability(quote({ lotCount: 3, totalQuantity: 8 }), 10);
    expect(shippingRisk(common, scarce)).toBe('HIGH');
  });

  it('is unknown when the replacement has no supply data', () => {
    const unknown = assessAvailability(quote({ lotCount: null, totalQuantity: null }), 10);
    expect(shippingRisk(common, unknown)).toBe('UNKNOWN');
  });

  it('flags a big drop in availability even between good levels', () => {
    const moderate = assessAvailability(quote({ lotCount: 25, totalQuantity: 400 }), 10);
    expect(shippingRisk(common, moderate)).toBe('MODERATE');
  });
});

describe('whether availability permits a change at all', () => {
  it('rejects a scarce replacement for a small saving', () => {
    const scarce = assessAvailability(quote({ lotCount: 2, totalQuantity: 5 }), 10);
    expect(availabilityAllowsChange(scarce, 0.4).allowed).toBe(false);
  });

  it('permits a scarce replacement when the saving is large enough to absorb a shipping charge', () => {
    const scarce = assessAvailability(quote({ lotCount: 2, totalQuantity: 5 }), 10);
    expect(availabilityAllowsChange(scarce, 40).allowed).toBe(true);
  });

  it('permits a change when supply is simply unknown', () => {
    // Unknown supply is not evidence of poor supply, and refusing every change
    // in demo mode would make the app useless offline. The UI marks it instead.
    const unknown = assessAvailability(quote({ lotCount: null, totalQuantity: null }), 10);
    expect(availabilityAllowsChange(unknown, 0.4).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    id: 'color:test',
    kind: 'hidden_color',
    commandRef: { fileIndex: 0, commandIndex: 1 },
    quantity: 30,
    instanceIds: ['0.1'],
    parentModel: 'main.ldr',
    stepIndex: 0,
    partId: '3001',
    partDescription: 'Brick 2 x 4',
    originalPartId: '3001',
    originalColorId: 4,
    originalColorName: 'Red',
    replacementPartId: '3001',
    replacementColorId: 0,
    replacementColorName: 'Black',
    originalUnitPrice: 0.51,
    replacementUnitPrice: 0.18,
    originalTotal: 15.3,
    replacementTotal: 5.4,
    savings: 9.9,
    reason: 'Completely hidden inside the completed model',
    confidence: 0.999,
    visibility: {
      classification: 'HIDDEN',
      confidence: 0.999,
      totalRays: 400_000,
      trianglesCovered: 100,
      trianglesTotal: 100,
      evidence: 'no escape',
    },
    evidence: [],
    moldRule: null,
    alternatives: [],
    conflictsWith: [],
    enabledByDefault: true,
    originalQuote: quote({ colorId: 4, unitPrice: 0.51 }),
    replacementQuote: quote({ colorId: 0, unitPrice: 0.18 }),
    ...overrides,
  };
}

describe('the practicality pass', () => {
  it('drops a change that saves less than the threshold', () => {
    const result = applyPracticality([change({ savings: 0.01 })]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped[0]!.blocker).toBe('saving_below_threshold');
  });

  it('rejects a penny cheaper but extremely scarce color', () => {
    const result = applyPracticality([
      change({
        savings: 0.3,
        replacementQuote: quote({ colorId: 0, unitPrice: 0.18, lotCount: 2, totalQuantity: 4 }),
      }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(result.dropped[0]!.blocker).toBe('replacement_poorly_stocked');
  });

  it('keeps a moderately cheaper, widely available color', () => {
    const result = applyPracticality([change({ savings: 2 })]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.isHighConfidence).toBe(true);
    expect(result.candidates[0]!.shippingRisk).toBe('LOW');
    expect(result.candidates[0]!.confidenceCaveat).toBeNull();
  });

  it('prefers the widely available color when both are cheaper by similar amounts', () => {
    // Same saving; one is stocked everywhere, the other barely at all. Only the
    // available one survives to be recommended.
    const wide = change({ id: 'wide', savings: 2 });
    const thin = change({
      id: 'thin',
      savings: 2,
      commandRef: { fileIndex: 0, commandIndex: 2 },
      replacementQuote: quote({ lotCount: 2, totalQuantity: 5 }),
    });
    const result = applyPracticality([wide, thin]);
    expect(result.candidates.map((c) => c.id)).toEqual(['wide']);
  });

  it('does not let one unusually cheap listing carry the recommendation', () => {
    // The engine prices from the quantity-weighted average, so a single cheap
    // lot does not move the figure it uses; and the shape is flagged.
    const oneCheapLot = quote({
      colorId: 0,
      unitPrice: 0.4,
      quantityAverage: 0.4,
      average: 0.42,
      minPrice: 0.02,
      lotCount: 6,
      totalQuantity: 600,
    });
    const result = applyPracticality([
      change({ savings: 3.3, replacementUnitPrice: 0.4, replacementQuote: oneCheapLot }),
    ]);
    const candidate = result.candidates[0]!;
    // Priced from the weighted average, not the two-cent outlier.
    expect(candidate.replacementUnitPrice).toBe(0.4);
    expect(candidate.replacementAvailability.flags).toContain('single_cheap_lot_risk');
  });

  it('gives high-availability replacements the better confidence rating', () => {
    const wide = applyPracticality([change({ savings: 2 })]).candidates[0]!;
    const thin = applyPracticality([
      change({
        savings: 20,
        replacementQuote: quote({ lotCount: 3, totalQuantity: 9 }),
      }),
    ]).candidates[0]!;

    expect(wide.isHighConfidence).toBe(true);
    expect(thin.isHighConfidence).toBe(false);
    expect(availabilityRank(wide.replacementAvailability.level)).toBeGreaterThan(
      availabilityRank(thin.replacementAvailability.level),
    );
  });

  it('flags a low-availability substitution in words the user can act on', () => {
    const thin = applyPracticality([
      change({ savings: 20, replacementQuote: quote({ lotCount: 3, totalQuantity: 9 }) }),
    ]).candidates[0]!;

    expect(thin.confidenceCaveat).toMatch(/limited/);
    expect(thin.confidenceCaveat).toMatch(/erase the apparent saving/);
    expect(thin.shippingRisk).toBe('HIGH');
  });

  it('marks a change high confidence only when BOTH safety and supply are good', () => {
    const shakyVisibility = applyPracticality([change({ savings: 2, confidence: 0.9 })]).candidates[0]!;
    expect(shakyVisibility.isHighConfidence).toBe(false);
    expect(shakyVisibility.confidenceCaveat).toMatch(/visibility evidence/);
  });

  it('does not call a change high confidence when supply is unknown', () => {
    // Demo mode. Cheaper on paper, unverifiable in practice.
    const demo = applyPracticality([
      change({
        savings: 2,
        replacementQuote: quote({ source: 'demo', lotCount: null, totalQuantity: null }),
      }),
    ]).candidates[0]!;
    expect(demo.isHighConfidence).toBe(false);
    expect(demo.confidenceCaveat).toMatch(/no supply information/);
  });

  it('uses the documented default threshold', () => {
    // Deliberately low: candidates are per LINE, and a big model is mostly
    // lines covering one or two pieces, so a high floor throws away a long tail
    // that adds up. See the comment on DEFAULT_PRACTICALITY.
    expect(DEFAULT_PRACTICALITY.minSavingPerChange).toBe(0.02);
    const justUnder = applyPracticality([change({ savings: 0.01 })]);
    const justOver = applyPracticality([change({ savings: 0.03 })]);
    expect(justUnder.candidates).toHaveLength(0);
    expect(justOver.candidates).toHaveLength(1);
  });

  it('still keeps the long tail of small per-line changes', () => {
    // A ten-cent floor dropped 22 of 32 changes and 30% of the saving on a
    // real model. Each of these is small; together they are the product.
    const tail = Array.from({ length: 20 }, (_, i) =>
      change({ id: `c${i}`, commandRef: { fileIndex: 0, commandIndex: i }, savings: 0.05 }),
    );
    expect(applyPracticality(tail).candidates).toHaveLength(20);
  });
});
