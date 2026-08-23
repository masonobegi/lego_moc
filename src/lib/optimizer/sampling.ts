/**
 * Deterministic sampling helpers for the visibility engine.
 *
 * Everything here is deterministic - no RNG anywhere. Two analyses of the same
 * model produce identical ray counts and identical verdicts, which matters
 * because those numbers are shown to the user as evidence and asserted by
 * tests.
 */

import type { Vec3 } from '../ldraw/math';

/**
 * The only thing the samplers need from a mesh. Keeping it structural means a
 * worker thread can rebuild just the triangle buffer instead of a whole
 * PartMesh with colours and provenance it will never read.
 */
export interface SampleableMesh {
  readonly positions: Float32Array;
  readonly triangleCount: number;
}

/**
 * Directions spread evenly over the whole sphere using the Fibonacci lattice.
 *
 * The full sphere, not a normal-oriented hemisphere: LDraw part files are
 * surface models whose triangle winding is not reliably outward, so a computed
 * "outward" normal cannot be trusted. Rays aimed into the part's own solid
 * simply hit its far wall and are counted as blocked, which makes the method
 * self-correcting and removes any dependency on normal orientation.
 *
 * `phase` rotates the lattice per sample point so that different points on the
 * same part do not all probe the same directions.
 */
export function fibonacciDirections(count: number, phase = 0): Float64Array {
  const out = new Float64Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i + phase;
    out[i * 3] = Math.cos(theta) * radius;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * radius;
  }
  return out;
}

export interface SurfaceSample {
  readonly point: Vec3;
  readonly triangle: number;
}

/** Radical inverse base 2, for a low-discrepancy sequence inside a triangle. */
function vanDerCorput(index: number): number {
  let bits = index >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

function pointInTriangle(mesh: SampleableMesh, tri: number, u: number, v: number): Vec3 {
  const o = tri * 9;
  const p = mesh.positions;
  // Map the unit square to barycentric coordinates.
  let su = Math.sqrt(u);
  const b0 = 1 - su;
  const b1 = v * su;
  const b2 = 1 - b0 - b1;
  return {
    x: p[o]! * b0 + p[o + 3]! * b1 + p[o + 6]! * b2,
    y: p[o + 1]! * b0 + p[o + 4]! * b1 + p[o + 7]! * b2,
    z: p[o + 2]! * b0 + p[o + 5]! * b1 + p[o + 8]! * b2,
  };
}

function centroid(mesh: SampleableMesh, tri: number): Vec3 {
  const o = tri * 9;
  const p = mesh.positions;
  return {
    x: (p[o]! + p[o + 3]! + p[o + 6]!) / 3,
    y: (p[o + 1]! + p[o + 4]! + p[o + 7]!) / 3,
    z: (p[o + 2]! + p[o + 5]! + p[o + 8]!) / 3,
  };
}

/** Point pulled 85% of the way from the centroid towards vertex `v` (0-2). */
function nearVertex(mesh: SampleableMesh, tri: number, v: number): Vec3 {
  const o = tri * 9 + v * 3;
  const p = mesh.positions;
  const c = centroid(mesh, tri);
  const t = 0.85;
  return {
    x: c.x + (p[o]! - c.x) * t,
    y: c.y + (p[o + 1]! - c.y) * t,
    z: c.z + (p[o + 2]! - c.z) * t,
  };
}

function triangleArea(mesh: SampleableMesh, tri: number): number {
  const o = tri * 9;
  const p = mesh.positions;
  const ux = p[o + 3]! - p[o]!, uy = p[o + 4]! - p[o + 1]!, uz = p[o + 5]! - p[o + 2]!;
  const vx = p[o + 6]! - p[o]!, vy = p[o + 7]! - p[o + 1]!, vz = p[o + 8]! - p[o + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * Coarse pass sampling: `count` points spread over the part's surface in
 * proportion to triangle area, using stratified cumulative-area selection.
 * Cheap, and good enough to find any substantial exposed region immediately.
 */
export function areaStratifiedSamples(mesh: SampleableMesh, count: number): SurfaceSample[] {
  if (mesh.triangleCount === 0 || count <= 0) return [];

  const cumulative = new Float64Array(mesh.triangleCount);
  let total = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    total += triangleArea(mesh, t);
    cumulative[t] = total;
  }
  if (total <= 0) return [];

  const samples: SurfaceSample[] = [];
  for (let i = 0; i < count; i++) {
    const target = ((i + 0.5) / count) * total;
    let lo = 0;
    let hi = mesh.triangleCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const u = vanDerCorput(i + 1);
    const v = ((i * 0.6180339887498949) % 1 + 1) % 1;
    samples.push({ point: pointInTriangle(mesh, lo, u, v), triangle: lo });
  }
  return samples;
}

export interface VerifySampling {
  readonly samples: SurfaceSample[];
  /** How many of the part's triangles got at least one sample point. */
  readonly coveredTriangles: number;
  readonly totalTriangles: number;
}

/**
 * Verification pass sampling.
 *
 * Unlike the coarse pass this aims for COVERAGE, not for an unbiased estimate:
 * every triangle gets at least one point when the budget allows, and any budget
 * left over goes to the largest triangles as three extra near-vertex points.
 * Corners and edges are where a part is most likely to peek out, and a purely
 * area-weighted sample can miss a thin exposed sliver entirely.
 *
 * The returned `coveredTriangles` is reported to the user verbatim, so a claim
 * like "every one of the part's 700 triangles was probed" is literally true.
 */
export function coverageSamples(mesh: SampleableMesh, pointBudget: number): VerifySampling {
  const total = mesh.triangleCount;
  if (total === 0 || pointBudget <= 0) {
    return { samples: [], coveredTriangles: 0, totalTriangles: total };
  }

  const samples: SurfaceSample[] = [];

  if (total <= pointBudget) {
    for (let t = 0; t < total; t++) {
      samples.push({ point: centroid(mesh, t), triangle: t });
    }
    let remaining = pointBudget - total;
    if (remaining > 0) {
      // Spend the rest on near-vertex probes of the largest triangles.
      const order = Array.from({ length: total }, (_, t) => t).sort(
        (a, b) => triangleArea(mesh, b) - triangleArea(mesh, a),
      );
      outer: for (const t of order) {
        for (let v = 0; v < 3; v++) {
          if (remaining <= 0) break outer;
          samples.push({ point: nearVertex(mesh, t, v), triangle: t });
          remaining--;
        }
      }
    }
    return { samples, coveredTriangles: total, totalTriangles: total };
  }

  // More triangles than budget: take the largest triangles first, then fill the
  // rest with an even stride so no region of the mesh is skipped wholesale.
  const order = Array.from({ length: total }, (_, t) => t).sort(
    (a, b) => triangleArea(mesh, b) - triangleArea(mesh, a),
  );
  const chosen = new Set<number>();
  const half = Math.floor(pointBudget / 2);
  for (let i = 0; i < half; i++) chosen.add(order[i]!);
  const stride = Math.max(1, Math.floor(total / (pointBudget - half)));
  for (let t = 0; t < total && chosen.size < pointBudget; t += stride) chosen.add(t);

  for (const t of chosen) samples.push({ point: centroid(mesh, t), triangle: t });
  return { samples, coveredTriangles: chosen.size, totalTriangles: total };
}
