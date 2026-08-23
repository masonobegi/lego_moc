/**
 * JSON report, CSV change log and BrickLink Wanted List XML.
 */

import { colorName } from '../ldraw/colors';
import type { CatalogService } from '../catalog/types';
import { buildQualityMetrics } from '../analysis/metrics';
import type { AnalysisResult, OptimizationQualityMetrics, SavingsSummary } from '../analysis/types';
import type { OptimizationCandidate } from '../optimizer/types';
import type { CostSummary } from '../pricing/priceEngine';
import type { PartInstance } from '../ldraw/types';

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

export interface OptimizationReport {
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly model: AnalysisResult['model'];
  readonly priceSource: {
    id: string;
    label: string;
    isDemoData: boolean;
    condition: string;
    currency: string;
    disclaimer: string;
  };
  readonly catalogSource: { id: string; label: string; limitations: readonly string[] };
  readonly safetyLevel: string;
  /**
   * Estimated PART cost, both figures. Neither is a delivered order total:
   * they exclude shipping, seller minimums, handling and tax, and they assume
   * every lot is bought at its typical market price, which no single real order
   * achieves. See `disclaimer` on priceSource.
   */
  readonly originalEstimatedPartCost: number;
  readonly optimizedEstimatedPartCost: number;
  readonly estimatedPartSavings: number;
  readonly savingsPercent: number;
  /** The part of the saving from changes that are both safe AND practical to buy. */
  readonly highConfidenceEstimatedPartSavings: number;
  readonly costBasis: string;
  readonly qualityMetrics: OptimizationQualityMetrics;
  readonly changedPieceCount: number;
  readonly uniqueSubstitutionCount: number;
  readonly unpricedLotCount: number;
  readonly changes: readonly ReportChange[];
  readonly notEnabled: readonly ReportChange[];
}

export interface ReportChange {
  readonly id: string;
  readonly kind: string;
  readonly subModel: string;
  readonly step: number;
  readonly part: string;
  readonly partDescription: string;
  readonly quantity: number;
  readonly fromPart: string;
  readonly toPart: string;
  readonly fromColorId: number;
  readonly fromColor: string;
  readonly toColorId: number;
  readonly toColor: string;
  readonly originalUnitPrice: number;
  readonly optimizedUnitPrice: number;
  readonly originalTotal: number;
  readonly optimizedTotal: number;
  readonly savings: number;
  readonly reason: string;
  readonly confidence: number;
  readonly visibility: string;
  readonly evidence: readonly string[];
  readonly originalAvailability: string;
  readonly replacementAvailability: string;
  readonly replacementLotsListed: number | null;
  readonly replacementPiecesListed: number | null;
  readonly shippingRisk: string;
  readonly isHighConfidence: boolean;
  readonly confidenceCaveat: string | null;
}

function toReportChange(candidate: OptimizationCandidate): ReportChange {
  return {
    id: candidate.id,
    kind: candidate.kind,
    subModel: candidate.parentModel,
    step: candidate.stepIndex + 1,
    part: candidate.partId,
    partDescription: candidate.partDescription,
    quantity: candidate.quantity,
    fromPart: candidate.originalPartId,
    toPart: candidate.replacementPartId,
    fromColorId: candidate.originalColorId,
    fromColor: candidate.originalColorName,
    toColorId: candidate.replacementColorId,
    toColor: candidate.replacementColorName,
    originalUnitPrice: candidate.originalUnitPrice,
    optimizedUnitPrice: candidate.replacementUnitPrice,
    originalTotal: candidate.originalTotal,
    optimizedTotal: candidate.replacementTotal,
    savings: candidate.savings,
    reason: candidate.reason,
    confidence: candidate.confidence,
    visibility: candidate.visibility.classification,
    evidence: candidate.evidence,
    originalAvailability: candidate.originalAvailability.level,
    replacementAvailability: candidate.replacementAvailability.level,
    replacementLotsListed: candidate.replacementAvailability.lots,
    replacementPiecesListed: candidate.replacementAvailability.pieces,
    shippingRisk: candidate.shippingRisk,
    isHighConfidence: candidate.isHighConfidence,
    confidenceCaveat: candidate.confidenceCaveat,
  };
}

