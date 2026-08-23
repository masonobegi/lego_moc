import { NextResponse } from 'next/server';

import { getRuntimeConfig } from '@/lib/runtime/config';
import { getCatalog, getPartSource } from '@/lib/runtime/services';
import { NodePartSource } from '@/lib/geometry/nodePartSource';
import { COLOR_TABLE_SOURCE, allColors } from '@/lib/ldraw/colors';
import { curatedColorMappingSize } from '@/lib/catalog/colorMapping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Diagnostics for the /dev page. Reports configuration, never secrets. */
export async function GET(): Promise<Response> {
  const config = getRuntimeConfig();
  const catalog = getCatalog(config);

  let bundledPartCount = 0;
  let fullPartCount = 0;
  try {
    bundledPartCount = await new NodePartSource(config.bundledLibraryPath).size();
    if (config.fullLibraryPath) {
      fullPartCount = await new NodePartSource(config.fullLibraryPath).size();
    }
  } catch {
    // Diagnostics only.
  }
  void getPartSource(config);

  return NextResponse.json({
    priceSource: config.priceSource,
    requestedPriceSource: config.requestedPriceSource,
    priceSourceFallbackReason: config.priceSourceFallbackReason,
    isDemoData: config.priceSource === 'demo',
    condition: config.condition,
    guideType: config.guideType,
    currency: config.currency,
    partsLibrary: {
      bundledPath: 'public/ldraw',
      bundledEntries: bundledPartCount,
      fullPath: config.fullLibraryPath,
      fullEntries: fullPartCount,
      usingFullLibrary: config.fullLibraryPath !== null,
    },
    colors: { source: COLOR_TABLE_SOURCE, count: allColors().length },
    catalog: catalog.status,
    colorMappingEntries: curatedColorMappingSize(),
  });
}
