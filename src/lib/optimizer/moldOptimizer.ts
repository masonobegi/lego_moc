/**
 * Optimizer 2: known-equivalent / mold substitution.
 *
 * Some elements exist in more than one mold and BrickLink sells them as
 * separate catalog items at different prices - the classic case being a tile
 * "with Groove" and "without Groove". Swapping the expensive mold for the cheap
 * one buys the same brick.
 *
 * The safety rules here are deliberately tighter than for color changes,
 * because a wrong mold substitution changes a physical object rather than just
 * its color:
 *
 *   1. The rule must come from a source we can name, with an explicit
 *      confidence, and must be marked geometryCompatible. Rules are never
 *      inferred from two parts merely having similar names.
 *   2. A rule whose appearanceImpact is anything other than `none` is only
 *      applied to parts the visibility engine says are hidden. A groove along
 *      the edge of a tile is a small difference, but it is a difference, and
 *      the promise of this product is that the exterior does not change.
 *   3. The replacement must exist in the SAME color, evidenced by the catalog.
 *   4. It must actually be cheaper.
 *
 * V1 never replaces one part with several and never changes how parts connect.
 */

import { colorName } from '../ldraw/colors';
import type { CatalogService, EquivalentPartRule } from '../catalog/types';
import { round2 } from '../pricing/priceEngine';
import type { PriceBook } from '../pricing/priceEngine';
import type { Condition } from '../pricing/types';
import type { CommandGroup } from './candidates';
import { consensusVisibility, isHiddenEnough, isMoldRuleAllowed, moldChangeConfidence } from './scoring';
import type {
  CandidateBlocker,
  ProposedChange,
  RejectedCommand,
  SafetyLevel,
} from './types';
import type { VisibilityResult } from './visibilityEngine';

export interface MoldOptimizerInput {
  readonly groups: readonly CommandGroup[];
  readonly visibility: ReadonlyMap<string, VisibilityResult>;
  readonly catalog: CatalogService;
  readonly prices: PriceBook;
  readonly condition: Condition;
  readonly safetyLevel: SafetyLevel;
  readonly partDescriptions: ReadonlyMap<string, string | null>;
}

export interface MoldOptimizerOutput {
  readonly candidates: ProposedChange[];
  readonly rejected: RejectedCommand[];
}

/** Replacement part ids whose price is needed to evaluate mold rules. */
export function moldPricesToRequest(
  groups: readonly CommandGroup[],
  catalog: CatalogService,
  safetyLevel: SafetyLevel,
): { partId: string; colorId: number }[] {
  const out = new Map<string, { partId: string; colorId: number }>();
  for (const group of groups) {
    if (group.effectiveColorId === null) continue;
    for (const rule of catalog.equivalents(group.partId)) {
      if (!isMoldRuleAllowed(rule, safetyLevel)) continue;
      if (!catalog.isKnownCombination(rule.replacementPart, group.effectiveColorId)) continue;
      const key = `${rule.replacementPart}|${group.effectiveColorId}`;
      out.set(key, { partId: rule.replacementPart, colorId: group.effectiveColorId });
    }
  }
  return [...out.values()];
}