export function buildJsonReport(
  result: AnalysisResult,
  savings: SavingsSummary,
  enabledIds: ReadonlySet<string>,
): OptimizationReport {
  const enabled = result.candidates.filter((c) => enabledIds.has(c.id));
  const disabled = result.candidates.filter((c) => !enabledIds.has(c.id));

  return {
    generatedBy: 'BrickThrift',
    generatedAt: new Date().toISOString(),
    model: result.model,
    priceSource: {
      id: result.pricing.sourceId,
      label: result.pricing.sourceLabel,
      isDemoData: result.pricing.isDemoData,
      condition: result.pricing.condition,
      currency: result.pricing.currency,
      disclaimer: result.pricing.isDemoData
        ? 'DEMO PRICE DATA. These are synthetic figures built into the app, not real market prices.'
        : 'Estimated market parts cost. Excludes shipping, seller minimums, lot availability and tax.',
    },
    catalogSource: {
      id: result.catalog.sourceId,
      label: result.catalog.label,
      limitations: result.catalog.limitations,
    },
    safetyLevel: result.safetyLevel,
    originalEstimatedPartCost: savings.originalCost,
    optimizedEstimatedPartCost: savings.optimizedCost,
    estimatedPartSavings: savings.savings,
    savingsPercent: savings.savingsPercent,
    highConfidenceEstimatedPartSavings: savings.highConfidenceSavings,
    costBasis:
      'Estimated part cost only. NOT a delivered order total: excludes shipping, seller minimums, ' +
      'handling and tax, and assumes every lot is bought at its typical market price. Import the ' +
      'original and optimized Wanted Lists into BrickLink and compare the two order totals to find ' +
      'out what the change is actually worth.',
    qualityMetrics: buildQualityMetrics(result, savings),
    changedPieceCount: savings.changedPieceCount,
    uniqueSubstitutionCount: savings.uniqueSubstitutionCount,
    unpricedLotCount: result.originalCost.unpricedLots.length,
    changes: enabled.map(toReportChange),
    notEnabled: disabled.map(toReportChange),
  };
}

// ---------------------------------------------------------------------------
// CSV change log
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'step',
  'submodel',
  'part',
  'partDescription',
  'quantity',
  'oldPart',
  'newPart',
  'oldColorId',
  'oldColor',
  'newColorId',
  'newColor',
  'oldUnitPrice',
  'newUnitPrice',
  'oldTotal',
  'newTotal',
  'savings',
  'reason',
  'confidence',
  'visibility',
  'replacementAvailability',
  'shippingRisk',
  'highConfidence',
  'enabled',
] as const;

/**
 * RFC 4180 quoting. A leading =, +, - or @ is also prefixed with a single quote
 * so a spreadsheet does not interpret a value as a formula.
 */
