/**
 * The parallel visibility path must be indistinguishable from the in-process
 * one. Visibility decides whether a brick gets recolored, so "it is faster and
 * probably the same" is not good enough - this asserts it is byte-identical.
 */

import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { PartMeshLibrary, type PartMesh } from '@/lib/geometry/partMesh';
import { ModelScene } from '@/lib/geometry/scene';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { analyzeVisibility, DEFAULT_VISIBILITY_OPTIONS } from '@/lib/optimizer/visibilityEngine';
import { resolveWorkerFile, workerBundleIsCurrent } from '@/lib/optimizer/visibilityParallel';
import { runSlice } from '@/lib/optimizer/visibilityWorker';

const ROOT = process.cwd();
const partSource = new NodePartSource(path.join(ROOT, 'public', 'ldraw'));

async function build(fixture: string) {
  const document = parseLDraw(
    readFileSync(path.join(ROOT, 'test-models', fixture), 'utf8'),
    { sourceName: fixture },
  );
  const resolved = resolveModel(document);
  const library = new PartMeshLibrary(partSource);
  const meshes = new Map<string, PartMesh>();
  for (const instance of resolved.instances) {
    if (!meshes.has(instance.partId)) meshes.set(instance.partId, await library.get(instance.partFile));
  }
  const scene = new ModelScene(resolved.instances, meshes);
  return { scene, targets: scene.visibilityTargets(resolved.instances), meshes };
}

describe('scene serialization', () => {
  it('a transferred scene answers ray queries identically', async () => {
    const { scene, targets, meshes } = await build('buried-brick.ldr');
    const restored = ModelScene.fromTransfer(scene.toTransfer());

    const direct = analyzeVisibility(scene, targets, meshes, DEFAULT_VISIBILITY_OPTIONS);
    const viaTransfer = analyzeVisibility(restored, targets, meshes, DEFAULT_VISIBILITY_OPTIONS);

    for (const target of targets) {
      const a = direct.results.get(target.instanceId)!;
      const b = viaTransfer.results.get(target.instanceId)!;
      expect(b.classification).toBe(a.classification);
      expect(b.raysCast).toBe(a.raysCast);
      expect(b.escapedRays).toBe(a.escapedRays);
      expect(b.confidence).toBe(a.confidence);
    }
  });
});

describe('sliced analysis', () => {
  it('splitting the work across slices reproduces the whole-model result exactly', async () => {
    const { scene, targets, meshes } = await build('multiple-instances.mpd');
    const whole = analyzeVisibility(scene, targets, meshes, DEFAULT_VISIBILITY_OPTIONS);

    const transfer = scene.toTransfer();
    const meshPayload = [...meshes.entries()].map(([partId, mesh]) => ({
      partId,
      positions: mesh.positions,
      triangleCount: mesh.triangleCount,
    }));

    const sliceSize = Math.ceil(targets.length / 4);
    const merged = new Map<string, ReturnType<typeof analyzeVisibility>['results'] extends Map<string, infer V> ? V : never>();
    let totalRays = 0;
    for (let i = 0; i < 4; i++) {
      const output = runSlice({
        scene: transfer,
        targets,
        meshes: meshPayload,
        options: DEFAULT_VISIBILITY_OPTIONS,
        start: i * sliceSize,
        end: Math.min((i + 1) * sliceSize, targets.length),
      });
      for (const result of output.results) merged.set(result.instanceId, result);
      totalRays += output.totalRays;
    }

    expect(merged.size).toBe(whole.results.size);
    expect(totalRays).toBe(whole.stats.totalRays);
    for (const [id, expected] of whole.results) {
      const actual = merged.get(id)!;
      expect(actual.classification).toBe(expected.classification);
      expect(actual.raysCast).toBe(expected.raysCast);
      expect(actual.escapedRays).toBe(expected.escapedRays);
      expect(actual.confidence).toBe(expected.confidence);
      expect(actual.evidence).toBe(expected.evidence);
    }
  });

  it('slices cover every target exactly once', async () => {
    const { scene, targets, meshes } = await build('transparent-window.mpd');
    const transfer = scene.toTransfer();
    const meshPayload = [...meshes.entries()].map(([partId, mesh]) => ({
      partId,
      positions: mesh.positions,
      triangleCount: mesh.triangleCount,
    }));
    const seen: string[] = [];
    const sliceSize = 5;
    for (let start = 0; start < targets.length; start += sliceSize) {
      const output = runSlice({
        scene: transfer,
        targets,
        meshes: meshPayload,
        options: DEFAULT_VISIBILITY_OPTIONS,
        start,
        end: Math.min(start + sliceSize, targets.length),
      });
      seen.push(...output.results.map((r) => r.instanceId));
    }
    expect(new Set(seen).size).toBe(targets.length);
    expect(seen).toHaveLength(targets.length);
  });
});

