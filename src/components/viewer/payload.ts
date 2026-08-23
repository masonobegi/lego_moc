'use client';

/**
 * Client-side decoder for the viewer's binary payload.
 * Mirrors src/lib/analysis/viewerPayload.ts.
 */

import type { ViewerHeader } from '@/lib/analysis/viewerPayload';

export interface DecodedPayload {
  readonly header: ViewerHeader;
  /** Triangle positions per distinct part, in header order. */
  readonly partPositions: Float32Array[];
  /** 12 floats per instance: 3x3 row-major matrix then x, y, z. */
  readonly transforms: Float32Array;
  readonly colorIds: Int32Array;
  readonly partIndices: Int32Array;
}

export function decodeViewerPayload(buffer: ArrayBuffer): DecodedPayload {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as ViewerHeader;
  const base = 4 + headerLength;

  const partPositions = header.parts.map(
    (part) => new Float32Array(buffer.slice(base + part.byteOffset, base + part.byteOffset + part.byteLength)),
  );

  const count = header.instanceCount;
  const transforms = new Float32Array(buffer.slice(base + header.transformsOffset, base + header.transformsOffset + count * 12 * 4));
  const colorIds = new Int32Array(buffer.slice(base + header.colorsOffset, base + header.colorsOffset + count * 4));
  const partIndices = new Int32Array(buffer.slice(base + header.partIndexOffset, base + header.partIndexOffset + count * 4));

  return { header, partPositions, transforms, colorIds, partIndices };
}
