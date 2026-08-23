/**
 * Resolves an LDraw part reference into a triangle mesh in part-local space.
 *
 * A part file is a tree: `3001.dat` references `s/3001s01.dat` and primitives
 * like `stud.dat` and `box5.dat`, which reference further primitives. This
 * walks that tree, applies the accumulated transform to every triangle, and
 * flattens the result.
 *
 * Notes on fidelity:
 *  - Line types 2 (line) and 5 (optional line) are edge decorations, not
 *    surfaces. They are skipped: they contribute nothing to occlusion and
 *    rendering them as geometry would be wrong.
 *  - Quads (type 4) are split into two triangles on the 0-1-2 / 0-2-3 diagonal.
 *  - BFC winding is deliberately NOT tracked. The visibility engine samples
 *    directions over the full sphere rather than a normal-oriented hemisphere,
 *    so it never needs a reliable outward normal, and the viewer renders
 *    double-sided. This removes a whole class of "part had inverted normals"
 *    bugs. See docs/ARCHITECTURE.md.
 *  - Color 16 on a triangle means "inherit from the instance". It is stored as
 *    16 and resolved at render time. Any other value is a fixed color baked
 *    into the part (rubber tyres, printed decoration) and is preserved, which
 *    also means the optimizer must never assume recoloring an instance changes
 *    every triangle.
 */

import { LIMITS } from '../security/limits';
import { IDENTITY_MAT3, composeTransform, expandBox, emptyBox, transformPoint, type Box3, type Mat3, type Vec3 } from '../ldraw/math';
import { COLOR_INHERIT, parseColorToken } from '../ldraw/parser';
import { parseLDraw } from '../ldraw/parser';
import type { PartSource } from './partSource';

export interface PartMesh {
  /** 9 floats per triangle: x1,y1,z1, x2,y2,z2, x3,y3,z3. */
  readonly positions: Float32Array;
  /** One color id per triangle. 16 means "inherit the instance color". */
  readonly triangleColors: Int32Array;
  readonly triangleCount: number;
  readonly bounds: Box3;
  /** Sum of triangle areas, used to scale visibility sampling density. */
  readonly surfaceArea: number;
  /** The part's description, taken from the first line of its .dat file. */
  readonly description: string | null;
  /** References inside this part that could not be found in the library. */
  readonly missingReferences: readonly string[];
  /** True when a limit stopped expansion and the mesh is incomplete. */
  readonly truncated: boolean;
}

export const EMPTY_MESH: PartMesh = {
  positions: new Float32Array(0),
  triangleColors: new Int32Array(0),
  triangleCount: 0,
  bounds: emptyBox(),
  surfaceArea: 0,
  description: null,
  missingReferences: [],
  truncated: false,
};

interface BuildState {
  positions: number[];
  colors: number[];
  missing: Set<string>;
  truncated: boolean;
  description: string | null;
}

/**
 * Caches resolved part meshes by reference. A 10,000-part model typically uses
 * only a few hundred distinct parts, so this is the single biggest performance
 * lever in the pipeline.
 */
export class PartMeshLibrary {
  private readonly cache = new Map<string, Promise<PartMesh>>();
  private readonly textCache = new Map<string, Promise<string | null>>();

  constructor(private readonly source: PartSource) {}

  get size(): number {
    return this.cache.size;
  }

  /** Distinct part references resolved so far. */
  keys(): string[] {
    return [...this.cache.keys()];
  }

  private readText(reference: string): Promise<string | null> {
    const key = reference.replace(/\\/g, '/').toLowerCase();
    let pending = this.textCache.get(key);
    if (!pending) {
      pending = this.source.read(reference);
      this.textCache.set(key, pending);
    }
    return pending;
  }

