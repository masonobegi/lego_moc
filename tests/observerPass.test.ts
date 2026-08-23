/**
 * Regression tests for the observer pass.
 *
 * The surface-escape pass asks "does a ray leaving a random point on this part
 * in a random direction get out?". For a part visible only through a small
 * gap that is a rare event in a four-dimensional space - the point has to land
 * on the patch facing the gap AND the direction has to fall inside the gap's
 * solid angle. Measured on the UCS Millennium Falcon, such parts escape on the
 * order of one ray in a hundred thousand, and raising the budget converges
 * painfully slowly: 34.7% of accepted parts were found visible at 34,200 rays
 * each, still climbing to 58.5% at 804,000 rays each.
 *
 * The observer pass asks the question an observer asks - "standing over there,
 * do I see this part?" - by laying rays out on the IMAGE PLANE, which is where
 * the gap's aperture actually is. Across fifteen real models it cut the rate of
 * proposed changes with a genuine line of sight from 15.9% to 1.4%.
 *
 * These tests use synthetic geometry rather than real LDraw parts so the
 * aperture size is exact and the result cannot drift with a parts-library
 * update.
 */

import { describe, expect, it } from 'vitest';

import { PartMeshLibrary, type PartMesh } from '@/lib/geometry/partMesh';
import { MemoryPartSource } from '@/lib/geometry/partSource';
import { ModelScene } from '@/lib/geometry/scene';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { analyzeVisibility, DEFAULT_VISIBILITY_OPTIONS } from '@/lib/optimizer/visibilityEngine';

/** Two triangles making an axis-aligned rectangle in the plane y = `y`. */
function quadY(y: number, x0: number, z0: number, x1: number, z1: number): string {
  return (
    `3 16 ${x0} ${y} ${z0} ${x1} ${y} ${z0} ${x1} ${y} ${z1}\n` +
    `3 16 ${x0} ${y} ${z0} ${x1} ${y} ${z1} ${x0} ${y} ${z1}\n`
  );
}
function quadX(x: number, y0: number, z0: number, y1: number, z1: number): string {
  return (
    `3 16 ${x} ${y0} ${z0} ${x} ${y1} ${z0} ${x} ${y1} ${z1}\n` +
    `3 16 ${x} ${y0} ${z0} ${x} ${y1} ${z1} ${x} ${y0} ${z1}\n`
  );
}
function quadZ(z: number, x0: number, y0: number, x1: number, y1: number): string {
  return (
    `3 16 ${x0} ${y0} ${z} ${x1} ${y0} ${z} ${x1} ${y1} ${z}\n` +
    `3 16 ${x0} ${y0} ${z} ${x1} ${y1} ${z} ${x0} ${y1} ${z}\n`
  );
}

/** A solid 20 LDU cube centred on the origin - the part we might recolor. */
const TARGET = [
  quadY(-10, -10, -10, 10, 10),
  quadY(10, -10, -10, 10, 10),
  quadX(-10, -10, -10, 10, 10),
  quadX(10, -10, -10, 10, 10),
  quadZ(-10, -10, -10, 10, 10),
  quadZ(10, -10, -10, 10, 10),
].join('');

/**
 * A closed 200 LDU box around the origin. The top face is built from four
 * rectangles leaving a square hole `aperture` LDU across, centred `offsetX` LDU
 * along x; pass aperture 0 for a sealed box.
 *
 * The offset matters. A hole directly above the target is found by the escape
 * pass on its own, because that pass always probes the six world axes and
 * straight up goes through it. Moving the hole sideways makes the only line of
 * sight an oblique one, which is the case that separates the two methods.
 */
function shell(aperture: number, offsetX = 0): string {
  const h = 100;
  const a = aperture / 2;
  const c = offsetX;
  const top =
    aperture === 0
      ? quadY(-h, -h, -h, h, h)
      : // Four bands around the hole.
        quadY(-h, -h, -h, c - a, h) +
        quadY(-h, c + a, -h, h, h) +
        quadY(-h, c - a, -h, c + a, -a) +
        quadY(-h, c - a, a, c + a, h);
  return [
    top,
    quadY(h, -h, -h, h, h),
    quadX(-h, -h, -h, h, h),
    quadX(h, -h, -h, h, h),
    quadZ(-h, -h, -h, h, h),
    quadZ(h, -h, -h, h, h),
  ].join('');
}

