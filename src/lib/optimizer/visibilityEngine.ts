/**
 * Visibility engine.
 *
 * Question it answers: **would changing this part's colour change what the
 * finished model looks like from the outside?**
 *
 * Method
 * ------
 * 1. Build the completed model from real LDraw part meshes (not bounding boxes,
 *    not proxies) into a two-level BVH (src/lib/geometry/scene.ts).
 * 2. For a candidate part, take points on its actual triangle surface.
 * 3. From each point cast rays in directions spread over the whole sphere.
 * 4. A ray "escapes" if nothing opaque blocks it before it leaves the model's
 *    bounding sphere. An escaping ray means an observer in that direction can
 *    see that point of the part.
 * 5. Zero escaping rays over a large, triangle-covering sample means hidden.
 *
 * Two passes: a cheap screen that exits on the first escaping ray (which is
 * what happens for almost every exterior part), then an expensive verification
 * pass run only for parts that survived the screen.
 *
 * What the confidence number actually means
 * -----------------------------------------
 * When N rays are cast and none escape, the rule of three gives an upper bound
 * on the true escape probability of about 3/N at 95% confidence. The reported
 * confidence is `1 - 3/N`. It is a statement about the sampling, not a proof of
 * geometric invisibility, and the UI says so. We never claim absolute
 * invisibility, because we have not proved it.
 *
 * Deliberate conservatism
 * -----------------------
 * - Transparent parts are excluded from the occluder set entirely, so anything
 *   behind glass reads as visible.
 * - A part whose own geometry could not be fully resolved can never reach
 *   HIDDEN, only LIKELY_HIDDEN.
 * - Any escaping ray at all disqualifies a part from HIDDEN.
 * - Missing parts do not occlude, so an unresolved neighbour makes candidates
 *   look MORE visible, never less.
 *
 * Scope, stated plainly: this analyses the completed model exactly as supplied.
 * It does not model detachable roofs, hinged panels opening, or how the model
 * looks mid-build.
 */

import type { ModelScene } from '../geometry/scene';
import type { PartMesh } from '../geometry/partMesh';
import type { PartInstance } from '../ldraw/types';
import { areaStratifiedSamples, coverageSamples, fibonacciDirections } from './sampling';

export type VisibilityClass =
  | 'VISIBLE'
  | 'LIKELY_VISIBLE'
  | 'UNCERTAIN'
  | 'LIKELY_HIDDEN'
  | 'HIDDEN';

export type VisibilityRisk =
  | 'geometry_unavailable'
  | 'geometry_incomplete'
  | 'reduced_sampling_budget'
  | 'transparent_part';

export interface VisibilityResult {
  readonly instanceId: string;
  readonly classification: VisibilityClass;
  /** Fraction of cast rays that reached the outside. */
  readonly exposureFraction: number;
  /** Fraction of sampled surface points visible from at least one direction. */
  readonly exposedPointFraction: number;
  readonly raysCast: number;
  readonly escapedRays: number;
  readonly pointsSampled: number;
  readonly exposedPoints: number;
  /**
   * True when ray casting stopped at the first escaping ray. The exposure
   * numbers are then LOWER BOUNDS, not estimates, and the UI must say so.
   */
  readonly earlyStopped: boolean;
  readonly trianglesCovered: number;
  readonly trianglesTotal: number;
  /** 0-1. Meaningful only for the HIDDEN / LIKELY_HIDDEN verdicts. */
  readonly confidence: number;
  readonly risks: readonly VisibilityRisk[];
  /** Human-readable justification shown in the UI. */
  readonly evidence: string;
}

export interface VisibilityOptions {
  screenPoints: number;
  screenDirections: number;
  verifyPoints: number;
  verifyDirections: number;
  /** Ray hits closer than this are ignored so a ray does not hit its own origin surface. */
  epsilon: number;
}

export const DEFAULT_VISIBILITY_OPTIONS: VisibilityOptions = {
  screenPoints: 24,
  screenDirections: 12,
  verifyPoints: 900,
  verifyDirections: 32,
  epsilon: 0.02,
};

