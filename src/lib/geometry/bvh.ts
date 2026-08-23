/**
 * Bounding volume hierarchy over a triangle soup, in the mesh's own coordinate
 * space.
 *
 * Written by hand rather than pulled from a library for three reasons:
 *  - the only query the visibility engine needs is "does anything block this
 *    ray before distance t", which allows an early-out on the FIRST hit and is
 *    much cheaper than a nearest-hit query;
 *  - it must run identically in Node (analysis) and in the browser (viewer)
 *    with no DOM or WebGL dependency;
 *  - construction is fully deterministic, so an analysis of the same model
 *    always produces the same numbers.
 *
 * Build strategy is a binned surface-area-heuristic split with a median
 * fallback, which is a good balance of build time and traversal quality for the
 * long thin geometry LDraw parts are made of.
 */

const BIN_COUNT = 12;
const MAX_LEAF_TRIANGLES = 8;
const TRAVERSAL_COST = 1;
const INTERSECTION_COST = 1.2;

export interface RayHitOptions {
  /** Hits closer than this are ignored, so a ray starting on a surface does not hit it. */
  epsilon?: number;
}

export class TriangleBVH {
  /** 9 floats per triangle. */
  readonly positions: Float32Array;
  readonly triangleCount: number;

  /** Per node: minX,minY,minZ,maxX,maxY,maxZ. */
  private readonly nodeBounds: Float32Array;
  /** Per node: leftChild (or firstTriangle when count > 0). */
  private readonly nodeLeft: Int32Array;
  /** Per node: triangle count, 0 for interior nodes. */
  private readonly nodeCount: Int32Array;
  private readonly triIndices: Uint32Array;
  private readonly nodeUsed: number;

