import { buildViewerPayload } from '@/lib/analysis/viewerPayload';
import { PartMeshLibrary, type PartMesh } from '@/lib/geometry/partMesh';
import { getPartSource } from '@/lib/runtime/services';
import { loadAnalysis } from '@/lib/runtime/store';
import { rehydrate } from '@/lib/runtime/rehydrate';
import type { VisibilityClass } from '@/lib/optimizer/visibilityEngine';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * Geometry for the 3D viewer.
 *
 * Meshes are rebuilt from the parts library rather than stored: resolving a
 * few hundred distinct parts takes a couple of seconds and costs nothing to
 * keep, whereas caching megabytes of triangles per analysis would not scale.
 * The result is cached in the process for repeat views.
 */
const cache = new Map<string, Uint8Array>();
const CACHE_LIMIT = 4;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const record = loadAnalysis(id);
  if (!record) {
    return new Response(JSON.stringify({ error: 'That analysis is no longer available.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Every candidate's replacement is included, enabled or not, so the browser
  // can switch between original and optimised instantly without refetching
  // megabytes of geometry each time a checkbox moves.
  const cacheKey = id;
  const cached = cache.get(cacheKey);
  if (cached) return binary(cached);

  const { instances } = rehydrate(record);

  const library = new PartMeshLibrary(getPartSource());
  const meshes = new Map<string, PartMesh>();
  const seen = new Map<string, string>();
  for (const instance of instances) {
    if (!seen.has(instance.partId)) seen.set(instance.partId, instance.partFile);
  }
  // The optimiser may swap in a part the original model never used.
  for (const candidate of record.result.candidates) {
    if (!seen.has(candidate.replacementPartId)) {
      seen.set(candidate.replacementPartId, `${candidate.replacementPartId}.dat`);
    }
  }
  for (const [partId, reference] of seen) {
    meshes.set(partId, await library.get(reference));
  }

  const visibility = new Map<string, VisibilityClass>();
  const changes = new Map<
    string,
    { candidateId: string; colorId: number; partId: string; colorName: string }
  >();
  for (const candidate of record.result.candidates) {
    for (const instanceId of candidate.instanceIds) {
      if (changes.has(instanceId)) continue;
      changes.set(instanceId, {
        candidateId: candidate.id,
        colorId: candidate.replacementColorId,
        partId: candidate.replacementPartId,
        colorName: candidate.replacementColorName,
      });
    }
  }
  for (const candidate of record.result.candidates) {
    for (const instanceId of candidate.instanceIds) {
      visibility.set(instanceId, candidate.visibility.classification);
    }
  }

  const payload = buildViewerPayload({ instances, meshes, visibility, changes });

  cache.set(cacheKey, payload);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return binary(payload);
}

function binary(payload: Uint8Array): Response {
  return new Response(payload as unknown as BodyInit, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': String(payload.byteLength),
    },
  });
}