/**
 * The worker is a separate esbuild bundle, so it does not rebuild when the
 * source does. A stale bundle runs old visibility code in the workers while the
 * parent runs current code - the two paths silently disagree about which parts
 * are hidden. Guard against it.
 *
 * These use a scratch directory rather than the repo so the assertions do not
 * depend on whether a build hook happened to run first.
 */
describe('stale worker bundles are refused', () => {
  function scratch(bundleMtime: number, sourceMtime: number) {
    const dir = mkdtempSync(path.join(tmpdir(), 'bt-worker-'));
    const bundle = path.join(dir, 'visibilityWorker.mjs');
    const source = path.join(dir, 'src');
    mkdirSync(source);
    writeFileSync(bundle, 'export {};');
    writeFileSync(path.join(source, 'sampling.ts'), 'export {};');
    writeFileSync(path.join(source, 'notes.md'), 'not source');
    utimesSync(bundle, new Date(bundleMtime), new Date(bundleMtime));
    utimesSync(path.join(source, 'sampling.ts'), new Date(sourceMtime), new Date(sourceMtime));
    // A non-TypeScript file far in the future must not disable the workers.
    utimesSync(path.join(source, 'notes.md'), new Date(sourceMtime + 1e6), new Date(sourceMtime + 1e6));
    return { dir, bundle, source };
  }

  it('accepts a bundle built after its source', () => {
    const { bundle, source } = scratch(2_000_000_000_000, 1_999_999_000_000);
    expect(workerBundleIsCurrent(bundle, source)).toBe(true);
  });

  it('rejects a bundle older than a source file', () => {
    const { bundle, source } = scratch(1_999_999_000_000, 2_000_000_000_000);
    expect(workerBundleIsCurrent(bundle, source)).toBe(false);
  });

  it('rejects a bundle older than a source file nested in a subdirectory', () => {
    const { bundle, source } = scratch(2_000_000_000_000, 1_999_999_000_000);
    const nested = path.join(source, 'geometry');
    mkdirSync(nested);
    const deep = path.join(nested, 'scene.ts');
    writeFileSync(deep, 'export {};');
    const future = new Date(2_000_001_000_000);
    utimesSync(deep, future, future);
    expect(workerBundleIsCurrent(bundle, source)).toBe(false);
  });

  it('rejects a bundle that is not there at all', () => {
    const { source } = scratch(2_000_000_000_000, 1_999_999_000_000);
    expect(workerBundleIsCurrent(path.join(source, '..', 'nope.mjs'), source)).toBe(false);
  });

  it('uses a bundle as-is when no source tree is on disk to compare against', () => {
    // A deployed standalone build ships the bundle without `src/`.
    const { bundle, dir } = scratch(1_000_000_000_000, 2_000_000_000_000);
    expect(workerBundleIsCurrent(bundle, path.join(dir, 'no-such-src'))).toBe(true);
  });

  it('trusts an explicitly configured path without checking mtimes', () => {
    const previous = process.env.VISIBILITY_WORKER_PATH;
    process.env.VISIBILITY_WORKER_PATH = '/definitely/not/here.mjs';
    try {
      // A host that points at a specific file has taken responsibility for it.
      expect(workerBundleIsCurrent('/definitely/not/here.mjs')).toBe(true);
      expect(resolveWorkerFile()).toBe('/definitely/not/here.mjs');
    } finally {
      if (previous === undefined) delete process.env.VISIBILITY_WORKER_PATH;
      else process.env.VISIBILITY_WORKER_PATH = previous;
    }
  });
});
