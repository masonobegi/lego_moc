/**
 * The shape of a completed analysis. This is what the results page renders,
 * what the exports are generated from, and what is persisted between requests.
 */

import type { CatalogStatus } from '../catalog/types';
import type { ParseWarning } from '../ldraw/types';
import type { CostSummary } from '../pricing/priceEngine';
import type { Condition, PriceSourceId } from '../pricing/types';
import type { OptimizationCandidate, SafetyLevel } from '../optimizer/types';
import type { VisibilityClass } from '../optimizer/visibilityEngine';

export type AnalysisStage =
  | 'parsing'
  | 'resolving'
  | 'geometry'
  | 'visibility'
  | 'pricing'
  | 'colors'
  | 'molds'
  | 'savings';

export const ANALYSIS_STAGES: { id: AnalysisStage; label: string }[] = [
  { id: 'parsing', label: 'Parsing model' },
  { id: 'resolving', label: 'Resolving parts' },
  { id: 'geometry', label: 'Building geometry' },
  { id: 'visibility', label: 'Analyzing visibility' },
  { id: 'pricing', label: 'Loading prices' },
  { id: 'colors', label: 'Finding cheaper colors' },
  { id: 'molds', label: 'Checking equivalent molds' },
  { id: 'savings', label: 'Calculating savings' },
];

export interface ModelInfo {
  readonly fileName: string;
  readonly title: string;
  readonly author: string | null;
  readonly isMpd: boolean;
  readonly partCount: number;
  readonly uniqueLotCount: number;
  readonly uniquePartCount: number;
  readonly stepCount: number;
  readonly submodelCount: number;
  readonly byteSize: number;
}

export interface ParseReport {
  readonly warnings: readonly ParseWarning[];
  readonly malformedLineCount: number;
  readonly unresolvedSubmodels: readonly string[];
  readonly truncated: boolean;
  readonly truncationReason: string | null;
}

export interface GeometryReport {
  readonly distinctPartCount: number;
  readonly totalTriangles: number;
  readonly sceneBuildMs: number;
  readonly missingParts: readonly { partId: string; reference: string; count: number }[];
  readonly incompletePartCount: number;
}

export interface VisibilityReport {
  readonly counts: Record<VisibilityClass, number>;
  readonly totalRays: number;
  readonly verifiedInstances: number;
  readonly elapsedMs: number;
  /** Worker threads used. 1 means the analysis ran in-process. */
  readonly workerCount: number;
  readonly scope: string;
}

export interface PricingReport {
  readonly sourceId: PriceSourceId;
  readonly sourceLabel: string;
  readonly isLive: boolean;
  readonly isDemoData: boolean;
  readonly condition: Condition;
  readonly currency: string;
  readonly requested: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly elapsedMs: number;
  readonly liveVerified: boolean | null;
  readonly liveFailures: readonly string[];
  readonly notes: readonly string[];
}

export interface RejectionSummary {
  readonly reason: string;
  readonly label: string;
  readonly commandCount: number;
  readonly pieceCount: number;
}

export interface AnalysisResult {
  readonly id: string;
  readonly createdAt: string;
  readonly schemaVersion: 1;
  readonly model: ModelInfo;
  readonly parse: ParseReport;
  readonly geometry: GeometryReport;
  readonly visibility: VisibilityReport;
  readonly pricing: PricingReport;
  readonly catalog: CatalogStatus;
  readonly safetyLevel: SafetyLevel;
  readonly originalCost: CostSummary;
  readonly candidates: readonly OptimizationCandidate[];
  readonly defaultEnabledIds: readonly string[];
  readonly rejections: readonly RejectionSummary[];
  readonly timings: Record<AnalysisStage, number>;
  readonly totalMs: number;
}

