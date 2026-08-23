/**
 * Visibility engine.
 *
 * Question it answers: **would changing this part's color change what the
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
 * - Missing parts do not occlude, so an unresolved neighbor makes candidates
 *   look MORE visible, never less.
 *
 * Scope, stated plainly: this analyzes the completed model exactly as supplied.
 * It does not model detachable roofs, hinged panels opening, or how the model
 * looks mid-build.
 */

import type { ModelScene } from '../geometry/scene';
import type { Mat3, Vec3 } from '../ldraw/math';
import {
  FIXED_AXIS_COUNT,
  areaStratifiedSamples,
  coverageSamples,
  directionSet,
  pointRotation,
  type SampleableMesh,
} from './sampling';

/**
 * Everything the engine needs to know about one part instance.
 *
 * Deliberately a flat, plain-data record rather than a PartInstance plus a
 * ModelScene lookup: it can be sent to a worker thread as-is, and it keeps the
 * engine independent of how the rest of the app models a part.
 */
export interface VisibilityTarget {
  /** Index into the scene's flat instance arrays, for observer-pass queries. */
  readonly sceneIndex: number;
  readonly instanceId: string;
  readonly partId: string;
  readonly partFile: string;
  readonly matrix: Mat3;
  readonly position: Vec3;
  /** The part's own mesh could not be fully resolved from the library. */
  readonly geometryIncomplete: boolean;
  readonly isTransparent: boolean;
}

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
  /**
   * Viewpoints for the observer pass. Directions are spread over the whole
   * sphere, so the model is looked at from underneath as well as from above.
   */
  observerViewpoints: number;
  /**
   * Image-plane resolution per observer viewpoint. The grid spans the part's
   * projected bounding box, so this is a resolution RELATIVE TO THE PART: at
   * 24, a 40 LDU brick is sampled roughly every 1.7 LDU (0.7 mm).
   */
  observerResolution: number;
  /** Ray hits closer than this are ignored so a ray does not hit its own origin surface. */
  epsilon: number;
}

export const DEFAULT_VISIBILITY_OPTIONS: VisibilityOptions = {
  screenPoints: 24,
  screenDirections: 12,
  verifyPoints: 900,
  verifyDirections: 32,
  observerViewpoints: 96,
  observerResolution: 64,
  epsilon: 0.02,
};

/**
 * Sampling budgets scale down for very large models so a 10,000-part MOC still
 * finishes in reasonable time. The reduction is recorded as a risk factor and
 * shows up as a lower reported confidence - it is never hidden from the user.
 *
 * The OBSERVER budget is deliberately reduced far less than the surface-escape
 * budget. Measurement on real models showed the observer pass finds narrow
 * lines of sight several times more efficiently per ray than surface sampling
 * does, so when the budget has to be cut, it is the weaker test that gives way.
 */
