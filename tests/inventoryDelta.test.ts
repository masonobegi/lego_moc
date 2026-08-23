/**
 * The changed-parts-only export.
 *
 * The whole point of this artifact is that a user can act on it without reading
 * two full parts lists. That makes it the export most likely to be trusted
 * blindly, and therefore the one where a quiet arithmetic error does the most
 * damage: order the wrong quantity of the wrong color and the model is wrong and
 * the money is spent.
 *
 * The case these tests exist for is MERGING. When twelve hidden red bricks
 * become black and the model already contained four black ones, the answer is
 * not "12 red became 12 black" - it is "red: 12 to 0" and "black: 4 to 16".
 * A delta built from the change list instead of from the two inventories gets
 * that wrong while looking entirely plausible.
 */

import { describe, expect, it } from 'vitest';

import { applyToInstances } from '@/lib/analysis/pipeline';
import { selectAppliedCandidates } from '@/lib/optimizer/applyOptimizations';
import { DefaultCatalogService } from '@/lib/catalog/catalogService';
import { buildInventoryDelta, type InventoryDelta } from '@/lib/export/inventoryDelta';
import {
  buildInventoryDeltaCsv,
  buildInventoryDeltaWantedListXml,
  deltaExportPreamble,
  type DeltaExportContext,
} from '@/lib/export/reports';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { countLots } from '@/lib/ldraw/inventory';
import { PriceBook } from '@/lib/pricing/priceEngine';
import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { assessAvailability } from '@/lib/pricing/availability';
import { DELTA_ACTION_LABELS } from '@/lib/export/inventoryDelta';
import type { PriceQuote } from '@/lib/pricing/types';

const catalog = new DefaultCatalogService({
  bundled: {
    schemaVersion: 1,
    source: 'test',
    sourceUrl: '',
    license: '',
    description: 'empty',
    modelFileCount: 0,
    setCount: 0,
    partCount: 0,
    pairCount: 0,
    parts: {},
  },
  moldRules: { schemaVersion: 1, source: 'test', description: 'none', autoApplyThreshold: 0.85, rules: [] },
});

/**
 * Four red 2x4, two black 2x4, one blue 1x1. The two black bricks are the
 * point: the recolored red ones merge into that existing lot.
 */
const SOURCE = [
  '0 Delta Fixture',
  '0 Name: delta.ldr',
  '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 100 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 200 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 300 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 0 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 0 100 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 1 0 -48 0 1 0 0 0 1 0 0 0 1 3005.dat',
  '0 STEP',
].join('\n');

const document = parseLDraw(SOURCE, { sourceName: 'delta.ldr' });
const instances = resolveModel(document).instances;

function quote(partId: string, colorId: number, unitPrice: number): PriceQuote {
  return {
    partId,
    colorId,
    condition: 'new',
    unitPrice,
    currency: 'USD',
    source: 'demo',
    sourceDetail: 'test',
    timestamp: '2026-01-01T00:00:00.000Z',
    average: unitPrice,
    quantityAverage: unitPrice,
    minPrice: unitPrice,
    maxPrice: unitPrice,
    lotCount: null,
    totalQuantity: null,
    isEstimate: true,
    notes: [],
  };
}

const prices = new PriceBook({
  requested: 3,
  resolved: 3,
  unresolved: 0,
  elapsedMs: 0,
  providerId: 'demo',
  providerLabel: 'test',
  isLive: false,
});
prices.set('3001', 4, 'new', quote('3001', 4, 0.75));
prices.set('3001', 0, 'new', quote('3001', 0, 0.12));
prices.set('3005', 1, 'new', quote('3005', 1, 0.2));

