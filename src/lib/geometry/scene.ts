/**
 * The occlusion scene: a two-level acceleration structure over a whole model.
 *
 * A realistic MOC has thousands of part instances but only a few hundred
 * DISTINCT parts. Merging every instance's triangles into one giant BVH would
 * use memory proportional to the instance count - tens of millions of triangles
 * for a 10,000-part model. Instead:
 *
 *   bottom level (BLAS)  one TriangleBVH per distinct part, in part-local space
 *   top level    (TLAS)  one BVH over the instances' world-space boxes
 *
 * A ray is traversed against the TLAS; for each candidate instance it is
 * transformed into that part's local space and tested against the shared BLAS.
 * Memory is then proportional to distinct parts, and build time is paid once
 * per part rather than once per instance. See docs/PERFORMANCE.md.
 *
 * Because the affine instance transform maps `o + t*d` to
 * `localOrigin + t*(M^-1 d)`, the ray parameter `t` is identical in both
 * spaces, so distance limits and epsilons need no conversion.
 */

import { isTransparentColor } from '../ldraw/colors';
import {
  boxCenter,
  emptyBox,
  expandBox,
  invertMat3,
  transformPoint,
  type Box3,
  type Mat3,
  type Vec3,
} from '../ldraw/math';
import type { PartInstance } from '../ldraw/types';
import { TriangleBVH, type TransferableBVH } from './bvh';
import type { PartMesh } from './partMesh';

/** Mirrors VisibilityTarget in the optimizer, kept structural to avoid a cycle. */
export interface VisibilityTargetRecord {
  /** Index into the scene's flat instance arrays, for observer-pass queries. */
  readonly sceneIndex: number;
  readonly instanceId: string;
  readonly partId: string;
  readonly partFile: string;
  readonly matrix: Mat3;
  readonly position: Vec3;
  readonly geometryIncomplete: boolean;
  readonly isTransparent: boolean;
}

export interface SceneInstance {
  readonly index: number;
  readonly instanceId: string;
  readonly partId: string;
  readonly colorId: number;
  readonly matrix: Mat3;
  readonly position: Vec3;
  readonly inverse: Mat3 | null;
  readonly bounds: Box3;
  /** Index into ModelScene.meshes / ModelScene.bvhs. -1 when geometry is unavailable. */
  readonly meshIndex: number;
  /** False for transparent parts and for parts with no geometry: they cannot hide anything. */
  readonly isOccluder: boolean;
  /** True when the part's own mesh was incomplete, which weakens any HIDDEN verdict about it. */
  readonly geometryIncomplete: boolean;
}

export interface SceneBuildStats {
  instanceCount: number;
  distinctPartCount: number;
  occluderCount: number;
  transparentCount: number;
  missingGeometryCount: number;
  totalTriangles: number;
  buildMs: number;
}

/**
 * Plain-data form of a whole scene: every array is structured-cloneable, so a
 * built scene can be handed to worker threads without rebuilding any BVH.
 */
export interface TransferableScene {
  readonly bvhs: readonly TransferableBVH[];
  readonly instBounds: Float32Array;
  readonly instInverse: Float64Array;
  readonly instPosition: Float64Array;
  readonly instMesh: Int32Array;
  readonly order: Uint32Array;
  readonly nodeBounds: Float32Array;
  readonly nodeLeft: Int32Array;
  readonly nodeCount: Int32Array;
  readonly nodeStart: Int32Array;
  readonly nodeUsed: number;
  readonly center: { x: number; y: number; z: number };
  readonly boundingRadius: number;
}

export class ModelScene {
  readonly instances: SceneInstance[];
  readonly meshes: PartMesh[];
  readonly bvhs: TriangleBVH[];
  readonly bounds: Box3;
  readonly boundingRadius: number;
  readonly center: Vec3;
  readonly stats: SceneBuildStats;

  /**
   * Everything the ray query touches lives in flat typed arrays rather than in
   * objects. Chasing `node.bounds.min.x` through three object headers on every
   * box test costs more than the arithmetic does; with millions of rays per
   * analysis that difference is the whole performance budget.
   */
  private nodeBounds = new Float32Array(0);
  private nodeLeft = new Int32Array(0);
  private nodeCount = new Int32Array(0);
  private nodeStart = new Int32Array(0);
  private nodeUsed = 0;

  private readonly instBounds: Float32Array;
  private readonly instInverse: Float64Array;
  private readonly instPosition: Float64Array;
  private readonly instMesh: Int32Array;

  private readonly order: Uint32Array;
  private readonly occluderIndices: number[];