/**
 * Sampling budgets scale down for very large models so a 10,000-part MOC still
 * finishes in reasonable time. The reduction is recorded as a risk factor and
 * shows up as a lower reported confidence - it is never hidden from the user.
 */
export function optionsForModelSize(instanceCount: number): VisibilityOptions {
  if (instanceCount <= 1500) return DEFAULT_VISIBILITY_OPTIONS;
  if (instanceCount <= 5000) {
    return { ...DEFAULT_VISIBILITY_OPTIONS, verifyPoints: 450, verifyDirections: 24 };
  }
  return { ...DEFAULT_VISIBILITY_OPTIONS, verifyPoints: 220, verifyDirections: 20 };
}

export interface VisibilityRunStats {
  readonly totalRays: number;
  readonly screenedInstances: number;
  readonly verifiedInstances: number;
  readonly elapsedMs: number;
}

export interface VisibilityAnalysis {
  readonly results: Map<string, VisibilityResult>;
  readonly stats: VisibilityRunStats;
}

export function analyzeVisibility(
  scene: ModelScene,
  instances: readonly PartInstance[],
  meshByPart: ReadonlyMap<string, PartMesh>,
  options: VisibilityOptions = DEFAULT_VISIBILITY_OPTIONS,
  onProgress?: (done: number, total: number) => void,
): VisibilityAnalysis {
  const started = Date.now();
  const results = new Map<string, VisibilityResult>();
  const budgetReduced =
    options.verifyPoints < DEFAULT_VISIBILITY_OPTIONS.verifyPoints ||
    options.verifyDirections < DEFAULT_VISIBILITY_OPTIONS.verifyDirections;

  let totalRays = 0;
  let verified = 0;

  const screenDirs = fibonacciDirections(options.screenDirections);
  const verifyDirs = fibonacciDirections(options.verifyDirections);

  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    const sceneInstance = scene.instances[index]!;
    const mesh = meshByPart.get(instance.partId);

    if (!mesh || mesh.triangleCount === 0) {
      results.set(instance.instanceId, {
        instanceId: instance.instanceId,
        classification: 'UNCERTAIN',
        exposureFraction: 0,
        exposedPointFraction: 0,
        raysCast: 0,
        escapedRays: 0,
        pointsSampled: 0,
        exposedPoints: 0,
        earlyStopped: false,
        trianglesCovered: 0,
        trianglesTotal: 0,
        confidence: 0,
        risks: ['geometry_unavailable'],
        evidence:
          `No LDraw geometry is available for ${instance.partFile}, so its visibility could not be ` +
          `evaluated. Nothing will be changed about this part.`,
      });
      onProgress?.(index + 1, instances.length);
      continue;
    }

    // ---- pass 1: cheap screen, exit on the first escaping ray --------------
    const screen = castPass(
      scene,
      sceneInstance.index,
      instance,
      areaStratifiedSamples(mesh, options.screenPoints).map((s) => s.point),
      screenDirs,
      options.epsilon,
      1,
    );
    totalRays += screen.raysCast;

    if (screen.escapedRays > 0) {
      // Visible. Estimate how visible with the full screen budget, no early exit.
      const full = castPass(
        scene,
        sceneInstance.index,
        instance,
        areaStratifiedSamples(mesh, options.screenPoints).map((s) => s.point),
        screenDirs,
        options.epsilon,
        Number.POSITIVE_INFINITY,
      );
      totalRays += full.raysCast;
      results.set(
        instance.instanceId,
        classifyVisible(instance, full, mesh, sceneInstance.geometryIncomplete),
      );
      onProgress?.(index + 1, instances.length);
      continue;
    }

    // ---- pass 2: verification, aiming for per-triangle coverage ------------
    verified++;
    const sampling = coverageSamples(mesh, options.verifyPoints);
    const verify = castPass(
      scene,
      sceneInstance.index,
      instance,
      sampling.samples.map((s) => s.point),
      verifyDirs,
      options.epsilon,
      1,
    );
    totalRays += verify.raysCast;

    const risks: VisibilityRisk[] = [];
    if (sceneInstance.geometryIncomplete) risks.push('geometry_incomplete');
    if (budgetReduced) risks.push('reduced_sampling_budget');
    if (!sceneInstance.isOccluder && mesh.triangleCount > 0) risks.push('transparent_part');

    if (verify.escapedRays > 0) {
      // The coarse screen missed it but the dense pass found a line of sight.
      // That is exactly the "visible only through a small gap" case. Ray
      // casting stopped at the first escape, so the counts below are lower
      // bounds and the verdict is deliberately pessimistic.
      const risksHere: VisibilityRisk[] = [];
      if (sceneInstance.geometryIncomplete) risksHere.push('geometry_incomplete');
      results.set(instance.instanceId, {
        instanceId: instance.instanceId,
        classification: 'LIKELY_VISIBLE',
        exposureFraction: verify.escapedRays / Math.max(1, verify.raysCast),
        exposedPointFraction: verify.exposedPoints / Math.max(1, verify.pointsSampled),
        raysCast: screen.raysCast + verify.raysCast,
        escapedRays: verify.escapedRays,
        pointsSampled: verify.pointsSampled,
        exposedPoints: verify.exposedPoints,
        earlyStopped: true,
        trianglesCovered: sampling.coveredTriangles,
        trianglesTotal: sampling.totalTriangles,
        confidence: 0,
        risks: risksHere,
        evidence:
          `A clear line of sight to the outside was found on this part after probing ` +
          `${(screen.raysCast + verify.raysCast).toLocaleString()} rays. It is not visible from most ` +
          `directions, but it can be seen through a gap, so it is treated as visible and left unchanged.`,
      });
      onProgress?.(index + 1, instances.length);
      continue;
    }

    const rays = screen.raysCast + verify.raysCast;
    const confidence = ruleOfThreeConfidence(rays);
    const blocking = risks.filter((r) => r === 'geometry_incomplete');
    const classification: VisibilityClass = blocking.length > 0 ? 'LIKELY_HIDDEN' : 'HIDDEN';

    const coverageText =
      sampling.coveredTriangles >= sampling.totalTriangles
        ? `every one of the part's ${sampling.totalTriangles.toLocaleString()} surface triangles`
        : `${sampling.coveredTriangles.toLocaleString()} of the part's ${sampling.totalTriangles.toLocaleString()} surface triangles`;

    const evidence =
      `No externally visible surface detected. ${verify.pointsSampled.toLocaleString()} points covering ` +
      `${coverageText} were probed in ${options.verifyDirections} directions each ` +
      `(${rays.toLocaleString()} rays in total); none reached the outside of the model. ` +
      (blocking.length > 0
        ? `Part of this element's own geometry could not be resolved, so this is reported as likely hidden rather than hidden.`
        : `By the rule of three, any remaining externally visible fraction is below ${(300 / rays).toFixed(3)}% at 95% confidence.`);

    results.set(instance.instanceId, {
      instanceId: instance.instanceId,
      classification,
      exposureFraction: 0,
      exposedPointFraction: 0,
      raysCast: rays,
      escapedRays: 0,
      pointsSampled: verify.pointsSampled,
      exposedPoints: 0,
      earlyStopped: false,
      trianglesCovered: sampling.coveredTriangles,
      trianglesTotal: sampling.totalTriangles,
      confidence,
      risks,
      evidence,
    });
    onProgress?.(index + 1, instances.length);
  }

  return {
    results,
    stats: {
      totalRays,
      screenedInstances: instances.length,
      verifiedInstances: verified,
      elapsedMs: Date.now() - started,
    },
  };
}

