/**
 * Marketplace availability.
 *
 * Why this exists
 * ---------------
 * A color substitution that is cheaper per piece is not automatically a
 * substitution worth making. If the replacement color exists in four lots
 * worldwide and you need sixty pieces, the "saving" is fictional: you will end
 * up adding another seller to the order, paying another shipping charge and
 * quite possibly another minimum-order top-up, and the few cents per piece will
 * be gone several times over.
 *
 * So every price quote carries what the marketplace can tell us about supply,
 * and the optimizer treats a thinly-stocked replacement as a risk rather than a
 * bargain.
 *
 * What the data actually is
 * -------------------------
 * BrickLink's Price Guide endpoint returns, for the filtered set (condition,
 * currency and - when configured - country or region):
 *
 *   unit_quantity   number of LOTS behind the figure
 *   total_quantity  total PIECES available across those lots
 *
 * A lot is one seller's listing of one item in one condition. It is a good
 * proxy for "how many different stores have this" but it is not the same
 * number: one store can list the same part in two lots. BrickLink's API does
 * not expose a store count for a price-guide query, so this module says "lots"
 * everywhere rather than inventing a store count it cannot know.
 *
 * When `country_code` or `region` is configured, BrickLink restricts the guide
 * to sellers in that location, so the counts already reflect who can ship
 * there. When it is not configured the counts are worldwide and the assessment
 * says so, because "500 lots exist somewhere on earth" is a much weaker
 * statement than "500 lots exist in your country".
 *
 * Sold-price mode (`guide_type=sold`) reports what actually changed hands over
 * the last six months. Those counts describe past trades, not current supply,
 * so an assessment built from them is explicitly marked as such: the optimizer
 * treats it as unknown supply rather than pretending it is stock on hand.
 */

import type { PriceQuote } from './types';

export type AvailabilityLevel =
  | 'VERY_HIGH'
  | 'HIGH'
  | 'MODERATE'
  | 'LOW'
  | 'VERY_LOW'
  | 'UNKNOWN';

/** Ordered worst to best, so levels can be compared numerically. */
export const AVAILABILITY_ORDER: readonly AvailabilityLevel[] = [
  'UNKNOWN',
  'VERY_LOW',
  'LOW',
  'MODERATE',
  'HIGH',
  'VERY_HIGH',
];

export function availabilityRank(level: AvailabilityLevel): number {
  const index = AVAILABILITY_ORDER.indexOf(level);
  return index < 0 ? 0 : index;
}

export const AVAILABILITY_LABELS: Record<AvailabilityLevel, string> = {
  VERY_HIGH: 'Very high availability',
  HIGH: 'High availability',
  MODERATE: 'Moderate availability',
  LOW: 'Low availability',
  VERY_LOW: 'Very low availability',
  UNKNOWN: 'Availability unknown',
};

/**
 * Thresholds, in lots and in pieces.
 *
 * These are judgement calls, not measurements, and they are written here in one
 * place so they can be argued with. The shape of the judgement: a part you can
 * buy from a hundred different sellers will turn up in whichever stores your
 * order already uses, whereas a part in five lots worldwide will almost
 * certainly force an extra seller into the order.
 */
const THRESHOLDS: readonly { level: AvailabilityLevel; lots: number; pieces: number }[] = [
  { level: 'VERY_HIGH', lots: 200, pieces: 5_000 },
  { level: 'HIGH', lots: 60, pieces: 1_000 },
  { level: 'MODERATE', lots: 20, pieces: 200 },
  { level: 'LOW', lots: 5, pieces: 50 },
];

/**
 * How many times the quantity you need should be on the market before supply
 * counts as comfortable. Buying every piece in existence means buying from
 * every seller who has one.
 */
const HEADROOM = 3;

export interface AvailabilityAssessment {
  readonly level: AvailabilityLevel;
  readonly lots: number | null;
  readonly pieces: number | null;
  /** True when enough pieces are listed to cover the quantity with headroom. */
  readonly sufficientForQuantity: boolean;
  /** Whether the underlying figures were restricted to the buyer's location. */
  readonly locationFiltered: boolean;
  /** One sentence for the UI. Always says what it is based on. */
  readonly summary: string;
  /** Machine-readable reasons, for tests and the JSON report. */
  readonly flags: readonly AvailabilityFlag[];
}

export type AvailabilityFlag =
  | 'no_supply_data'
  | 'sold_history_not_stock'
  | 'worldwide_not_local'
  | 'below_required_quantity'
  | 'few_lots'
  | 'single_cheap_lot_risk';

/**
 * Assess supply for one quote against the quantity the model actually needs.
 *
 * `requiredQuantity` matters: sixty lots is plenty when you need four pieces
 * and marginal when you need four hundred.
 */