  constructor(
    instances: readonly PartInstance[],
    meshByPart: ReadonlyMap<string, PartMesh>,
  ) {
    const started = Date.now();

    const partIds: string[] = [];
    const partIndex = new Map<string, number>();
    this.meshes = [];
    for (const instance of instances) {
      if (partIndex.has(instance.partId)) continue;
      const mesh = meshByPart.get(instance.partId);
      if (!mesh || mesh.triangleCount === 0) continue;
      partIndex.set(instance.partId, this.meshes.length);
      partIds.push(instance.partId);
      this.meshes.push(mesh);
    }

    this.bvhs = this.meshes.map((mesh) => new TriangleBVH(mesh.positions));

    this.instances = [];
    const bounds = emptyBox();
    let occluderCount = 0;
    let transparentCount = 0;
    let missingGeometry = 0;
    let totalTriangles = 0;

    instances.forEach((instance, index) => {
      const meshIndex = partIndex.get(instance.partId) ?? -1;
      const mesh = meshIndex >= 0 ? this.meshes[meshIndex]! : null;
      const transparent = isTransparentColor(instance.colorId);
      if (transparent) transparentCount++;
      if (!mesh) missingGeometry++;

      const instanceBounds = emptyBox();
      if (mesh) {
        // Transform the eight corners of the part's local box.
        const b = mesh.bounds;
        for (let i = 0; i < 8; i++) {
          const corner: Vec3 = {
            x: i & 1 ? b.max.x : b.min.x,
            y: i & 2 ? b.max.y : b.min.y,
            z: i & 4 ? b.max.z : b.min.z,
          };
          const world = transformPoint(instance.transformation, instance.position, corner);
          expandBox(instanceBounds, world);
          expandBox(bounds, world);
        }
        totalTriangles += mesh.triangleCount;
      } else {
        expandBox(instanceBounds, instance.position);
        expandBox(bounds, instance.position);
      }

      const isOccluder = mesh !== null && !transparent;
      if (isOccluder) occluderCount++;

      this.instances.push({
        index,
        instanceId: instance.instanceId,
        partId: instance.partId,
        colorId: instance.colorId,
        matrix: instance.transformation,
        position: instance.position,
        inverse: invertMat3(instance.transformation),
        bounds: instanceBounds,
        meshIndex,
        isOccluder,
        geometryIncomplete: mesh ? mesh.truncated || mesh.missingReferences.length > 0 : true,
      });
    });

    this.bounds = bounds;
    this.center = boxCenter(bounds);
    const dx = bounds.max.x - this.center.x;
    const dy = bounds.max.y - this.center.y;
    const dz = bounds.max.z - this.center.z;
    this.boundingRadius = Number.isFinite(dx) ? Math.sqrt(dx * dx + dy * dy + dz * dz) : 0;

    const n = this.instances.length;
    this.instBounds = new Float32Array(n * 6);
    this.instInverse = new Float64Array(n * 9);
    this.instPosition = new Float64Array(n * 3);
    this.instMesh = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const instance = this.instances[i]!;
      const b = i * 6;
      this.instBounds[b] = instance.bounds.min.x;
      this.instBounds[b + 1] = instance.bounds.min.y;
      this.instBounds[b + 2] = instance.bounds.min.z;
      this.instBounds[b + 3] = instance.bounds.max.x;
      this.instBounds[b + 4] = instance.bounds.max.y;
      this.instBounds[b + 5] = instance.bounds.max.z;
      this.instPosition[i * 3] = instance.position.x;
      this.instPosition[i * 3 + 1] = instance.position.y;
      this.instPosition[i * 3 + 2] = instance.position.z;
      const inv = instance.inverse;
      if (inv) for (let k = 0; k < 9; k++) this.instInverse[i * 9 + k] = inv[k]!;
      this.instMesh[i] = inv ? instance.meshIndex : -1;
    }

    this.occluderIndices = this.instances.filter((i) => i.isOccluder).map((i) => i.index);
    this.order = new Uint32Array(this.occluderIndices);
    this.buildTlas();