interface PassResult {
  raysCast: number;
  escapedRays: number;
  pointsSampled: number;
  exposedPoints: number;
}

function castPass(
  scene: ModelScene,
  _instanceIndex: number,
  instance: PartInstance,
  localPoints: readonly { x: number; y: number; z: number }[],
  directions: Float64Array,
  epsilon: number,
  stopAfterEscapes: number,
): PassResult {
  const m = instance.transformation;
  const t = instance.position;
  const dirCount = directions.length / 3;

  let raysCast = 0;
  let escapedRays = 0;
  let exposedPoints = 0;
  let pointsSampled = 0;

  for (let p = 0; p < localPoints.length; p++) {
    const local = localPoints[p]!;
    // Transform the surface point into world space.
    const wx = m[0]! * local.x + m[1]! * local.y + m[2]! * local.z + t.x;
    const wy = m[3]! * local.x + m[4]! * local.y + m[5]! * local.z + t.y;
    const wz = m[6]! * local.x + m[7]! * local.y + m[8]! * local.z + t.z;
    pointsSampled++;

    // Rotate the direction lattice per point so different points probe
    // different directions, deterministically.
    const phase = (p * 0.7548776662466927) % 1;
    const cosP = Math.cos(phase * Math.PI * 2);
    const sinP = Math.sin(phase * Math.PI * 2);

    let pointExposed = false;
    for (let d = 0; d < dirCount; d++) {
      const dx0 = directions[d * 3]!;
      const dy = directions[d * 3 + 1]!;
      const dz0 = directions[d * 3 + 2]!;
      // Rotate about Y by `phase`.
      const dx = dx0 * cosP - dz0 * sinP;
      const dz = dx0 * sinP + dz0 * cosP;

      const tMax = scene.escapeDistance({ x: wx, y: wy, z: wz }, { x: dx, y: dy, z: dz });
      raysCast++;
      if (!scene.occluded(wx, wy, wz, dx, dy, dz, tMax, epsilon)) {
        escapedRays++;
        pointExposed = true;
        if (escapedRays >= stopAfterEscapes) {
          if (pointExposed) exposedPoints++;
          return { raysCast, escapedRays, pointsSampled, exposedPoints };
        }
      }
    }
    if (pointExposed) exposedPoints++;
  }

  return { raysCast, escapedRays, pointsSampled, exposedPoints };
}

