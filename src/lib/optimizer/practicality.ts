/**
 * Is this change worth making?
 *
 * The color and mold optimizers answer two questions: is the change SAFE (can
 * anybody see this part?) and is it CHEAPER (does the replacement cost less per
 * piece?). Neither of those is the same as worth making.
 *
 * A change is worth making when:
 *
 *   1. the saving is big enough to care about - nobody wants a change list
 *      cluttered with one-cent swaps;
 *   2. you can actually buy the replacement - a color that exists in four lots
 *      worldwide is not a bargain, it is an extra seller, an extra shipping
 *      charge and probably an extra minimum-order top-up.
 *
 * Both judgements live here rather than in each optimizer, so there is one
 * place to read the policy and one place to change it.
 *
 * What this does NOT do
 * ---------------------
 * It does not compute shipping, pick sellers, or predict a checkout total.
 * BrickLink already has that machinery and it needs the whole order to work.
 * This only asks whether swapping a widely-stocked color for a thinly-stocked
 * one is likely to make the order worse, which is a question about supply and
 * can be answered from supply data alone.
 */

import {
  assessAvailability,
  availabilityAllowsChange,
  availabilityRank,
  shippingRisk,
  type AvailabilityLevel,
} from '../pricing/availability';
import type { CandidateBlocker, OptimizationCandidate, ProposedChange } from './types';

export interface PracticalityOptions {
  /**
   * Smallest total saving, across every piece the change affects, that is worth
   * proposing at all. Below this the change is dropped rather than shown
   * disabled, because a list of one-cent changes buries the ones that matter.
   */
  readonly minSavingPerChange: number;
  /** Visibility confidence a change needs before it counts as high confidence. */
  readonly highConfidenceMinConfidence: number;
  /** Supply the replacement needs before a change counts as high confidence. */
  readonly highConfidenceMinAvailability: AvailabilityLevel;
}

/**
 * Ten cents. Small enough that a bag of common bricks still qualifies, large
 * enough that the change list is about decisions rather than rounding.
 */
export const DEFAULT_PRACTICALITY: PracticalityOptions = {
  minSavingPerChange: 0.1,
  highConfidenceMinConfidence: 0.99,
  highConfidenceMinAvailability: 'MODERATE',
};

export interface PracticalityResult {
  readonly candidates: OptimizationCandidate[];
  /** Changes dropped, with the reason, so the rejection summary can report them. */
  readonly dropped: readonly { change: ProposedChange; blocker: CandidateBlocker }[];
}

export function applyPracticality(
  changes: readonly ProposedChange[],
  options: PracticalityOptions = DEFAULT_PRACTICALITY,
): PracticalityResult {
  const candidates: OptimizationCandidate[] = [];
  const dropped: { change: ProposedChange; blocker: CandidateBlocker }[] = [];

  for (const change of changes) {
    if (change.savings < options.minSavingPerChange) {
      dropped.push({ change, blocker: 'saving_below_threshold' });
      continue;
    }

    const originalAvailability = assessAvailability(change.originalQuote, change.quantity);
    const replacementAvailability = assessAvailability(change.replacementQuote, change.quantity);

    const permitted = availabilityAllowsChange(replacementAvailability, change.savings);
    if (!permitted.allowed) {
      dropped.push({ change, blocker: 'replacement_poorly_stocked' });
      continue;
    }

    const risk = shippingRisk(originalAvailability, replacementAvailability);
    const availabilityIsGood =
      availabilityRank(replacementAvailability.level) >=
        availabilityRank(options.highConfidenceMinAvailability) &&
      replacementAvailability.sufficientForQuantity;
    const confidenceIsGood = change.confidence >= options.highConfidenceMinConfidence;

    candidates.push({
      ...change,
      originalAvailability,
      replacementAvailability,
      shippingRisk: risk,
      isHighConfidence: confidenceIsGood && availabilityIsGood,
      confidenceCaveat: caveatFor(confidenceIsGood, availabilityIsGood, replacementAvailability.level),
    });
  }

  return { candidates, dropped };
}

function caveatFor(
  confidenceIsGood: boolean,
  availabilityIsGood: boolean,
  level: AvailabilityLevel,
): string | null {
  if (confidenceIsGood && availabilityIsGood) return null;
  if (!confidenceIsGood && !availabilityIsGood) {
    return (
      'This change rests on slightly weaker visibility evidence than usual, and the replacement ' +
      'color is not widely stocked. Both are reasons to look at it yourself before ordering.'
    );
  }
  if (!confidenceIsGood) {
    return 'The visibility evidence for this part is weaker than the threshold for a high-confidence change.';
  }
  if (level === 'UNKNOWN') {
    return (
      'This substitution is cheaper based on marketplace pricing, but no supply information is ' +
      'available for the replacement color, so we cannot tell whether buying it is practical. ' +
      'Shipping or additional seller requirements may erase the apparent saving.'
    );
  }
  return (
    'This substitution is cheaper based on marketplace pricing, but the replacement has limited ' +
    'seller availability. Shipping or additional seller requirements may erase the apparent saving.'
  );
}