export function assessAvailability(
  quote: PriceQuote | null,
  requiredQuantity: number,
): AvailabilityAssessment {
  if (!quote) {
    return {
      level: 'UNKNOWN',
      lots: null,
      pieces: null,
      sufficientForQuantity: false,
      locationFiltered: false,
      summary: 'No price or supply information is available for this part and color.',
      flags: ['no_supply_data'],
    };
  }

  const lots = quote.lotCount;
  const pieces = quote.totalQuantity;
  const flags: AvailabilityFlag[] = [];
  const locationFiltered = quote.supplyIsLocationFiltered === true;

  if (quote.supplyReflectsSoldHistory) flags.push('sold_history_not_stock');
  if (lots === null || pieces === null) {
    flags.push('no_supply_data');
    return {
      level: 'UNKNOWN',
      lots,
      pieces,
      sufficientForQuantity: false,
      locationFiltered,
      summary:
        quote.supplyReflectsSoldHistory === true
          ? 'This price comes from BrickLink sold history, which describes past sales rather than ' +
            'what is on sale now, so current supply is unknown.'
          : `${quote.source === 'demo' ? 'Demo data does not model' : 'This source does not report'} ` +
            'how many of this part are currently listed, so availability is unknown.',
      flags,
    };
  }

  if (!locationFiltered) flags.push('worldwide_not_local');

  // Sold history counts trades, not stock. Never let it read as supply.
  if (quote.supplyReflectsSoldHistory) {
    return {
      level: 'UNKNOWN',
      lots,
      pieces,
      sufficientForQuantity: false,
      locationFiltered,
      summary:
        `${pieces.toLocaleString()} pieces across ${lots.toLocaleString()} lots CHANGED HANDS in the ` +
        'last six months. That is sales history, not stock on hand, so current availability is unknown.',
      flags,
    };
  }

  const needed = Math.max(1, Math.round(requiredQuantity));
  const sufficientForQuantity = pieces >= needed * HEADROOM;
  if (!sufficientForQuantity) flags.push('below_required_quantity');

  let level: AvailabilityLevel = 'VERY_LOW';
  for (const threshold of THRESHOLDS) {
    if (lots >= threshold.lots && pieces >= threshold.pieces) {
      level = threshold.level;
      break;
    }
  }

  // Supply that cannot cover the order is never called comfortable, however
  // many lots exist.
  if (!sufficientForQuantity && availabilityRank(level) > availabilityRank('LOW')) {
    level = 'LOW';
  }
  if (lots < 5) flags.push('few_lots');

  // One cheap lot among few can drag a naive figure down. The quote's own unit
  // price is already the quantity-weighted average where the source gives one,
  // but flag the shape so the UI can warn.
  if (
    quote.minPrice !== null &&
    quote.average !== null &&
    quote.average > 0 &&
    quote.minPrice < quote.average * 0.4 &&
    lots < 20
  ) {
    flags.push('single_cheap_lot_risk');
  }

  const where = locationFiltered ? 'from sellers who ship to you' : 'worldwide';
  const summary =
    `${pieces.toLocaleString()} ${pieces === 1 ? 'piece' : 'pieces'} listed across ` +
    `${lots.toLocaleString()} ${lots === 1 ? 'lot' : 'lots'} ${where}` +
    (sufficientForQuantity
      ? `, against the ${needed.toLocaleString()} this build needs.`
      : `, which is thin against the ${needed.toLocaleString()} this build needs.`);

  return { level, lots, pieces, sufficientForQuantity, locationFiltered, summary, flags };
}

export type ShippingRisk = 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN';

export const SHIPPING_RISK_LABELS: Record<ShippingRisk, string> = {
  LOW: 'Low',
  MODERATE: 'Moderate',
  HIGH: 'High',
  UNKNOWN: 'Unknown',
};

/**
 * How likely this substitution is to cost more at checkout than it saves on
 * paper, judged only on supply.
 *
 * This is emphatically NOT a shipping calculation. We do not know which sellers
 * BrickLink will pick, what they charge, or what their minimums are. It is a
 * statement about one specific risk: swapping a part everyone stocks for one
 * hardly anyone stocks tends to add a seller to the order, and adding a seller
 * adds a shipping charge.
 */
export function shippingRisk(
  original: AvailabilityAssessment,
  replacement: AvailabilityAssessment,
): ShippingRisk {
  if (replacement.level === 'UNKNOWN') return 'UNKNOWN';
  if (replacement.level === 'VERY_LOW' || !replacement.sufficientForQuantity) return 'HIGH';
  if (replacement.level === 'LOW') return 'HIGH';
  if (replacement.level === 'MODERATE') return 'MODERATE';

  // Going from a very common part to a merely common one is not a real risk,
  // but a big drop in availability is worth flagging even at high levels.
  if (availabilityRank(original.level) - availabilityRank(replacement.level) >= 2) return 'MODERATE';
  return 'LOW';
}

/**
 * Is this replacement's supply good enough to recommend at all?
 *
 * Deliberately asymmetric: a large saving buys tolerance for thinner supply,
 * because at some point the extra shipping charge really is worth paying. The
 * thresholds are per-change totals, not per-piece.
 */
export function availabilityAllowsChange(
  assessment: AvailabilityAssessment,
  savingForThisChange: number,
): { allowed: boolean; reason: string | null } {
  if (assessment.level === 'UNKNOWN') {
    // Unknown supply is not evidence of poor supply. Demo mode has no supply
    // data at all, and refusing every change there would make the app useless
    // offline. The UI shows the change as unverified instead.
    return { allowed: true, reason: null };
  }

  if (assessment.level === 'VERY_LOW') {
    // A typical BrickLink shipping charge is several dollars; a saving smaller
    // than that cannot survive adding a seller to the order.
    if (savingForThisChange < 15) {
      return {
        allowed: false,
        reason:
          'The replacement color is barely stocked, and the saving is not large enough to be worth ' +
          'adding another seller and another shipping charge to the order.',
      };
    }
    return { allowed: true, reason: null };
  }

  if (!assessment.sufficientForQuantity && savingForThisChange < 5) {
    return {
      allowed: false,
      reason:
        'Fewer pieces are listed than this build needs with any margin, and the saving is too small ' +
        'to be worth splitting the order across more sellers.',
    };
  }

  return { allowed: true, reason: null };
}