export function findMoldCandidates(input: MoldOptimizerInput): MoldOptimizerOutput {
  const candidates: ProposedChange[] = [];
  const rejected: RejectedCommand[] = [];

  for (const group of input.groups) {
    if (group.effectiveColorId === null) continue;

    const rules = input.catalog.equivalents(group.partId);
    if (rules.length === 0) continue;

    const allowed = rules.filter((rule) => isMoldRuleAllowed(rule, input.safetyLevel));
    if (allowed.length === 0) {
      rejected.push(reject(group, ['rule_confidence_too_low']));
      continue;
    }

    const colorId = group.effectiveColorId;
    const originalQuote = input.prices.get(group.partId, colorId, input.condition);
    if (!originalQuote) {
      rejected.push(reject(group, ['no_price_for_original']));
      continue;
    }

    const results = group.instances
      .map((instance) => input.visibility.get(instance.instanceId))
      .filter((r): r is VisibilityResult => r !== undefined);
    const consensus = consensusVisibility(results);
    const hidden = consensus !== null && isHiddenEnough(consensus, input.safetyLevel);

    let best: { rule: EquivalentPartRule; unitPrice: number; saving: number } | null = null;
    const blockers = new Set<CandidateBlocker>();

    for (const rule of allowed) {
      if (rule.appearanceImpact !== 'none' && !hidden) {
        // The swap is only invisible if the part is invisible.
        blockers.add('visible');
        continue;
      }
      if (!input.catalog.isKnownCombination(rule.replacementPart, colorId)) {
        blockers.add('replacement_color_unavailable');
        continue;
      }
      const quote = input.prices.get(rule.replacementPart, colorId, input.condition);
      if (!quote) {
        blockers.add('replacement_color_unavailable');
        continue;
      }
      const saving = round2((originalQuote.unitPrice - quote.unitPrice) * group.quantity);
      if (saving <= 0) {
        blockers.add('replacement_not_cheaper');
        continue;
      }
      if (!best || saving > best.saving) best = { rule, unitPrice: quote.unitPrice, saving };
    }

    if (!best) {
      rejected.push(reject(group, [...blockers.values()]));
      continue;
    }

    const replacementQuote = input.prices.get(best.rule.replacementPart, colorId, input.condition)!;
    const confidence = moldChangeConfidence(hidden ? consensus : null, best.rule);
    const description = input.partDescriptions.get(group.partId) ?? group.partId;
    const replacementDescription =
      input.partDescriptions.get(best.rule.replacementPart) ?? best.rule.replacementPart;

    const evidence: string[] = [
      `${best.rule.note}`,
      `Rule source: ${best.rule.source}`,
      `Rule confidence ${(best.rule.confidence * 100).toFixed(0)}%, geometry compatible.`,
    ];
    if (best.rule.appearanceImpact !== 'none') {
      evidence.push(
        consensus
          ? `Because the two molds are not visually identical, this swap is only offered for parts the ` +
            `visibility engine classified as hidden. ${consensus.representativeEvidence}`
          : 'This swap is only offered for hidden parts.',
      );
    }
    evidence.push(
      `The replacement is catalogd in ${colorName(colorId)}, so the color does not change.`,
    );
    evidence.push(
      `Build step is unchanged: only the part reference on the existing line is rewritten.`,
    );

    candidates.push({
      id: `mold:${group.key}`,
      kind: 'mold_equivalent',
      commandRef: group.commandRef,
      quantity: group.quantity,
      instanceIds: group.instances.map((i) => i.instanceId),
      parentModel: group.parentModel,
      stepIndex: group.stepIndex,
      partId: group.partId,
      partDescription: description,
      originalPartId: group.partId,
      originalColorId: colorId,
      originalColorName: colorName(colorId),
      replacementPartId: best.rule.replacementPart,
      replacementColorId: colorId,
      replacementColorName: colorName(colorId),
      originalUnitPrice: originalQuote.unitPrice,
      replacementUnitPrice: best.unitPrice,
      originalTotal: round2(originalQuote.unitPrice * group.quantity),
      replacementTotal: round2(replacementQuote.unitPrice * group.quantity),
      savings: best.saving,
      reason: `Equivalent mold: ${description} to ${replacementDescription}`,
      confidence,
      visibility: {
        classification: consensus?.worstClassification ?? 'UNCERTAIN',
        confidence: consensus?.minConfidence ?? 0,
        totalRays: consensus?.totalRays ?? 0,
        trianglesCovered: consensus?.trianglesCovered ?? 0,
        trianglesTotal: consensus?.trianglesTotal ?? 0,
        evidence: consensus?.representativeEvidence ?? 'Visibility was not the deciding factor for this change.',
      },
      evidence,
      moldRule: best.rule,
      alternatives: [],
      conflictsWith: [],
      enabledByDefault: true,
      originalQuote,
      replacementQuote,
    });
  }

  return { candidates, rejected };
}

function reject(group: CommandGroup, blockers: CandidateBlocker[]): RejectedCommand {
  return {
    commandRef: group.commandRef,
    partId: group.partId,
    colorId: group.effectiveColorId ?? group.declaredColorId,
    quantity: group.quantity,
    blockers: blockers.length > 0 ? blockers : ['no_equivalent_rule'],
  };
}
