import { NextResponse } from 'next/server';

import { applyToInstances, computeSavings } from '@/lib/analysis/pipeline';
import { calculateCost } from '@/lib/pricing/priceEngine';
import { loadAnalysis } from '@/lib/runtime/store';
import { rehydrate, resolveEnabledIds } from '@/lib/runtime/rehydrate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recompute the optimized cost for an arbitrary set of enabled changes.
 *
 * The cost is recomputed by applying the changes to the flattened part list and
 * running exactly the same costing function the original total came from,
 * rather than by subtracting savings, so the two totals can never disagree
 * through rounding.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const record = loadAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: 'That analysis is no longer available.' }, { status: 404 });
  }

  let body: { enabledIds?: unknown };
  try {
    body = (await request.json()) as { enabledIds?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const requested = Array.isArray(body.enabledIds)
    ? body.enabledIds.filter((v): v is string => typeof v === 'string').slice(0, 100_000)
    : undefined;

  const enabled = resolveEnabledIds(record, requested);
  const { instances, prices } = rehydrate(record);
  const optimizedInstances = applyToInstances(instances, record.result.candidates, enabled);
  const optimizedCost = calculateCost(
    optimizedInstances,
    prices,
    record.result.pricing.condition,
    record.result.pricing.currency,
  );
  const savings = computeSavings(
    record.result.originalCost.total,
    optimizedCost.total,
    record.result.candidates,
    enabled,
    record.result.pricing.currency,
  );

  return NextResponse.json({ savings, optimizedCost, enabledIds: [...enabled] });
}