function classifyVisible(
  instance: PartInstance,
  pass: PassResult,
  mesh: PartMesh,
  geometryIncomplete: boolean,
): VisibilityResult {
  // Callers only reach here with a pass that ran to completion.
  const exposureFraction = pass.raysCast > 0 ? pass.escapedRays / pass.raysCast : 0;
  const exposedPointFraction = pass.pointsSampled > 0 ? pass.exposedPoints / pass.pointsSampled : 0;

  let classification: VisibilityClass;
  if (exposedPointFraction > 0.05 || exposureFraction > 0.02) classification = 'VISIBLE';
  else if (exposureFraction > 0.002) classification = 'LIKELY_VISIBLE';
  else classification = 'UNCERTAIN';

  const risks: VisibilityRisk[] = [];
  if (geometryIncomplete) risks.push('geometry_incomplete');

  const percent = (exposedPointFraction * 100).toFixed(exposedPointFraction < 0.01 ? 2 : 1);
  const evidence =
    classification === 'UNCERTAIN'
      ? `Only ${pass.escapedRays} of ${pass.raysCast.toLocaleString()} sampled rays reached the outside, ` +
        `which is too close to the noise floor to call. Treated as visible and left unchanged.`
      : `${pass.exposedPoints} of ${pass.pointsSampled} sampled surface points (${percent}%) are directly ` +
        `visible from outside the completed model.`;

  return {
    instanceId: instance.instanceId,
    classification,
    exposureFraction,
    exposedPointFraction,
    raysCast: pass.raysCast,
    escapedRays: pass.escapedRays,
    pointsSampled: pass.pointsSampled,
    exposedPoints: pass.exposedPoints,
    earlyStopped: false,
    trianglesCovered: 0,
    trianglesTotal: mesh.triangleCount,
    confidence: 0,
    risks,
    evidence,
  };
}

/**
 * Rule of three: with N independent trials and zero successes, the 95% upper
 * bound on the success probability is about 3/N.
 */
export function ruleOfThreeConfidence(rays: number): number {
  if (rays <= 0) return 0;
  return Math.max(0, Math.min(0.99999, 1 - 3 / rays));
}

export const VISIBILITY_ORDER: Record<VisibilityClass, number> = {
  VISIBLE: 0,
  LIKELY_VISIBLE: 1,
  UNCERTAIN: 2,
  LIKELY_HIDDEN: 3,
  HIDDEN: 4,
};
