/**
 * Pricing types.
 *
 * The single most important thing here is that a PriceQuote is an ESTIMATE and
 * says so structurally. Nothing in this app produces a checkout price: shipping,
 * seller minimums, lot availability and tax are all outside what any of these
 * sources can tell us.
 */

export type Condition = 'new' | 'used';
export type PriceSourceId = 'demo' | 'bricklink';

export interface PriceQuote {
  /** LDraw part id the quote was requested for. */
  readonly partId: string;
  /** LDraw color id the quote was requested for. */
  readonly colorId: number;
  readonly condition: Condition;
  /** The figure the cost calculation uses, per piece. */
  readonly unitPrice: number;
  readonly currency: string;
  readonly source: PriceSourceId;
  /** Precisely which source produced this number, shown in the UI. */
  readonly sourceDetail: string;
  /** ISO 8601. When the number was obtained. */
  readonly timestamp: string;
  /** Average price across the source's sample, where the source provides one. */
  readonly average: number | null;
  /** Quantity-weighted average, where the source provides one. */
  readonly quantityAverage: number | null;
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
  /**
   * Number of LOTS behind the figure, where known. A lot is one seller's
   * listing of one item in one condition - a good proxy for how many stores
   * carry the part, but not the same number, since one store can list the same
   * part twice. BrickLink's price-guide response does not expose a store count.
   */
  readonly lotCount: number | null;
  /** Total pieces available across those lots, where known. */
  readonly totalQuantity: number | null;
  /**
   * True when the supply figures were restricted to sellers who ship to the
   * configured country or region. When false the counts are worldwide, which is
   * a much weaker guarantee that you can actually buy the part.
   */
  readonly supplyIsLocationFiltered?: boolean;
  /**
   * True when the figures come from BrickLink's SOLD guide. Those counts
   * describe what changed hands over the last six months, not what is on sale
   * now, so they must never be read as current stock.
   */
  readonly supplyReflectsSoldHistory?: boolean;
  /** Always true. There is no such thing as a guaranteed price here. */
  readonly isEstimate: true;
  /** Caveats to show alongside the number. */
  readonly notes: readonly string[];
}

/**
 * The abstraction the optimizer depends on. Implementations must never throw
 * for an unknown part: return null so the caller can carry on and report the
 * gap.
 */
export interface PriceProvider {
  readonly id: PriceSourceId;
  readonly label: string;
  /** True when this provider talks to a live market. */
  readonly isLive: boolean;
  getPrice(partId: string, colorId: number, condition: Condition): Promise<PriceQuote | null>;
}

/** Optional extra information a provider can use to price an unfamiliar part. */
export interface PartSizeHint {
  /** Bounding-box volume in cubic LDraw units. */
  readonly volume: number;
  readonly triangleCount: number;
}

export interface SizeAwarePriceProvider extends PriceProvider {
  setSizeHints(hints: ReadonlyMap<string, PartSizeHint>): void;
}

export function isSizeAware(provider: PriceProvider): provider is SizeAwarePriceProvider {
  return typeof (provider as SizeAwarePriceProvider).setSizeHints === 'function';
}

export interface PriceLookupKey {
  readonly partId: string;
  readonly colorId: number;
  readonly condition: Condition;
}

export function priceKey(partId: string, colorId: number, condition: Condition): string {
  return `${partId}|${colorId}|${condition}`;
}
