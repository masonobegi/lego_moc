/**
 * Optimizer 1: hidden color substitution.
 *
 * For a part that has no externally visible surface, the color it is moulded
 * in has no effect on the finished model's appearance, so it can be bought in
 * whatever color is cheapest. This is the core feature of the product.
 *
 * A substitution is only ever proposed when ALL of the following hold:
 *   1. Every physical instance produced by the line is hidden, at the
 *      confidence the chosen safety level demands.
 *   2. The line's color can actually be rewritten (not color 16 or 24).
 *   3. The replacement color is one the part has demonstrably been produced
 *      in, according to the catalog. A color we cannot evidence is never
 *      proposed, however cheap the price data says it would be.
 *   4. Transparency class is preserved. A transparent part is only ever swapped
 *      for another transparent color.
 *   5. Both the original and the replacement have a real price, and the
 *      replacement is genuinely cheaper.
 *
 * Anything that fails is recorded as a rejection with a reason, so the /dev
 * page and the results page can show WHY a part was left alone.
 */

import { colorName, isTransparentColor } from '../ldraw/colors';
import type { CatalogService } from '../catalog/types';
import type { PriceBook } from '../pricing/priceEngine';
import { round2 } from '../pricing/priceEngine';
import type { Condition } from '../pricing/types';
import type { CommandGroup } from './candidates';
import { colorChangeConfidence, consensusVisibility, isHiddenEnough } from './scoring';
import type {
  AlternativeOption,
  CandidateBlocker,
  ProposedChange,
  RejectedCommand,
  SafetyLevel,
} from './types';
import type { VisibilityResult } from './visibilityEngine';

/**
 * Colors worth evaluating as a cheap replacement.
 *
 * These are the high-volume production colors that are consistently the
 * cheapest and most available on the secondary market. Restricting the search
 * to them bounds the number of price lookups, which matters a great deal in
 * Live Mode where BrickLink allows 5,000 requests a day and has no bulk
 * endpoint. In Demo Mode there is no request cost, so every catalogd color
 * is evaluated instead.
 */
export const COMMON_CHEAP_COLORS: readonly number[] = [
  0,   // Black
  71,  // Light Bluish Gray
  72,  // Dark Bluish Gray
  15,  // White
  1,   // Blue
  14,  // Yellow
  70,  // Reddish Brown
  19,  // Tan
  2,   // Green
  4,   // Red
  25,  // Orange
  28,  // Dark Tan
];

/** Transparent equivalents of the shortlist. */
export const COMMON_CHEAP_TRANS_COLORS: readonly number[] = [47, 40, 36, 34, 33, 46, 57];

export interface ColorOptimizerInput {
  readonly groups: readonly CommandGroup[];
  readonly visibility: ReadonlyMap<string, VisibilityResult>;
  readonly catalog: CatalogService;
  readonly prices: PriceBook;
  readonly condition: Condition;
  readonly safetyLevel: SafetyLevel;
  readonly partDescriptions: ReadonlyMap<string, string | null>;
}

export interface ColorOptimizerOutput {
  readonly candidates: ProposedChange[];
  readonly rejected: RejectedCommand[];
  readonly hiddenCommandCount: number;
}

/**
 * Which colors should be priced so this group can be evaluated.
 * Called before the price book is built.
 */
export function alternativeColorsToPrice(
  group: CommandGroup,
  catalog: CatalogService,
  exhaustive: boolean,
): number[] {
  if (!group.isRecolorable || group.effectiveColorId === null) return [];
  const known = catalog.availableColors(group.partId);
  if (!known) return [];

  const wantTransparent = isTransparentColor(group.effectiveColorId);
  const shortlist = new Set(wantTransparent ? COMMON_CHEAP_TRANS_COLORS : COMMON_CHEAP_COLORS);

  return known
    .map((entry) => entry.colorId)
    .filter((colorId) => colorId !== group.effectiveColorId)
    .filter((colorId) => isTransparentColor(colorId) === wantTransparent)
    .filter((colorId) => exhaustive || shortlist.has(colorId));
}

