/**
 * BrickLink Wanted List exports.
 *
 * Two lists are produced: the ORIGINAL inventory exactly as uploaded, and the
 * OPTIMIZED inventory with the enabled changes applied. The point of exporting
 * both is that our figures are parts-price estimates, while BrickLink is the
 * only system that knows about sellers, shipping and minimum orders. Running
 * both lists through BrickLink and comparing the two order totals is the real
 * answer; our estimate is a prediction of it.
 *
 * That makes correctness here load-bearing. If the original list quietly
 * included the changes, the comparison would show no difference and the user
 * would conclude the tool does nothing. If quantities or colors were wrong,
 * they would order the wrong bricks.
 *
 * The XML is validated structurally rather than eyeballed - see `parseInventory`
 * below. It has still never been imported into a live BrickLink account by this
 * build, and the export says so in its own header comment.
 */

import { describe, expect, it } from 'vitest';

import { applyToInstances } from '@/lib/analysis/pipeline';
import { DefaultCatalogService } from '@/lib/catalog/catalogService';
import { buildWantedListXml, xmlEscape } from '@/lib/export/reports';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { assessAvailability } from '@/lib/pricing/availability';

// The Wanted List only needs id mapping, so an empty catalog keeps the test
// independent of whatever the bundled data happens to contain.
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
 * A model with three distinct lots so quantities are checkable:
 * four red 2x4 bricks, two black 2x4 bricks, one blue 1x1.
 */
const SOURCE = [
  '0 Wanted List Fixture',
  '0 Name: wanted.ldr',
  '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 100 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 200 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 4 300 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 0 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 0 100 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '1 1 0 -48 0 1 0 0 0 1 0 0 0 1 3005.dat',
  '0 STEP',
].join('\n');

const document = parseLDraw(SOURCE, { sourceName: 'wanted.ldr' });
const instances = resolveModel(document).instances;

/** Recolor the four red 2x4 bricks to black. Each red line is its own command. */
function recolorRedToBlack(): OptimizationCandidate[] {
  const reds = instances.filter((i) => i.colorId === 4);
  return reds.map((instance, index) => ({
    id: `color:red-${index}`,
    kind: 'hidden_color' as const,
    commandRef: instance.commandRef,
    quantity: 1,
    instanceIds: [instance.instanceId],
    parentModel: 'wanted.ldr',
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
      classification: 'HIDDEN' as const,
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
    shippingRisk: 'UNKNOWN' as const,
    isHighConfidence: false,
    confidenceCaveat: null,
  }));
}

interface InventoryItem {
  itemType: string;
  itemId: string;
  color: number;
  minQty: number;
  condition: string;
}

/**
 * Parse the export back into structured items, checking the document shape as
 * it goes. Deliberately strict: a file that merely looks plausible is exactly
 * what this is meant to catch.
 */
function parseInventory(xml: string): InventoryItem[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').trim();
  expect(body.startsWith('<INVENTORY>')).toBe(true);
  expect(body.endsWith('</INVENTORY>')).toBe(true);

  // No stray tags outside ITEM blocks, and every open tag is closed.
  const tags = [...body.matchAll(/<\/?([A-Z]+)>/g)].map((m) => m[0]);
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith('</')) {
      expect(stack.pop()).toBe(tag.replace('</', '<'));
    } else {
      stack.push(tag);
    }
  }
  expect(stack).toHaveLength(0);

  const items: InventoryItem[] = [];
  for (const match of body.matchAll(/<ITEM>([\s\S]*?)<\/ITEM>/g)) {
    const block = match[1]!;
    const field = (name: string): string => {
      const found = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      expect(found, `missing <${name}> in ITEM block`).not.toBeNull();
      return found![1]!.trim();
    };
    items.push({
      itemType: field('ITEMTYPE'),
      itemId: field('ITEMID'),
      color: Number(field('COLOR')),
      minQty: Number(field('MINQTY')),
      condition: field('CONDITION'),
    });
  }
  return items;
}