function candidate(
  overrides: Partial<OptimizationCandidate> & { id: string; instance: (typeof instances)[number] },
): OptimizationCandidate {
  const { instance, ...rest } = overrides;
  return {
    kind: 'hidden_color',
    commandRef: instance.commandRef,
    quantity: 1,
    instanceIds: [instance.instanceId],
    parentModel: 'delta.ldr',
    stepIndex: 0,
    partId: '3001',
    partDescription: 'Brick 2 x 4',
    originalPartId: '3001',
    originalColorId: 4,
    originalColorName: 'Red',
    replacementPartId: '3001',
    replacementColorId: 0,
    replacementColorName: 'Black',
    originalUnitPrice: 0.75,
    replacementUnitPrice: 0.12,
    originalTotal: 0.75,
    replacementTotal: 0.12,
    savings: 0.63,
    reason: 'Completely hidden inside the completed model',
    confidence: 0.999,
    visibility: {
      classification: 'HIDDEN',
      confidence: 0.999,
      totalRays: 400_000,
      trianglesCovered: 10,
      trianglesTotal: 10,
      evidence: 'no escape',
    },
    evidence: [],
    moldRule: null,
    alternatives: [],
    conflictsWith: [],
    enabledByDefault: true,
    originalQuote: null,
    replacementQuote: null,
    originalAvailability: assessAvailability(null, 1),
    replacementAvailability: assessAvailability(null, 1),
    shippingRisk: 'UNKNOWN',
    isHighConfidence: false,
    confidenceCaveat: null,
    ...rest,
  } as OptimizationCandidate;
}

const redInstances = instances.filter((i) => i.colorId === 4);
const recolorAll = redInstances.map((instance, index) =>
  candidate({ id: `red-${index}`, instance }),
);

function delta(enabledIds: ReadonlySet<string>, candidates = recolorAll): InventoryDelta {
  return buildInventoryDelta({
    originalInstances: instances,
    optimizedInstances: applyToInstances(instances, candidates, enabledIds),
    prices,
    condition: 'new',
    currency: 'USD',
    descriptions: new Map([['3001', 'Brick 2 x 4']]),
  });
}

const CONTEXT: DeltaExportContext = {
  modelFileName: 'delta.ldr',
  analysisId: 'test-analysis-id',
  generatedAt: '2026-01-01T00:00:00.000Z',
  enabledChangeCount: 4,
  candidateCount: 4,
  priceSourceLabel: 'Demo price data',
  isDemoData: true,
  condition: 'new',
};

function lot(d: InventoryDelta, partId: string, colorId: number) {
  return d.lots.find((l) => l.partId === partId && l.colorId === colorId);
}

describe('a recolor that merges into an existing lot', () => {
  const d = delta(new Set(recolorAll.map((c) => c.id)));

  it('reports the merged total, not the number of pieces that changed', () => {
    // The mistake this guards against: emitting "black +12" when the user
    // already had 4 and now needs 16 in ONE lot.
    expect(lot(d, '3001', 0)).toMatchObject({
      originalQuantity: 2,
      optimizedQuantity: 6,
      difference: 4,
      action: 'buy_more',
    });
  });

  it('reports the emptied lot as no longer needed', () => {
    expect(lot(d, '3001', 4)).toMatchObject({
      originalQuantity: 4,
      optimizedQuantity: 0,
      difference: -4,
      action: 'no_longer_needed',
    });
  });

  it('omits lots that did not change', () => {
    expect(lot(d, '3005', 1)).toBeUndefined();
    expect(d.lots).toHaveLength(2);
  });

  it('conserves the piece count', () => {
    // A recolor changes which bricks you buy, never how many. If this ever
    // fails, the optimizer has invented or lost pieces.
    expect(d.piecesAdded).toBe(4);
    expect(d.piecesRemoved).toBe(4);
    expect(d.pieceCountConserved).toBe(true);
    expect(d.totalPieces).toBe(7);
  });

  it('nets the cost change across both directions', () => {
    // -4 x $0.75 plus +4 x $0.12 = -$2.52. Negative means cheaper.
    expect(d.estimatedCostDifference).toBe(-2.52);
    expect(lot(d, '3001', 4)!.costDifference).toBe(-3);
    expect(lot(d, '3001', 0)!.costDifference).toBe(0.48);
  });

  it('agrees with the sum of the individual savings', () => {
    // The delta and the change list must not tell different stories.
    const savingsFromCandidates = recolorAll.reduce((sum, c) => sum + c.savings, 0);
    expect(Math.abs(-d.estimatedCostDifference - savingsFromCandidates)).toBeLessThan(0.005);
  });
});

