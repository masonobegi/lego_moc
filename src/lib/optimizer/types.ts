/**
 * Optimizer types.
 *
 * The unit of change is a COMMAND, not a part instance. One line type 1 inside
 * a submodel used three times produces three physical bricks; editing that line
 * changes all three. So a candidate carries the command it would edit, every
 * instance that command produces, and a quantity. A candidate is only ever
 * proposed when every one of those instances is safe.
 */

import type { EquivalentPartRule } from '../catalog/types';
import type { CommandRef } from '../ldraw/types';
import type { AvailabilityAssessment, ShippingRisk } from '../pricing/availability';
import type { PriceQuote } from '../pricing/types';
import type { VisibilityClass } from './visibilityEngine';

export type SafetyLevel = 'extremely_conservative' | 'conservative';

export const SAFETY_LEVELS: Record<
  SafetyLevel,
  { label: string; description: string; allowedVisibility: VisibilityClass[]; minConfidence: number; minMoldConfidence: number }
> = {
  extremely_conservative: {
    label: 'Extremely conservative',
    description:
      'Only parts with no externally visible surface at all, verified against every triangle of the ' +
      'part. This is the default.',
    allowedVisibility: ['HIDDEN'],
    minConfidence: 0.99,
    minMoldConfidence: 0.9,
  },
  conservative: {
    label: 'Conservative',
    description:
      'Also allows parts that appear hidden but whose own geometry could not be fully resolved from ' +
      'the LDraw library, so the verdict rests on slightly less evidence.',
    allowedVisibility: ['HIDDEN', 'LIKELY_HIDDEN'],
    minConfidence: 0.97,
    minMoldConfidence: 0.85,
  },
};

export const DEFAULT_SAFETY_LEVEL: SafetyLevel = 'extremely_conservative';

export type CandidateKind = 'hidden_color' | 'mold_equivalent';

export type CandidateBlocker =
  | 'visible'
  | 'mixed_visibility'
  | 'inherited_color'
  | 'sentinel_color'
  | 'no_price_for_original'
  | 'no_cheaper_alternative'
  | 'part_not_in_catalog'
  | 'no_valid_alternative_color'
  | 'no_equivalent_rule'
  | 'rule_confidence_too_low'
  | 'replacement_color_unavailable'
  | 'replacement_not_cheaper'
  | 'saving_below_threshold'
  | 'replacement_poorly_stocked'
  | 'geometry_unavailable';

export interface CandidateVisibility {
  readonly classification: VisibilityClass;
  /** Lowest confidence across every instance this command produces. */
  readonly confidence: number;
  readonly totalRays: number;
  readonly trianglesCovered: number;
  readonly trianglesTotal: number;
  readonly evidence: string;
}

export interface AlternativeOption {
  readonly colorId: number;
  readonly colorName: string;
  readonly unitPrice: number;
  readonly saving: number;
  readonly evidenceSets: readonly string[];
}

export interface OptimizationCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly commandRef: CommandRef;
  /** How many physical parts this one change affects. */
  readonly quantity: number;
  readonly instanceIds: readonly string[];
  readonly parentModel: string;
  readonly stepIndex: number;
  readonly partId: string;
  readonly partDescription: string;

  readonly originalPartId: string;
  readonly originalColorId: number;
  readonly originalColorName: string;
  readonly replacementPartId: string;
  readonly replacementColorId: number;
  readonly replacementColorName: string;

  readonly originalUnitPrice: number;
  readonly replacementUnitPrice: number;
  readonly originalTotal: number;
  readonly replacementTotal: number;
  readonly savings: number;

  readonly reason: string;
  /** 0-1, combining visibility evidence with rule confidence. */
  readonly confidence: number;
  readonly visibility: CandidateVisibility;
  readonly evidence: readonly string[];
  readonly moldRule: EquivalentPartRule | null;
  /** Cheaper colors we found but did not pick, best first. */
  readonly alternatives: readonly AlternativeOption[];
  /** Candidates that cannot be enabled at the same time as this one. */
  readonly conflictsWith: readonly string[];
  readonly enabledByDefault: boolean;
  readonly originalQuote: PriceQuote | null;
  readonly replacementQuote: PriceQuote | null;

  /** Marketplace supply for the color you would stop buying. */
  readonly originalAvailability: AvailabilityAssessment;
  /** Marketplace supply for the color you would start buying. */
  readonly replacementAvailability: AvailabilityAssessment;
  /**
   * How likely this swap is to add a seller - and therefore a shipping charge -
   * to the order. Judged only on supply; it is not a shipping calculation.
   */
  readonly shippingRisk: ShippingRisk;
  /**
   * True when the change is both safe to make (high visibility confidence) and
   * practical to buy (acceptable supply for the replacement). Only these count
   * toward the high-confidence savings figure.
   */
  readonly isHighConfidence: boolean;
  /** Why this change is not high confidence, when it is not. */
  readonly confidenceCaveat: string | null;
}

/**
 * What the color and mold optimizers produce, before the practicality pass.
 *
 * Those two modules answer "is this change safe, and is it cheaper?". Whether a
 * change is worth MAKING is a separate question - is the saving big enough to
 * bother with, can you actually buy the replacement - and it is answered in one
 * place, `practicality.ts`, rather than duplicated in each optimizer.
 */
export type ProposedChange = Omit<
  OptimizationCandidate,
  'originalAvailability' | 'replacementAvailability' | 'shippingRisk' | 'isHighConfidence' | 'confidenceCaveat'
>;

/** A command we looked at but produced no candidate for, and why. */
export interface RejectedCommand {
  readonly commandRef: CommandRef;
  readonly partId: string;
  readonly colorId: number;
  readonly quantity: number;
  readonly blockers: readonly CandidateBlocker[];
}

export interface OptimizerCounters {
  readonly commandsExamined: number;
  readonly hiddenCommands: number;
  readonly colorCandidates: number;
  readonly moldCandidates: number;
  readonly blockedBy: Record<string, number>;
}