export interface SavingsSummary {
  /**
   * Estimated PART cost of the model as supplied - the sum of per-piece market
   * price estimates. It is not a checkout total: it excludes shipping, seller
   * minimums, handling and tax, and it assumes every part is bought at its
   * typical market price, which no single real order achieves.
   */
  readonly originalCost: number;
  /** Estimated part cost after the enabled changes, on the same basis. */
  readonly optimizedCost: number;
  /**
   * Difference between the two estimates above. Raw estimated part-price
   * savings: the most optimistic honest figure, including changes whose
   * replacement color may be hard to buy.
   */
  readonly savings: number;
  readonly savingsPercent: number;
  /**
   * The part of `savings` that comes from changes which are BOTH safe on the
   * visibility evidence AND practical to buy. Always less than or equal to
   * `savings`. This is the figure to trust.
   */
  readonly highConfidenceSavings: number;
  readonly highConfidenceSavingsPercent: number;
  /**
   * Whether the price source told us anything about supply at all.
   *
   * False in demo mode, which has no marketplace behind it. When false, the
   * high-confidence split is meaningless - every change would be marked
   * unverified and the figure would collapse to zero - so the UI hides it and
   * says supply could not be checked instead of implying nothing is safe.
   */
  readonly supplyDataAvailable: boolean;
  readonly currency: string;
  readonly candidateCount: number;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly changedPieceCount: number;
  readonly uniqueSubstitutionCount: number;
}

/**
 * How much this model was worth running through the optimizer.
 *
 * The point of this is to be able to say "we found nothing worth doing" out
 * loud. A tool that always reports a result implies it always found value, and
 * for a model whose designer already used cheap colors inside, it did not.
 */
export type ModelValueRating =
  | 'excellent'
  | 'moderate'
  | 'marginal'
  | 'too_small_to_matter'
  | 'already_efficient';

export interface ModelValueScore {
  readonly rating: ModelValueRating;
  readonly headline: string;
  readonly detail: string;
  /** True when the honest answer is "this was not worth optimizing". */
  readonly worthwhile: boolean;
}

/**
 * Everything needed to judge how well the optimizer did on one model.
 *
 * Structured now so that a future opt-in, anonymous validation study can be
 * built on it. NOTHING here is uploaded, stored off the machine, or shared:
 * the fields exist, the collection does not, and adding collection would be a
 * deliberate change with the user's explicit consent.
 */
export interface OptimizationQualityMetrics {
  readonly originalEstimatedPartCost: number;
  readonly optimizedEstimatedPartCost: number;
  readonly estimatedPartSavings: number;
  readonly savingsPercent: number;
  readonly highConfidenceEstimatedPartSavings: number;
  readonly currency: string;

  readonly partCount: number;
  readonly changedPieceCount: number;
  readonly changedPiecePercent: number;
  readonly hiddenPieceCount: number;
  readonly hiddenPiecePercent: number;

  readonly candidateCount: number;
  readonly enabledChangeCount: number;
  readonly rejectedCandidateCount: number;

  /**
   * What BrickLink itself said the two orders cost, if the user ran both
   * Wanted Lists through it and typed the totals back in. Null until then -
   * never estimated, never inferred.
   */
  readonly delivered: DeliveredCostComparison | null;
}

/**
 * The user's own measurement of what the two orders actually cost on
 * BrickLink, entered by hand.
 *
 * This is the only figure in the app that reflects sellers, shipping and
 * minimums, because it is the only one that came from the system that knows
 * about them. Even so, BrickLink presents its own numbers as estimates, so
 * neither is called a guaranteed price.
 */
export interface DeliveredCostComparison {
  readonly originalDeliveredEstimate: number;
  readonly optimizedDeliveredEstimate: number;
  readonly currency: string;
  /** Original minus optimized. Negative means the optimized order cost MORE. */
  readonly difference: number;
  /**
   * What we predicted (estimated part savings) minus what BrickLink's totals
   * actually differed by. A large positive number means we were optimistic.
   */
  readonly predictionError: number;
  readonly enteredAt: string;
  readonly note: string | null;
}
