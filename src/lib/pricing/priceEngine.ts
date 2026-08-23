/**
 * Price engine: turns a set of part+color+condition requests into a price
 * book, and a price book plus a part list into a cost.
 *
 * Deduplication happens here, not in the providers. A 2,800-part model with 411
 * distinct part/color combinations issues 411 lookups, not 2,800. With the
 * alternative colors the optimizer wants to evaluate on top, that number grows
 * again, so requests are batched and deduplicated in one place.
 */

import type { PartInstance } from '../ldraw/types';
import { priceKey, type Condition, type PriceProvider, type PriceQuote } from './types';

export interface PriceBookStats {
  requested: number;
  resolved: number;
  unresolved: number;
  elapsedMs: number;
  providerId: string;
  providerLabel: string;
  isLive: boolean;
}

export class PriceBook {
  private readonly quotes = new Map<string, PriceQuote | null>();

  constructor(readonly stats: PriceBookStats) {}

  set(partId: string, colorId: number, condition: Condition, quote: PriceQuote | null): void {
    this.quotes.set(priceKey(partId, colorId, condition), quote);
  }

  get(partId: string, colorId: number, condition: Condition): PriceQuote | null {
    return this.quotes.get(priceKey(partId, colorId, condition)) ?? null;
  }

  has(partId: string, colorId: number, condition: Condition): boolean {
    return this.quotes.has(priceKey(partId, colorId, condition));
  }

  get size(): number {
    return this.quotes.size;
  }

  entries(): IterableIterator<[string, PriceQuote | null]> {
    return this.quotes.entries();
  }
}

export interface PriceRequest {
  readonly partId: string;
  readonly colorId: number;
}

/**
 * Fetch every requested price with the given provider.
 * `concurrency` is modest by default: BrickLink is a shared, rate-limited API
 * and hammering it is both rude and counter-productive.
 */
export async function buildPriceBook(
  provider: PriceProvider,
  requests: readonly PriceRequest[],
  condition: Condition,
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<PriceBook> {
  const started = Date.now();
  const unique = new Map<string, PriceRequest>();
  for (const request of requests) {
    unique.set(priceKey(request.partId, request.colorId, condition), request);
  }

  const list = [...unique.values()];
  const concurrency = Math.max(1, options.concurrency ?? (provider.isLive ? 4 : 32));

  const book = new PriceBook({
    requested: list.length,
    resolved: 0,
    unresolved: 0,
    elapsedMs: 0,
    providerId: provider.id,
    providerLabel: provider.label,
    isLive: provider.isLive,
  });

  let cursor = 0;
  let done = 0;
  let resolved = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      const request = list[index]!;
      let quote: PriceQuote | null = null;
      try {
        quote = await provider.getPrice(request.partId, request.colorId, condition);
      } catch (error) {
        // A provider that throws (rate limit, network) must not abort the whole
        // analysis. The lot is reported as unpriced instead.
        if ((error as Error).name === 'BrickLinkRateLimitError') {
          cursor = list.length;
        }
        quote = null;
      }
      book.set(request.partId, request.colorId, condition, quote);
      if (quote) resolved++;
      done++;
      options.onProgress?.(done, list.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));

  const stats = book.stats as { -readonly [K in keyof PriceBookStats]: PriceBookStats[K] };
  stats.resolved = resolved;
  stats.unresolved = list.length - resolved;
  stats.elapsedMs = Date.now() - started;
  return book;
}

export interface LotSummary {
  readonly partId: string;
  readonly colorId: number;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly lineTotal: number | null;
  readonly quote: PriceQuote | null;
}

export interface CostSummary {
  /** Sum of quantity x unit price over every lot that has a price. */
  readonly total: number;
  readonly currency: string;
  readonly pricedPieceCount: number;
  readonly unpricedPieceCount: number;
  readonly lotCount: number;
  readonly unpricedLots: readonly { partId: string; colorId: number; quantity: number }[];
  readonly lots: readonly LotSummary[];
}

/** Group part instances into lots and total them against a price book. */
export function calculateCost(
  instances: readonly PartInstance[],
  book: PriceBook,
  condition: Condition,
  currency = 'USD',
): CostSummary {
  const counts = new Map<string, { partId: string; colorId: number; quantity: number }>();
  for (const instance of instances) {
    const key = `${instance.partId}|${instance.colorId}`;
    const existing = counts.get(key);
    if (existing) existing.quantity++;
    else counts.set(key, { partId: instance.partId, colorId: instance.colorId, quantity: 1 });
  }

  let total = 0;
  let pricedPieces = 0;
  let unpricedPieces = 0;
  const unpricedLots: { partId: string; colorId: number; quantity: number }[] = [];
  const lots: LotSummary[] = [];

  for (const lot of counts.values()) {
    const quote = book.get(lot.partId, lot.colorId, condition);
    if (quote) {
      const lineTotal = round2(quote.unitPrice * lot.quantity);
      total += lineTotal;
      pricedPieces += lot.quantity;
      lots.push({ ...lot, unitPrice: quote.unitPrice, lineTotal, quote });
    } else {
      unpricedPieces += lot.quantity;
      unpricedLots.push(lot);
      lots.push({ ...lot, unitPrice: null, lineTotal: null, quote: null });
    }
  }

  lots.sort((a, b) => (b.lineTotal ?? 0) - (a.lineTotal ?? 0));

  return {
    total: round2(total),
    currency,
    pricedPieceCount: pricedPieces,
    unpricedPieceCount: unpricedPieces,
    lotCount: counts.size,
    unpricedLots,
    lots,
  };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
