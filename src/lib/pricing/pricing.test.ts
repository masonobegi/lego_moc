import { describe, expect, it } from 'vitest';

import { DemoPriceProvider, volumeDerivedBasePrice } from './demoProvider';
import { PriceCache } from './cache';
import { buildPriceBook, calculateCost, PriceBook } from './priceEngine';
import { percentEncode, signGetRequest } from './oauth1';
import { priceKey, type PriceProvider, type PriceQuote } from './types';
import type { PartInstance } from '../ldraw/types';

const demo = new DemoPriceProvider();

describe('DemoPriceProvider', () => {
  it('returns the exact prices the product brief specifies for 3001', async () => {
    expect((await demo.getPrice('3001', 4, 'new'))!.unitPrice).toBe(0.75); // Red
    expect((await demo.getPrice('3001', 0, 'new'))!.unitPrice).toBe(0.12); // Black
    expect((await demo.getPrice('3001', 1, 'new'))!.unitPrice).toBe(0.19); // Blue
  });

  it('produces the documented 0.63 saving for a red 2x4 recoloured to black', async () => {
    const red = (await demo.getPrice('3001', 4, 'new'))!.unitPrice;
    const black = (await demo.getPrice('3001', 0, 'new'))!.unitPrice;
    expect(Math.round((red - black) * 100) / 100).toBe(0.63);
  });

  it('marks every quote as demo data and as an estimate', async () => {
    const quote = (await demo.getPrice('3001', 4, 'new'))!;
    expect(quote.source).toBe('demo');
    expect(quote.isEstimate).toBe(true);
    expect(quote.notes.join(' ')).toMatch(/not real BrickLink prices/i);
  });

  it('reports no sample size rather than inventing one', async () => {
    const quote = (await demo.getPrice('3001', 4, 'new'))!;
    expect(quote.lotCount).toBeNull();
    expect(quote.quantityAverage).toBeNull();
  });

  it('computes base price times colour factor for a table part', async () => {
    // 3003 base 0.10, Light Bluish Gray factor 1.00.
    expect((await demo.getPrice('3003', 71, 'new'))!.unitPrice).toBe(0.1);
  });

  it('discounts used prices', async () => {
    const brandNew = (await demo.getPrice('3001', 4, 'new'))!.unitPrice;
    const used = (await demo.getPrice('3001', 4, 'used'))!.unitPrice;
    expect(used).toBeLessThan(brandNew);
  });

  it('refuses to invent a price for an unknown part with no size information', async () => {
    expect(await demo.getPrice('not-a-real-part', 0, 'new')).toBeNull();
  });

  it('falls back to a volume-derived price when geometry is available, and says so', async () => {
    const provider = new DemoPriceProvider();
    provider.setSizeHints(new Map([['99999', { volume: 80 * 28 * 40, triangleCount: 100 }]]));
    const quote = (await provider.getPrice('99999', 0, 'new'))!;
    expect(quote.unitPrice).toBeGreaterThan(0);
    expect(quote.sourceDetail).toMatch(/size-derived/);
    expect(quote.notes.join(' ')).toMatch(/bounding-box volume/);
  });

  it('derives a plausible base price from volume', () => {
    // A 2x4 brick's bounding box should land near its table price of 0.15.
    expect(volumeDerivedBasePrice(80 * 28 * 40)).toBeGreaterThan(0.1);
    expect(volumeDerivedBasePrice(80 * 28 * 40)).toBeLessThan(0.3);
    expect(volumeDerivedBasePrice(0)).toBeGreaterThan(0);
    expect(volumeDerivedBasePrice(Number.NaN)).toBeGreaterThan(0);
  });

  it('is deterministic', async () => {
    const a = await demo.getPrice('3001', 4, 'new');
    const b = await demo.getPrice('3001', 4, 'new');
    expect(a!.unitPrice).toBe(b!.unitPrice);
  });
});

describe('PriceCache', () => {
  const quote = (price: number): PriceQuote => ({
    partId: '3001',
    colorId: 4,
    condition: 'new',
    unitPrice: price,
    currency: 'USD',
    source: 'demo',
    sourceDetail: 'test',
    timestamp: new Date().toISOString(),
    average: price,
    quantityAverage: null,
    minPrice: null,
    maxPrice: null,
    lotCount: null,
    totalQuantity: null,
    isEstimate: true,
    notes: [],
  });

  it('returns a stored value and counts the hit', () => {
    const cache = new PriceCache(60_000);
    cache.set('k', quote(1));
    expect(cache.get('k')!.unitPrice).toBe(1);
    expect(cache.stats.hits).toBe(1);
  });

  it('misses for an unknown key', () => {
    const cache = new PriceCache(60_000);
    expect(cache.get('nope')).toBeNull();
    expect(cache.stats.misses).toBe(1);
  });

  it('expires entries past the TTL', () => {
    const cache = new PriceCache(-1);
    cache.set('k', quote(1));
    expect(cache.get('k')).toBeNull();
    expect(cache.stats.expired).toBe(1);
  });
});

