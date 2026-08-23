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
import { countLots } from '../ldraw/inventory';
import { DELTA_ACTION_LABELS, type InventoryDelta } from './inventoryDelta';

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

/**
 * A number we computed ourselves, formatted for CSV.
 *
 * `csvEscape` prefixes anything starting with `-`, `+`, `=` or `@` with an
 * apostrophe so a spreadsheet cannot evaluate attacker-controlled text as a
 * formula. That guard is essential for values taken from an uploaded model -
 * a part description or a color name is whatever the file said - and actively
 * harmful for a numeric column, where it turns -4 into the TEXT '-4 and breaks
 * sorting and summing.
 *
 * The distinction is provenance, not appearance: these numbers are computed
 * here from integers and prices, never copied out of the uploaded file, so
 * there is nothing to inject.
 */
export function csvNumber(value: number | null, decimals = 0): string {
  if (value === null || !Number.isFinite(value)) return '';
  return value.toFixed(decimals);
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
 * One lot in LDraw terms. `quantity` may be negative in a delta.
 */
export interface WantedLot {
  readonly partId: string;
  readonly colorId: number;
  readonly quantity: number;
}

export interface WantedListBuildResult extends WantedListResult {
  /**
   * Resolved lots whose signed quantities cancelled exactly. Only a delta can
   * produce these: a mold swap BrickLink sells under one number is no change at
   * all to an order.
   */
  readonly nettedToNothing: number;
  /**
   * Lots with a NEGATIVE quantity that could not be resolved, so could not be
   * offset against the positives. A quantity emitted here may be higher than
   * the buyer actually needs, and the caller must say so.
   */
  readonly unmappedDecreases: number;
}

/**
 * BrickLink Wanted List XML, from lots given in LDraw ids.
 *
 * Structure per docs/RESEARCH.md section 11:
 *   <INVENTORY><ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID/><COLOR/><MINQTY/><CONDITION/></ITEM></INVENTORY>
 *
 * The one thing this function exists to get right: **aggregation happens after
 * id resolution, not before.** The LDraw to BrickLink map is many-to-one, and
 * the collisions are live in the shipped tables - LDraw colors 32 and 40 are
 * both BrickLink 13, and LDraw parts 6141 and 4073 are both BrickLink 4073.
 * Counting lots in LDraw space and then mapping each one, which is what this
 * code used to do, emits two ITEM blocks with the same ITEMID and COLOR and the
 * quantity split between them - three and one where the buyer needs four.
 * BrickLink's behaviour on a duplicated item within one upload is unverified,
 * so the export must never depend on it.
 *
 * Quantities may be signed. Entries are summed per resolved BrickLink identity
 * and only positives are emitted, because a Wanted List can say what you want
 * and never what you no longer want.
 *
 * Any lot whose ids cannot be resolved with confidence is EXCLUDED and reported
 * rather than guessed, because a wrong id silently orders the wrong brick.
 */
export function buildWantedListFromLots(
  lots: readonly WantedLot[],
  catalog: CatalogService,
  condition: 'new' | 'used',
): WantedListBuildResult {
  const netted = new Map<string, { brickLinkPartId: string; brickLinkColorId: number; net: number }>();
  const excluded: { partId: string; colorId: number; quantity: number; reason: string }[] = [];
  let unmappedDecreases = 0;

  for (const lot of lots) {
    if (lot.quantity === 0) continue;
    const partMapping = catalog.mapPart(lot.partId);
    const colorMapping = catalog.mapColor(lot.colorId);
    const reason =
      partMapping.confidence === 'unmapped' || !partMapping.brickLinkPartId
        ? (partMapping.note ?? 'No BrickLink part number could be resolved.')
        : colorMapping.brickLinkColorId === null
          ? `No BrickLink color id is known for LDraw color ${lot.colorId} (${colorName(lot.colorId)}).`
          : null;

    if (reason !== null) {
      // Only a positive quantity is something the buyer would have been told to
      // order, so only that is a gap worth reporting in the file.
      if (lot.quantity > 0) {
        excluded.push({ partId: lot.partId, colorId: lot.colorId, quantity: lot.quantity, reason });
      } else {
        unmappedDecreases++;
      }
      continue;
    }

    const brickLinkPartId = partMapping.brickLinkPartId!;
    const brickLinkColorId = colorMapping.brickLinkColorId!;
    const key = `${brickLinkPartId}|${brickLinkColorId}`;
    const entry = netted.get(key);
    if (entry) entry.net += lot.quantity;
    else netted.set(key, { brickLinkPartId, brickLinkColorId, net: lot.quantity });
  }

  const lines: string[] = ['<INVENTORY>'];
  let itemCount = 0;
  let pieceCount = 0;
  let nettedToNothing = 0;

  const ordered = [...netted.values()].sort(
    (a, b) =>
      a.brickLinkPartId.localeCompare(b.brickLinkPartId) || a.brickLinkColorId - b.brickLinkColorId,
  );

  for (const entry of ordered) {
    if (entry.net === 0) {
      nettedToNothing++;
      continue;
    }
    if (entry.net < 0) continue;

    lines.push('    <ITEM>');
    lines.push('        <ITEMTYPE>P</ITEMTYPE>');
    lines.push(`        <ITEMID>${xmlEscape(entry.brickLinkPartId)}</ITEMID>`);
    lines.push(`        <COLOR>${entry.brickLinkColorId}</COLOR>`);
    lines.push(`        <MINQTY>${entry.net}</MINQTY>`);
    lines.push(`        <CONDITION>${condition === 'new' ? 'N' : 'U'}</CONDITION>`);
    lines.push('    </ITEM>');
    itemCount++;
    pieceCount += entry.net;
  }

  lines.push('</INVENTORY>');
  return {
    xml: lines.join('\n') + '\n',
    itemCount,
    pieceCount,
    excluded,
    nettedToNothing,
    unmappedDecreases,
  };
}

/** The complete inventory as a Wanted List. */
export function buildWantedListXml(
  instances: readonly PartInstance[],
  catalog: CatalogService,
  condition: 'new' | 'used',
): WantedListResult {
  return buildWantedListFromLots([...countLots(instances).values()], catalog, condition);
}

const DELTA_CSV_COLUMNS = [
  'action',
  'part',
  'partDescription',
  'colorId',
  'color',
  'originalQty',
  'optimizedQty',
  'change',
  'estUnitPrice',
  'estOriginalLineTotal',
  'estOptimizedLineTotal',
  'estCostChange',
] as const;

/**
 * Context every changed-parts file has to carry.
 *
 * A parts list with no provenance is dangerous in a way a report is not: it is
 * short, it is actionable, and it will be opened weeks later with no memory of
 * which model or which settings produced it.
 */
export interface DeltaExportContext {
  readonly modelFileName: string;
  readonly analysisId: string;
  readonly generatedAt: string;
  readonly enabledChangeCount: number;
  readonly candidateCount: number;
  readonly priceSourceLabel: string;
  readonly isDemoData: boolean;
  readonly condition: 'new' | 'used';
}

/**
 * The lines every changed-parts export opens with, without comment markers.
 *
 * Shared so the CSV and the XML cannot drift into telling different stories,
 * and so the one sentence that actually decides whether this file is safe to
 * act on - "only if what you already hold is the original list" - is written
 * once.
 */
export function deltaExportPreamble(delta: InventoryDelta, context: DeltaExportContext): string[] {
  const money = (value: number): string => `${value.toFixed(2)} ${delta.currency}`;
  const lines = [
    'CHANGED PARTS ONLY - this is NOT a complete parts list for this model.',
    '',
    `Model:            ${context.modelFileName}`,
    `Analysis:         ${context.analysisId}`,
    `Generated:        ${context.generatedAt}`,
    `Changes applied:  ${context.enabledChangeCount} of ${context.candidateCount} proposed`,
    `Prices:           ${context.priceSourceLabel} (${context.condition === 'new' ? 'New' : 'Used'}, ${delta.currency})`,
  ];

  if (context.isDemoData) {
    lines.push(
      'DEMO PRICE DATA - synthetic figures built into the app, not real market prices.',
    );
  }

  lines.push(
    '',
    'This is the difference between the ORIGINAL parts list for this model and',
    `the optimized one. It is correct only if what you already hold or have`,
    'ordered is exactly the original list. If you have not ordered yet, do not',
    'use this file - use the OPTIMIZED Wanted List, which is complete on its own.',
    '',
    `Pieces to buy:    ${delta.piecesAdded}`,
    `Pieces made spare: ${delta.piecesRemoved}`,
    `Whole model:      ${delta.totalPieces} pieces`,
    '',
    'MONEY. Three different figures, because they answer different questions:',
    delta.estimatedCostDifference === 0
      ? '  If you have NOT ordered yet, the optimized list costs the same as the original.'
      : `  If you have NOT ordered yet, the optimized list is ${money(
          Math.abs(delta.estimatedCostDifference),
        )} ${delta.estimatedCostDifference < 0 ? 'CHEAPER' : 'MORE'} than the original.`,
    `  To act on THIS file you spend ${money(delta.additionalSpend)} on the parts below.`,
    `  You will be left with roughly ${money(delta.spareValue)} of parts you no longer need.`,
    '',
    'If your original order is already placed, acting on this file COSTS you the',
    'second figure and returns nothing: the parts you no longer need are already',
    'bought and cannot be un-bought. The optimization only pays if it is applied',
    'BEFORE you order.',
    '',
    'These are estimated PART prices, not an order total. Buying the difference',
    'is its own BrickLink order with its own shipping charge and seller minimums,',
    'which on a small difference can easily exceed what the change saves.',
  );

  if (delta.unpricedLotCount > 0) {
    lines.push(
      '',
      `${delta.unpricedLotCount} lot(s) covering ${delta.unpricedPieceCount} piece(s) have no price`,
      'estimate and are excluded from every figure above. They are still listed.',
    );
  }

  return lines;
}

/**
 * The delta as a spreadsheet.
 *
 * Unlike the Wanted List XML, this can carry BOTH directions, so it is the
 * authoritative artifact: the lots you need fewer of only exist here. The
 * `action` column spells that out in words rather than leaving the reader to
 * infer it from a minus sign.
 *
 * The preamble uses `#` comment lines. Every mainstream CSV reader either skips
 * them or shows them as plain rows at the top of the sheet, and neither outcome
 * can be mistaken for data - the alternative, a naked column row, ships a file
 * with no model name, no settings and no note that the prices might be
 * synthetic.
 */
export function buildInventoryDeltaCsv(delta: InventoryDelta, context: DeltaExportContext): string {
  const rows: string[] = deltaExportPreamble(delta, context).map((line) =>
    line === '' ? '#' : `# ${line}`,
  );
  rows.push(DELTA_CSV_COLUMNS.join(','));
  for (const lot of delta.lots) {
    rows.push(
      [
        // Text from the model goes through the injection guard; numbers we
        // computed go through csvNumber so they stay numbers in a spreadsheet.
        csvEscape(DELTA_ACTION_LABELS[lot.action]),
        csvEscape(lot.partId),
        csvEscape(lot.partDescription),
        csvNumber(lot.colorId),
        csvEscape(lot.colorName),
        csvNumber(lot.originalQuantity),
        csvNumber(lot.optimizedQuantity),
        // Signed, and negative on purpose: "buy 4 fewer" is -4. The direction is
        // also spelled out in the action column for anyone reading rather than
        // computing.
        csvNumber(lot.difference),
        csvNumber(lot.unitPrice, 2),
        csvNumber(lot.originalLineTotal, 2),
        csvNumber(lot.optimizedLineTotal, 2),
        csvNumber(lot.costDifference, 2),
      ].join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}

export type DeltaWantedListResult = WantedListBuildResult;

/**
 * The delta as a BrickLink Wanted List.
 *
 * The format cannot express a decrease: there is no negative MINQTY and no
 * removal element - a Wanted List says what you want, not what you no longer
 * want. So this contains ONLY the lots whose quantity went up. The lots that
 * went down are in the CSV, and the header says so at length, because a list of
 * parts is exactly the kind of file somebody opens later and treats as an order.
 *
 * Everything else - resolving to BrickLink ids, summing after resolution rather
 * than before, dropping what cancels out - is `buildWantedListFromLots`, shared
 * with the two complete lists so the three cannot disagree about what one lot is.
 */
export function buildInventoryDeltaWantedListXml(
  delta: InventoryDelta,
  catalog: CatalogService,
  condition: 'new' | 'used',
): DeltaWantedListResult {
  return buildWantedListFromLots(
    delta.lots.map((lot) => ({
      partId: lot.partId,
      colorId: lot.colorId,
      quantity: lot.difference,
    })),
    catalog,
    condition,
  );
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