  async get(reference: string): Promise<PartMesh> {
    const key = reference.replace(/\\/g, '/').toLowerCase();
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.build(reference);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async build(reference: string): Promise<PartMesh> {
    const state: BuildState = {
      positions: [], colors: [], missing: new Set(), truncated: false, description: null,
    };
    await this.expand(reference, IDENTITY_MAT3, { x: 0, y: 0, z: 0 }, COLOR_INHERIT, 0, state, new Set());

    const triangleCount = state.colors.length;
    const positions = new Float32Array(state.positions);
    const bounds = emptyBox();
    let surfaceArea = 0;
    for (let t = 0; t < triangleCount; t++) {
      const o = t * 9;
      const ax = positions[o]!, ay = positions[o + 1]!, az = positions[o + 2]!;
      const bx = positions[o + 3]!, by = positions[o + 4]!, bz = positions[o + 5]!;
      const cx = positions[o + 6]!, cy = positions[o + 7]!, cz = positions[o + 8]!;
      expandBox(bounds, { x: ax, y: ay, z: az });
      expandBox(bounds, { x: bx, y: by, z: bz });
      expandBox(bounds, { x: cx, y: cy, z: cz });
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      surfaceArea += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    }

    return {
      positions,
      triangleColors: new Int32Array(state.colors),
      triangleCount,
      bounds,
      surfaceArea,
      description: state.description,
      missingReferences: [...state.missing],
      truncated: state.truncated,
    };
  }

  private async expand(
    reference: string,
    matrix: Mat3,
    position: Vec3,
    color: number,
    depth: number,
    state: BuildState,
    ancestry: ReadonlySet<string>,
  ): Promise<void> {
    if (depth > LIMITS.maxPartDepth) {
      state.truncated = true;
      return;
    }
    if (state.colors.length > LIMITS.maxTrianglesPerPart) {
      state.truncated = true;
      return;
    }

    const key = reference.replace(/\\/g, '/').toLowerCase();
    if (ancestry.has(key)) {
      // A primitive that references itself would loop forever.
      state.truncated = true;
      return;
    }

    const text = await this.readText(reference);
    if (text === null) {
      state.missing.add(reference);
      return;
    }

    const document = parseLDraw(text, { sourceName: reference });

    if (depth === 0 && state.description === null) {
      // The first line of a .dat file is the part's description, e.g.
      // "Brick  2 x  4". A leading ~ or = marks an obsolete part or an alias.
      const first = document.files[0]?.commands.find((c) => c.type !== 'blank');
      if (first?.type === 'meta' && first.text.length > 0) {
        state.description = first.text.replace(/\s+/g, ' ').trim();
      }
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(key);

    // A .dat is normally a single block, but be tolerant of embedded 0 FILE.
    for (const file of document.files) {
      for (const command of file.commands) {
        if (command.type === 'part') {
          const resolvedColor = command.colorId === COLOR_INHERIT ? color : command.colorId;
          const composed = composeTransform(matrix, position, command.matrix, command.position);
          await this.expand(
            command.file,
            composed.matrix,
            composed.position,
            resolvedColor,
            depth + 1,
            state,
            nextAncestry,
          );
          continue;
        }
        if (command.type === 'triangle') {
          const c = command.coords;
          this.pushTriangle(
            state,
            matrix,
            position,
            command.colorId === COLOR_INHERIT ? color : command.colorId,
            c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!, c[8]!,
          );
          continue;
        }
        if (command.type === 'quad') {
          const c = command.coords;
          const resolved = command.colorId === COLOR_INHERIT ? color : command.colorId;
          this.pushTriangle(state, matrix, position, resolved,
            c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!, c[8]!);
          this.pushTriangle(state, matrix, position, resolved,
            c[0]!, c[1]!, c[2]!, c[6]!, c[7]!, c[8]!, c[9]!, c[10]!, c[11]!);
          continue;
        }
        // Types 2 and 5 are edge lines - not surfaces. Skipped deliberately.
      }
    }
  }

  private pushTriangle(
    state: BuildState,
    matrix: Mat3,
    position: Vec3,
    colorId: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    if (state.colors.length > LIMITS.maxTrianglesPerPart) {
      state.truncated = true;
      return;
    }
    const a = transformPoint(matrix, position, { x: ax, y: ay, z: az });
    const b = transformPoint(matrix, position, { x: bx, y: by, z: bz });
    const c = transformPoint(matrix, position, { x: cx, y: cy, z: cz });
    state.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    state.colors.push(colorId);
  }
}

/** Color ids referenced by LDraw geometry that are not real materials. */
export function isInheritColor(colorId: number): boolean {
  return colorId === COLOR_INHERIT;
}

export { parseColorToken };