describe('a partial recolor', () => {
  const d = delta(new Set([recolorAll[0]!.id, recolorAll[1]!.id]));

  it('splits the lot rather than emptying it', () => {
    expect(lot(d, '3001', 4)).toMatchObject({
      originalQuantity: 4,
      optimizedQuantity: 2,
      difference: -2,
      action: 'buy_fewer',
    });
    expect(lot(d, '3001', 0)).toMatchObject({ originalQuantity: 2, optimizedQuantity: 4, difference: 2 });
  });

  it('still conserves pieces', () => {
    expect(d.pieceCountConserved).toBe(true);
  });
});

describe('a recolor into a color the model did not contain', () => {
  const toBlue = redInstances.map((instance, index) =>
    candidate({
      id: `blue-${index}`,
      instance,
      replacementColorId: 1,
      replacementColorName: 'Blue',
    }),
  );
  const d = delta(new Set(toBlue.map((c) => c.id)), toBlue);

  it('marks the new lot as one to buy that was not in the original list', () => {
    // 3005/Blue exists, but 3001/Blue does not - the action must distinguish
    // "more of something you were already buying" from "something new".
    expect(lot(d, '3001', 1)).toMatchObject({
      originalQuantity: 0,
      optimizedQuantity: 4,
      action: 'buy_new',
    });
    expect(d.lotsAdded).toBe(1);
    expect(d.lotsRemoved).toBe(1);
  });

  it('does not touch the unrelated blue 1x1 lot', () => {
    expect(lot(d, '3005', 1)).toBeUndefined();
  });
});

describe('a mold swap that changes the part id', () => {
  const swap = [
    candidate({
      id: 'mold-0',
      instance: redInstances[0]!,
      kind: 'mold_equivalent',
      replacementPartId: '3001b',
      replacementColorId: 4,
      replacementColorName: 'Red',
    }),
  ];
  const d = delta(new Set(['mold-0']), swap);

  it('is handled the same way as a color change', () => {
    expect(lot(d, '3001', 4)!.difference).toBe(-1);
    expect(lot(d, '3001b', 4)).toMatchObject({ originalQuantity: 0, optimizedQuantity: 1, action: 'buy_new' });
    expect(d.pieceCountConserved).toBe(true);
  });
});

describe('nothing enabled', () => {
  const d = delta(new Set<string>());

  it('produces an empty delta rather than an error', () => {
    expect(d.lots).toHaveLength(0);
    expect(d.estimatedCostDifference).toBe(0);
    expect(d.pieceCountConserved).toBe(true);
  });

  it('still produces a valid, empty CSV and XML', () => {
    const csv = buildInventoryDeltaCsv(d, CONTEXT);
    const rows = csv.trim().split('\r\n').filter((row) => !row.startsWith('#'));
    expect(rows[0]).toContain('action');
    expect(rows).toHaveLength(1);

    const xml = buildInventoryDeltaWantedListXml(d, catalog, 'new');
    expect(xml.xml.trim()).toBe('<INVENTORY>\n</INVENTORY>');
    expect(xml.itemCount).toBe(0);
  });
});