function lot(items: InventoryItem[], itemId: string, color: number): InventoryItem | undefined {
  return items.find((i) => i.itemId === itemId && i.color === color);
}

describe('the original Wanted List', () => {
  const result = buildWantedListXml(instances, catalog, 'new');
  const items = parseInventory(result.xml);

  it('is well formed and marks every entry as a part', () => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.itemType).toBe('P');
      expect(Number.isInteger(item.minQty)).toBe(true);
      expect(item.minQty).toBeGreaterThan(0);
      expect(Number.isInteger(item.color)).toBe(true);
    }
  });

  it('has the right quantities', () => {
    // Four red, two black, one blue - as built.
    expect(lot(items, '3001', 5)!.minQty).toBe(4); // BrickLink red = 5
    expect(lot(items, '3001', 11)!.minQty).toBe(2); // BrickLink black = 11
    expect(lot(items, '3005', 7)!.minQty).toBe(1); // BrickLink blue = 7
  });

  it('maps part ids and colors to BrickLink ids, not LDraw ones', () => {
    // LDraw red is 4 and black is 0; BrickLink's are 5 and 11. Emitting the
    // LDraw numbers would order the wrong colors without any error.
    expect(items.some((i) => i.color === 4 && i.itemId === '3001')).toBe(false);
    expect(lot(items, '3001', 5)).toBeDefined();
    expect(lot(items, '3001', 11)).toBeDefined();
  });

  it('carries the requested condition', () => {
    expect(items.every((i) => i.condition === 'N')).toBe(true);
    const used = parseInventory(buildWantedListXml(instances, catalog, 'used').xml);
    expect(used.every((i) => i.condition === 'U')).toBe(true);
  });

  it('counts what it emitted', () => {
    expect(result.itemCount).toBe(items.length);
    expect(result.pieceCount).toBe(items.reduce((sum, i) => sum + i.minQty, 0));
  });
});

describe('the optimized Wanted List', () => {
  const candidates = recolorRedToBlack();
  const allEnabled = new Set(candidates.map((c) => c.id));

  it('reflects the enabled changes', () => {
    const optimized = applyToInstances(instances, candidates, allEnabled);
    const items = parseInventory(buildWantedListXml(optimized, catalog, 'new').xml);

    // The four red bricks became black, joining the two that were already
    // black: one lot of six, and no red left.
    expect(lot(items, '3001', 5)).toBeUndefined();
    expect(lot(items, '3001', 11)!.minQty).toBe(6);
    expect(lot(items, '3005', 7)!.minQty).toBe(1);
  });

  it('leaves disabled changes at the original color', () => {
    // Enable two of the four; the other two stay red.
    const partial = new Set([candidates[0]!.id, candidates[1]!.id]);
    const optimized = applyToInstances(instances, candidates, partial);
    const items = parseInventory(buildWantedListXml(optimized, catalog, 'new').xml);

    expect(lot(items, '3001', 5)!.minQty).toBe(2);
    expect(lot(items, '3001', 11)!.minQty).toBe(4);
  });

  it('is identical to the original when every change is disabled', () => {
    const none = applyToInstances(instances, candidates, new Set<string>());
    expect(buildWantedListXml(none, catalog, 'new').xml).toBe(
      buildWantedListXml(instances, catalog, 'new').xml,
    );
  });

  it('never alters the original list', () => {
    // The whole comparison workflow depends on this: if applying changes
    // mutated the source inventory, the "before" list would silently become
    // the "after" list and the two BrickLink totals would match for the wrong
    // reason.
    const before = buildWantedListXml(instances, catalog, 'new').xml;
    applyToInstances(instances, candidates, allEnabled);
    const after = buildWantedListXml(instances, catalog, 'new').xml;
    expect(after).toBe(before);
    expect(instances.filter((i) => i.colorId === 4)).toHaveLength(4);
  });

  it('conserves the total piece count', () => {
    // A recolor changes which lots exist, never how many bricks are needed.
    const original = buildWantedListXml(instances, catalog, 'new');
    const optimized = buildWantedListXml(
      applyToInstances(instances, candidates, allEnabled),
      catalog,
      'new',
    );
    expect(optimized.pieceCount).toBe(original.pieceCount);
  });
});

