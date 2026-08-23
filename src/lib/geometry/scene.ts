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
  applyMat3,
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
import { TriangleBVH } from './bvh';
import type { PartMesh } from './partMesh';

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

interface TlasNode {
  bounds: Box3;
  start: number;
  count: number;
  left: number;
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

export class ModelScene {
  readonly instances: SceneInstance[];
  readonly meshes: PartMesh[];
  readonly bvhs: TriangleBVH[];
  readonly bounds: Box3;
  readonly boundingRadius: number;
  readonly center: Vec3;
  readonly stats: SceneBuildStats;

  private readonly nodes: TlasNode[] = [];
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
    if (this.order.length === 0) {
      this.nodes.push({ bounds: emptyBox(), start: 0, count: 0, left: -1 });
      return;
    }
    this.nodes.push({ bounds: emptyBox(), start: 0, count: this.order.length, left: -1 });
    this.updateNodeBounds(0);
    this.subdivide(0, 0);
  }

  private updateNodeBounds(nodeIndex: number): void {
    const node = this.nodes[nodeIndex]!;
    const bounds = emptyBox();
    for (let i = 0; i < node.count; i++) {
      const instance = this.instances[this.order[node.start + i]!]!;
      expandBox(bounds, instance.bounds.min);
      expandBox(bounds, instance.bounds.max);
    }
    node.bounds = bounds;
  }

  private subdivide(nodeIndex: number, depth: number): void {
    const node = this.nodes[nodeIndex]!;
    if (node.count <= 4 || depth > 40) return;

    const extentX = node.bounds.max.x - node.bounds.min.x;
    const extentY = node.bounds.max.y - node.bounds.min.y;
    const extentZ = node.bounds.max.z - node.bounds.min.z;
    const axis = extentX > extentY ? (extentX > extentZ ? 0 : 2) : extentY > extentZ ? 1 : 2;
    const extent = axis === 0 ? extentX : axis === 1 ? extentY : extentZ;
    if (extent < 1e-6) return;

    const centerOf = (index: number): number => {
      const c = boxCenter(this.instances[index]!.bounds);
      return axis === 0 ? c.x : axis === 1 ? c.y : c.z;
    };

    const split =
      (axis === 0 ? node.bounds.min.x : axis === 1 ? node.bounds.min.y : node.bounds.min.z) + extent / 2;

    let i = node.start;
    let j = node.start + node.count - 1;
    while (i <= j) {
      if (centerOf(this.order[i]!) < split) {
        i++;
      } else {
        const tmp = this.order[i]!;
        this.order[i] = this.order[j]!;
        this.order[j] = tmp;
        j--;
      }
    }

    let leftCount = i - node.start;
    if (leftCount === 0 || leftCount === node.count) {
      // Degenerate spatial split (many coincident boxes): fall back to a median split.
      leftCount = node.count >> 1;
    }

    const leftIndex = this.nodes.length;
    this.nodes.push({ bounds: emptyBox(), start: node.start, count: leftCount, left: -1 });
    this.nodes.push({
      bounds: emptyBox(),
      start: node.start + leftCount,
      count: node.count - leftCount,
      left: -1,
    });
    node.left = leftIndex;
    node.count = 0;

    this.updateNodeBounds(leftIndex);
    this.updateNodeBounds(leftIndex + 1);
    this.subdivide(leftIndex, depth + 1);
    this.subdivide(leftIndex + 1, depth + 1);
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
    if (this.nodes.length === 0) return false;

    const invDx = 1 / (dx === 0 ? 1e-12 : dx);
    const invDy = 1 / (dy === 0 ? 1e-12 : dy);
    const invDz = 1 / (dz === 0 ? 1e-12 : dz);

    const stack = ModelScene.stack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const nodeIndex = stack[--sp]!;
      const node = this.nodes[nodeIndex]!;
      if (!slabTest(node.bounds, ox, oy, oz, invDx, invDy, invDz, epsilon, tMax)) continue;

      if (node.count === 0 && node.left >= 0) {
        stack[sp++] = node.left;
        stack[sp++] = node.left + 1;
        continue;
      }

      for (let i = 0; i < node.count; i++) {
        const instance = this.instances[this.order[node.start + i]!]!;
        if (instance.meshIndex < 0 || instance.inverse === null) continue;
        if (!slabTest(instance.bounds, ox, oy, oz, invDx, invDy, invDz, epsilon, tMax)) continue;

        const inv = instance.inverse;
        const rx = ox - instance.position.x;
        const ry = oy - instance.position.y;
        const rz = oz - instance.position.z;
        const lo = applyMat3(inv, { x: rx, y: ry, z: rz });
        const ld = applyMat3(inv, { x: dx, y: dy, z: dz });

        if (this.bvhs[instance.meshIndex]!.intersectsRay(lo.x, lo.y, lo.z, ld.x, ld.y, ld.z, tMax, epsilon)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Distance at which a ray from `origin` leaves the model's bounding sphere. */
  escapeDistance(origin: Vec3, direction: Vec3): number {
    const r = this.boundingRadius * 1.05 + 1;
    const ox = origin.x - this.center.x;
    const oy = origin.y - this.center.y;
    const oz = origin.z - this.center.z;
    const b = ox * direction.x + oy * direction.y + oz * direction.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - c;
    if (disc <= 0) return r * 2;
    return Math.max(1, -b + Math.sqrt(disc));
  }

  private static readonly stack = new Int32Array(256);
}

function slabTest(
  bounds: Box3,
  ox: number, oy: number, oz: number,
  invDx: number, invDy: number, invDz: number,
  tMin: number, tMax: number,
): boolean {
  let t0 = (bounds.min.x - ox) * invDx;
  let t1 = (bounds.max.x - ox) * invDx;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  let lo = t0;
  let hi = t1;

  t0 = (bounds.min.y - oy) * invDy;
  t1 = (bounds.max.y - oy) * invDy;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;
  if (lo > hi) return false;

  t0 = (bounds.min.z - oz) * invDz;
  t1 = (bounds.max.z - oz) * invDz;
  if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
  if (t0 > lo) lo = t0;
  if (t1 < hi) hi = t1;

  return lo <= hi && hi >= tMin && lo <= tMax;
}