export function findColorCandidates(input: ColorOptimizerInput): ColorOptimizerOutput {
  const candidates: ProposedChange[] = [];
  const rejected: RejectedCommand[] = [];
  let hiddenCommandCount = 0;

  for (const group of input.groups) {
    const blockers: CandidateBlocker[] = [];

    const results = group.instances
      .map((instance) => input.visibility.get(instance.instanceId))
      .filter((r): r is VisibilityResult => r !== undefined);

    const consensus = consensusVisibility(results);
    if (!consensus) {
      rejected.push(reject(group, ['geometry_unavailable']));
      continue;
    }

    const hidden = isHiddenEnough(consensus, input.safetyLevel);
    if (hidden) hiddenCommandCount++;

    if (!hidden) {
      blockers.push(results.length > 1 && new Set(results.map((r) => r.classification)).size > 1 ? 'mixed_visibility' : 'visible');
      rejected.push(reject(group, blockers));
      continue;
    }

    if (!group.isRecolorable || group.effectiveColorId === null) {
      blockers.push(
        group.declaredColorId === 16 ? 'inherited_color' : 'sentinel_color',
      );
      rejected.push(reject(group, blockers));
      continue;
    }

    const currentColor = group.effectiveColorId;
    const originalQuote = input.prices.get(group.partId, currentColor, input.condition);
    if (!originalQuote) {
      rejected.push(reject(group, ['no_price_for_original']));
      continue;
    }

    const known = input.catalog.availableColors(group.partId);
    if (!known) {
      rejected.push(reject(group, ['part_not_in_catalog']));
      continue;
    }

    const wantTransparent = isTransparentColor(currentColor);
    const options: AlternativeOption[] = [];

    for (const entry of known) {
      if (entry.colorId === currentColor) continue;
      if (isTransparentColor(entry.colorId) !== wantTransparent) continue;
      const quote = input.prices.get(group.partId, entry.colorId, input.condition);
      if (!quote) continue;
      const saving = round2((originalQuote.unitPrice - quote.unitPrice) * group.quantity);
      if (saving <= 0) continue;
      options.push({
        colorId: entry.colorId,
        colorName: colorName(entry.colorId),
        unitPrice: quote.unitPrice,
        saving,
        evidenceSets: entry.evidence.sets,
      });
    }

    if (options.length === 0) {
      rejected.push(reject(group, known.length > 1 ? ['no_cheaper_alternative'] : ['no_valid_alternative_color']));
      continue;
    }

    options.sort((a, b) => b.saving - a.saving);
    const best = options[0]!;
    const replacementQuote = input.prices.get(group.partId, best.colorId, input.condition)!;

    const confidence = colorChangeConfidence(consensus);
    const description = input.partDescriptions.get(group.partId) ?? group.partId;

    const evidence: string[] = [consensus.representativeEvidence];
    if (consensus.instanceCount > 1) {
      evidence.push(
        `This single line produces ${consensus.instanceCount} physical parts because its submodel is ` +
          `reused. All ${consensus.instanceCount} were checked and all are hidden.`,
      );
    }
    if (best.evidenceSets.length > 0) {
      evidence.push(
        `${description} exists in ${best.colorName}: observed in official set` +
          `${best.evidenceSets.length === 1 ? '' : 's'} ${best.evidenceSets.join(', ')}.`,
      );
    } else {
      evidence.push(
        `${description} in ${best.colorName} is listed in the ${input.catalog.status.label}.`,
      );
    }
    evidence.push(
      `Build step is unchanged: only the color field of the existing line is rewritten, so the ` +
        `part stays exactly where it is in step ${group.stepIndex + 1} of ${group.parentModel}.`,
    );

    candidates.push({
      id: `color:${group.key}`,
      kind: 'hidden_color',
      commandRef: group.commandRef,
      quantity: group.quantity,
      instanceIds: group.instances.map((i) => i.instanceId),
      parentModel: group.parentModel,
      stepIndex: group.stepIndex,
      partId: group.partId,
      partDescription: description,
      originalPartId: group.partId,
      originalColorId: currentColor,
      originalColorName: colorName(currentColor),
      replacementPartId: group.partId,
      replacementColorId: best.colorId,
      replacementColorName: best.colorName,
      originalUnitPrice: originalQuote.unitPrice,
      replacementUnitPrice: replacementQuote.unitPrice,
      originalTotal: round2(originalQuote.unitPrice * group.quantity),
      replacementTotal: round2(replacementQuote.unitPrice * group.quantity),
      savings: best.saving,
      reason: 'Completely hidden inside the completed model',
      confidence,
      visibility: {
        classification: consensus.worstClassification,
        confidence: consensus.minConfidence,
        totalRays: consensus.totalRays,
        trianglesCovered: consensus.trianglesCovered,
        trianglesTotal: consensus.trianglesTotal,
        evidence: consensus.representativeEvidence,
      },
      evidence,
      moldRule: null,
      alternatives: options.slice(1, 6),
      conflictsWith: [],
      enabledByDefault: true,
      originalQuote,
      replacementQuote,
    });
  }

  return { candidates, rejected, hiddenCommandCount };
}

function reject(group: CommandGroup, blockers: CandidateBlocker[]): RejectedCommand {
  return {
    commandRef: group.commandRef,
    partId: group.partId,
    colorId: group.effectiveColorId ?? group.declaredColorId,
    quantity: group.quantity,
    blockers,
  };
}
