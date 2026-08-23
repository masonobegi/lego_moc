/**
 * Live BrickLink Price Guide provider. SERVER ONLY.
 *
 * Endpoint (docs/RESEARCH.md section 6):
 *   GET https://api.bricklink.com/api/store/v1/items/PART/{no}/price
 *       ?color_id=&guide_type=stock|sold&new_or_used=N|U&currency_code=&vat=N
 *
 * Response `data` carries min_price, max_price, avg_price, qty_avg_price,
 * unit_quantity, total_quantity and a price_detail array.
 *
 * IMPORTANT, AND STATED IN THE UI AS WELL AS HERE: this implementation has
 * NEVER been executed against the real API during development, because
 * api.bricklink.com was unreachable from the build environment. The request
 * shape follows BrickLink's documentation and two maintained client libraries,
 * and the OAuth signing is covered by unit tests against the RFC 5849 worked
 * example, but the first live call is the first real test. The app reports
 * "BrickLink live pricing (unverified in this build)" until it has had a
 * successful response.
 *
 * Credentials are read from the environment inside this module and never leave
 * the server. Nothing here is imported by a client component.
 */

import type { Condition, PriceQuote, PriceProvider } from './types';
import { signGetRequest, type OAuth1Credentials } from './oauth1';
import type { PriceCache } from './cache';
import { priceKey } from './types';

const API_BASE = 'https://api.bricklink.com/api/store/v1';

export type GuideType = 'stock' | 'sold';

export interface BrickLinkOptions {
  readonly credentials: OAuth1Credentials;
  readonly guideType: GuideType;
  readonly currency: string;
  readonly countryCode?: string;
  readonly region?: string;
  /** Maps an LDraw part id to the BrickLink part number. Returns null to skip. */
  readonly mapPart: (partId: string) => string | null;
  /** Maps an LDraw color id to the BrickLink color id. Returns null to skip. */
  readonly mapColor: (colorId: number) => number | null;
  readonly cache: PriceCache;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Hard cap on requests issued in one analysis, to protect the daily budget. */
  readonly maxRequests?: number;
  readonly timeoutMs?: number;
}

interface BrickLinkPriceData {
  item?: { no?: string; type?: string };
  new_or_used?: string;
  currency_code?: string;
  min_price?: string | number;
  max_price?: string | number;
  avg_price?: string | number;
  qty_avg_price?: string | number;
  unit_quantity?: number;
  total_quantity?: number;
  price_detail?: unknown[];
}

interface BrickLinkEnvelope {
  meta?: { code?: number; message?: string; description?: string };
  data?: BrickLinkPriceData;
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export class BrickLinkRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrickLinkRateLimitError';
  }
}

export class BrickLinkPriceProvider implements PriceProvider {
  readonly id = 'bricklink' as const;
  readonly label = 'BrickLink Price Guide';
  readonly isLive = true;

  private requestCount = 0;
  private successCount = 0;
  private readonly failures: string[] = [];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BrickLinkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get diagnostics(): {
    requests: number;
    successes: number;
    failures: readonly string[];
    verifiedLive: boolean;
  } {
    return {
      requests: this.requestCount,
      successes: this.successCount,
      failures: this.failures.slice(0, 10),
      verifiedLive: this.successCount > 0,
    };
  }

  /**
   * Cache key.
   *
   * Part, color and condition are not enough: guide type, currency and store
   * location all change what the returned number MEANS, and the cache outlives
   * a configuration change because it is written to disk. Keying on only the
   * item would serve a EUR "last 6 months sold" figure to a USD "currently for
   * sale" request.
   */
  private cacheKey(partId: string, colorId: number, condition: Condition): string {
    return [
      priceKey(partId, colorId, condition),
      this.options.guideType,
      this.options.currency,
      this.options.countryCode ?? '',
      this.options.region ?? '',
    ].join('|');
  }