async function verdict(aperture: number, offsetX: number, observerViewpoints: number) {
  const source = new MemoryPartSource({
    'target.dat': `0 Target\n0 BFC CERTIFY CCW\n${TARGET}`,
    'shell.dat': `0 Shell\n0 BFC CERTIFY CCW\n${shell(aperture, offsetX)}`,
  });
  const document = parseLDraw(
    '0 Aperture test\n' +
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 target.dat\n' +
      '1 71 0 0 0 1 0 0 0 1 0 0 0 1 shell.dat\n' +
      '0 STEP\n',
    { sourceName: 'aperture.ldr' },
  );
  const resolved = resolveModel(document);
  const library = new PartMeshLibrary(source);
  const meshes = new Map<string, PartMesh>();
  for (const instance of resolved.instances) {
    if (!meshes.has(instance.partId)) meshes.set(instance.partId, await library.get(instance.partFile));
  }
  const scene = new ModelScene(resolved.instances, meshes);
  const targets = scene.visibilityTargets(resolved.instances);
  const analysis = analyzeVisibility(scene, targets, meshes, {
    ...DEFAULT_VISIBILITY_OPTIONS,
    observerViewpoints,
  });
  const targetInstance = resolved.instances.find((i) => i.partId === 'target')!;
  return analysis.results.get(targetInstance.instanceId)!;
}

describe('a part inside a sealed shell', () => {
  it('is hidden', async () => {
    const result = await verdict(0, 0, DEFAULT_VISIBILITY_OPTIONS.observerViewpoints);
    expect(result.classification).toBe('HIDDEN');
    expect(result.escapedRays).toBe(0);
  }, 120_000);
});

describe('a part visible only through a small off-axis hole', () => {
  // Each of these is HIDDEN to surface-escape sampling alone. The observer
  // pass is what keeps them off the change list.
  it.each([
    { aperture: 6, offsetX: 40, mm: '2.4 mm hole, 16 mm off-axis' },
    { aperture: 4, offsetX: 60, mm: '1.6 mm hole, 24 mm off-axis' },
    { aperture: 10, offsetX: 40, mm: '4 mm hole, 16 mm off-axis' },
  ])('is never recolored: $mm', async ({ aperture, offsetX }) => {
    const withoutObserver = await verdict(aperture, offsetX, 0);
    // Establishes that this case really does defeat surface sampling, so the
    // test cannot quietly stop testing anything if the geometry drifts.
    expect(withoutObserver.classification).toBe('HIDDEN');

    const withObserver = await verdict(aperture, offsetX, DEFAULT_VISIBILITY_OPTIONS.observerViewpoints);
    expect(withObserver.classification).toBe('LIKELY_VISIBLE');
    expect(withObserver.evidence).toContain('through a gap');
  }, 120_000);
});

describe('the limit of what the observer pass finds', () => {
  it('a 2.4 mm hole 32 mm off-axis is missed by both passes', async () => {
    // Recorded, not celebrated. The line of sight through this hole exists over
    // roughly four degrees of viewing direction, which is narrower than the
    // spacing between observer viewpoints, and it is far too rare an event for
    // surface sampling to find. A part like this WOULD be recolored.
    //
    // This is the shape of the residual: across fifteen real models, 1.4% of
    // proposed changes still had a genuine line of sight when re-checked at a
    // much higher budget. The product reports its confidence as a bound on how
    // much of a part can be seen, never as a proof that none of it can be, and
    // docs/AUDIT.md carries the measured number.
    const result = await verdict(6, 80, DEFAULT_VISIBILITY_OPTIONS.observerViewpoints);
    expect(result.classification).toBe('HIDDEN');
  }, 120_000);
});