describe('the delta CSV', () => {
  const d = delta(new Set(recolorAll.map((c) => c.id)));
  const csv = buildInventoryDeltaCsv(d, CONTEXT);
  const rows = csv.trim().split('\r\n').filter((row) => !row.startsWith('#'));

  it('names the direction in words, not just a sign', () => {
    // This file gets opened out of context. "-4" is ambiguous; "No longer
    // needed" is not.
    expect(rows.some((r) => r.startsWith('No longer needed,'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Buy more,'))).toBe(true);
  });

  it('keeps the change column a real signed number', () => {
    // Not "'+4". A spreadsheet must be able to sort and sum this column, and
    // the formula-injection guard that protects text from the uploaded model
    // must not be applied to numbers we computed ourselves.
    expect(csv).toContain(',4,');
    expect(csv).toContain(',-4,');
    expect(csv).not.toContain("'-4");
    expect(csv).not.toContain("'+4");
  });

  it('carries both directions, which the XML cannot', () => {
    expect(rows).toHaveLength(3); // column row plus two lots
  });

  it('opens with provenance, not a naked column row', () => {
    // This file is short, actionable, and will be opened weeks later with no
    // memory of which model or settings produced it.
    const preamble = csv.split('\r\n').filter((row) => row.startsWith('#'));
    expect(preamble.length).toBeGreaterThan(10);
    const text = preamble.join('\n');
    expect(text).toContain('NOT a complete parts list');
    expect(text).toContain('delta.ldr');
    expect(text).toContain('test-analysis-id');
    expect(text).toContain('DEMO PRICE DATA');
    expect(csv.startsWith('#')).toBe(true);
  });

  it('is still parseable once the comment lines are dropped', () => {
    const dataRows = rows.slice(1);
    const actions = dataRows.map((row) => row.split(',')[0]);
    for (const action of actions) {
      expect(Object.values(DELTA_ACTION_LABELS)).toContain(action);
    }
  });

  it('still guards text that came from the uploaded model', () => {
    // The injection guard has to stay on for anything the file supplied. A part
    // description is whatever the model said it was.
    const injected = buildInventoryDeltaCsv(
      { ...d, lots: [{ ...d.lots[0]!, partDescription: '=cmd|calc!A1' }] },
      CONTEXT,
    );
    expect(injected).toContain("'=cmd|calc!A1");
  });
});

describe('the delta Wanted List XML', () => {
  const d = delta(new Set(recolorAll.map((c) => c.id)));
  const result = buildInventoryDeltaWantedListXml(d, catalog, 'new');

  it('contains only the increases, with the increase as MINQTY', () => {
    // 4 more black bricks - NOT 6, which is the new lot total, and NOT the
    // 4 red ones, which cannot be expressed as a removal.
    expect(result.itemCount).toBe(1);
    expect(result.pieceCount).toBe(4);
    expect(result.xml).toContain('<MINQTY>4</MINQTY>');
    expect(result.xml).toContain('<COLOR>11</COLOR>'); // BrickLink black
    expect(result.xml).not.toContain('<COLOR>5</COLOR>'); // BrickLink red
  });

  it('is structurally a valid inventory', () => {
    expect(result.xml.trim().startsWith('<INVENTORY>')).toBe(true);
    expect(result.xml.trim().endsWith('</INVENTORY>')).toBe(true);
    const opens = [...result.xml.matchAll(/<ITEM>/g)].length;
    const closes = [...result.xml.matchAll(/<\/ITEM>/g)].length;
    expect(opens).toBe(closes);
    expect(opens).toBe(result.itemCount);
  });

  it('excludes lots whose BrickLink id cannot be resolved rather than guessing', () => {
    // One instance of a part with no BrickLink mapping, recolored. Both sides
    // of the delta are unmappable, so nothing may be emitted and the increase
    // must be reported as a gap rather than guessed at.
    const odd = parseLDraw(
      '0 Odd\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 not-a-real-part-xyz.dat\n0 STEP\n',
      { sourceName: 'odd.ldr' },
    );
    const oddInstances = resolveModel(odd).instances;
    const oddDelta = buildInventoryDelta({
      originalInstances: oddInstances,
      optimizedInstances: oddInstances.map((i) => ({ ...i, colorId: 0, declaredColorId: 0 })),
      prices,
      condition: 'new',
      currency: 'USD',
    });
    const built = buildInventoryDeltaWantedListXml(oddDelta, catalog, 'new');
    expect(built.itemCount).toBe(0);
    expect(built.excluded).toHaveLength(1);
    expect(built.excluded[0]!.quantity).toBe(1);
    expect(built.excluded[0]!.partId).toBe('not-a-real-part-xyz');
  });
});

describe('the delta never modifies its inputs', () => {
  it('leaves the original instances untouched', () => {
    const before = instances.map((i) => `${i.partId}|${i.colorId}`).join(',');
    delta(new Set(recolorAll.map((c) => c.id)));
    const after = instances.map((i) => `${i.partId}|${i.colorId}`).join(',');
    expect(after).toBe(before);
  });
});

/**
 * Findings from an adversarial design review of this feature. Each of these is a
 * way the export could be wrong while looking entirely plausible.
 */
describe('netting happens at the BrickLink level, not the LDraw level', () => {
  // Two LDraw part ids that BrickLink sells under ONE item number. This is what
  // a mold-variant swap usually is.
  const mergingCatalog = {
    mapPart: (partId: string) =>
      partId === '3068a' || partId === '3068b'
        ? { brickLinkPartId: '3068b', confidence: 'verified' as const, note: null }
        : { brickLinkPartId: partId, confidence: 'identity' as const, note: null },
    mapColor: (colorId: number) => ({
      brickLinkColorId: colorId === 4 ? 5 : colorId === 0 ? 11 : 7,
      note: null,
    }),
  } as unknown as Parameters<typeof buildInventoryDeltaWantedListXml>[1];

  const swapDelta: InventoryDelta = {
    lots: [
      {
        partId: '3068a', partDescription: 'Tile 2 x 2', colorId: 4, colorName: 'Red',
        originalQuantity: 12, optimizedQuantity: 0, difference: -12, action: 'no_longer_needed',
        unitPrice: 0.1, originalLineTotal: 1.2, optimizedLineTotal: 0, costDifference: -1.2,
      },
      {
        partId: '3068b', partDescription: 'Tile 2 x 2', colorId: 4, colorName: 'Red',
        originalQuantity: 0, optimizedQuantity: 12, difference: 12, action: 'buy_new',
        unitPrice: 0.08, originalLineTotal: 0, optimizedLineTotal: 0.96, costDifference: 0.96,
      },
    ],
    piecesAdded: 12, piecesRemoved: 12, pieceCountConserved: true, totalPieces: 100,
    lotsAdded: 1, lotsRemoved: 1, lotsChanged: 2,
    estimatedCostDifference: -0.24, additionalSpend: 0.96, spareValue: 1.2,
    unpricedLotCount: 0, unpricedPieceCount: 0, currency: 'USD',
  };

  it('emits nothing when the swap is one item number to BrickLink', () => {
    // The bug this guards against: telling the user to buy 12 tiles they
    // already have, because two LDraw ids became one BrickLink id.
    const result = buildInventoryDeltaWantedListXml(swapDelta, mergingCatalog, 'new');
    expect(result.itemCount).toBe(0);
    expect(result.pieceCount).toBe(0);
    expect(result.nettedToNothing).toBe(1);
    expect(result.xml).not.toContain('<ITEM>');
  });

  it('never emits two ITEM elements for the same item and color', () => {
    const d = delta(new Set(recolorAll.map((c) => c.id)));
    const result = buildInventoryDeltaWantedListXml(d, catalog, 'new');
    const keys = [...result.xml.matchAll(/<ITEMID>([^<]*)<\/ITEMID>\s*<COLOR>([^<]*)<\/COLOR>/g)].map(
      (m) => `${m[1]}|${m[2]}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('records decreases it could not map, because they could not be offset', () => {
    const partial = {
      ...swapDelta,
      lots: [
        { ...swapDelta.lots[0]!, partId: 'unmappable-xyz' },
        swapDelta.lots[1]!,
      ],
    };
    const unmappable = {
      mapPart: (partId: string) =>
        partId === 'unmappable-xyz'
          ? { brickLinkPartId: null, confidence: 'unmapped' as const, note: 'no mapping' }
          : { brickLinkPartId: '3068b', confidence: 'verified' as const, note: null },
      mapColor: () => ({ brickLinkColorId: 5, note: null }),
    } as unknown as Parameters<typeof buildInventoryDeltaWantedListXml>[1];

    const result = buildInventoryDeltaWantedListXml(partial, unmappable, 'new');
    expect(result.unmappedDecreases).toBe(1);
    // The increase still stands, and the caller is told the quantity may be high.
    expect(result.pieceCount).toBe(12);
  });
});

describe('the delta reconstructs the optimized Wanted List', () => {
  it('original plus delta equals optimized, lot for lot', () => {
    // The strongest single check on the arithmetic: if this holds, the delta
    // cannot be describing a different order from the full lists.
    const enabledIds = new Set(recolorAll.map((c) => c.id));
    const optimizedInstances = applyToInstances(instances, recolorAll, enabledIds);
    const d = delta(enabledIds);

    const reconstructed = new Map<string, number>();
    for (const [key, lotCount] of countLots(instances)) reconstructed.set(key, lotCount.quantity);
    for (const lot of d.lots) {
      const key = `${lot.partId}|${lot.colorId}`;
      reconstructed.set(key, (reconstructed.get(key) ?? 0) + lot.difference);
    }
    for (const [key, quantity] of reconstructed) {
      if (quantity === 0) reconstructed.delete(key);
    }

    const expected = new Map(
      [...countLots(optimizedInstances)].map(([key, lotCount]) => [key, lotCount.quantity]),
    );
    expect([...reconstructed].sort()).toEqual([...expected].sort());
  });
});

describe('every quantity in the Wanted List is orderable', () => {
  it('has no zero or negative MINQTY', () => {
    const d = delta(new Set(recolorAll.map((c) => c.id)));
    const result = buildInventoryDeltaWantedListXml(d, catalog, 'new');
    const quantities = [...result.xml.matchAll(/<MINQTY>([^<]*)<\/MINQTY>/g)].map((m) => Number(m[1]));
    expect(quantities.length).toBeGreaterThan(0);
    for (const quantity of quantities) {
      expect(Number.isInteger(quantity)).toBe(true);
      expect(quantity).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('a delta that does not conserve pieces', () => {
  it('refuses to be built rather than ordering the wrong quantities', () => {
    // Every substitution is one-for-one, so this can only mean a bug. Emitting
    // a parts list anyway would silently under- or over-order.
    const oneExtra = [...instances, instances[0]!];
    expect(() =>
      buildInventoryDelta({
        originalInstances: instances,
        optimizedInstances: oneExtra,
        prices,
        condition: 'new',
        currency: 'USD',
      }),
    ).toThrow(/not piece-conserving/);
  });
});

/**
 * The money on a delta is the main way this export could mislead.
 *
 * The reader a delta is FOR has already bought the original parts list - that
 * is why they want the difference rather than the whole thing. For them the
 * optimization does not save the net figure: they cannot un-buy what they
 * already have, so acting on this file costs them the increases and leaves them
 * with spare bricks. Presenting one number labelled "savings" would be exactly
 * backwards for the audience.
 */
describe('the three money figures', () => {
  const d = delta(new Set(recolorAll.map((c) => c.id)));

  it('separates the net difference from what acting on the file costs', () => {
    // 4 red out at $0.75, 4 black in at $0.12.
    expect(d.additionalSpend).toBe(0.48);
    expect(d.spareValue).toBe(3);
    expect(d.estimatedCostDifference).toBe(-2.52);
  });

  it('keeps the three consistent: net equals spend minus spare', () => {
    expect(Math.abs(d.estimatedCostDifference - (d.additionalSpend - d.spareValue))).toBeLessThan(0.005);
  });

  it('never presents a single figure as a saving', () => {
    const preamble = deltaExportPreamble(d, CONTEXT).join('\n');
    expect(preamble).not.toMatch(/you save/i);
    expect(preamble).not.toMatch(/^savings:/im);
  });

  it('states plainly that acting on it after ordering costs money and returns nothing', () => {
    const preamble = deltaExportPreamble(d, CONTEXT).join('\n');
    expect(preamble).toContain('COSTS you');
    expect(preamble).toContain('cannot be un-bought');
    expect(preamble).toContain('BEFORE you order');
  });

  it('names the precondition and the alternative export', () => {
    const preamble = deltaExportPreamble(d, CONTEXT).join('\n');
    expect(preamble).toContain('correct only if');
    expect(preamble).toContain('OPTIMIZED Wanted List');
  });

  it('warns that the top-up is its own order with its own shipping', () => {
    const preamble = deltaExportPreamble(d, CONTEXT).join('\n');
    expect(preamble).toContain('own BrickLink order');
    expect(preamble).toContain('seller minimums');
  });
});

describe('lots with no price estimate', () => {
  it('sort to the end rather than ranking as a zero cost change', () => {
    // An unpriced 40-piece lot filed in the middle of the money ordering reads
    // as "this one does not matter", when the truth is we do not know.
    const unpricedInstances = instances.map((i) =>
      i.partId === '3005' ? { ...i, partId: 'no-price-part' } : i,
    );
    const d = buildInventoryDelta({
      originalInstances: unpricedInstances,
      optimizedInstances: unpricedInstances.map((i) =>
        i.colorId === 4 ? { ...i, colorId: 0, declaredColorId: 0 } : i,
      ),
      prices,
      condition: 'new',
      currency: 'USD',
    });
    const unpricedIndex = d.lots.findIndex((l) => l.costDifference === null);
    const pricedIndexes = d.lots
      .map((l, i) => (l.costDifference === null ? -1 : i))
      .filter((i) => i >= 0);
    if (unpricedIndex >= 0) {
      expect(unpricedIndex).toBeGreaterThan(Math.max(...pricedIndexes));
    }
  });

  it('are counted, in lots and in pieces, so the size of the gap is visible', () => {
    const oddInstances = [
      ...instances,
      { ...instances[0]!, instanceId: 'x1', partId: 'no-price-part' },
      { ...instances[0]!, instanceId: 'x2', partId: 'no-price-part' },
    ];
    const d = buildInventoryDelta({
      originalInstances: oddInstances,
      optimizedInstances: oddInstances.map((i) =>
        i.partId === 'no-price-part' ? { ...i, colorId: 2, declaredColorId: 2 } : i,
      ),
      prices,
      condition: 'new',
      currency: 'USD',
    });
    expect(d.unpricedLotCount).toBe(2);
    expect(d.unpricedPieceCount).toBe(4);
    expect(deltaExportPreamble(d, CONTEXT).join('\n')).toContain('no price');
  });
});

/**
 * The two apply paths must agree.
 *
 * The delta comes from `applyToInstances`; the downloadable .ldr comes from
 * `applyOptimizations`. They previously chose between two changes competing for
 * the same line by different rules - savings in one, array order in the other -
 * and agreed only because the pipeline happens to sort candidates by descending
 * saving first. Two independent rules that agree by coincidence are one
 * refactor away from a shopping list that does not match the model file.
 */
describe('conflicting changes on one line', () => {
  const target = redInstances[0]!;
  const cheap = candidate({ id: 'a-cheap', instance: target, savings: 0.1, replacementColorId: 0 });
  const rich = candidate({ id: 'z-rich', instance: target, savings: 5, replacementColorId: 1 });

  it('picks the bigger saving regardless of array order', () => {
    const enabled = new Set(['a-cheap', 'z-rich']);
    const forward = applyToInstances(instances, [cheap, rich], enabled);
    const reversed = applyToInstances(instances, [rich, cheap], enabled);

    const colorOf = (list: typeof instances) =>
      list.find((i) => i.instanceId === target.instanceId)!.colorId;
    // Blue is the 5.00 saving; black is the 0.10 one.
    expect(colorOf(forward)).toBe(1);
    expect(colorOf(reversed)).toBe(1);
  });

  it('resolves the same way as the LDraw export does', () => {
    const enabled = new Set(['a-cheap', 'z-rich']);
    const selection = selectAppliedCandidates([cheap, rich], enabled);
    expect([...selection.byCommand.values()].map((c) => c.id)).toEqual(['z-rich']);
    expect(selection.skipped.map((s) => s.candidateId)).toEqual(['a-cheap']);
  });

  it('breaks a tie deterministically rather than by position', () => {
    const tieA = candidate({ id: 'aaa', instance: target, savings: 1, replacementColorId: 0 });
    const tieB = candidate({ id: 'bbb', instance: target, savings: 1, replacementColorId: 1 });
    const enabled = new Set(['aaa', 'bbb']);
    const forward = selectAppliedCandidates([tieA, tieB], enabled);
    const reversed = selectAppliedCandidates([tieB, tieA], enabled);
    expect([...forward.byCommand.values()][0]!.id).toBe('aaa');
    expect([...reversed.byCommand.values()][0]!.id).toBe('aaa');
  });
});