describe('lots that cannot be mapped', () => {
  it('are excluded and reported rather than guessed', () => {
    // A part with no confident BrickLink mapping must never be emitted with an
    // invented id: that would order the wrong brick with no error shown.
    const odd = parseLDraw(
      '0 Odd\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 not-a-real-part-xyz.dat\n0 STEP\n',
      { sourceName: 'odd.ldr' },
    );
    const result = buildWantedListXml(resolveModel(odd).instances, catalog, 'new');
    const items = parseInventory(result.xml);
    expect(items).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.partId).toBe('not-a-real-part-xyz');
    expect(result.excluded[0]!.reason).toBeTruthy();
  });
});

describe('XML escaping', () => {
  it('escapes every character that would break the document', () => {
    expect(xmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });
});

/**
 * Colliding BrickLink ids.
 *
 * The LDraw to BrickLink map is many-to-one, and the collisions are live in the
 * shipped tables: LDraw colors 32 and 40 are both BrickLink 13, and LDraw parts
 * 6141 and 4073 are both BrickLink 4073. Counting lots in LDraw space and then
 * mapping each one - which this code did until an adversarial design review
 * caught it - emitted two ITEM blocks with the same ITEMID and COLOR, with the
 * quantity split between them. A buyer needing four got three and one.
 *
 * BrickLink's behaviour on a duplicated item inside one upload is unverified,
 * so the export must never produce one.
 */
describe('two LDraw ids that are one BrickLink id', () => {
  it('sums colors 32 and 40 into a single BrickLink 13 lot', () => {
    const source = [
      '0 Colliding colors',
      '1 32 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 32 20 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 32 40 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 40 60 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '0 STEP',
    ].join('\n');
    const result = buildWantedListXml(
      resolveModel(parseLDraw(source, { sourceName: 'c.ldr' })).instances,
      catalog,
      'new',
    );
    const items = parseInventory(result.xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: '3005', color: 13, minQty: 4 });
    expect(result.itemCount).toBe(1);
    expect(result.pieceCount).toBe(4);
  });

  it('sums parts 6141 and 4073 into a single BrickLink 4073 lot', () => {
    const source = [
      '0 Colliding parts',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 6141.dat',
      '1 4 20 0 0 1 0 0 0 1 0 0 0 1 4073.dat',
      '0 STEP',
    ].join('\n');
    const items = parseInventory(
      buildWantedListXml(
        resolveModel(parseLDraw(source, { sourceName: 'c2.ldr' })).instances,
        catalog,
        'new',
      ).xml,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: '4073', minQty: 2 });
  });

  it('never emits the same item and color twice in any list', () => {
    const source = [
      '0 Mixed',
      '1 32 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 40 20 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 4 40 0 0 1 0 0 0 1 0 0 0 1 6141.dat',
      '1 4 60 0 0 1 0 0 0 1 0 0 0 1 4073.dat',
      '0 STEP',
    ].join('\n');
    const xml = buildWantedListXml(
      resolveModel(parseLDraw(source, { sourceName: 'm.ldr' })).instances,
      catalog,
      'new',
    ).xml;
    const keys = parseInventory(xml).map((i) => `${i.itemId}|${i.color}|${i.condition}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('still conserves the total piece count when lots collapse', () => {
    const source = [
      '0 Mixed',
      '1 32 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 40 20 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '1 4 40 0 0 1 0 0 0 1 0 0 0 1 6141.dat',
      '0 STEP',
    ].join('\n');
    const instances = resolveModel(parseLDraw(source, { sourceName: 'm.ldr' })).instances;
    const result = buildWantedListXml(instances, catalog, 'new');
    expect(result.pieceCount).toBe(instances.length);
  });
});