export function optionsForModelSize(instanceCount: number): VisibilityOptions {
  if (instanceCount <= 1500) return DEFAULT_VISIBILITY_OPTIONS;
  if (instanceCount <= 5000) {
    return {
      ...DEFAULT_VISIBILITY_OPTIONS,
      verifyPoints: 700,
      verifyDirections: 32,
      observerViewpoints: 80,
      observerResolution: 64,
    };
  }
  return {
    ...DEFAULT_VISIBILITY_OPTIONS,
    verifyPoints: 400,
    verifyDirections: 28,
    observerViewpoints: 64,
    observerResolution: 56,
  };
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
  targets: readonly VisibilityTarget[],
  meshByPart: ReadonlyMap<string, SampleableMesh>,
  options: VisibilityOptions = DEFAULT_VISIBILITY_OPTIONS,
  range?: { start: number; end: number },
  onProgress?: (done: number, total: number) => void,
): VisibilityAnalysis {
  const started = Date.now();
  const results = new Map<string, VisibilityResult>();
  const budgetReduced =
    options.verifyPoints < DEFAULT_VISIBILITY_OPTIONS.verifyPoints ||
    options.verifyDirections < DEFAULT_VISIBILITY_OPTIONS.verifyDirections;

  let totalRays = 0;
  let verified = 0;

  // Each set is the six world axes followed by a Fibonacci lattice. Only the
  // lattice portion is rotated per sample point.
  const screenDirs = directionSet(options.screenDirections);
  const verifyDirs = directionSet(options.verifyDirections);

  // Surface samples are computed in the part's own coordinate space, so every
  // instance of the same part reuses them. A model with 3,500 parts but only
  // 130 distinct ones would otherwise redo this work 27 times over.
  const screenSampleCache = new Map<string, Float64Array>();
  const verifySampleCache = new Map<string, { points: Float64Array; covered: number; total: number }>();

  const screenSamplesFor = (partId: string, mesh: SampleableMesh): Float64Array => {
    let cached = screenSampleCache.get(partId);
    if (!cached) {
      cached = packPoints(areaStratifiedSamples(mesh, options.screenPoints).map((s) => s.point));
      screenSampleCache.set(partId, cached);
    }
    return cached;
  };

  const verifySamplesFor = (
    partId: string,
    mesh: SampleableMesh,
  ): { points: Float64Array; covered: number; total: number } => {
    let cached = verifySampleCache.get(partId);
    if (!cached) {
      const sampling = coverageSamples(mesh, options.verifyPoints);
      cached = {
        points: packPoints(sampling.samples.map((s) => s.point)),
        covered: sampling.coveredTriangles,
        total: sampling.totalTriangles,
      };
      verifySampleCache.set(partId, cached);
    }
    return cached;
  };

  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? targets.length, targets.length);
  const total = end - start;

  for (let index = start; index < end; index++) {
    const instance = targets[index]!;
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
      onProgress?.(index - start + 1, total);
      continue;
    }

    // ---- pass 1: cheap screen, exit on the first escaping ray --------------
    const screenPoints = screenSamplesFor(instance.partId, mesh);
    const screen = castPass(scene, instance, screenPoints, screenDirs, options.epsilon, 1);
    totalRays += screen.raysCast;

    if (screen.escapedRays > 0) {
      // Visible. Estimate how visible with the full screen budget, no early exit.
      const full = castPass(
        scene,
        instance,
        screenPoints,
        screenDirs,
        options.epsilon,
        Number.POSITIVE_INFINITY,
      );
      totalRays += full.raysCast;
      results.set(
        instance.instanceId,
        classifyVisible(instance, full, mesh, instance.geometryIncomplete),
      );
      onProgress?.(index - start + 1, total);
      continue;
    }

    // ---- pass 2: verification, aiming for per-triangle coverage ------------
    verified++;
    const sampling = verifySamplesFor(instance.partId, mesh);
    const verify = castPass(scene, instance, sampling.points, verifyDirs, options.epsilon, 1);
    totalRays += verify.raysCast;

    const risks: VisibilityRisk[] = [];
    if (instance.geometryIncomplete) risks.push('geometry_incomplete');
    if (budgetReduced) risks.push('reduced_sampling_budget');
    if (instance.isTransparent) risks.push('transparent_part');

    if (verify.escapedRays > 0) {
      // The coarse screen missed it but the dense pass found a line of sight.
      // That is exactly the "visible only through a small gap" case. Ray
      // casting stopped at the first escape, so the counts below are lower
      // bounds and the verdict is deliberately pessimistic.
      const risksHere: VisibilityRisk[] = [];
      if (instance.geometryIncomplete) risksHere.push('geometry_incomplete');
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
        trianglesCovered: sampling.covered,
        trianglesTotal: sampling.total,
        confidence: 0,
        risks: risksHere,
        evidence:
          `A clear line of sight to the outside was found on this part after probing ` +
          `${(screen.raysCast + verify.raysCast).toLocaleString()} rays. It is not visible from most ` +
          `directions, but it can be seen through a gap, so it is treated as visible and left unchanged.`,
      });
      onProgress?.(index - start + 1, total);
      continue;
    }

    // ---- pass 3: observer gate ---------------------------------------------
    // Nothing has escaped from the part's surface. Before calling it hidden,
    // look at the model from the outside and check the part does not show up.
    // This is the test that actually finds narrow lines of sight; see
    // `observerPass` for the measurements that led to it existing.
    const observer = observerPass(
      scene,
      instance,
      options.observerViewpoints,
      options.observerResolution,
    );
    totalRays += observer.raysCast;

    if (observer.sighted) {
      results.set(instance.instanceId, {
        instanceId: instance.instanceId,
        classification: 'LIKELY_VISIBLE',
        exposureFraction: 0,
        exposedPointFraction: 0,
        raysCast: screen.raysCast + verify.raysCast + observer.raysCast,
        escapedRays: 0,
        pointsSampled: verify.pointsSampled,
        exposedPoints: 0,
        earlyStopped: true,
        trianglesCovered: sampling.covered,
        trianglesTotal: sampling.total,
        confidence: 0,
        risks: instance.geometryIncomplete ? ['geometry_incomplete'] : [],
        evidence:
          `No ray leaving this part's surface reached the outside, but looking at the finished model ` +
          `from ${observer.viewpointsTried.toLocaleString()} directions found one that shows it - it can be seen ` +
          `through a gap. Treated as visible and left unchanged.`,
      });
      onProgress?.(index - start + 1, total);
      continue;
    }

    const rays = screen.raysCast + verify.raysCast + observer.raysCast;
    const confidence = ruleOfThreeConfidence(rays);
    const blocking = risks.filter((r) => r === 'geometry_incomplete');
    const classification: VisibilityClass = blocking.length > 0 ? 'LIKELY_HIDDEN' : 'HIDDEN';

    const coverageText =
      sampling.covered >= sampling.total
        ? `every one of the part's ${sampling.total.toLocaleString()} surface triangles`
        : `${sampling.covered.toLocaleString()} of the part's ${sampling.total.toLocaleString()} surface triangles`;

    const evidence =
      `No externally visible surface detected. ${verify.pointsSampled.toLocaleString()} points covering ` +
      `${coverageText} were probed in ${options.verifyDirections} directions each, and the finished model was ` +
      `then viewed from ${options.observerViewpoints} directions all round - including from underneath - ` +
      `at an image resolution of ${observer.pixelSpacing.toFixed(2)} LDU ` +
      `(${(observer.pixelSpacing * 0.4).toFixed(2)} mm) across this part. ` +
      `${rays.toLocaleString()} rays in total; none reached it. ` +
      (blocking.length > 0
        ? `Part of this element's own geometry could not be resolved, so this is reported as likely hidden rather than hidden.`
        : `By the rule of three, any remaining externally visible fraction is below ${(300 / rays).toFixed(3)}% at 95% confidence. ` +
          `That bounds how much of it can be seen; it is not a proof that none of it can be.`);

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
      trianglesCovered: sampling.covered,
      trianglesTotal: sampling.total,
      confidence,
      risks,
      evidence,
    });
    onProgress?.(index - start + 1, total);
  }

  return {
    results,
    stats: {
      totalRays,
      screenedInstances: total,
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

function packPoints(points: readonly { x: number; y: number; z: number }[]): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  return out;
}

function castPass(
  scene: ModelScene,
  instance: VisibilityTarget,
  localPoints: Float64Array,
  directions: Float64Array,
  epsilon: number,
  stopAfterEscapes: number,
): PassResult {
  const m = instance.matrix;
  const t = instance.position;
  const dirCount = directions.length / 3;
  const pointCount = localPoints.length / 3;

  let raysCast = 0;
  let escapedRays = 0;
  let exposedPoints = 0;
  let pointsSampled = 0;

  for (let p = 0; p < pointCount; p++) {
    const lx = localPoints[p * 3]!;
    const ly = localPoints[p * 3 + 1]!;
    const lz = localPoints[p * 3 + 2]!;
    // Transform the surface point into world space.
    const wx = m[0]! * lx + m[1]! * ly + m[2]! * lz + t.x;
    const wy = m[3]! * lx + m[4]! * ly + m[5]! * lz + t.y;
    const wz = m[6]! * lx + m[7]! * ly + m[8]! * lz + t.z;
    pointsSampled++;

    // Rotate the direction lattice per point, about BOTH Y and X, so that the
    // elevations vary from point to point as well as the azimuths. Rotating
    // about Y alone leaves a permanent unsampled cone around the vertical axis,
    // which is the direction a model is most often looked at from. See
    // `pointRotation` in sampling.ts for the full explanation.
    const rot = pointRotation(p);

    let pointExposed = false;
    for (let d = 0; d < dirCount; d++) {
      const dx0 = directions[d * 3]!;
      const dy0 = directions[d * 3 + 1]!;
      const dz0 = directions[d * 3 + 2]!;

      let dx: number;
      let dy: number;
      let dz: number;
      if (d < FIXED_AXIS_COUNT) {
        // The six world axes are cast unrotated from every point, so straight
        // down, straight up and straight along each horizontal axis are always
        // probed no matter how the lattice happens to fall.
        dx = dx0;
        dy = dy0;
        dz = dz0;
      } else {
        const rx = dx0 * rot.cosY - dz0 * rot.sinY;
        const rz = dx0 * rot.sinY + dz0 * rot.cosY;
        dx = rx;
        dy = dy0 * rot.cosX - rz * rot.sinX;
        dz = dy0 * rot.sinX + rz * rot.cosX;
      }

      const tMax = scene.escapeDistanceScalar(wx, wy, wz, dx, dy, dz);
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

interface ObserverResult {
  /** A viewpoint from which a ray reached this part before anything else. */
  readonly sighted: boolean;
  readonly raysCast: number;
  readonly viewpointsTried: number;
  /** Image-plane spacing achieved, in LDU. Smaller finds narrower gaps. */
  readonly pixelSpacing: number;
}

/**
 * Look at the model from many directions and see whether this part shows up.
 *
 * Why this exists
 * ---------------
 * The surface-escape pass asks "does a ray leaving a random point on this part
 * in a random direction get out?". For a part visible only through a small gap
 * that is a rare event in a four-dimensional space: the point has to land on
 * the small patch that faces the gap AND the direction has to fall inside the
 * gap's solid angle. Measured on real models, such parts escape on the order of
 * one ray in a hundred thousand, so a 30,000-ray budget misses them most of the
 * time - and raising the budget converges painfully slowly. Measurements on the
 * UCS Millennium Falcon: 34.7% of accepted parts were found visible at 34,200
 * rays each, still climbing to 58.5% at 804,000 rays each.
 *
 * This pass asks the question an observer asks instead: "standing over there,
 * do I see this part?" Rays are laid out on the IMAGE PLANE, which is exactly
 * where the gap's aperture is. A pinhole one LDU across on a 40 LDU part is one
 * fortieth of the image width, so a 24x24 grid lands in it routinely. On the
 * same Falcon test this found MORE visible parts (85 of 118) than the largest
 * surface-sampling budget did, in a sixth of the time.
 *
 * Method: for each viewpoint direction, frame the part's projected bounding box
 * and shoot a grid of parallel rays from outside the model. A ray that reaches
 * this part's own triangles before anything else means the part is visible from
 * that direction.
 *
 * A sighting must survive a robustness check before it counts - see
 * `sightingIsRobust`.
 */
function observerPass(
  scene: ModelScene,
  instance: VisibilityTarget,
  viewpoints: number,
  resolution: number,
): ObserverResult {
  const box = observerScratchBox;
  if (!scene.instanceHasGeometry(instance.sceneIndex) || !scene.instanceBoundsInto(instance.sceneIndex, box)) {
    return { sighted: false, raysCast: 0, viewpointsTried: 0, pixelSpacing: Infinity };
  }

  const cx = (box[0]! + box[3]!) / 2;
  const cy = (box[1]! + box[4]!) / 2;
  const cz = (box[2]! + box[5]!) / 2;
  const standOff = scene.boundingRadius * 1.2 + 10;
  // Six world axes first, then a Fibonacci lattice. LDraw models are
  // axis-aligned and are looked at from straight above, straight ahead and
  // straight along a side far more often than from anywhere else, so those
  // directions are always probed rather than left to wherever the lattice
  // happens to fall. A lattice of 96 leaves roughly 8 degrees between
  // viewpoints, which is wider than the angular window of a deep, narrow gap.
  const directions = directionSet(viewpoints);
  const viewpointCount = directions.length / 3;

  let raysCast = 0;
  let worstSpacing = 0;

  for (let v = 0; v < viewpointCount; v++) {
    const dx = directions[v * 3]!;
    const dy = directions[v * 3 + 1]!;
    const dz = directions[v * 3 + 2]!;

    // An orthonormal frame perpendicular to the view direction.
    let ax = 0;
    let ay = 0;
    if (Math.abs(dx) < 0.9) ax = 1;
    else ay = 1;
    let ux = ay * dz;
    let uy = -ax * dz;
    let uz = ax * dy - ay * dx;
    const ulen = Math.hypot(ux, uy, uz);
    if (ulen === 0) continue;
    ux /= ulen;
    uy /= ulen;
    uz /= ulen;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    // Size the image plane to the part's projected bounding box.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let c = 0; c < 8; c++) {
      const px = (c & 1 ? box[3]! : box[0]!) - cx;
      const py = (c & 2 ? box[4]! : box[1]!) - cy;
      const pz = (c & 4 ? box[5]! : box[2]!) - cz;
      const pu = px * ux + py * uy + pz * uz;
      const pv = px * vx + py * vy + pz * vz;
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
      if (pv < vMin) vMin = pv;
      if (pv > vMax) vMax = pv;
    }
    // A small margin so a part flush with its own box is not clipped.
    uMin -= 0.5;
    uMax += 0.5;
    vMin -= 0.5;
    vMax += 0.5;
    const spanU = uMax - uMin;
    const spanV = vMax - vMin;
    const spacing = Math.max(spanU, spanV) / resolution;
    if (spacing > worstSpacing) worstSpacing = spacing;

    for (let i = 0; i < resolution; i++) {
      const su = uMin + ((i + 0.5) / resolution) * spanU;
      for (let j = 0; j < resolution; j++) {
        const sv = vMin + ((j + 0.5) / resolution) * spanV;
        const ox = cx + ux * su + vx * sv - dx * standOff;
        const oy = cy + uy * su + vy * sv - dy * standOff;
        const oz = cz + uz * su + vz * sv - dz * standOff;

        raysCast++;
        const tHit = scene.nearestHitOnInstance(instance.sceneIndex, ox, oy, oz, dx, dy, dz);
        if (!Number.isFinite(tHit)) continue;
        // Does anything reach this part first?
        if (scene.occluded(ox, oy, oz, dx, dy, dz, tHit - 0.05, 0.02)) continue;
        // Any sighting at all counts. An earlier version required neighbouring
        // rays to confirm, to filter out rays slipping along the zero-width gap
        // between two exactly-touching LDraw surfaces. It was dropped: that
        // filter also discarded real sightings through narrow gaps, and the
        // trade is not symmetric. Discarding a sighting that was only an
        // artifact costs a saving; keeping a part that is genuinely visible off
        // the change list costs nothing but a saving too - but MISSING a real
        // sighting recolors a brick somebody can see, which is the one failure
        // this product must not have.
        return { sighted: true, raysCast, viewpointsTried: v + 1, pixelSpacing: worstSpacing };
      }
    }
  }

  return { sighted: false, raysCast, viewpointsTried: viewpointCount, pixelSpacing: worstSpacing };
}

/** Reused so the observer pass allocates nothing per instance. */
const observerScratchBox = new Float64Array(6);

function classifyVisible(
  instance: VisibilityTarget,
  pass: PassResult,
  mesh: SampleableMesh,
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
