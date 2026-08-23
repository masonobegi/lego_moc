/**
 * Server-side runtime configuration. Never imported by a client component.
 *
 * The rule that matters: with no configuration at all the app runs in Demo
 * Mode and everything works. Live mode is opt-in and degrades to demo mode with
 * a visible warning rather than failing.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

import type { Condition } from '../pricing/types';
import type { GuideType } from '../pricing/bricklinkProvider';
import { readBrickLinkCredentials } from '../pricing/bricklinkProvider';

export interface RuntimeConfig {
  readonly repoRoot: string;
  readonly priceSource: 'demo' | 'bricklink';
  readonly requestedPriceSource: 'demo' | 'bricklink';
  /** Why we are not in the requested mode, when that happened. */
  readonly priceSourceFallbackReason: string | null;
  readonly condition: Condition;
  readonly guideType: GuideType;
  readonly currency: string;
  readonly countryCode: string | undefined;
  readonly region: string | undefined;
  readonly libraryPaths: readonly string[];
  readonly bundledLibraryPath: string;
  readonly fullLibraryPath: string | null;
  readonly stateDir: string;
  readonly priceCachePath: string;
  readonly priceCacheTtlMs: number;
}

let cached: RuntimeConfig | null = null;

export function getRuntimeConfig(): RuntimeConfig {
  if (cached) return cached;

  const repoRoot = process.cwd();
  const bundledLibraryPath = path.join(repoRoot, 'public', 'ldraw');

  const envLibrary = process.env.LDRAW_LIBRARY_PATH?.trim();
  const defaultFull = path.join(repoRoot, 'public', 'ldraw-full');
  const fullCandidate = envLibrary && envLibrary.length > 0 ? envLibrary : defaultFull;
  const fullLibraryPath = existsSync(fullCandidate) ? fullCandidate : null;

  // Full library first so an installed copy wins over the bundled subset.
  const libraryPaths = fullLibraryPath ? [fullLibraryPath, bundledLibraryPath] : [bundledLibraryPath];

  const requested = (process.env.PRICE_SOURCE?.trim().toLowerCase() === 'bricklink'
    ? 'bricklink'
    : 'demo') as 'demo' | 'bricklink';

  let priceSource = requested;
  let fallbackReason: string | null = null;
  if (requested === 'bricklink' && readBrickLinkCredentials() === null) {
    priceSource = 'demo';
    fallbackReason =
      'PRICE_SOURCE is set to "bricklink" but one or more of BRICKLINK_CONSUMER_KEY, ' +
      'BRICKLINK_CONSUMER_SECRET, BRICKLINK_TOKEN_VALUE and BRICKLINK_TOKEN_SECRET is missing. ' +
      'Falling back to Demo Mode.';
  }

  const stateDir = path.join(repoRoot, '.brickthrift');

  cached = {
    repoRoot,
    priceSource,
    requestedPriceSource: requested,
    priceSourceFallbackReason: fallbackReason,
    condition: process.env.BRICKLINK_CONDITION?.trim().toUpperCase() === 'U' ? 'used' : 'new',
    guideType: process.env.BRICKLINK_GUIDE_TYPE?.trim().toLowerCase() === 'sold' ? 'sold' : 'stock',
    currency: process.env.BRICKLINK_CURRENCY?.trim() || 'USD',
    countryCode: process.env.BRICKLINK_COUNTRY_CODE?.trim() || undefined,
    region: process.env.BRICKLINK_REGION?.trim() || undefined,
    libraryPaths,
    bundledLibraryPath,
    fullLibraryPath,
    stateDir,
    priceCachePath: path.join(stateDir, 'price-cache.json'),
    priceCacheTtlMs: 24 * 60 * 60 * 1000,
  };
  return cached;
}

/** Test hook. */
export function resetRuntimeConfig(): void {
  cached = null;
}
