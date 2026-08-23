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

import { readdirSync, statSync } from 'node:fs';
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

  if (!workerBundleIsCurrent(workerFile)) {
    // See `workerBundleIsCurrent`. A stale bundle is worse than no bundle.
    const analysis = analyzeVisibility(scene, targets, meshByPart, options, undefined, parallel.onProgress);
    return { ...analysis, workerCount: 1 };
  }

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
export function resolveWorkerFile(): string {
  const override = process.env.VISIBILITY_WORKER_PATH;
  if (override) return override;
  return path.join(process.cwd(), 'dist-workers', 'visibilityWorker.mjs');
}

/**
 * Refuse to run a worker bundle that is older than the source it was built
 * from.
 *
 * The worker is a SEPARATE esbuild bundle, so unlike every other module here it
 * does not rebuild when the source changes - it only rebuilds when one of the
 * `workers:build` hooks runs. A stale bundle therefore runs OLD visibility code
 * in the workers while the parent process runs the current code, and because
 * the parallel path is the default for anything above `PARALLEL_THRESHOLD`
 * parts, that means real models get judged by code nobody is testing.
 *
 * This is not hypothetical: it happened during development. A fix that closed a
 * blind cone in the direction sampling landed in `sampling.ts`, the bundle was
 * not rebuilt, and every model over 600 parts was still being analyzed with the
 * unfixed sampler - the exact failure mode where a visible brick can be
 * recolored. Silent divergence between two code paths is the worst possible
 * shape for a bug in a tool whose whole job is not touching visible parts.
 *
 * So: if any TypeScript source under `src/lib` is newer than the bundle, the
 * bundle is not trusted and the analysis runs in-process instead. Slower, but
 * it is the code that the tests actually exercise. When `src/lib` is not on
 * disk at all - a deployed standalone build - there is nothing to compare
 * against and the bundle is used as-is.
 */
export function workerBundleIsCurrent(
  workerFile: string,
  sourceRoot: string = path.join(process.cwd(), 'src', 'lib'),
): boolean {
  if (process.env.VISIBILITY_WORKER_PATH) return true;
  try {
    const bundleMtime = statSync(workerFile).mtimeMs;
    const newest = newestSourceMtime(sourceRoot);
    if (newest === null) return true;
    return bundleMtime >= newest;
  } catch {
    return false;
  }
}

/** Newest mtime of any `.ts` file under `dir`, or null if `dir` is absent. */
function newestSourceMtime(dir: string): number | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestSourceMtime(full);
      if (nested !== null && nested > newest) newest = nested;
    } else if (entry.name.endsWith('.ts')) {
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Unreadable file: ignore it rather than disabling the workers.
      }
    }
  }
  return newest;
}
