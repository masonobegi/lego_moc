/**
 * Worker-thread entry point for the visibility engine.
 *
 * Each worker receives the already-built scene as plain typed arrays - no BVH
 * is rebuilt - plus the slice of instances it is responsible for. Slices are
 * disjoint and the engine is fully deterministic, so the merged result is
 * identical to running single-threaded. `visibilityParallel.test.ts` asserts
 * exactly that.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { ModelScene, type TransferableScene } from '../geometry/scene';
import { analyzeVisibility, type VisibilityOptions, type VisibilityResult, type VisibilityTarget } from './visibilityEngine';
import type { SampleableMesh } from './sampling';

export interface VisibilityWorkerInput {
  readonly scene: TransferableScene;
  readonly targets: readonly VisibilityTarget[];
  readonly meshes: readonly { partId: string; positions: Float32Array; triangleCount: number }[];
  readonly options: VisibilityOptions;
  readonly start: number;
  readonly end: number;
}

export interface VisibilityWorkerOutput {
  readonly results: VisibilityResult[];
  readonly totalRays: number;
  readonly verifiedInstances: number;
}

export function runSlice(input: VisibilityWorkerInput): VisibilityWorkerOutput {
  const scene = ModelScene.fromTransfer(input.scene);
  const meshes = new Map<string, SampleableMesh>();
  for (const mesh of input.meshes) {
    meshes.set(mesh.partId, { positions: mesh.positions, triangleCount: mesh.triangleCount });
  }
  const analysis = analyzeVisibility(scene, input.targets, meshes, input.options, {
    start: input.start,
    end: input.end,
  });
  return {
    results: [...analysis.results.values()],
    totalRays: analysis.stats.totalRays,
    verifiedInstances: analysis.stats.verifiedInstances,
  };
}

if (parentPort) {
  const output = runSlice(workerData as VisibilityWorkerInput);
  parentPort.postMessage(output);
}
