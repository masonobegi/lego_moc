/**
 * Regression tests for defects found by an adversarial review of the
 * safety-critical code. Each test names the finding it pins down.
 *
 * The vertical blind cone finding has its own file, tests/verticalShaft.test.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeModel } from '@/lib/analysis/pipeline';
import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from '@/lib/catalog/catalogService';
import { MemoryPartSource } from '@/lib/geometry/partSource';
import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { PartMeshLibrary } from '@/lib/geometry/partMesh';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { serializeDocument } from '@/lib/ldraw/serializer';
import { applyOptimizations } from '@/lib/optimizer/applyOptimizations';
import { BrickLinkPriceProvider } from '@/lib/pricing/bricklinkProvider';
import { PriceCache } from '@/lib/pricing/cache';
import { assessAvailability } from '@/lib/pricing/availability';
import { DemoPriceProvider } from '@/lib/pricing/demoProvider';
import { checkContentLength } from '@/lib/security/requestGuards';
import { LIMITS } from '@/lib/security/limits';
import type { OptimizationCandidate } from '@/lib/optimizer/types';

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

describe('a malformed line inside a part file is not silently dropped', () => {
  it('marks the mesh incomplete so the part cannot reach the top confidence tier', async () => {
    const source = new MemoryPartSource({
      'parts/broken.dat': [
        '0 Broken Test Part',
        '3 16 0 0 0 10 0 0 10 10 0',
        // A triangle with an unreadable coordinate: this WAS silently skipped,
        // leaving a hole in the occluder with nothing recorded about it.
        '3 16 0 0 0 10 0 0 10 NOTANUMBER 0',
        '4 16 0 0 0 10 0 0 10 10 0 0 10 0',
      ].join('\n'),
    });
    const mesh = await new PartMeshLibrary(source).get('broken.dat');

    expect(mesh.triangleCount).toBe(3); // the quad became two triangles
    expect(mesh.malformedLines).toBe(1);
    expect(mesh.truncated).toBe(true);
  });

  it('leaves a clean part unmarked', async () => {
    const mesh = await new PartMeshLibrary(partSource).get('3001.dat');
    expect(mesh.malformedLines).toBe(0);
    expect(mesh.truncated).toBe(false);
  });
});

describe('expansion work is bounded, not just the instance count', () => {
  it('stops a submodel graph that multiplies out exponentially', () => {
    // A chain of sub-files each referencing the previous one twice. It contains
    // NO library parts, so it produces no instances and the instance cap can
    // never fire, while the walk itself is 2^depth.
    const lines = ['0 FILE root.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 l40.ldr', '0 FILE l0.ldr', '0 empty'];
    for (let level = 1; level <= 40; level++) {
      lines.push(`0 FILE l${level}.ldr`);
      lines.push(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 l${level - 1}.ldr`);
      lines.push(`1 16 100 0 0 1 0 0 0 1 0 0 0 1 l${level - 1}.ldr`);
    }

    const started = Date.now();
    const resolved = resolveModel(parseLDraw(lines.join('\n')), { maxFrames: 50_000 });
    const elapsed = Date.now() - started;

    expect(resolved.instances).toHaveLength(0);
    expect(resolved.truncated).toBe(true);
    expect(resolved.truncationReason).toMatch(/exceeded/);
    // Without the frame cap this never terminates.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('has a default frame limit', () => {
    expect(LIMITS.maxExpansionFrames).toBeGreaterThan(0);
  });
});

describe('a truncated expansion produces no candidates', () => {
  it('refuses to propose changes when not every copy was enumerated', async () => {
    // A model that expands past a deliberately tiny instance cap.
    const lines = ['0 Truncation Test', '0 Name: trunc.ldr'];
    for (let i = 0; i < 40; i++) {
      lines.push(`1 4 ${i * 100} 0 0 1 0 0 0 1 0 0 0 1 3001.dat`);
    }
    lines.push('0 STEP');

    const output = await analyzeModel({
      source: lines.join('\n'),
      fileName: 'trunc.ldr',
      partSource,
      catalog,
      priceProvider: new DemoPriceProvider(),
      condition: 'new',
      safetyLevel: 'extremely_conservative',
      exhaustiveColorSearch: true,
      singleThreaded: true,
      resolveOptions: { maxInstances: 10 },
    });

    expect(output.result.parse.truncated).toBe(true);
    expect(output.result.candidates).toHaveLength(0);
    expect(output.result.rejections.map((r) => r.reason)).toContain('expansion_truncated');
  }, 120_000);
});

describe('the BrickLink cache key carries the pricing context', () => {
  function providerWith(overrides: Partial<{ guideType: 'stock' | 'sold'; currency: string; region: string }>, cache: PriceCache) {
    return new BrickLinkPriceProvider({
      credentials: { consumerKey: 'k', consumerSecret: 's', tokenValue: 't', tokenSecret: 'ts' },
      guideType: overrides.guideType ?? 'stock',
      currency: overrides.currency ?? 'USD',
      region: overrides.region,
      cache,
      mapPart: (partId) => partId,
      mapColor: () => 11,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            meta: { code: 200 },
            data: { avg_price: '1.00', qty_avg_price: '1.00', currency_code: overrides.currency ?? 'USD', unit_quantity: 20 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
  }

  it('does not serve a sold-price figure to a stock-price request', async () => {
    // One shared cache, as the app uses: the process-wide singleton.
    const cache = new PriceCache(60_000);
    const sold = providerWith({ guideType: 'sold' }, cache);
    const stock = providerWith({ guideType: 'stock' }, cache);

    const first = await sold.getPrice('3001', 0, 'new');
    expect(first?.sourceDetail).toMatch(/last 6 months/);

    const second = await stock.getPrice('3001', 0, 'new');
    // The cache must NOT have answered this with the sold figure.
    expect(second?.sourceDetail).toMatch(/current items for sale/);
  });

  it('does not serve a EUR figure to a USD request', async () => {
    const cache = new PriceCache(60_000);
    const euros = providerWith({ currency: 'EUR' }, cache);
    const dollars = providerWith({ currency: 'USD' }, cache);

    expect((await euros.getPrice('3001', 0, 'new'))?.currency).toBe('EUR');
    expect((await dollars.getPrice('3001', 0, 'new'))?.currency).toBe('USD');
  });

  it('still caches a genuinely identical request', async () => {
    const cache = new PriceCache(60_000);
    let calls = 0;
    const provider = new BrickLinkPriceProvider({
      credentials: { consumerKey: 'k', consumerSecret: 's', tokenValue: 't', tokenSecret: 'ts' },
      guideType: 'stock',
      currency: 'USD',
      cache,
      mapPart: (partId) => partId,
      mapColor: () => 11,
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({ meta: { code: 200 }, data: { avg_price: '1.00', currency_code: 'USD' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await provider.getPrice('3001', 0, 'new');
    await provider.getPrice('3001', 0, 'new');
    expect(calls).toBe(1);
  });
});

describe('parser warnings are bounded', () => {
  it('caps the warning array on a file full of bad lines', () => {
    const source = Array.from({ length: 5000 }, () => 'this is not a valid LDraw line').join('\n');
    const document = parseLDraw(source);

    expect(document.warnings.length).toBeLessThanOrEqual(201);
    // The count is still exact, because it comes from a counter.
    expect(document.malformedLineCount).toBe(5000);
    expect(document.suppressedWarningCount).toBeGreaterThan(0);
    expect(document.warnings.at(-1)!.message).toMatch(/further warnings were suppressed/);
    // And every line is still preserved.
    expect(serializeDocument(document)).toBe(source);
  });

  it('keeps every warning when there are few', () => {
    const document = parseLDraw(['1 4 0 0 0 3001.dat', '0 fine'].join('\n'));
    expect(document.malformedLineCount).toBe(1);
    expect(document.suppressedWarningCount).toBe(0);
  });
});

describe('a mold swap on an inherit-color line is actually applied', () => {
  it('rewrites the part reference and leaves color 16 alone', () => {
    const source = [
      '0 FILE main.ldr',
      '1 71 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
      '0 FILE sub.ldr',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3070a.dat',
    ].join('\n');
    const document = parseLDraw(source);
    const instances = resolveModel(document).instances;
    const target = instances.find((i) => i.partId === '3070a')!;

    const candidate: OptimizationCandidate = {
      id: 'mold:test',
      kind: 'mold_equivalent',
      commandRef: target.commandRef,
      quantity: 1,
      instanceIds: [target.instanceId],
      parentModel: 'sub.ldr',
      stepIndex: 0,
      partId: '3070a',
      partDescription: 'Tile 1 x 1 without Groove',
      originalPartId: '3070a',
      // The EFFECTIVE color, which is what the optimizer records - the line
      // itself says 16.
      originalColorId: 71,
      originalColorName: 'Light Bluish Gray',
      replacementPartId: '3070b',
      replacementColorId: 71,
      replacementColorName: 'Light Bluish Gray',
      originalUnitPrice: 0.28,
      replacementUnitPrice: 0.05,
      originalTotal: 0.28,
      replacementTotal: 0.05,
      savings: 0.23,
      reason: 'Equivalent mold',
      confidence: 0.92,
      visibility: {
        classification: 'HIDDEN',
        confidence: 0.999,
        totalRays: 1000,
        trianglesCovered: 44,
        trianglesTotal: 44,
        evidence: 'test',
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
    };

    const applied = applyOptimizations(document, [candidate], new Set(['mold:test']));

    // The change was applied, not silently skipped.
    expect(applied.appliedCount).toBe(1);
    expect(applied.skipped).toHaveLength(0);

    const text = serializeDocument(applied.document);
    expect(text).toContain('1 16 0 0 0 1 0 0 0 1 0 0 0 1 3070b.dat');
    expect(text).not.toContain('3070a.dat');
    // The inherit color is preserved, so the part still takes its parent's color.
    const after = resolveModel(parseLDraw(text)).instances[0]!;
    expect(after.declaredColorId).toBe(16);
    expect(after.colorId).toBe(71);
  });

  it('still refuses a swap whose target line does not match', () => {
    const document = parseLDraw('1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
    const instance = resolveModel(document).instances[0]!;
    const candidate = {
      id: 'mold:mismatch',
      kind: 'mold_equivalent' as const,
      commandRef: instance.commandRef,
      quantity: 1,
      instanceIds: [instance.instanceId],
      parentModel: 'm',
      stepIndex: 0,
      partId: '3070a',
      partDescription: 'x',
      originalPartId: '3070a',
      originalColorId: 16,
      originalColorName: 'x',
      replacementPartId: '3070b',
      replacementColorId: 16,
      replacementColorName: 'x',
      originalUnitPrice: 1,
      replacementUnitPrice: 0,
      originalTotal: 1,
      replacementTotal: 0,
      savings: 1,
      reason: 'x',
      confidence: 1,
      visibility: {
        classification: 'HIDDEN' as const,
        confidence: 1,
        totalRays: 1,
        trianglesCovered: 1,
        trianglesTotal: 1,
        evidence: '',
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
    };
    const applied = applyOptimizations(document, [candidate], new Set(['mold:mismatch']));
    expect(applied.appliedCount).toBe(0);
    expect(applied.skipped[0]!.reason).toMatch(/expected part 3070a/);
  });
});

describe('oversized uploads are rejected before the body is read', () => {
  const url = 'http://localhost/api/analyze';

  it('rejects a Content-Length over the limit with 413', () => {
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-length': String(LIMITS.maxFileBytes * 10) },
    });
    const response = checkContentLength(request);
    expect(response?.status).toBe(413);
  });

  it('requires a Content-Length header', () => {
    const request = new Request(url, { method: 'POST' });
    expect(checkContentLength(request)?.status).toBe(411);
  });

  it('allows a normal upload through', () => {
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-length': '4096' },
    });
    expect(checkContentLength(request)).toBeNull();
  });

  it('allows multipart framing overhead', () => {
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-length': String(LIMITS.maxFileBytes + 1024) },
    });
    expect(checkContentLength(request)).toBeNull();
  });
});