  constructor(positions: Float32Array) {
    this.positions = positions;
    this.triangleCount = Math.floor(positions.length / 9);

    const maxNodes = Math.max(1, this.triangleCount * 2);
    this.nodeBounds = new Float32Array(maxNodes * 6);
    this.nodeLeft = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.triIndices = new Uint32Array(this.triangleCount);

    for (let i = 0; i < this.triangleCount; i++) this.triIndices[i] = i;

    if (this.triangleCount === 0) {
      this.nodeUsed = 1;
      this.setBounds(0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
      this.nodeLeft[0] = 0;
      this.nodeCount[0] = 0;
      return;
    }

    const centroids = new Float32Array(this.triangleCount * 3);
    for (let t = 0; t < this.triangleCount; t++) {
      const o = t * 9;
      centroids[t * 3] = (positions[o]! + positions[o + 3]! + positions[o + 6]!) / 3;
      centroids[t * 3 + 1] = (positions[o + 1]! + positions[o + 4]! + positions[o + 7]!) / 3;
      centroids[t * 3 + 2] = (positions[o + 2]! + positions[o + 5]! + positions[o + 8]!) / 3;
    }

    this.nodeLeft[0] = 0;
    this.nodeCount[0] = this.triangleCount;
    this.updateBounds(0);
    const used = { value: 1 };
    this.subdivide(0, centroids, used, 0);
    this.nodeUsed = used.value;
  }

  private setBounds(node: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const b = node * 6;
    this.nodeBounds[b] = x0;
    this.nodeBounds[b + 1] = y0;
    this.nodeBounds[b + 2] = z0;
    this.nodeBounds[b + 3] = x1;
    this.nodeBounds[b + 4] = y1;
    this.nodeBounds[b + 5] = z1;
  }

  private updateBounds(node: number): void {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const first = this.nodeLeft[node]!;
    const count = this.nodeCount[node]!;
    for (let i = 0; i < count; i++) {
      const t = this.triIndices[first + i]!;
      const o = t * 9;
      for (let v = 0; v < 3; v++) {
        const x = this.positions[o + v * 3]!;
        const y = this.positions[o + v * 3 + 1]!;
        const z = this.positions[o + v * 3 + 2]!;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
    }
    this.setBounds(node, x0, y0, z0, x1, y1, z1);
  }

  private subdivide(node: number, centroids: Float32Array, used: { value: number }, depth: number): void {
    const count = this.nodeCount[node]!;
    if (count <= MAX_LEAF_TRIANGLES || depth > 48) return;

    const first = this.nodeLeft[node]!;
    const b = node * 6;
    const ex = this.nodeBounds[b + 3]! - this.nodeBounds[b]!;
    const ey = this.nodeBounds[b + 4]! - this.nodeBounds[b + 1]!;
    const ez = this.nodeBounds[b + 5]! - this.nodeBounds[b + 2]!;
    const parentArea = 2 * (ex * ey + ey * ez + ez * ex);
    if (parentArea <= 0) return;

    let bestAxis = -1;
    let bestPos = 0;
    let bestCost = TRAVERSAL_COST + INTERSECTION_COST * count * parentArea;

    for (let axis = 0; axis < 3; axis++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < count; i++) {
        const c = centroids[this.triIndices[first + i]! * 3 + axis]!;
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
      if (hi - lo < 1e-9) continue;

      const binMin = new Float32Array(BIN_COUNT * 6);
      const binCount = new Int32Array(BIN_COUNT);
      for (let i = 0; i < BIN_COUNT; i++) {
        binMin[i * 6] = Infinity; binMin[i * 6 + 1] = Infinity; binMin[i * 6 + 2] = Infinity;
        binMin[i * 6 + 3] = -Infinity; binMin[i * 6 + 4] = -Infinity; binMin[i * 6 + 5] = -Infinity;
      }
      const scale = BIN_COUNT / (hi - lo);
      for (let i = 0; i < count; i++) {
        const t = this.triIndices[first + i]!;
        const c = centroids[t * 3 + axis]!;
        let bin = Math.floor((c - lo) * scale);
        if (bin >= BIN_COUNT) bin = BIN_COUNT - 1;
        if (bin < 0) bin = 0;
        binCount[bin]!;
        binCount[bin] = binCount[bin]! + 1;
        const o = t * 9;
        const bo = bin * 6;
        for (let v = 0; v < 3; v++) {
          const x = this.positions[o + v * 3]!;
          const y = this.positions[o + v * 3 + 1]!;
          const z = this.positions[o + v * 3 + 2]!;
          if (x < binMin[bo]!) binMin[bo] = x;
          if (y < binMin[bo + 1]!) binMin[bo + 1] = y;
          if (z < binMin[bo + 2]!) binMin[bo + 2] = z;
          if (x > binMin[bo + 3]!) binMin[bo + 3] = x;
          if (y > binMin[bo + 4]!) binMin[bo + 4] = y;
          if (z > binMin[bo + 5]!) binMin[bo + 5] = z;
        }
      }

      // Sweep from both sides to get the area of each candidate split.
      const leftArea = new Float32Array(BIN_COUNT - 1);
      const leftCount = new Int32Array(BIN_COUNT - 1);
      const rightArea = new Float32Array(BIN_COUNT - 1);
      const rightCount = new Int32Array(BIN_COUNT - 1);

      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
      let running = 0;
      for (let i = 0; i < BIN_COUNT - 1; i++) {
        const bo = i * 6;
        if (binCount[i]! > 0) {
          if (binMin[bo]! < ax0) ax0 = binMin[bo]!;
          if (binMin[bo + 1]! < ay0) ay0 = binMin[bo + 1]!;
          if (binMin[bo + 2]! < az0) az0 = binMin[bo + 2]!;
          if (binMin[bo + 3]! > ax1) ax1 = binMin[bo + 3]!;
          if (binMin[bo + 4]! > ay1) ay1 = binMin[bo + 4]!;
          if (binMin[bo + 5]! > az1) az1 = binMin[bo + 5]!;
        }
        running += binCount[i]!;
        leftCount[i] = running;
        leftArea[i] = surfaceArea(ax0, ay0, az0, ax1, ay1, az1);
      }

      ax0 = Infinity; ay0 = Infinity; az0 = Infinity; ax1 = -Infinity; ay1 = -Infinity; az1 = -Infinity;
      running = 0;
      for (let i = BIN_COUNT - 1; i >= 1; i--) {
        const bo = i * 6;
        if (binCount[i]! > 0) {
          if (binMin[bo]! < ax0) ax0 = binMin[bo]!;
          if (binMin[bo + 1]! < ay0) ay0 = binMin[bo + 1]!;
          if (binMin[bo + 2]! < az0) az0 = binMin[bo + 2]!;
          if (binMin[bo + 3]! > ax1) ax1 = binMin[bo + 3]!;
          if (binMin[bo + 4]! > ay1) ay1 = binMin[bo + 4]!;
          if (binMin[bo + 5]! > az1) az1 = binMin[bo + 5]!;
        }
        running += binCount[i]!;
        rightCount[i - 1] = running;
        rightArea[i - 1] = surfaceArea(ax0, ay0, az0, ax1, ay1, az1);
      }

      for (let i = 0; i < BIN_COUNT - 1; i++) {
        if (leftCount[i] === 0 || rightCount[i] === 0) continue;
        const cost =
          TRAVERSAL_COST * parentArea +
          INTERSECTION_COST * (leftCount[i]! * leftArea[i]! + rightCount[i]! * rightArea[i]!);
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestPos = lo + ((i + 1) * (hi - lo)) / BIN_COUNT;
        }
      }
    }

    if (bestAxis === -1) return;

    // Partition in place.
    let i = first;
    let j = first + count - 1;
    while (i <= j) {
      const t = this.triIndices[i]!;
      if (centroids[t * 3 + bestAxis]! < bestPos) {
        i++;
      } else {
        this.triIndices[i] = this.triIndices[j]!;
        this.triIndices[j] = t;
        j--;
      }
    }

    const leftCount = i - first;
    if (leftCount === 0 || leftCount === count) return;

    const leftChild = used.value++;
    const rightChild = used.value++;
    this.nodeLeft[leftChild] = first;
    this.nodeCount[leftChild] = leftCount;
    this.nodeLeft[rightChild] = i;
    this.nodeCount[rightChild] = count - leftCount;

    this.nodeLeft[node] = leftChild;
    this.nodeCount[node] = 0;

    this.updateBounds(leftChild);
    this.updateBounds(rightChild);
    this.subdivide(leftChild, centroids, used, depth + 1);
    this.subdivide(rightChild, centroids, used, depth + 1);
  }

  get nodeCountTotal(): number {
    return this.nodeUsed;
  }

  bounds(): { min: [number, number, number]; max: [number, number, number] } {
    return {
      min: [this.nodeBounds[0]!, this.nodeBounds[1]!, this.nodeBounds[2]!],
      max: [this.nodeBounds[3]!, this.nodeBounds[4]!, this.nodeBounds[5]!],
    };
  }

  /**
   * True if any triangle is hit by the ray in (epsilon, tMax).
   * Triangles are treated as double-sided: an LDraw part file is a surface
   * model whose winding is not reliably outward, and for occlusion the facing
   * direction is irrelevant.
   */
  intersectsRay(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMax: number,
    epsilon = 1e-4,
  ): boolean {
    if (this.triangleCount === 0) return false;

    const invDx = 1 / dx;
    const invDy = 1 / dy;
    const invDz = 1 / dz;

    const stack = TriangleBVH.scratchStack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp]!;
      const b = node * 6;

      let tmin = (this.nodeBounds[b]! - ox) * invDx;
      let tmax = (this.nodeBounds[b + 3]! - ox) * invDx;
      if (tmin > tmax) { const tmp = tmin; tmin = tmax; tmax = tmp; }

      let tymin = (this.nodeBounds[b + 1]! - oy) * invDy;
      let tymax = (this.nodeBounds[b + 4]! - oy) * invDy;
      if (tymin > tymax) { const tmp = tymin; tymin = tymax; tymax = tmp; }
      if (tmin > tymax || tymin > tmax) continue;
      if (tymin > tmin) tmin = tymin;
      if (tymax < tmax) tmax = tymax;

      let tzmin = (this.nodeBounds[b + 2]! - oz) * invDz;
      let tzmax = (this.nodeBounds[b + 5]! - oz) * invDz;
      if (tzmin > tzmax) { const tmp = tzmin; tzmin = tzmax; tzmax = tmp; }
      if (tmin > tzmax || tzmin > tmax) continue;
      if (tzmin > tmin) tmin = tzmin;
      if (tzmax < tmax) tmax = tzmax;

      if (tmax < epsilon || tmin > tMax) continue;

      const count = this.nodeCount[node]!;
      if (count === 0) {
        const left = this.nodeLeft[node]!;
        stack[sp++] = left;
        stack[sp++] = left + 1;
        continue;
      }

      const first = this.nodeLeft[node]!;
      for (let i = 0; i < count; i++) {
        const t = this.triIndices[first + i]!;
        if (this.intersectTriangle(t, ox, oy, oz, dx, dy, dz, tMax, epsilon)) return true;
      }
    }
    return false;
  }

  private intersectTriangle(
    t: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMax: number,
    epsilon: number,
  ): boolean {
    const p = this.positions;
    const o = t * 9;
    const ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!;
    const e1x = p[o + 3]! - ax, e1y = p[o + 4]! - ay, e1z = p[o + 5]! - az;
    const e2x = p[o + 6]! - ax, e2y = p[o + 7]! - ay, e2z = p[o + 8]! - az;

    // Moeller-Trumbore, double sided.
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) return false;

    const invDet = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return false;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) return false;

    const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return dist > epsilon && dist < tMax;
  }

  /** Shared traversal stack. Single-threaded by construction. */
  private static readonly scratchStack = new Int32Array(128);
}

function surfaceArea(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  if (x1 < x0) return 0;
  const ex = x1 - x0;
  const ey = y1 - y0;
  const ez = z1 - z0;
  return 2 * (ex * ey + ey * ez + ez * ex);
}