    this.stats = {
      instanceCount: instances.length,
      distinctPartCount: this.meshes.length,
      occluderCount,
      transparentCount,
      missingGeometryCount: missingGeometry,
      totalTriangles,
      buildMs: Date.now() - started,
    };
  }

  // -- TLAS ----------------------------------------------------------------

  private buildTlas(): void {
    const maxNodes = Math.max(2, this.order.length * 2);
    this.nodeBounds = new Float32Array(maxNodes * 6);
    this.nodeLeft = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.nodeStart = new Int32Array(maxNodes);

    this.nodeStart[0] = 0;
    this.nodeCount[0] = this.order.length;
    this.nodeLeft[0] = -1;
    this.nodeUsed = 1;
    if (this.order.length === 0) {
      this.setNodeBounds(0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
      return;
    }
    this.updateNodeBounds(0);
    this.subdivide(0, 0);
  }

  private setNodeBounds(
    node: number,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
  ): void {
    const b = node * 6;
    this.nodeBounds[b] = x0;
    this.nodeBounds[b + 1] = y0;
    this.nodeBounds[b + 2] = z0;
    this.nodeBounds[b + 3] = x1;
    this.nodeBounds[b + 4] = y1;
    this.nodeBounds[b + 5] = z1;
  }

  private updateNodeBounds(node: number): void {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const start = this.nodeStart[node]!;
    const count = this.nodeCount[node]!;
    for (let i = 0; i < count; i++) {
      const b = this.order[start + i]! * 6;
      if (this.instBounds[b]! < x0) x0 = this.instBounds[b]!;
      if (this.instBounds[b + 1]! < y0) y0 = this.instBounds[b + 1]!;
      if (this.instBounds[b + 2]! < z0) z0 = this.instBounds[b + 2]!;
      if (this.instBounds[b + 3]! > x1) x1 = this.instBounds[b + 3]!;
      if (this.instBounds[b + 4]! > y1) y1 = this.instBounds[b + 4]!;
      if (this.instBounds[b + 5]! > z1) z1 = this.instBounds[b + 5]!;
    }
    this.setNodeBounds(node, x0, y0, z0, x1, y1, z1);
  }

  private subdivide(node: number, depth: number): void {
    const count = this.nodeCount[node]!;
    if (count <= 2 || depth > 48) return;

    const b = node * 6;
    const ex = this.nodeBounds[b + 3]! - this.nodeBounds[b]!;
    const ey = this.nodeBounds[b + 4]! - this.nodeBounds[b + 1]!;
    const ez = this.nodeBounds[b + 5]! - this.nodeBounds[b + 2]!;
    const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2;
    const extent = axis === 0 ? ex : axis === 1 ? ey : ez;
    if (extent < 1e-6) return;

    const split = this.nodeBounds[b + axis]! + extent / 2;
    const start = this.nodeStart[node]!;

    let i = start;
    let j = start + count - 1;
    while (i <= j) {
      const idx = this.order[i]! * 6;
      const center = (this.instBounds[idx + axis]! + this.instBounds[idx + 3 + axis]!) / 2;
      if (center < split) {
        i++;
      } else {
        const tmp = this.order[i]!;
        this.order[i] = this.order[j]!;
        this.order[j] = tmp;
        j--;
      }
    }

    let leftCount = i - start;
    // Many LDraw models stack coincident parts, which defeats a spatial split.
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1;

    const left = this.nodeUsed;
    this.nodeUsed += 2;
    this.nodeStart[left] = start;
    this.nodeCount[left] = leftCount;
    this.nodeLeft[left] = -1;
    this.nodeStart[left + 1] = start + leftCount;
    this.nodeCount[left + 1] = count - leftCount;
    this.nodeLeft[left + 1] = -1;

    this.nodeLeft[node] = left;
    this.nodeCount[node] = 0;

    this.updateNodeBounds(left);
    this.updateNodeBounds(left + 1);
    this.subdivide(left, depth + 1);
    this.subdivide(left + 1, depth + 1);
  }

  // -- Queries -------------------------------------------------------------

  /**
   * True if any opaque geometry blocks the ray between `epsilon` and `tMax`.
   *
   * Transparent instances are not in the occluder set at all, so a ray passing
   * through a trans-clear brick counts as reaching the outside. That is the
   * conservative choice: it can only ever cause us to call a part visible when
   * it is arguably hidden, never the reverse.
   */
  occluded(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMax: number,
    epsilon = 0.02,
  ): boolean {
    if (this.nodeUsed === 0 || this.order.length === 0) return false;

    const invDx = 1 / (dx === 0 ? 1e-30 : dx);
    const invDy = 1 / (dy === 0 ? 1e-30 : dy);
    const invDz = 1 / (dz === 0 ? 1e-30 : dz);

    const stack = ModelScene.stack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp]!;
      const count = this.nodeCount[node]!;

      if (count === 0) {
        // Descend into the nearer child first. In a dense model most rays are
        // blocked within a few LDU, so front-to-back order turns a full walk
        // of the ray's path into a couple of box tests.
        const left = this.nodeLeft[node]!;
        if (left < 0) continue;
        const tLeft = boxEntry(this.nodeBounds, left, ox, oy, oz, invDx, invDy, invDz, epsilon, tMax);
        const tRight = boxEntry(this.nodeBounds, left + 1, ox, oy, oz, invDx, invDy, invDz, epsilon, tMax);
        if (tLeft <= tRight) {
          if (tRight < Infinity) stack[sp++] = left + 1;
          if (tLeft < Infinity) stack[sp++] = left;
        } else {
          if (tLeft < Infinity) stack[sp++] = left;
          if (tRight < Infinity) stack[sp++] = left + 1;
        }
        continue;
      }

      const start = this.nodeStart[node]!;
      for (let i = 0; i < count; i++) {
        const index = this.order[start + i]!;
        const meshIndex = this.instMesh[index]!;
        if (meshIndex < 0) continue;
        if (boxEntry(this.instBounds, index, ox, oy, oz, invDx, invDy, invDz, epsilon, tMax) === Infinity) {
          continue;
        }

        // Scalar transform into part space. This is the hottest code in the
        // whole application, so it deliberately allocates nothing.
        const mo = index * 9;
        const po = index * 3;
        const rx = ox - this.instPosition[po]!;
        const ry = oy - this.instPosition[po + 1]!;
        const rz = oz - this.instPosition[po + 2]!;
        const m0 = this.instInverse[mo]!, m1 = this.instInverse[mo + 1]!, m2 = this.instInverse[mo + 2]!;
        const m3 = this.instInverse[mo + 3]!, m4 = this.instInverse[mo + 4]!, m5 = this.instInverse[mo + 5]!;
        const m6 = this.instInverse[mo + 6]!, m7 = this.instInverse[mo + 7]!, m8 = this.instInverse[mo + 8]!;

        if (
          this.bvhs[meshIndex]!.intersectsRay(
            m0 * rx + m1 * ry + m2 * rz,
            m3 * rx + m4 * ry + m5 * rz,
            m6 * rx + m7 * ry + m8 * rz,
            m0 * dx + m1 * dy + m2 * dz,
            m3 * dx + m4 * dy + m5 * dz,
            m6 * dx + m7 * dy + m8 * dz,
            tMax,
            epsilon,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** Distance at which a ray from `origin` leaves the model's bounding sphere. */
  escapeDistance(origin: Vec3, direction: Vec3): number {
    return this.escapeDistanceScalar(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z);
  }

  /** Allocation-free variant used by the visibility engine's inner loop. */
  escapeDistanceScalar(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): number {
    const r = this.boundingRadius * 1.05 + 1;
    const px = ox - this.center.x;
    const py = oy - this.center.y;
    const pz = oz - this.center.z;
    const b = px * dx + py * dy + pz * dz;
    const c = px * px + py * py + pz * pz - r * r;
    const disc = b * b - c;
    if (disc <= 0) return r * 2;
    const t = -b + Math.sqrt(disc);
    return t > 1 ? t : 1;
  }

  /** The per-instance records the visibility engine works from. */
  /**
   * World-space bounding box of one instance, written into `out` as
   * [minX, minY, minZ, maxX, maxY, maxZ]. Reads the flat array so it works on a
   * scene restored in a worker, where the descriptive `instances` list is empty.
   */
  instanceBoundsInto(index: number, out: Float64Array): boolean {
    const b = index * 6;
    if (b + 5 >= this.instBounds.length) return false;
    for (let k = 0; k < 6; k++) out[k] = this.instBounds[b + k]!;
    return true;
  }

  /** True when the instance has resolved geometry that can be ray-tested. */
  instanceHasGeometry(index: number): boolean {
    return index >= 0 && index < this.instMesh.length && this.instMesh[index]! >= 0;
  }

  /**
   * Distance along the ray at which it first hits THIS instance's own
   * triangles, or Infinity.
   *
   * The ray is moved into the part's local space by the instance's inverse
   * transform. The direction is deliberately NOT renormalised afterwards: the
   * transform is affine, so leaving the direction unnormalised keeps the ray
   * parameter `t` identical in both spaces and the returned distance is
   * directly comparable to a world-space occlusion query.
   */
  nearestHitOnInstance(
    index: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): number {
    const meshIndex = this.instMesh[index] ?? -1;
    if (meshIndex < 0) return Infinity;
    const bvh = this.bvhs[meshIndex];
    if (!bvh) return Infinity;

    const p = index * 3;
    const rx = ox - this.instPosition[p]!;
    const ry = oy - this.instPosition[p + 1]!;
    const rz = oz - this.instPosition[p + 2]!;
    const m = index * 9;
    const i0 = this.instInverse[m]!, i1 = this.instInverse[m + 1]!, i2 = this.instInverse[m + 2]!;
    const i3 = this.instInverse[m + 3]!, i4 = this.instInverse[m + 4]!, i5 = this.instInverse[m + 5]!;
    const i6 = this.instInverse[m + 6]!, i7 = this.instInverse[m + 7]!, i8 = this.instInverse[m + 8]!;

    const lox = i0 * rx + i1 * ry + i2 * rz;
    const loy = i3 * rx + i4 * ry + i5 * rz;
    const loz = i6 * rx + i7 * ry + i8 * rz;
    const ldx = i0 * dx + i1 * dy + i2 * dz;
    const ldy = i3 * dx + i4 * dy + i5 * dz;
    const ldz = i6 * dx + i7 * dy + i8 * dz;

    return bvh.nearestHit(lox, loy, loz, ldx, ldy, ldz, Infinity, 1e-4);
  }

  visibilityTargets(instances: readonly PartInstance[]): VisibilityTargetRecord[] {
    return instances.map((instance, index) => {
      const sceneInstance = this.instances[index]!;
      return {
        sceneIndex: index,
        instanceId: instance.instanceId,
        partId: instance.partId,
        partFile: instance.partFile,
        matrix: instance.transformation,
        position: instance.position,
        geometryIncomplete: sceneInstance.geometryIncomplete,
        isTransparent: !sceneInstance.isOccluder && sceneInstance.meshIndex >= 0,
      };
    });
  }

  toTransfer(): TransferableScene {
    return {
      bvhs: this.bvhs.map((bvh) => bvh.toTransfer()),
      instBounds: this.instBounds,
      instInverse: this.instInverse,
      instPosition: this.instPosition,
      instMesh: this.instMesh,
      order: this.order,
      nodeBounds: this.nodeBounds,
      nodeLeft: this.nodeLeft,
      nodeCount: this.nodeCount,
      nodeStart: this.nodeStart,
      nodeUsed: this.nodeUsed,
      center: this.center,
      boundingRadius: this.boundingRadius,
    };
  }

  /**
   * Rebuild a queryable scene from transferred arrays. Only the ray query is
   * restored; the descriptive `instances`/`meshes`/`stats` are not needed by a
   * worker and are left empty.
   */
  static fromTransfer(data: TransferableScene): ModelScene {
    const scene = Object.create(ModelScene.prototype) as Record<string, unknown>;
    scene.instances = [];
    scene.meshes = [];
    scene.bvhs = data.bvhs.map((bvh) => TriangleBVH.fromTransfer(bvh));
    scene.instBounds = data.instBounds;
    scene.instInverse = data.instInverse;
    scene.instPosition = data.instPosition;
    scene.instMesh = data.instMesh;
    scene.order = data.order;
    scene.nodeBounds = data.nodeBounds;
    scene.nodeLeft = data.nodeLeft;
    scene.nodeCount = data.nodeCount;
    scene.nodeStart = data.nodeStart;
    scene.nodeUsed = data.nodeUsed;
    scene.center = data.center;
    scene.boundingRadius = data.boundingRadius;
    scene.bounds = emptyBox();
    scene.occluderIndices = [];
    scene.stats = {
      instanceCount: 0, distinctPartCount: data.bvhs.length, occluderCount: data.order.length,
      transparentCount: 0, missingGeometryCount: 0, totalTriangles: 0, buildMs: 0,
    };
    return scene as unknown as ModelScene;
  }

  private static readonly stack = new Int32Array(256);
}

/** Ray entry distance into box `slot` of a packed 6-floats-per-box array. */
function boxEntry(
  boxes: Float32Array,
  slot: number,
  ox: number, oy: number, oz: number,
  invDx: number, invDy: number, invDz: number,
  tMin: number, tMax: number,
): number {
  const b = slot * 6;
  let t0 = (boxes[b]! - ox) * invDx;
  let t1 = (boxes[b + 3]! - ox) * invDx;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  let lo = t0;
  let hi = t1;

  t0 = (boxes[b + 1]! - oy) * invDy;
  t1 = (boxes[b + 4]! - oy) * invDy;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  if (lo > hi) return Infinity;

  t0 = (boxes[b + 2]! - oz) * invDz;
  t1 = (boxes[b + 5]! - oz) * invDz;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  if (lo > hi || hi < tMin || lo > tMax) return Infinity;
  return lo > tMin ? lo : tMin;
}
