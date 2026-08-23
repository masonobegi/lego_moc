/**
 * Runs the visibility engine across several worker threads.
 *
 * Visibility is the dominant cost of an analysis - typically 90% of it - and it
 * is embarrassingly parallel: each part's verdict depends only on the shared,
 * read-only scene. Slices are disjoint and the engine is deterministic, so the
 * merged result is byte-identical to the single-threaded path, which is what
 * makes it safe to parallelize something this safety-critical.
 *
 * Falls back to running in-process when there is only one usable core, when the
 * model is small enough that thread start-up would dominate, or if a worker
 * fails for any reason. Correctness never depends on the workers being there.
 */

import { availableParallelism } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { ModelScene } from '../geometry/scene';
import type { SampleableMesh } from './sampling';
import {
  analyzeVisibility,
  type VisibilityAnalysis,
  type VisibilityOptions,
  type VisibilityResult,
  type VisibilityTarget,
} from './visibilityEngine';
import type { VisibilityWorkerInput, VisibilityWorkerOutput } from './visibilityWorker';

/** Below this many parts, thread start-up costs more than it saves. */
const PARALLEL_THRESHOLD = 600;

export interface ParallelOptions {
  readonly maxWorkers?: number;
  readonly forceSingleThread?: boolean;
  readonly onProgress?: (done: number, total: number) => void;
}

export async function analyzeVisibilityParallel(
  scene: ModelScene,
  targets: readonly VisibilityTarget[],
  meshByPart: ReadonlyMap<string, SampleableMesh>,
  options: VisibilityOptions,
  parallel: ParallelOptions = {},
): Promise<VisibilityAnalysis & { workerCount: number }> {
  const cores = safeParallelism();
  const requested = parallel.maxWorkers ?? cores;
  const workerCount = Math.max(1, Math.min(requested, cores, Math.ceil(targets.length / 200)));

  if (parallel.forceSingleThread || workerCount <= 1 || targets.length < PARALLEL_THRESHOLD) {
    const analysis = analyzeVisibility(scene, targets, meshByPart, options, undefined, parallel.onProgress);
    return { ...analysis, workerCount: 1 };
  }

  const started = Date.now();
  const transferScene = scene.toTransfer();
  const meshes = [...meshByPart.entries()].map(([partId, mesh]) => ({
    partId,
    positions: mesh.positions,
    triangleCount: mesh.triangleCount,
  }));

  const sliceSize = Math.ceil(targets.length / workerCount);
  const workerFile = resolveWorkerFile();

  try {
    const outputs = await Promise.all(
      Array.from({ length: workerCount }, (_, i) => {
        const input: VisibilityWorkerInput = {
          scene: transferScene,
          targets,
          meshes,
          options,
          start: i * sliceSize,
          end: Math.min((i + 1) * sliceSize, targets.length),
        };
        return runWorker(workerFile, input);
      }),
    );

    const results = new Map<string, VisibilityResult>();
    let totalRays = 0;
    let verified = 0;
    for (const output of outputs) {
      for (const result of output.results) results.set(result.instanceId, result);
      totalRays += output.totalRays;
      verified += output.verifiedInstances;
    }

    if (results.size !== targets.length) {
      throw new Error(
        `Workers returned ${results.size} verdicts for ${targets.length} parts; falling back to single-threaded.`,
      );
    }

    return {
      results,
      stats: {
        totalRays,
        screenedInstances: targets.length,
        verifiedInstances: verified,
        elapsedMs: Date.now() - started,
      },
      workerCount,
    };
  } catch {
    // Any worker problem at all: redo the work in-process. Slower, never wrong.
    const analysis = analyzeVisibility(scene, targets, meshByPart, options, undefined, parallel.onProgress);
    return { ...analysis, workerCount: 1 };
  }
}

function runWorker(file: string, input: VisibilityWorkerInput): Promise<VisibilityWorkerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: input });
    let settled = false;
    worker.on('message', (message: VisibilityWorkerOutput) => {
      settled = true;
      resolve(message);
      void worker.terminate();
    });
    worker.on('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`Visibility worker exited with code ${code}`));
    });
  });
}

function safeParallelism(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return 1;
  }
}

/**
 * Locate the compiled worker.
 *
 * Next.js bundles server code, so the on-disk layout differs between `next dev`,
 * `next build` and a plain tsx/vitest run. `VISIBILITY_WORKER_PATH` lets a host
 * point at the right file; otherwise we look for the build output next to this
 * module and, failing that, throw so the caller falls back to single-threaded.
 */
function resolveWorkerFile(): string {
  const override = process.env.VISIBILITY_WORKER_PATH;
  if (override) return override;
  return path.join(process.cwd(), 'dist-workers', 'visibilityWorker.mjs');
}
