/**
 * Turns evidence into the confidence number shown next to a change, and decides
 * whether a candidate is safe enough to be enabled by default.
 *
 * There is exactly one rule here that matters: a change is enabled by default
 * only when every piece of evidence supporting it clears the threshold for the
 * chosen safety level. A false positive - recolouring a brick that turns out to
 * be visible - is far worse than a missed saving, so everything is biased
 * towards not acting.
 */

import type { EquivalentPartRule } from '../catalog/types';
import { SAFETY_LEVELS, type SafetyLevel } from './types';
import { VISIBILITY_ORDER, type VisibilityClass, type VisibilityResult } from './visibilityEngine';

export interface VisibilityConsensus {
  /** The WEAKEST verdict across every instance the command produces. */
  readonly worstClassification: VisibilityClass;
  readonly minConfidence: number;
  readonly totalRays: number;
  readonly trianglesCovered: number;
  readonly trianglesTotal: number;
  readonly representativeEvidence: string;
  readonly instanceCount: number;
}

/**
 * Combine the per-instance verdicts for one command.
 *
 * The command as a whole is only as safe as its least hidden instance: if a
 * submodel is used twice and one copy is on the outside of the model, the line
 * must not be touched. That is the `multiple-instances.mpd` fixture.
 */
export function consensusVisibility(results: readonly VisibilityResult[]): VisibilityConsensus | null {
  if (results.length === 0) return null;

  let worst = results[0]!;
  let minConfidence = 1;
  let totalRays = 0;
  let trianglesCovered = Number.POSITIVE_INFINITY;
  let trianglesTotal = 0;

  for (const result of results) {
    if (VISIBILITY_ORDER[result.classification] < VISIBILITY_ORDER[worst.classification]) {
      worst = result;
    }
    minConfidence = Math.min(minConfidence, result.confidence);
    totalRays += result.raysCast;
    trianglesCovered = Math.min(trianglesCovered, result.trianglesCovered);
    trianglesTotal = Math.max(trianglesTotal, result.trianglesTotal);
  }

  return {
    worstClassification: worst.classification,
    minConfidence,
    totalRays,
    trianglesCovered: Number.isFinite(trianglesCovered) ? trianglesCovered : 0,
    trianglesTotal,
    representativeEvidence: worst.evidence,
    instanceCount: results.length,
  };
}

export function isHiddenEnough(consensus: VisibilityConsensus, level: SafetyLevel): boolean {
  const config = SAFETY_LEVELS[level];
  if (!config.allowedVisibility.includes(consensus.worstClassification)) return false;
  return consensus.minConfidence >= config.minConfidence;
}

/**
 * Confidence for a colour substitution.
 *
 * The number is the visibility confidence, which is itself derived from the ray
 * count by the rule of three, tempered slightly when more than one physical
 * instance rides on the same line (more instances, more ways to be wrong).
 */
export function colorChangeConfidence(consensus: VisibilityConsensus): number {
  const instancePenalty = consensus.instanceCount > 1 ? 0.999 ** (consensus.instanceCount - 1) : 1;
  return clamp01(consensus.minConfidence * instancePenalty);
}

/**
 * Confidence for a mold substitution: the visibility confidence and the rule's
 * own confidence multiplied, because both have to hold.
 */
export function moldChangeConfidence(
  consensus: VisibilityConsensus | null,
  rule: EquivalentPartRule,
): number {
  const visibility = consensus ? colorChangeConfidence(consensus) : 1;
  return clamp01(visibility * rule.confidence);
}

export function isMoldRuleAllowed(rule: EquivalentPartRule, level: SafetyLevel): boolean {
  if (!rule.geometryCompatible) return false;
  return rule.confidence >= SAFETY_LEVELS[level].minMoldConfidence;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Percentage string used throughout the UI, e.g. "99.85%". */
export function formatConfidence(value: number): string {
  if (value >= 0.9999) return '99.99%';
  return `${(value * 100).toFixed(2)}%`;
}
