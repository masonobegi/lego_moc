import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { applyToInstances, computeSavings } from '@/lib/analysis/pipeline';
import { calculateCost } from '@/lib/pricing/priceEngine';
import { ResultsView } from '@/components/results/ResultsView';
import { loadAnalysis } from '@/lib/runtime/store';
import { rehydrate } from '@/lib/runtime/rehydrate';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const record = loadAnalysis(id);
  return { title: record ? `${record.result.model.title} - results` : 'Results' };
}

export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = loadAnalysis(id);
  if (!record) notFound();

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

  return (
    <ResultsView
      result={record.result}
      initialSavings={savings}
      initialOrderSummary={{
        lots: optimizedCost.lotCount,
        pieces: optimizedCost.pricedPieceCount,
        unpriced: optimizedCost.unpricedLots.length,
      }}
    />
  );
}