export function csvEscape(value: string | number | boolean): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildChangeLogCsv(
  candidates: readonly OptimizationCandidate[],
  enabledIds: ReadonlySet<string>,
): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  const sorted = [...candidates].sort(
    (a, b) => a.parentModel.localeCompare(b.parentModel) || a.stepIndex - b.stepIndex || b.savings - a.savings,
  );
  for (const candidate of sorted) {
    rows.push(
      [
        candidate.stepIndex + 1,
        candidate.parentModel,
        candidate.partId,
        candidate.partDescription,
        candidate.quantity,
        candidate.originalPartId,
        candidate.replacementPartId,
        candidate.originalColorId,
        candidate.originalColorName,
        candidate.replacementColorId,
        candidate.replacementColorName,
        candidate.originalUnitPrice.toFixed(2),
        candidate.replacementUnitPrice.toFixed(2),
        candidate.originalTotal.toFixed(2),
        candidate.replacementTotal.toFixed(2),
        candidate.savings.toFixed(2),
        candidate.reason,
        (candidate.confidence * 100).toFixed(2) + '%',
        candidate.visibility.classification,
        candidate.replacementAvailability.level,
        candidate.shippingRisk,
        candidate.isHighConfidence,
        enabledIds.has(candidate.id),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// BrickLink Wanted List XML
// ---------------------------------------------------------------------------

export interface WantedListResult {
  readonly xml: string;
  readonly itemCount: number;
  readonly pieceCount: number;
  /** Lots left out because no BrickLink id or color could be resolved. */
  readonly excluded: readonly { partId: string; colorId: number; quantity: number; reason: string }[];
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * BrickLink Wanted List XML.
 *
 * Structure per docs/RESEARCH.md section 11:
 *   <INVENTORY><ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID/><COLOR/><MINQTY/><CONDITION/></ITEM></INVENTORY>
 *
 * ITEMID is the BrickLink part number and COLOR the BrickLink color id, both
 * of which differ from LDraw's. Any lot whose ids cannot be resolved with
 * confidence is EXCLUDED and reported rather than guessed, because a wrong id
 * would silently order the wrong brick.
 */
export function buildWantedListXml(
  instances: readonly PartInstance[],
  catalog: CatalogService,
  condition: 'new' | 'used',
): WantedListResult {
  const counts = new Map<string, { partId: string; colorId: number; quantity: number }>();
  for (const instance of instances) {
    const key = `${instance.partId}|${instance.colorId}`;
    const existing = counts.get(key);
    if (existing) existing.quantity++;
    else counts.set(key, { partId: instance.partId, colorId: instance.colorId, quantity: 1 });
  }

  const lines: string[] = ['<INVENTORY>'];
  const excluded: { partId: string; colorId: number; quantity: number; reason: string }[] = [];
  let itemCount = 0;
  let pieceCount = 0;

  const sorted = [...counts.values()].sort(
    (a, b) => a.partId.localeCompare(b.partId) || a.colorId - b.colorId,
  );

  for (const lot of sorted) {
    const partMapping = catalog.mapPart(lot.partId);
    if (partMapping.confidence === 'unmapped' || !partMapping.brickLinkPartId) {
      excluded.push({ ...lot, reason: partMapping.note ?? 'No BrickLink part number could be resolved.' });
      continue;
    }
    const colorMapping = catalog.mapColor(lot.colorId);
    if (colorMapping.brickLinkColorId === null) {
      excluded.push({
        ...lot,
        reason: `No BrickLink color id is known for LDraw color ${lot.colorId} (${colorName(lot.colorId)}).`,
      });
      continue;
    }
    lines.push('    <ITEM>');
    lines.push('        <ITEMTYPE>P</ITEMTYPE>');
    lines.push(`        <ITEMID>${xmlEscape(partMapping.brickLinkPartId)}</ITEMID>`);
    lines.push(`        <COLOR>${colorMapping.brickLinkColorId}</COLOR>`);
    lines.push(`        <MINQTY>${lot.quantity}</MINQTY>`);
    lines.push(`        <CONDITION>${condition === 'new' ? 'N' : 'U'}</CONDITION>`);
    lines.push('    </ITEM>');
    itemCount++;
    pieceCount += lot.quantity;
  }

  lines.push('</INVENTORY>');
  return { xml: lines.join('\n') + '\n', itemCount, pieceCount, excluded };
}

export function summarizeCostForExport(cost: CostSummary): {
  total: number;
  lots: number;
  pieces: number;
  unpricedLots: number;
} {
  return {
    total: cost.total,
    lots: cost.lotCount,
    pieces: cost.pricedPieceCount,
    unpricedLots: cost.unpricedLots.length,
  };
}
