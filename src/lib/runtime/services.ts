/**
 * Builds the concrete services the pipeline needs, from disk and environment.
 * Server-only.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from '../catalog/catalogService';
import type { CatalogService } from '../catalog/types';
import { ChainedPartSource, type PartSource } from '../geometry/partSource';
import { NodePartSource } from '../geometry/nodePartSource';
import { PriceCache } from '../pricing/cache';
import { DemoPriceProvider } from '../pricing/demoProvider';
import { BrickLinkPriceProvider, readBrickLinkCredentials } from '../pricing/bricklinkProvider';
import type { PriceProvider } from '../pricing/types';
import { getRuntimeConfig, type RuntimeConfig } from './config';

let catalogSingleton: CatalogService | null = null;
let partSourceSingleton: PartSource | null = null;
let priceCacheSingleton: PriceCache | null = null;

export function getPartSource(config: RuntimeConfig = getRuntimeConfig()): PartSource {
  if (partSourceSingleton) return partSourceSingleton;
  partSourceSingleton = new ChainedPartSource(config.libraryPaths.map((root) => new NodePartSource(root)));
  return partSourceSingleton;
}

export function getCatalog(config: RuntimeConfig = getRuntimeConfig()): CatalogService {
  if (catalogSingleton) return catalogSingleton;

  const bundled = JSON.parse(
    readFileSync(path.join(config.repoRoot, 'data', 'catalog', 'bundled-catalog.json'), 'utf8'),
  ) as BundledCatalogFile;
  const moldRules = JSON.parse(
    readFileSync(path.join(config.repoRoot, 'data', 'catalog', 'mold-rules.json'), 'utf8'),
  ) as MoldRulesFile;

  // Written by `npm run catalog:import` when a Rebrickable key is configured.
  const colorsPath = path.join(config.repoRoot, 'data', 'catalog', 'rebrickable', 'part-colors.json');

  if (existsSync(colorsPath)) {
    const raw = JSON.parse(readFileSync(colorsPath, 'utf8')) as {
      generatedAt: string;
      parts: Record<string, number[]>;
      externalIds?: Record<string, { bricklink?: string; rebrickable?: string; lego?: string }>;
      moldRules?: MoldRulesFile['rules'];
    };
    const colorsByPart = new Map<string, ReadonlySet<number>>();
    for (const [partId, colors] of Object.entries(raw.parts)) {
      colorsByPart.set(partId.toLowerCase(), new Set(colors));
    }
    catalogSingleton = new DefaultCatalogService({
      bundled,
      moldRules,
      rebrickable: {
        source: `Rebrickable catalogue import, ${raw.generatedAt}`,
        colorsByPart,
        externalIds: raw.externalIds
          ? {
              byLDrawId: new Map(Object.entries(raw.externalIds)),
              source: `Rebrickable import ${raw.generatedAt}`,
            }
          : undefined,
        moldRules: raw.moldRules,
      },
    });
    return catalogSingleton;
  }

  catalogSingleton = new DefaultCatalogService({ bundled, moldRules });
  return catalogSingleton;
}

export function getPriceCache(config: RuntimeConfig = getRuntimeConfig()): PriceCache {
  if (priceCacheSingleton) return priceCacheSingleton;
  priceCacheSingleton = new PriceCache(config.priceCacheTtlMs, config.priceCachePath);
  return priceCacheSingleton;
}

export function getPriceProvider(config: RuntimeConfig = getRuntimeConfig()): PriceProvider {
  if (config.priceSource === 'demo') return new DemoPriceProvider();

  const credentials = readBrickLinkCredentials();
  if (!credentials) return new DemoPriceProvider();

  const catalog = getCatalog(config);
  return new BrickLinkPriceProvider({
    credentials,
    guideType: config.guideType,
    currency: config.currency,
    countryCode: config.countryCode,
    region: config.region,
    cache: getPriceCache(config),
    mapPart: (partId) => {
      const mapping = catalog.mapPart(partId);
      return mapping.confidence === 'unmapped' ? null : mapping.brickLinkPartId;
    },
    mapColor: (colorId) => catalog.mapColor(colorId).brickLinkColorId,
  });
}

/** Test hook. */
export function resetServices(): void {
  catalogSingleton = null;
  partSourceSingleton = null;
  priceCacheSingleton = null;
}
