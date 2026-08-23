/**
 * The parallel visibility path must be indistinguishable from the in-process
 * one. Visibility decides whether a brick gets recoloured, so "it is faster and
 * probably the same" is not good enough - this asserts it is byte-identical.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { PartMeshLibrary, type PartMesh } from '@/lib/geometry/partMesh';
import { ModelScene } from '@/lib/geometry/scene';
import { parseLDraw } from '@/lib/ldraw/parser';
import { resolveModel } from '@/lib/ldraw/resolve';
import { analyzeVisibility, DEFAULT_VISIBILITY_OPTIONS } from '@/lib/optimizer/visibilityEngine';
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
