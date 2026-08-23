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
import { DefaultCatalogService } from '@/lib/catalog/catalogService';
import { buildInventoryDelta, type InventoryDelta } from '@/lib/export/inventoryDelta';
import { buildInventoryDeltaCsv, buildInventoryDeltaWantedListXml } from '@/lib/export/reports';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { PriceBook } from '@/lib/pricing/priceEngine';
import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { assessAvailability } from '@/lib/pricing/availability';
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
    const csv = buildInventoryDeltaCsv(d);
    expect(csv.split('\r\n')[0]).toContain('action');
    expect(csv.trim().split('\r\n')).toHaveLength(1);

    const xml = buildInventoryDeltaWantedListXml(d, catalog, 'new');
    expect(xml.xml.trim()).toBe('<INVENTORY>\n</INVENTORY>');
    expect(xml.itemCount).toBe(0);
  });
});

describe('the delta CSV', () => {
  const d = delta(new Set(recolorAll.map((c) => c.id)));
  const csv = buildInventoryDeltaCsv(d);
  const rows = csv.trim().split('\r\n');

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
    expect(rows).toHaveLength(3); // header plus two lots
  });

  it('still guards text that came from the uploaded model', () => {
    // The injection guard has to stay on for anything the file supplied. A part
    // description is whatever the model said it was.
    const injected = buildInventoryDeltaCsv({
      ...d,
      lots: [{ ...d.lots[0]!, partDescription: '=cmd|calc!A1' }],
    });
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
    const odd = parseLDraw(
      '0 Odd\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 not-a-real-part-xyz.dat\n0 STEP\n',
      { sourceName: 'odd.ldr' },
    );
    const oddInstances = resolveModel(odd).instances;
    const oddDelta = buildInventoryDelta({
      originalInstances: [],
      optimizedInstances: oddInstances,
      prices,
      condition: 'new',
      currency: 'USD',
    });
    const built = buildInventoryDeltaWantedListXml(oddDelta, catalog, 'new');
    expect(built.itemCount).toBe(0);
    expect(built.excluded).toHaveLength(1);
    expect(built.excluded[0]!.quantity).toBe(1);
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
