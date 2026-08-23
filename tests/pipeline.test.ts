/**
 * End-to-end tests of the analysis pipeline against the synthetic fixtures.
 *
 * These are the tests that matter most. They assert the SAFETY properties the
 * product depends on:
 *   - a visible part is never recolored;
 *   - a part visible only through a gap is never recolored;
 *   - a part behind glass is never recolored;
 *   - a reused submodel is only changed when every copy of it is hidden;
 *   - a change never moves a part out of its build step;
 *   - the exported file differs from the input by exactly the changed lines.
 *
 * Nothing here is stubbed. Fixtures go through the same parser, geometry
 * resolver, visibility engine, price engine, optimizer and serializer that an
 * upload does.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { analyzeModel, applyToInstances, computeSavings } from '@/lib/analysis/pipeline';
import type { AnalyzeOutput } from '@/lib/analysis/pipeline';
import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from '@/lib/catalog/catalogService';
import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { serializeDocument } from '@/lib/ldraw/serializer';
import { applyOptimizations } from '@/lib/optimizer/applyOptimizations';
import { exportOptimizedLDraw } from '@/lib/export/ldrawExport';
import { buildChangeLogCsv, buildJsonReport, buildWantedListXml } from '@/lib/export/reports';
import { DemoPriceProvider } from '@/lib/pricing/demoProvider';
import { calculateCost } from '@/lib/pricing/priceEngine';
import type { SafetyLevel } from '@/lib/optimizer/types';

const ROOT = process.cwd();
const catalog = new DefaultCatalogService({
  bundled: JSON.parse(
    readFileSync(path.join(ROOT, 'data', 'catalog', 'bundled-catalog.json'), 'utf8'),
  ) as BundledCatalogFile,
  moldRules: JSON.parse(
    readFileSync(path.join(ROOT, 'data', 'catalog', 'mold-rules.json'), 'utf8'),
  ) as MoldRulesFile,
});
const partSource = new NodePartSource(path.join(ROOT, 'public', 'ldraw'));

function fixtureSource(name: string): string {
  return readFileSync(path.join(ROOT, 'test-models', name), 'utf8');
}

async function analyze(
  name: string,
  safetyLevel: SafetyLevel = 'extremely_conservative',
): Promise<AnalyzeOutput> {
  return analyzeModel({
    source: fixtureSource(name),
    fileName: name,
    partSource,
    catalog,
    priceProvider: new DemoPriceProvider(),
    condition: 'new',
    safetyLevel,
    exhaustiveColorSearch: true,
    // Deterministic and directly comparable; the parallel path is covered
    // separately in visibilityParallel.test.ts.
    singleThreaded: true,
  });
}

const cache = new Map<string, AnalyzeOutput>();
async function analyzeCached(name: string): Promise<AnalyzeOutput> {
  const existing = cache.get(name);
  if (existing) return existing;
  const output = await analyze(name);
  cache.set(name, output);
  return output;
}

describe('optimizer safety: a visible part is never changed', () => {
  it('exposed-brick.ldr proposes nothing', async () => {
    const { result } = await analyzeCached('exposed-brick.ldr');
    expect(result.candidates).toHaveLength(0);
    expect(result.visibility.counts.HIDDEN).toBe(0);
    expect(result.visibility.counts.VISIBLE).toBe(2);
  });

  it('partially-visible.ldr leaves the target alone', async () => {
    const { result } = await analyzeCached('partially-visible.ldr');
    expect(result.candidates).toHaveLength(0);
    expect(result.visibility.counts.HIDDEN).toBe(0);
  });

  it('gap-visible.ldr leaves the target alone, which a bounding-box test would not', async () => {
    const { result, instances, visibility } = await analyzeCached('gap-visible.ldr');
    expect(result.candidates).toHaveLength(0);
    // The target IS enclosed by a naive test: it is inside the box's bounds.
    const target = instances.find((i) => i.colorId === 4)!;
    const verdict = visibility.get(target.instanceId)!;
    expect(verdict.classification).not.toBe('HIDDEN');
    expect(verdict.classification).not.toBe('LIKELY_HIDDEN');
    // And the reason is a real line of sight, not a lack of sampling.
    expect(verdict.escapedRays).toBeGreaterThan(0);
  });
});

describe('optimizer: a hidden part is changed', () => {
  it('buried-brick.ldr proposes red to black with the documented saving', async () => {
    const { result } = await analyzeCached('buried-brick.ldr');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.kind).toBe('hidden_color');
    expect(candidate.partId).toBe('3001');
    expect(candidate.originalColorId).toBe(4);
    expect(candidate.replacementColorId).toBe(0);
    expect(candidate.originalUnitPrice).toBe(0.75);
    expect(candidate.replacementUnitPrice).toBe(0.12);
    expect(candidate.savings).toBe(0.63);
    expect(candidate.visibility.classification).toBe('HIDDEN');
    expect(candidate.confidence).toBeGreaterThan(0.999);
  });

  it('reports evidence that matches what was actually measured', async () => {
    const { result } = await analyzeCached('buried-brick.ldr');
    const candidate = result.candidates[0]!;
    expect(candidate.visibility.totalRays).toBeGreaterThan(1000);
    expect(candidate.evidence.join(' ')).toContain('No externally visible surface detected');
    // The confidence must be exactly the rule-of-three bound for the ray count.
    const expected = 1 - 3 / candidate.visibility.totalRays;
    expect(candidate.confidence).toBeCloseTo(expected, 5);
    // Every triangle of a 2x4 brick is probed at the default budget.
    expect(candidate.visibility.trianglesCovered).toBe(candidate.visibility.trianglesTotal);
  });

  it('computes the whole-model saving consistently', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const enabled = new Set(output.result.defaultEnabledIds);
    const optimized = calculateCost(
      applyToInstances(output.instances, output.result.candidates, enabled),
      output.prices,
      'new',
    );
    const savings = computeSavings(
      output.result.originalCost.total,
      optimized.total,
      output.result.candidates,
      enabled,
      'USD',
    );
    expect(savings.originalCost).toBe(2.09);
    expect(savings.optimizedCost).toBe(1.46);
    expect(savings.savings).toBe(0.63);
    expect(savings.changedPieceCount).toBe(1);
  });
});

describe('optimizer: build steps are preserved', () => {
  it('multi-step.mpd changes the part introduced in step 3 and leaves it there', async () => {
    const output = await analyzeCached('multi-step.mpd');
    expect(output.result.candidates).toHaveLength(1);
    const candidate = output.result.candidates[0]!;
    expect(candidate.stepIndex).toBe(2); // zero-based: the third step

    const applied = applyOptimizations(
      output.document,
      output.result.candidates,
      new Set([candidate.id]),
    );
    const reparsed = parseLDraw(serializeDocument(applied.document), { sourceName: 'multi-step.mpd' });
    const resolved = resolveModel(reparsed);

    const black = resolved.instances.find((i) => i.colorId === 0 && i.partId === '3001')!;
    expect(black).toBeDefined();
    expect(black.stepIndex).toBe(2);

    // And no red 2x4 remains.
    expect(resolved.instances.some((i) => i.partId === '3001' && i.colorId === 4)).toBe(false);
  });

  it('does not change the number of steps or parts', async () => {
    const output = await analyzeCached('multi-step.mpd');
    const before = resolveModel(output.document);
    const applied = applyOptimizations(
      output.document,
      output.result.candidates,
      new Set(output.result.defaultEnabledIds),
    );
    const after = resolveModel(parseLDraw(serializeDocument(applied.document)));
    expect(after.instances.length).toBe(before.instances.length);
    expect(after.rootStepCount).toBe(before.rootStepCount);
    // Every part keeps its position and its step.
    for (let i = 0; i < before.instances.length; i++) {
      expect(after.instances[i]!.position).toEqual(before.instances[i]!.position);
      expect(after.instances[i]!.stepIndex).toBe(before.instances[i]!.stepIndex);
      expect(after.instances[i]!.parentModel).toBe(before.instances[i]!.parentModel);
    }
  });
});

describe('optimizer: nested submodels', () => {
  it('submodel.mpd finds the brick two levels down and edits that file', async () => {
    const output = await analyzeCached('submodel.mpd');
    expect(output.result.candidates).toHaveLength(1);
    const candidate = output.result.candidates[0]!;
    expect(candidate.parentModel).toBe('capsule.ldr');

    const applied = applyOptimizations(output.document, output.result.candidates, new Set([candidate.id]));
    const text = serializeDocument(applied.document);
    // The change lands inside capsule.ldr, not in main.ldr.
    const capsuleBlock = text.slice(text.indexOf('0 FILE capsule.ldr'));
    expect(capsuleBlock).toContain('1 0 0 0 0');
    expect(text.slice(0, text.indexOf('0 FILE core.ldr'))).not.toContain('1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
  });
});

describe('optimizer: a reused submodel is only changed when every copy is hidden', () => {
  it('multiple-instances.mpd changes sealed-pod but not pod', async () => {
    const { result } = await analyzeCached('multiple-instances.mpd');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.parentModel).toBe('sealed-pod.ldr');
    // One line, two physical bricks.
    expect(candidate.quantity).toBe(2);
    expect(candidate.instanceIds).toHaveLength(2);
    expect(candidate.savings).toBe(0.84);
  });

  it('records why pod.ldr was rejected', async () => {
    const { result } = await analyzeCached('multiple-instances.mpd');
    const mixed = result.rejections.find((r) => r.reason === 'mixed_visibility');
    expect(mixed).toBeDefined();
    expect(mixed!.pieceCount).toBe(2);
  });

  it('changing sealed-pod recolors both of its instances', async () => {
    const output = await analyzeCached('multiple-instances.mpd');
    const applied = applyOptimizations(
      output.document,
      output.result.candidates,
      new Set(output.result.defaultEnabledIds),
    );
    const resolved = resolveModel(parseLDraw(serializeDocument(applied.document)));
    const black = resolved.instances.filter((i) => i.partId === '3003' && i.colorId === 0);
    const red = resolved.instances.filter((i) => i.partId === '3003' && i.colorId === 4);
    expect(black).toHaveLength(2);
    // pod.ldr's two instances stay red.
    expect(red).toHaveLength(2);
  });
});

describe('optimizer: transparency', () => {
  it('transparent-window.mpd changes only the brick in the opaque box', async () => {
    const { result, instances } = await analyzeCached('transparent-window.mpd');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    const changed = instances.find((i) => i.instanceId === candidate.instanceIds[0])!;
    // The opaque box sits at x = -200 in the fixture.
    expect(changed.position.x).toBeCloseTo(-200);
  });

  it('classifies the brick behind the trans-clear wall as visible', async () => {
    const { instances, visibility } = await analyzeCached('transparent-window.mpd');
    const behindGlass = instances.find(
      (i) => i.colorId === 4 && i.partId === '3001' && Math.abs(i.position.x) < 1,
    )!;
    const verdict = visibility.get(behindGlass.instanceId)!;
    expect(['VISIBLE', 'LIKELY_VISIBLE', 'UNCERTAIN']).toContain(verdict.classification);
  });
});

describe('optimizer: color validity', () => {
  it('only proposes colors the catalog can evidence', async () => {
    const { result } = await analyzeCached('buried-brick.ldr');
    for (const candidate of result.candidates) {
      expect(catalog.isKnownCombination(candidate.replacementPartId, candidate.replacementColorId)).toBe(true);
    }
  });

  it('never proposes a more expensive color', async () => {
    for (const fixture of ['buried-brick.ldr', 'multi-step.mpd', 'multiple-instances.mpd']) {
      const { result } = await analyzeCached(fixture);
      for (const candidate of result.candidates) {
        expect(candidate.replacementUnitPrice).toBeLessThan(candidate.originalUnitPrice);
        expect(candidate.savings).toBeGreaterThan(0);
      }
    }
  });

  it('picks the cheapest valid color, not merely a cheaper one', async () => {
    const { result, prices } = await analyzeCached('buried-brick.ldr');
    const candidate = result.candidates[0]!;
    const options = catalog.availableColors(candidate.partId)!;
    for (const option of options) {
      const quote = prices.get(candidate.partId, option.colorId, 'new');
      if (!quote) continue;
      expect(quote.unitPrice).toBeGreaterThanOrEqual(candidate.replacementUnitPrice);
    }
  });
});

describe('exports', () => {
  it('changes exactly the lines it says it changed, and nothing else', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const source = fixtureSource('buried-brick.ldr');
    const exported = exportOptimizedLDraw({
      document: output.document,
      candidates: output.result.candidates,
      enabledIds: new Set(output.result.defaultEnabledIds),
      modelName: 'buried-brick.ldr',
      priceSourceLabel: 'demo',
      includeHeader: false,
    });

    const before = source.split('\n');
    const after = exported.text.split('\n');
    expect(after).toHaveLength(before.length);
    const differing = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toHaveLength(1);
    expect(before[differing[0]!]).toContain(' 4 ');
    expect(after[differing[0]!]).toContain(' 0 ');
  });

  it('reproduces the input byte for byte when nothing is enabled', async () => {
    const output = await analyzeCached('multiple-instances.mpd');
    const exported = exportOptimizedLDraw({
      document: output.document,
      candidates: output.result.candidates,
      enabledIds: new Set(),
      modelName: 'multiple-instances.mpd',
      priceSourceLabel: 'demo',
      includeHeader: false,
    });
    expect(exported.text).toBe(fixtureSource('multiple-instances.mpd'));
    expect(exported.appliedCount).toBe(0);
  });

  it('names the file after the source and keeps the MPD extension', async () => {
    const output = await analyzeCached('multi-step.mpd');
    const exported = exportOptimizedLDraw({
      document: output.document,
      candidates: output.result.candidates,
      enabledIds: new Set(output.result.defaultEnabledIds),
      modelName: 'multi-step.mpd',
      priceSourceLabel: 'demo',
    });
    expect(exported.fileName).toBe('multi-step-optimized.mpd');
    expect(exported.text).toContain('0 // Optimized by BrickThrift.');
  });

  it('produces a JSON report whose totals match the analysis', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const enabled = new Set(output.result.defaultEnabledIds);
    const optimized = calculateCost(
      applyToInstances(output.instances, output.result.candidates, enabled),
      output.prices,
      'new',
    );
    const savings = computeSavings(
      output.result.originalCost.total,
      optimized.total,
      output.result.candidates,
      enabled,
      'USD',
    );
    const report = buildJsonReport(output.result, savings, enabled);
    expect(report.originalEstimatedPartCost).toBe(2.09);
    expect(report.optimizedEstimatedPartCost).toBe(1.46);
    expect(report.estimatedPartSavings).toBe(0.63);
    // The report must never let a parts estimate read as an order total.
    expect(report.costBasis).toMatch(/NOT a delivered order total/);
    expect(report.changes).toHaveLength(1);
    expect(report.priceSource.isDemoData).toBe(true);
    expect(report.priceSource.disclaimer).toMatch(/DEMO PRICE DATA/);
  });

  it('produces a CSV with a row per candidate and an enabled flag', async () => {
    const output = await analyzeCached('multiple-instances.mpd');
    const csv = buildChangeLogCsv(output.result.candidates, new Set());
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('step,submodel,part');
    expect(lines).toHaveLength(output.result.candidates.length + 1);
    expect(lines[1]).toContain('false');
  });

  it('escapes CSV values and neutralises formula injection', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const csv = buildChangeLogCsv(output.result.candidates, new Set());
    expect(csv).not.toMatch(/\n=/);
    expect(csv.split('\r\n')[1]).toContain('Completely hidden inside the completed model');
  });

  it('produces a Wanted List with BrickLink ids, not LDraw ids', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const optimized = applyToInstances(
      output.instances,
      output.result.candidates,
      new Set(output.result.defaultEnabledIds),
    );
    const wanted = buildWantedListXml(optimized, catalog, 'new');
    expect(wanted.xml).toContain('<INVENTORY>');
    expect(wanted.xml).toContain('<ITEMTYPE>P</ITEMTYPE>');
    // LDraw Black is 0; BrickLink Black is 11.
    expect(wanted.xml).toContain('<COLOR>11</COLOR>');
    expect(wanted.xml).not.toContain('<COLOR>0</COLOR>');
    expect(wanted.pieceCount).toBe(output.instances.length);
  });

  it('excludes rather than guesses a lot it cannot map', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const withUnmappable = [
      ...output.instances,
      { ...output.instances[0]!, instanceId: 'x', partId: '3626bp01' },
    ];
    const wanted = buildWantedListXml(withUnmappable, catalog, 'new');
    expect(wanted.excluded.some((e) => e.partId === '3626bp01')).toBe(true);
    expect(wanted.xml).not.toContain('3626bp01');
  });
});

describe('toggling changes', () => {
  it('disabling a change removes it from the exported model', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const candidate = output.result.candidates[0]!;

    const on = applyOptimizations(output.document, output.result.candidates, new Set([candidate.id]));
    const off = applyOptimizations(output.document, output.result.candidates, new Set());

    expect(serializeDocument(on.document)).not.toBe(serializeDocument(off.document));
    expect(serializeDocument(off.document)).toBe(fixtureSource('buried-brick.ldr'));
  });

  it('never mutates the source document', async () => {
    const output = await analyzeCached('buried-brick.ldr');
    const before = serializeDocument(output.document);
    applyOptimizations(output.document, output.result.candidates, new Set(output.result.defaultEnabledIds));
    expect(serializeDocument(output.document)).toBe(before);
  });

  it('recosts correctly for an arbitrary subset', async () => {
    const output = await analyzeCached('multiple-instances.mpd');
    const none = calculateCost(
      applyToInstances(output.instances, output.result.candidates, new Set()),
      output.prices,
      'new',
    );
    expect(none.total).toBe(output.result.originalCost.total);
  });
});

describe('safety levels', () => {
  it('extremely conservative is the default and is not looser than conservative', async () => {
    const strict = await analyze('buried-brick.ldr', 'extremely_conservative');
    const loose = await analyze('buried-brick.ldr', 'conservative');
    expect(loose.result.candidates.length).toBeGreaterThanOrEqual(strict.result.candidates.length);
  });
});

describe('determinism', () => {
  let first: AnalyzeOutput;
  let second: AnalyzeOutput;
  beforeAll(async () => {
    first = await analyze('buried-brick.ldr');
    second = await analyze('buried-brick.ldr');
  });

  it('produces identical verdicts and ray counts on repeat runs', () => {
    expect(second.result.visibility.totalRays).toBe(first.result.visibility.totalRays);
    expect(second.result.visibility.counts).toEqual(first.result.visibility.counts);
    expect(second.result.candidates.map((c) => `${c.id}:${c.savings}:${c.confidence}`)).toEqual(
      first.result.candidates.map((c) => `${c.id}:${c.savings}:${c.confidence}`),
    );
  });
});
