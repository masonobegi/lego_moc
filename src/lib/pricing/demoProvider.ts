/**
 * Demo price provider. Requires no credentials and works entirely offline.
 *
 * See demoData.ts for what the numbers are and are not. Every quote produced
 * here is stamped `source: 'demo'` and carries the demo disclaimer in its
 * notes, and the UI renders a DEMO PRICE DATA badge wherever a demo figure is
 * shown. Nothing in the app ever presents a demo price as a live one.
 */

import {
  DEMO_BASE_PRICES,
  DEMO_COLOR_FACTORS,
  DEMO_CURRENCY,
  DEMO_DATA_DISCLAIMER,
  DEMO_DEFAULT_COLOR_FACTOR,
  DEMO_PRICE_OVERRIDES,
  DEMO_USED_DISCOUNT,
} from './demoData';
import type { Condition, PartSizeHint, PriceQuote, SizeAwarePriceProvider } from './types';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Fallback base price for a part with no entry in the demo table.
 *
 * Derived from the part's own bounding-box volume rather than from a hash or a
 * constant: a bigger element uses more plastic and costs more, which makes the
 * fallback explainable instead of arbitrary. The divisor is chosen so that a
 * 2 x 4 brick (80 x 28 x 40 LDU) lands near its table price.
 */
export function volumeDerivedBasePrice(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0.2;
  return Math.min(3, Math.max(0.03, round2(0.03 + volume / 600_000)));
}

export class DemoPriceProvider implements SizeAwarePriceProvider {
  readonly id = 'demo' as const;
  readonly label = 'Demo price data';
  readonly isLive = false;

  private sizeHints: ReadonlyMap<string, PartSizeHint> = new Map();
  private readonly issuedAt = new Date().toISOString();

  setSizeHints(hints: ReadonlyMap<string, PartSizeHint>): void {
    this.sizeHints = hints;
  }

  async getPrice(partId: string, colorId: number, condition: Condition): Promise<PriceQuote | null> {
    return this.getPriceSync(partId, colorId, condition);
  }

  /** Synchronous variant, used by tests and by the batch engine. */
  getPriceSync(partId: string, colorId: number, condition: Condition): PriceQuote | null {
    const id = partId.toLowerCase();
    const notes: string[] = [DEMO_DATA_DISCLAIMER];

    const override = DEMO_PRICE_OVERRIDES.get(`${id}|${colorId}`);
    let newPrice: number;
    let detail: string;

    if (override !== undefined) {
      newPrice = override;
      detail = 'demo dataset, exact table entry';
    } else {
      const base = DEMO_BASE_PRICES.get(id);
      const factorKnown = DEMO_COLOR_FACTORS.has(colorId);
      const factor = DEMO_COLOR_FACTORS.get(colorId) ?? DEMO_DEFAULT_COLOR_FACTOR;

      if (base !== undefined) {
        newPrice = round2(base * factor);
        detail = 'demo dataset, base price x color factor';
      } else {
        const hint = this.sizeHints.get(id);
        if (!hint) {
          // No table entry and no geometry: refuse rather than invent a number.
          return null;
        }
        newPrice = round2(volumeDerivedBasePrice(hint.volume) * factor);
        detail = 'demo dataset, size-derived estimate x color factor';
        notes.push(
          `No demo table entry for part ${partId}; the base price was derived from the part's own ` +
            `bounding-box volume (${Math.round(hint.volume).toLocaleString()} cubic LDU).`,
        );
      }
      if (!factorKnown) {
        notes.push(
          `No demo color factor for LDraw color ${colorId}; the default factor of ` +
            `${DEMO_DEFAULT_COLOR_FACTOR} was used.`,
        );
      }
    }

    const unitPrice = condition === 'used' ? round2(newPrice * DEMO_USED_DISCOUNT) : newPrice;
    if (condition === 'used') {
      notes.push(
        `Used prices in the demo dataset are modeled as ${Math.round(DEMO_USED_DISCOUNT * 100)}% of new.`,
      );
    }

    return {
      partId: id,
      colorId,
      condition,
      unitPrice: Math.max(0.01, unitPrice),
      currency: DEMO_CURRENCY,
      source: 'demo',
      sourceDetail: detail,
      timestamp: this.issuedAt,
      average: unitPrice,
      // The demo dataset has no listing sample behind it, so there is no
      // quantity-weighted average and no lot count to report. Reporting null
      // is the honest answer; reporting a made-up sample size would not be.
      quantityAverage: null,
      minPrice: null,
      maxPrice: null,
      // Demo mode has no marketplace behind it. Rather than invent lot counts
      // that would make an availability assessment look researched when it is
      // fabricated, they are left null and the assessment reports "unknown".
      lotCount: null,
      totalQuantity: null,
      supplyIsLocationFiltered: false,
      supplyReflectsSoldHistory: false,
      isEstimate: true,
      notes,
    };
  }
}
