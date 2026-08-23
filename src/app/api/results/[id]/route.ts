import { NextResponse } from 'next/server';

import { applyToInstances, computeSavings } from '@/lib/analysis/pipeline';
import { calculateCost } from '@/lib/pricing/priceEngine';
import { loadAnalysis } from '@/lib/runtime/store';
import { rehydrate } from '@/lib/runtime/rehydrate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const record = loadAnalysis(id);
  if (!record) {
    return NextResponse.json({ error: 'That analysis is no longer available.' }, { status: 404 });
  }

  const { instances, prices } = rehydrate(record);
  const enabled = new Set(record.result.defaultEnabledIds);
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

  return NextResponse.json({ result: record.result, savings, optimizedCost });
}
