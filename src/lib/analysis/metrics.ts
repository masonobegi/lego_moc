/**
 * Measurements of how well the optimizer did on one model.
 *
 * These exist so the question "is this product actually worth anything?" can be
 * answered with numbers instead of enthusiasm. `docs/VALIDATION_PLAN.md`
 * describes the study they are built for: run a large sample of real models
 * through the optimizer, look at the distribution of savings, and decide
 * against criteria fixed in advance.
 *
 * On privacy: nothing here is uploaded, transmitted or written anywhere except
 * the local analysis record the app already keeps on the user's own machine.
 * The fields exist so that a future opt-in study CAN be built; the collection
 * does not exist, and adding it would be a deliberate change requiring the
 * user's explicit consent. There is no telemetry in this application.
 */

import type {
  AnalysisResult,
  DeliveredCostComparison,
  OptimizationQualityMetrics,
  SavingsSummary,
} from './types';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildQualityMetrics(
  result: AnalysisResult,
  savings: SavingsSummary,
  delivered: DeliveredCostComparison | null = null,
): OptimizationQualityMetrics {
  const partCount = result.model.partCount;
  const hidden = result.visibility.counts.HIDDEN + result.visibility.counts.LIKELY_HIDDEN;
  const rejectedCandidates = result.rejections.reduce((sum, r) => sum + r.commandCount, 0);

  return {
    originalEstimatedPartCost: savings.originalCost,
    optimizedEstimatedPartCost: savings.optimizedCost,
    estimatedPartSavings: savings.savings,
    savingsPercent: savings.savingsPercent,
    highConfidenceEstimatedPartSavings: savings.highConfidenceSavings,
    currency: savings.currency,

    partCount,
    changedPieceCount: savings.changedPieceCount,
    changedPiecePercent: partCount > 0 ? round2((savings.changedPieceCount / partCount) * 100) : 0,
    hiddenPieceCount: hidden,
    hiddenPiecePercent: partCount > 0 ? round2((hidden / partCount) * 100) : 0,

    candidateCount: savings.candidateCount,
    enabledChangeCount: savings.enabledCount,
    rejectedCandidateCount: rejectedCandidates,

    delivered,
  };
}

/**
 * Turn two delivered-order totals the user read off BrickLink into a
 * comparison.
 *
 * `predictionError` is what we said we would save minus what BrickLink's two
 * totals actually differed by. A large positive number means our estimate was
 * optimistic - shipping, minimums or seller splits ate the difference. That
 * number is the whole point: it is the only feedback in the system about
 * whether the parts-price estimate means anything in practice.
 */
export function compareDeliveredCosts(input: {
  originalDeliveredEstimate: number;
  optimizedDeliveredEstimate: number;
  currency: string;
  predictedSavings: number;
  note?: string | null;
  now?: string;
}): DeliveredCostComparison {
  const difference = round2(input.originalDeliveredEstimate - input.optimizedDeliveredEstimate);
  return {
    originalDeliveredEstimate: round2(input.originalDeliveredEstimate),
    optimizedDeliveredEstimate: round2(input.optimizedDeliveredEstimate),
    currency: input.currency,
    difference,
    predictionError: round2(input.predictedSavings - difference),
    enteredAt: input.now ?? new Date().toISOString(),
    note: input.note ?? null,
  };
}
