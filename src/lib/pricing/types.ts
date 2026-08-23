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
  /** LDraw colour id the quote was requested for. */
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
  /** Number of lots/listings behind the figure, where known. */
  readonly lotCount: number | null;
  /** Total pieces available behind the figure, where known. */
  readonly totalQuantity: number | null;
  /** Always true. There is no such thing as a guaranteed price here. */
  readonly isEstimate: true;
  /** Caveats to show alongside the number. */
  readonly notes: readonly string[];
}

/**
 * The abstraction the optimiser depends on. Implementations must never throw
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