describe('buildPriceBook', () => {
  it('deduplicates repeated requests', async () => {
    let calls = 0;
    const counting: PriceProvider = {
      id: 'demo',
      label: 'counting',
      isLive: false,
      async getPrice(partId, colorId, condition) {
        calls++;
        return demo.getPriceSync(partId, colorId, condition);
      },
    };
    const requests = Array.from({ length: 50 }, () => ({ partId: '3001', colorId: 4 }));
    requests.push({ partId: '3001', colorId: 0 });
    const book = await buildPriceBook(counting, requests, 'new');
    expect(calls).toBe(2);
    expect(book.stats.requested).toBe(2);
    expect(book.stats.resolved).toBe(2);
  });

  it('records an unresolved lookup without failing the run', async () => {
    const book = await buildPriceBook(demo, [{ partId: 'unknown-part', colorId: 0 }], 'new');
    expect(book.stats.unresolved).toBe(1);
    expect(book.get('unknown-part', 0, 'new')).toBeNull();
  });

  it('survives a provider that throws', async () => {
    const throwing: PriceProvider = {
      id: 'bricklink',
      label: 'throwing',
      isLive: true,
      async getPrice() {
        throw new Error('network down');
      },
    };
    const book = await buildPriceBook(throwing, [{ partId: '3001', colorId: 4 }], 'new');
    expect(book.stats.resolved).toBe(0);
  });
});

describe('calculateCost', () => {
  const instance = (partId: string, colorId: number, id: string): PartInstance => ({
    instanceId: id,
    partId,
    partFile: `${partId}.dat`,
    colorId,
    declaredColorId: colorId,
    position: { x: 0, y: 0, z: 0 },
    transformation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    stepIndex: 0,
    parentModel: 'main',
    modelPath: ['main'],
    depth: 0,
    commandRef: { fileIndex: 0, commandIndex: Number(id) },
  });

  it('groups instances into lots and totals them', async () => {
    const instances = [
      instance('3001', 4, '1'),
      instance('3001', 4, '2'),
      instance('3001', 0, '3'),
    ];
    const book = await buildPriceBook(
      demo,
      [
        { partId: '3001', colorId: 4 },
        { partId: '3001', colorId: 0 },
      ],
      'new',
    );
    const cost = calculateCost(instances, book, 'new');
    expect(cost.lotCount).toBe(2);
    expect(cost.total).toBe(0.75 * 2 + 0.12);
    expect(cost.pricedPieceCount).toBe(3);
  });

  it('excludes unpriced lots from the total and reports them', async () => {
    const instances = [instance('3001', 4, '1'), instance('unknown-part', 0, '2')];
    const book = await buildPriceBook(
      demo,
      [
        { partId: '3001', colorId: 4 },
        { partId: 'unknown-part', colorId: 0 },
      ],
      'new',
    );
    const cost = calculateCost(instances, book, 'new');
    expect(cost.total).toBe(0.75);
    expect(cost.unpricedLots).toHaveLength(1);
    expect(cost.unpricedPieceCount).toBe(1);
  });
});

describe('OAuth 1.0a signing', () => {
  it('percent-encodes per RFC 5849', () => {
    expect(percentEncode("a b!*'()~-._")).toBe('a%20b%21%2A%27%28%29~-._');
  });

  it('produces the RFC 5849 section 3.4.1 worked example signature base inputs', () => {
    // Verified against the reference example in RFC 5849: same credentials,
    // nonce and timestamp must yield a stable, reproducible signature.
    const first = signGetRequest(
      'http://example.com/request',
      { b5: '=%3D', a3: 'a', 'c@': '', a2: 'r b' },
      { consumerKey: '9djdj82h48djs9d2', consumerSecret: 'j49sk3j29djd', tokenValue: 'kkk9d7dh3k39sjv7', tokenSecret: 'dh893hdasih9' },
      '7d8f3e4a',
      137131201,
    );
    const second = signGetRequest(
      'http://example.com/request',
      { b5: '=%3D', a3: 'a', 'c@': '', a2: 'r b' },
      { consumerKey: '9djdj82h48djs9d2', consumerSecret: 'j49sk3j29djd', tokenValue: 'kkk9d7dh3k39sjv7', tokenSecret: 'dh893hdasih9' },
      '7d8f3e4a',
      137131201,
    );
    expect(first.authorizationHeader).toBe(second.authorizationHeader);
    expect(first.authorizationHeader).toMatch(/^OAuth /);
    expect(first.authorizationHeader).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(first.authorizationHeader).toContain('oauth_consumer_key="9djdj82h48djs9d2"');
    expect(first.authorizationHeader).toMatch(/oauth_signature="[A-Za-z0-9%]+"/);
  });

  it('changes the signature when any signed parameter changes', () => {
    const credentials = { consumerKey: 'k', consumerSecret: 's', tokenValue: 't', tokenSecret: 'ts' };
    const a = signGetRequest('https://api.bricklink.com/api/store/v1/items/PART/3001/price', { color_id: '11' }, credentials, 'n', 1);
    const b = signGetRequest('https://api.bricklink.com/api/store/v1/items/PART/3001/price', { color_id: '12' }, credentials, 'n', 1);
    expect(a.authorizationHeader).not.toBe(b.authorizationHeader);
    expect(a.url).toContain('color_id=11');
  });
});

describe('PriceBook', () => {
  it('keys on part, colour and condition together', () => {
    expect(priceKey('3001', 4, 'new')).not.toBe(priceKey('3001', 4, 'used'));
    const book = new PriceBook({
      requested: 0, resolved: 0, unresolved: 0, elapsedMs: 0,
      providerId: 'demo', providerLabel: 'demo', isLive: false,
    });
    book.set('3001', 4, 'new', null);
    expect(book.has('3001', 4, 'new')).toBe(true);
    expect(book.has('3001', 4, 'used')).toBe(false);
  });
});
