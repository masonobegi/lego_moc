/**
 * How much was this model worth optimizing?
 *
 * The reason this exists is to be able to say "nothing here was worth doing".
 * A tool that always shows a result implies it always found value. For a model
 * whose designer already used cheap colors on the inside - and plenty do - the
 * honest answer is that we found almost nothing, and saying so is worth more to
 * the user than dressing up $1.82 as a win.
 *
 * The rating uses BOTH a percentage and an absolute figure, because either one
 * alone lies. 12% of a $30 model is $3.60, which is not worth an afternoon of
 * re-sorting bricks. $40 off a $2,000 UCS set is 2%, and is absolutely worth
 * having. A model has to clear a floor on both axes to be called a good
 * candidate.
 *
 * It scores the HIGH-CONFIDENCE saving, not the raw one. Telling somebody they
 * are an excellent candidate on the strength of changes we already flagged as
 * hard to buy would be exactly the sort of overclaiming the rest of this app
 * is built to avoid.
 */

import type { ModelValueScore, SavingsSummary } from './types';

/** Below this, the saving is not worth the handling however large the model. */
const TRIVIAL_ABSOLUTE = 3;

/**
 * Below this share of the parts bill, the honest verdict is about the MODEL:
 * its designer already used cheap plastic where it does not show.
 */
const TRIVIAL_PERCENT = 1.5;

const THRESHOLDS = {
  excellent: { percent: 8, absolute: 15 },
  moderate: { percent: 4, absolute: 6 },
} as const;

export function scoreModelValue(
  summary: SavingsSummary,
  currencyFormat: (n: number) => string,
): ModelValueScore {
  // Demo mode reports no supply data, so every change would be marked
  // unverified and the high-confidence figure would collapse to zero. Scoring
  // off that would tell every offline user their model is already efficient,
  // which is a lie about the model rather than a statement about the data.
  const saving = summary.supplyDataAvailable ? summary.highConfidenceSavings : summary.savings;
  const percent = summary.supplyDataAvailable
    ? summary.highConfidenceSavingsPercent
    : summary.savingsPercent;
  const unverified = summary.supplyDataAvailable
    ? ''
    : ' Marketplace supply could not be checked with this price source, so these substitutions are' +
      ' cheaper on paper but unverified as things you can actually buy.';
  const figure = `${currencyFormat(saving)} / ${percent.toFixed(1)}%`;

  if (percent < TRIVIAL_PERCENT) {
    return {
      rating: 'already_efficient',
      headline: 'Already cost-efficient',
      detail:
        `This model already appears cost-efficient. We could not find enough safe substitutions to ` +
        `make optimizing it worthwhile - the most we found was ${figure}. Nothing is wrong with the ` +
        `model or with the analysis; there simply is not much expensive plastic hidden inside it.`,
      worthwhile: false,
    };
  }

  if (saving < TRIVIAL_ABSOLUTE) {
    return {
      rating: 'too_small_to_matter',
      headline: 'Not worth acting on',
      detail:
        `The safe substitutions here come to ${figure}. That is a real proportion of a small parts ` +
        `bill, but the amount is too small to be worth reworking an order for - a single shipping ` +
        `charge would swallow it several times over.`,
      worthwhile: false,
    };
  }

  if (percent >= THRESHOLDS.excellent.percent && saving >= THRESHOLDS.excellent.absolute) {
    return {
      rating: 'excellent',
      headline: 'Excellent candidate',
      detail:
        `Estimated part-price savings of ${figure}, all from parts that nothing outside the finished ` +
        `model can see. Worth taking through to a BrickLink comparison.${unverified}`,
      worthwhile: true,
    };
  }

  if (percent >= THRESHOLDS.moderate.percent && saving >= THRESHOLDS.moderate.absolute) {
    return {
      rating: 'moderate',
      headline: 'Moderate candidate',
      detail:
        `Estimated part-price savings of ${figure}. Real, but modest enough that shipping and seller ` +
        `minimums could eat a good part of it - compare both Wanted Lists on BrickLink before ` +
        `deciding.${unverified}`,
      worthwhile: true,
    };
  }

  return {
    rating: 'marginal',
    headline: 'Marginal candidate',
    detail:
      `Estimated part-price savings of ${figure}. That is small enough that adding even one more ` +
      `seller to the order would probably cancel it out. Worth checking on BrickLink before acting ` +
      `on it, and reasonable to skip.${unverified}`,
    worthwhile: false,
  };
}
