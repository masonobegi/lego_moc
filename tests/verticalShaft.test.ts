/**
 * Regression test for the vertical blind cone.
 *
 * An adversarial review found that the visibility engine rotated its direction
 * lattice about the Y axis only. Y is exactly the axis the Fibonacci lattice's
 * elevations are defined on, so that rotation changed azimuth and nothing else:
 * every sample point of every part in every model probed the same fixed set of
 * elevations, leaving an unsampled polar cone of half-angle
 * `arccos(1 - 1/count)` - 14.4 degrees at 32 directions - around the vertical.
 *
 * LDraw's Y axis is the model's vertical, so that cone sat exactly where a
 * model on a shelf is most often looked at from. A 1x1 brick at the bottom of a
 * one-stud shaft was classified HIDDEN with zero escaping rays out of ten
 * thousand, and would have been recolored - the precise failure this product
 * exists to avoid.
 *
 * These tests build that shaft out of real LDraw parts and run it through the
 * real pipeline.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeModel } from '@/lib/analysis/pipeline';
import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from '@/lib/catalog/catalogService';
import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { DemoPriceProvider } from '@/lib/pricing/demoProvider';
import { AXIS_DIRECTIONS, directionSet, pointRotation } from '@/lib/optimizer/sampling';
import { readFileSync } from 'node:fs';

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

/**
 * A vertical shaft one stud across and `depth` bricks deep, with a red 1x1
 * brick at the bottom. Looking straight down, that brick is visible.
 *
 * A 1x1 brick (3005) spans x,z in -10..10 and y from its origin to origin+24.
 * The shaft walls are 1x1 bricks on all four sides at each level, sitting on a
 * 6x6 plate floor.
 */
function chimneyShaft(depth: number): string {
  const lines = [
    '0 Vertical Shaft',
    '0 Name: shaft.ldr',
    '0 // A one-stud shaft with a red 1x1 brick at the bottom, visible from directly above.',
    '',
    // Floor: 6x6 plate, top surface at y = 0.
    '1 71 0 0 0 1 0 0 0 1 0 0 0 1 3958.dat',
    // The target, sitting on the floor: occupies y -24..0.
    '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3005.dat',
  ];
  // Walls: a ring of 1x1 bricks around the shaft at every level, including the
  // level the target occupies.
  const ring = [
    [-20, 0], [20, 0], [0, -20], [0, 20],
    [-20, -20], [-20, 20], [20, -20], [20, 20],
  ];
  for (let level = 0; level < depth; level++) {
    const y = -24 * (level + 1);
    for (const [x, z] of ring) {
      lines.push(`1 71 ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 3005.dat`);
    }
  }
  lines.push('0 STEP');
  return lines.join('\n') + '\n';
}

async function analyzeShaft(depth: number) {
  return analyzeModel({
    source: chimneyShaft(depth),
    fileName: 'shaft.ldr',
    partSource,
    catalog,
    priceProvider: new DemoPriceProvider(),
    condition: 'new',
    safetyLevel: 'extremely_conservative',
    exhaustiveColorSearch: true,
    singleThreaded: true,
  });
}

describe('a part at the bottom of a vertical shaft is visible', () => {
  // Depths well past the point at which the old Y-only rotation gave up.
  it.each([2, 4, 6, 8])(
    'is never classified hidden at %i bricks deep',
    async (depth) => {
      const { result, instances, visibility } = await analyzeShaft(depth);
      const target = instances.find((i) => i.colorId === 4)!;
      expect(target).toBeDefined();

      const verdict = visibility.get(target.instanceId)!;
      expect(verdict.classification).not.toBe('HIDDEN');
      expect(verdict.classification).not.toBe('LIKELY_HIDDEN');
      // The reason must be a real escaping ray, not a lack of sampling.
      expect(verdict.escapedRays).toBeGreaterThan(0);

      // And no change is proposed for it.
      expect(result.candidates.some((c) => c.instanceIds.includes(target.instanceId))).toBe(false);
    },
    120_000,
  );

  it('still finds a genuinely sealed part in the same model', async () => {
    // Cap the shaft: now the target really is enclosed and should be found.
    const capped =
      chimneyShaft(2).replace('0 STEP\n', '') +
      // A 6x6 plate laid over the top of the two-level shaft, sealing it.
      '1 71 0 -80 0 1 0 0 0 1 0 0 0 1 3958.dat\n0 STEP\n';

    const output = await analyzeModel({
      source: capped,
      fileName: 'capped.ldr',
      partSource,
      catalog,
      priceProvider: new DemoPriceProvider(),
      condition: 'new',
      safetyLevel: 'extremely_conservative',
      exhaustiveColorSearch: true,
      singleThreaded: true,
    });

    const target = output.instances.find((i) => i.colorId === 4)!;
    const verdict = output.visibility.get(target.instanceId)!;
    expect(verdict.classification).toBe('HIDDEN');
    expect(output.result.candidates.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('direction sampling covers the whole sphere', () => {
  it('always includes the six world axes, unrotated', () => {
    const directions = directionSet(32);
    for (let i = 0; i < AXIS_DIRECTIONS.length; i++) {
      expect(directions[i]).toBe(AXIS_DIRECTIONS[i]);
    }
    // Straight down and straight up are both in there.
    expect([...directions.slice(0, 6)]).toEqual([0, 1, 0, 0, -1, 0]);
  });

  it('varies elevation between sample points, not only azimuth', () => {
    // The bug was that the per-point rotation preserved every direction's y
    // component. Applying the rotation to one lattice direction across many
    // points must now produce many distinct elevations.
    const lattice = directionSet(32);
    const elevations = new Set<string>();
    for (let point = 0; point < 400; point++) {
      const rot = pointRotation(point);
      // Take one lattice direction (skipping the fixed axes) and rotate it.
      const o = 6 * 3;
      const dx0 = lattice[o]!;
      const dy0 = lattice[o + 1]!;
      const dz0 = lattice[o + 2]!;
      const rz = dx0 * rot.sinY + dz0 * rot.cosY;
      const dy = dy0 * rot.cosX - rz * rot.sinX;
      elevations.add(dy.toFixed(6));
    }
    expect(elevations.size).toBeGreaterThan(300);
  });

  it('reaches elevations close to both poles across sample points', () => {
    const lattice = directionSet(32);
    let maxElevation = 0;
    for (let point = 0; point < 600; point++) {
      const rot = pointRotation(point);
      for (let d = 6; d < lattice.length / 3; d++) {
        const dx0 = lattice[d * 3]!;
        const dy0 = lattice[d * 3 + 1]!;
        const dz0 = lattice[d * 3 + 2]!;
        const rz = dx0 * rot.sinY + dz0 * rot.cosY;
        const dy = dy0 * rot.cosX - rz * rot.sinX;
        maxElevation = Math.max(maxElevation, Math.abs(dy));
      }
    }
    // Before the fix this capped at 1 - 1/32 = 0.96875 for every point.
    expect(maxElevation).toBeGreaterThan(0.999);
  });
});
