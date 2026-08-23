/**
 * Builds the binary payload the 3D viewer downloads.
 *
 * Sending part geometry as JSON is not viable: a 6,000-part model is 5 million
 * instanced triangles. Two things make it small enough:
 *
 *  1. Only DISTINCT parts are sent. A 6,000-part model typically uses a few
 *     hundred distinct parts, so the browser instances them rather than
 *     receiving the same brick 200 times.
 *  2. Geometry and per-instance transforms go in a binary block; only labels
 *     and identifiers go in JSON.
 *
 * Layout:
 *   [uint32 LE]  header JSON byte length
 *   [bytes]      header JSON, UTF-8
 *   [bytes]      part triangle positions, Float32, in header order
 *   [bytes]      instance transforms, Float32, 12 per instance (3x3 then xyz)
 *   [bytes]      instance color ids, Int32
 *   [bytes]      instance part indices, Int32
 */

import { colorHex, getColor } from '../ldraw/colors';
import type { PartMesh } from '../geometry/partMesh';
import type { PartInstance } from '../ldraw/types';
import type { VisibilityClass } from '../optimizer/visibilityEngine';

export interface ViewerHeader {
  readonly version: 1;
  readonly bounds: { min: [number, number, number]; max: [number, number, number] };
  readonly parts: readonly {
    partId: string;
    description: string | null;
    triangleCount: number;
    byteOffset: number;
    byteLength: number;
  }[];
  readonly instanceCount: number;
  readonly transformsOffset: number;
  readonly colorsOffset: number;
  readonly partIndexOffset: number;
  readonly instances: readonly {
    /** instanceId */
    id: string;
    /** part id */
    p: string;
    /** step index within its sub-file */
    s: number;
    /** sub-file name */
    m: string;
    /** color name */
    cn: string;
    /** color hex */
    ch: string;
    /** alpha 0-255 */
    ca: number;
    /** visibility class, when known */
    v: VisibilityClass | null;
    /** candidate id affecting this instance, when any */
    c: string | null;
    /** optimized color hex, when a candidate applies */
    oh: string | null;
    /** optimized color name */
    on: string | null;
    /** optimized part id */
    op: string | null;
  }[];
  /** Instances omitted because the model exceeded the viewer budget. */
  readonly omittedInstanceCount: number;
  readonly note: string;
}

export interface ViewerPayloadInput {
  readonly instances: readonly PartInstance[];
  readonly meshes: ReadonlyMap<string, PartMesh>;
  readonly visibility: ReadonlyMap<string, VisibilityClass>;
  /** instanceId -> { candidateId, colorId, partId } for enabled changes. */
  readonly changes: ReadonlyMap<
    string,
    { candidateId: string; colorId: number; partId: string; colorName: string }
  >;
  readonly maxInstances?: number;
}

export function buildViewerPayload(input: ViewerPayloadInput): Uint8Array {
  const maxInstances = input.maxInstances ?? 60_000;
  const kept = input.instances.slice(0, maxInstances);
  const omitted = input.instances.length - kept.length;

  const partIndex = new Map<string, number>();
  const partList: { partId: string; mesh: PartMesh }[] = [];
  for (const instance of kept) {
    if (partIndex.has(instance.partId)) continue;
    const mesh = input.meshes.get(instance.partId);
    if (!mesh || mesh.triangleCount === 0) continue;
    partIndex.set(instance.partId, partList.length);
    partList.push({ partId: instance.partId, mesh });
  }

  const drawable = kept.filter((i) => partIndex.has(i.partId));

  let offset = 0;
  const parts = partList.map((entry) => {
    const byteLength = entry.mesh.positions.byteLength;
    const record = {
      partId: entry.partId,
      description: entry.mesh.description,
      triangleCount: entry.mesh.triangleCount,
      byteOffset: offset,
      byteLength,
    };
    offset += byteLength;
    return record;
  });

  const transformsOffset = offset;
  offset += drawable.length * 12 * 4;
  const colorsOffset = offset;
  offset += drawable.length * 4;
  const partIndexOffset = offset;
  offset += drawable.length * 4;
  const binaryLength = offset;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const transforms = new Float32Array(drawable.length * 12);
  const colors = new Int32Array(drawable.length);
  const partIndices = new Int32Array(drawable.length);

  drawable.forEach((instance, i) => {
    const m = instance.transformation;
    const p = instance.position;
    const o = i * 12;
    for (let k = 0; k < 9; k++) transforms[o + k] = m[k]!;
    transforms[o + 9] = p.x;
    transforms[o + 10] = p.y;
    transforms[o + 11] = p.z;

    const change = input.changes.get(instance.instanceId);
    colors[i] = change ? change.colorId : instance.colorId;
    partIndices[i] = partIndex.get(instance.partId)!;

    const mesh = input.meshes.get(instance.partId)!;
    const b = mesh.bounds;
    for (let c = 0; c < 8; c++) {
      const lx = c & 1 ? b.max.x : b.min.x;
      const ly = c & 2 ? b.max.y : b.min.y;
      const lz = c & 4 ? b.max.z : b.min.z;
      const wx = m[0]! * lx + m[1]! * ly + m[2]! * lz + p.x;
      const wy = m[3]! * lx + m[4]! * ly + m[5]! * lz + p.y;
      const wz = m[6]! * lx + m[7]! * ly + m[8]! * lz + p.z;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
  });

  const header: ViewerHeader = {
    version: 1,
    bounds: {
      min: [finite(minX), finite(minY), finite(minZ)],
      max: [finite(maxX), finite(maxY), finite(maxZ)],
    },
    parts,
    instanceCount: drawable.length,
    transformsOffset,
    colorsOffset,
    partIndexOffset,
    instances: drawable.map((instance) => {
      const change = input.changes.get(instance.instanceId);
      const color = getColor(instance.colorId);
      return {
        id: instance.instanceId,
        p: instance.partId,
        s: instance.stepIndex,
        m: instance.parentModel,
        cn: color?.name ?? `Color ${instance.colorId}`,
        ch: colorHex(instance.colorId),
        ca: color?.alpha ?? 255,
        v: input.visibility.get(instance.instanceId) ?? null,
        c: change?.candidateId ?? null,
        oh: change ? colorHex(change.colorId) : null,
        on: change?.colorName ?? null,
        op: change?.partId ?? null,
      };
    }),
    omittedInstanceCount: omitted,
    note:
      omitted > 0
        ? `Only the first ${drawable.length.toLocaleString()} parts are shown in the viewer. ` +
          `The analysis covered all ${input.instances.length.toLocaleString()}.`
        : '',
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + binaryLength);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);

  const base = 4 + headerBytes.length;
  partList.forEach((entry, i) => {
    out.set(new Uint8Array(entry.mesh.positions.buffer, entry.mesh.positions.byteOffset, entry.mesh.positions.byteLength), base + parts[i]!.byteOffset);
  });
  out.set(new Uint8Array(transforms.buffer), base + transformsOffset);
  out.set(new Uint8Array(colors.buffer), base + colorsOffset);
  out.set(new Uint8Array(partIndices.buffer), base + partIndexOffset);

  return out;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
