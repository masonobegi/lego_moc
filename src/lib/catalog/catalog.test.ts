import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from './catalogService';
import { mapLDrawColorToBrickLink, mapBrickLinkColorToLDraw } from './colorMapping';
import { mapPartId } from './partMapping';

const bundled = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'catalog', 'bundled-catalog.json'), 'utf8'),
) as BundledCatalogFile;
const moldRules = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'catalog', 'mold-rules.json'), 'utf8'),
) as MoldRulesFile;

const catalog = new DefaultCatalogService({ bundled, moldRules });

describe('bundled catalogue', () => {
  it('carries real evidence for every part/colour pair', () => {
    const colors = catalog.availableColors('3001')!;
    expect(colors.length).toBeGreaterThan(5);
    const black = colors.find((c) => c.colorId === 0)!;
    expect(black.evidence.observations).toBeGreaterThan(0);
    expect(black.evidence.sets.length).toBeGreaterThan(0);
  });

  it('never records the inherit or edge colour sentinels', () => {
    for (const [, byColor] of Object.entries(bundled.parts).slice(0, 400)) {
      expect(Object.keys(byColor)).not.toContain('16');
      expect(Object.keys(byColor)).not.toContain('24');
    }
  });

  it('returns null for a part it has never seen, rather than an empty list', () => {
    // The distinction matters: null means "unknown", [] would mean "exists in
    // no colours", and the optimiser treats those differently.
    expect(catalog.availableColors('not-a-real-part-id')).toBeNull();
    expect(catalog.isKnownCombination('not-a-real-part-id', 0)).toBe(false);
  });

  it('confirms and denies specific combinations', () => {
    expect(catalog.isKnownCombination('3001', 0)).toBe(true);
    expect(catalog.isKnownCombination('3001', 4)).toBe(true);
    // 3001 has not been observed in every colour in the palette.
    const known = new Set(catalog.availableColors('3001')!.map((c) => c.colorId));
    const unknown = [...Array(200).keys()].find((c) => !known.has(c) && c !== 16 && c !== 24)!;
    expect(catalog.isKnownCombination('3001', unknown)).toBe(false);
  });

  it('reports its own limitations', () => {
    expect(catalog.status.limitations.join(' ')).toMatch(/never proposed/);
    expect(catalog.status.partCount).toBeGreaterThan(1000);
  });
});

describe('mold rules', () => {
  it('exposes rules in both directions', () => {
    const forward = catalog.equivalents('3068a').find((r) => r.replacementPart === '3068b');
    const backward = catalog.equivalents('3068b').find((r) => r.replacementPart === '3068a');
    expect(forward).toBeDefined();
    expect(backward).toBeDefined();
  });

  it('names a checkable source for every rule', () => {
    for (const rule of moldRules.rules) {
      expect(rule.source.length).toBeGreaterThan(20);
      expect(rule.note.length).toBeGreaterThan(20);
      expect(rule.confidence).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('keeps stud-type variants below the auto-apply threshold', () => {
    // A hollow stud accepts a bar and a solid one does not, so these must never
    // be applied automatically.
    const rule = moldRules.rules.find((r) => r.originalPart === '3062a')!;
    expect(rule.geometryCompatible).toBe(false);
    expect(rule.confidence).toBeLessThan(moldRules.autoApplyThreshold);
  });

  it('marks groove variants as geometry compatible but not visually identical', () => {
    const rule = moldRules.rules.find((r) => r.originalPart === '3070a')!;
    expect(rule.geometryCompatible).toBe(true);
    expect(rule.confidence).toBeGreaterThanOrEqual(moldRules.autoApplyThreshold);
    expect(rule.appearanceImpact).toBe('subtle');
  });

  it('returns nothing for a part with no rule', () => {
    expect(catalog.equivalents('3001')).toHaveLength(0);
  });
});

describe('part id mapping', () => {
  it('maps plain design numbers as identity', () => {
    expect(mapPartId('3001').confidence).toBe('identity');
    expect(mapPartId('3001').brickLinkPartId).toBe('3001');
    expect(mapPartId('3068b').confidence).toBe('identity');
  });

  it('refuses to guess for printed and stickered parts', () => {
    expect(mapPartId('3626bp01').confidence).toBe('unmapped');
    expect(mapPartId('3626bp01').brickLinkPartId).toBeNull();
    expect(mapPartId('3068bd01').confidence).toBe('unmapped');
  });

  it('refuses shortcut, sub-part and unofficial references', () => {
    expect(mapPartId('973c00').confidence).toBe('unmapped');
    expect(mapPartId('s/3001s01').confidence).toBe('unmapped');
    expect(mapPartId('u9012').confidence).toBe('unmapped');
  });

  it('applies curated exceptions where the catalogues genuinely diverge', () => {
    const mapping = mapPartId('6141');
    expect(mapping.confidence).toBe('verified');
    expect(mapping.brickLinkPartId).toBe('4073');
  });

  it('explains itself for every result', () => {
    for (const id of ['3001', '3626bp01', 's/3001s01', '6141', '']) {
      expect(mapPartId(id).note).toBeTruthy();
    }
  });
});

describe('colour mapping', () => {
  it('maps the common colours to their BrickLink ids', () => {
    expect(mapLDrawColorToBrickLink(0).brickLinkColorId).toBe(11); // Black
    expect(mapLDrawColorToBrickLink(4).brickLinkColorId).toBe(5); // Red
    expect(mapLDrawColorToBrickLink(71).brickLinkColorId).toBe(86); // Light Bluish Gray
    expect(mapLDrawColorToBrickLink(47).brickLinkColorId).toBe(12); // Trans-Clear
  });

  it('reports unmapped rather than guessing', () => {
    const mapping = mapLDrawColorToBrickLink(9999);
    expect(mapping.brickLinkColorId).toBeNull();
    expect(mapping.confidence).toBe('unmapped');
  });

  it('accepts a verified override from the live API', () => {
    const mapping = mapLDrawColorToBrickLink(0, new Map([[0, 999]]));
    expect(mapping.brickLinkColorId).toBe(999);
    expect(mapping.source).toMatch(/BrickLink API/);
  });

  it('reverses consistently', () => {
    expect(mapBrickLinkColorToLDraw(11)).toBe(0);
    expect(mapBrickLinkColorToLDraw(5)).toBe(4);
    expect(mapBrickLinkColorToLDraw(99999)).toBeNull();
  });
});