  async getPrice(partId: string, colorId: number, condition: Condition): Promise<PriceQuote | null> {
    const key = this.cacheKey(partId, colorId, condition);
    const cached = this.options.cache.get(key);
    if (cached) return cached;

    const blPart = this.options.mapPart(partId);
    const blColor = this.options.mapColor(colorId);
    if (blPart === null || blColor === null) {
      // We refuse to guess an id. The caller reports these as unpriced lots.
      return null;
    }

    const max = this.options.maxRequests ?? 4000;
    if (this.requestCount >= max) {
      throw new BrickLinkRateLimitError(
        `Stopped after ${max} BrickLink requests in one analysis to protect the 5,000/day API budget. ` +
          `Prices already fetched are cached; re-run the analysis to continue.`,
      );
    }

    const query: Record<string, string> = {
      color_id: String(blColor),
      guide_type: this.options.guideType,
      new_or_used: condition === 'new' ? 'N' : 'U',
      currency_code: this.options.currency,
      vat: 'N',
    };
    if (this.options.countryCode) query.country_code = this.options.countryCode;
    if (this.options.region) query.region = this.options.region;

    const baseUrl = `${API_BASE}/items/PART/${encodeURIComponent(blPart)}/price`;
    const signed = signGetRequest(baseUrl, query, this.options.credentials);

    this.requestCount++;
    let envelope: BrickLinkEnvelope;
    try {
      const response = await this.fetchImpl(signed.url, {
        method: 'GET',
        headers: { Authorization: signed.authorizationHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
      if (!response.ok) {
        this.failures.push(`${blPart}/${blColor}: HTTP ${response.status}`);
        return null;
      }
      envelope = (await response.json()) as BrickLinkEnvelope;
    } catch (error) {
      this.failures.push(`${blPart}/${blColor}: ${(error as Error).message}`);
      return null;
    }

    const code = envelope.meta?.code;
    if (code !== undefined && code !== 200) {
      this.failures.push(`${blPart}/${blColor}: BrickLink ${code} ${envelope.meta?.message ?? ''}`.trim());
      return null;
    }

    const data = envelope.data;
    if (!data) {
      this.failures.push(`${blPart}/${blColor}: empty response body`);
      return null;
    }

    const average = toNumber(data.avg_price);
    const quantityAverage = toNumber(data.qty_avg_price);
    const minPrice = toNumber(data.min_price);
    const maxPrice = toNumber(data.max_price);

    // Prefer the quantity-weighted average: it reflects what is actually
    // available in volume rather than being skewed by a single cheap lot.
    const unitPrice = quantityAverage ?? average ?? minPrice;
    if (unitPrice === null || unitPrice <= 0) {
      this.failures.push(`${blPart}/${blColor}: no usable price in response`);
      return null;
    }

    const lotCount = typeof data.unit_quantity === 'number' ? data.unit_quantity : null;
    const totalQuantity = typeof data.total_quantity === 'number' ? data.total_quantity : null;

    const notes: string[] = [
      'Estimated market parts cost. Excludes shipping, seller minimums, lot availability and tax.',
    ];
    if (lotCount !== null && lotCount < 5) {
      notes.push(
        `Only ${lotCount} listing${lotCount === 1 ? '' : 's'} behind this figure, so it is a weak estimate.`,
      );
    }
    if (quantityAverage === null && average !== null) {
      notes.push('BrickLink returned no quantity-weighted average; the plain average was used.');
    }

    const quote: PriceQuote = {
      partId,
      colorId,
      condition,
      unitPrice,
      currency: data.currency_code ?? this.options.currency,
      source: 'bricklink',
      sourceDetail: `BrickLink Price Guide (${this.options.guideType === 'stock' ? 'current items for sale' : 'last 6 months sales'}, ${condition})`,
      timestamp: new Date().toISOString(),
      average,
      quantityAverage,
      minPrice,
      maxPrice,
      lotCount,
      totalQuantity,
      supplyIsLocationFiltered: Boolean(this.options.countryCode || this.options.region),
      supplyReflectsSoldHistory: this.options.guideType === 'sold',
      isEstimate: true,
      notes,
    };

    this.successCount++;
    this.options.cache.set(key, quote);
    return quote;
  }
}

/**
 * Reads BrickLink credentials from the environment.
 * Returns null when any of the four values is missing, which is what makes the
 * app fall back to Demo Mode instead of failing.
 */
export function readBrickLinkCredentials(env: NodeJS.ProcessEnv = process.env): OAuth1Credentials | null {
  const consumerKey = env.BRICKLINK_CONSUMER_KEY?.trim();
  const consumerSecret = env.BRICKLINK_CONSUMER_SECRET?.trim();
  const tokenValue = env.BRICKLINK_TOKEN_VALUE?.trim();
  const tokenSecret = env.BRICKLINK_TOKEN_SECRET?.trim();
  if (!consumerKey || !consumerSecret || !tokenValue || !tokenSecret) return null;
  return { consumerKey, consumerSecret, tokenValue, tokenSecret };
}
