/**
 * The analysis pipeline.
 *
 * Everything the product does runs through here, in the order the UI reports:
 *   parse -> resolve -> geometry -> visibility -> prices -> colors -> molds -> savings
 *
 * There is no shortcut and no special case for the built-in fixtures: the /dev
 * page loads a fixture from disk and hands it to this same function that an
 * upload goes through.
 */

import { randomUUID } from 'node:crypto';

import type { CatalogService } from '../catalog/types';
import type { PartSource } from '../geometry/partSource';
import { PartMeshLibrary, type PartMesh } from '../geometry/partMesh';
import { ModelScene } from '../geometry/scene';
import { parseLDraw } from '../ldraw/parser';
import { resolveModel, summarizeModel } from '../ldraw/resolve';
import type { LDrawDocument, PartInstance } from '../ldraw/types';
import { sanitizeText } from '../security/limits';
import { buildPriceBook, calculateCost, round2, type PriceBook, type PriceRequest } from '../pricing/priceEngine';
import type { Condition, PriceProvider } from '../pricing/types';
import { isSizeAware, type PartSizeHint } from '../pricing/types';
import { groupInstancesByCommand, type CommandGroup } from '../optimizer/candidates';
import { alternativeColorsToPrice, findColorCandidates } from '../optimizer/colorOptimizer';
import { findMoldCandidates, moldPricesToRequest } from '../optimizer/moldOptimizer';
import type { OptimizationCandidate, RejectedCommand, SafetyLevel } from '../optimizer/types';
import {
  optionsForModelSize,
  type VisibilityClass,
  type VisibilityResult,
} from '../optimizer/visibilityEngine';
import { analyzeVisibilityParallel } from '../optimizer/visibilityParallel';
import type {
  AnalysisResult,
  AnalysisStage,
  RejectionSummary,
  SavingsSummary,
} from './types';

const BLOCKER_LABELS: Record<string, string> = {
  visible: 'Visible from outside the finished model',
  mixed_visibility: 'Reused submodel where at least one copy is visible',
  inherited_color: 'Drawn in LDraw color 16, so its color comes from its parent',
  sentinel_color: 'Uses a color that is not a purchasable element color',
  no_price_for_original: 'No price available for the part in its current color',
  no_cheaper_alternative: 'Hidden, but no catalogd color is cheaper',
  part_not_in_catalog: 'Part is not in the color catalog, so no alternative can be evidenced',
  no_valid_alternative_color: 'No alternative color is evidenced for this part',
  no_equivalent_rule: 'No verified equivalent-mold rule for this part',
  rule_confidence_too_low: 'An equivalent-mold rule exists but is below the confidence threshold',
  replacement_color_unavailable: 'The equivalent mold is not catalogd in this color',
  replacement_not_cheaper: 'The equivalent mold is not cheaper',
  geometry_unavailable: 'No LDraw geometry available, so visibility could not be assessed',
};

export interface AnalyzeOptions {
  readonly source: string;
  readonly fileName: string;
  readonly partSource: PartSource;
  readonly catalog: CatalogService;
  readonly priceProvider: PriceProvider;
  readonly condition: Condition;
  readonly safetyLevel: SafetyLevel;
  /** Demo mode has no per-request cost, so every catalogd color is evaluated. */
  readonly exhaustiveColorSearch: boolean;
  readonly onStage?: (stage: AnalysisStage, detail?: string) => void;
  readonly id?: string;
  /** Forces the visibility pass in-process. Used by tests that compare paths. */
  readonly singleThreaded?: boolean;
}

export interface AnalyzeOutput {
  readonly result: AnalysisResult;
  /** Kept in memory for the viewer and the exports; not part of the JSON report. */
  readonly document: LDrawDocument;
  readonly instances: readonly PartInstance[];
  readonly meshes: ReadonlyMap<string, PartMesh>;
  readonly scene: ModelScene;
  readonly visibility: ReadonlyMap<string, VisibilityResult>;
  readonly prices: PriceBook;
  readonly groups: readonly CommandGroup[];
}

export async function analyzeModel(options: AnalyzeOptions): Promise<AnalyzeOutput> {
  const started = Date.now();
  const timings = {} as Record<AnalysisStage, number>;
  const mark = <T>(stage: AnalysisStage, fn: () => T): T => {
    options.onStage?.(stage);
    const t0 = Date.now();
    const value = fn();
    timings[stage] = Date.now() - t0;
    return value;
  };
  const markAsync = async <T>(stage: AnalysisStage, fn: () => Promise<T>): Promise<T> => {
    options.onStage?.(stage);
    const t0 = Date.now();
    const value = await fn();
    timings[stage] = Date.now() - t0;
    return value;
  };

  // ---- 1. parse ----------------------------------------------------------
  const document = mark('parsing', () => parseLDraw(options.source, { sourceName: options.fileName }));

  // ---- 2. resolve --------------------------------------------------------
  const resolved = mark('resolving', () => resolveModel(document));
  const summary = summarizeModel(resolved);
  const instances = resolved.instances;

  // ---- 3. geometry -------------------------------------------------------
  const meshLibrary = new PartMeshLibrary(options.partSource);
  const meshes = new Map<string, PartMesh>();
  const missingByPart = new Map<string, { partId: string; reference: string; count: number }>();

  const scene = await markAsync('geometry', async () => {
    const distinct = new Map<string, string>();
    for (const instance of instances) {
      if (!distinct.has(instance.partId)) distinct.set(instance.partId, instance.partFile);
    }
    for (const [partId, reference] of distinct) {
      const mesh = await meshLibrary.get(reference);
      meshes.set(partId, mesh);
    }
    for (const instance of instances) {
      const mesh = meshes.get(instance.partId);
      if (!mesh || mesh.triangleCount === 0) {
        const existing = missingByPart.get(instance.partId);
        if (existing) existing.count++;
        else
          missingByPart.set(instance.partId, {
            partId: instance.partId,
            reference: instance.partFile,
            count: 1,
          });
      }
    }
    return new ModelScene(instances, meshes);
  });

  // ---- 4. visibility -----------------------------------------------------
  const visibilityOptions = optionsForModelSize(instances.length);
  const targets = scene.visibilityTargets(instances);
  const visibilityAnalysis = await markAsync('visibility', () =>
    analyzeVisibilityParallel(scene, targets, meshes, visibilityOptions, {
      forceSingleThread: options.singleThreaded,
    }),
  );
  const visibility = visibilityAnalysis.results;

  const visibilityCounts: Record<VisibilityClass, number> = {
    VISIBLE: 0,
    LIKELY_VISIBLE: 0,
    UNCERTAIN: 0,
    LIKELY_HIDDEN: 0,
    HIDDEN: 0,
  };
  for (const result of visibility.values()) visibilityCounts[result.classification]++;

  // ---- 5. prices ---------------------------------------------------------
  const groups = groupInstancesByCommand(instances);

  if (isSizeAware(options.priceProvider)) {
    const hints = new Map<string, PartSizeHint>();
    for (const [partId, mesh] of meshes) {
      if (mesh.triangleCount === 0) continue;
      const size = {
        x: mesh.bounds.max.x - mesh.bounds.min.x,
        y: mesh.bounds.max.y - mesh.bounds.min.y,
        z: mesh.bounds.max.z - mesh.bounds.min.z,
      };
      hints.set(partId, {
        volume: Math.max(0, size.x) * Math.max(0, size.y) * Math.max(0, size.z),
        triangleCount: mesh.triangleCount,
      });
    }
    options.priceProvider.setSizeHints(hints);
  }

  const requests = new Map<string, PriceRequest>();
  const addRequest = (partId: string, colorId: number): void => {
    requests.set(`${partId}|${colorId}`, { partId, colorId });
  };
  for (const instance of instances) addRequest(instance.partId, instance.colorId);

  // Alternative colors, but only for commands that are actually hidden -
  // there is no point pricing alternatives for a brick we will never change.
  const hiddenGroups = groups.filter((group) =>
    group.instances.every((instance) => {
      const result = visibility.get(instance.instanceId);
      return result?.classification === 'HIDDEN' || result?.classification === 'LIKELY_HIDDEN';
    }),
  );
  for (const group of hiddenGroups) {
    for (const colorId of alternativeColorsToPrice(group, options.catalog, options.exhaustiveColorSearch)) {
      addRequest(group.partId, colorId);
    }
  }
  for (const request of moldPricesToRequest(groups, options.catalog, options.safetyLevel)) {
    addRequest(request.partId, request.colorId);
  }

  const prices = await markAsync('pricing', () =>
    buildPriceBook(options.priceProvider, [...requests.values()], options.condition),
  );

  const partDescriptions = new Map<string, string | null>();
  for (const [partId, mesh] of meshes) partDescriptions.set(partId, mesh.description);
  for (const group of groups) {
    if (!partDescriptions.has(group.partId)) partDescriptions.set(group.partId, null);
  }
  // Descriptions for mold replacement parts, which are not in the model.
  for (const group of groups) {
    for (const rule of options.catalog.equivalents(group.partId)) {
      if (partDescriptions.has(rule.replacementPart)) continue;
      const mesh = await meshLibrary.get(`${rule.replacementPart}.dat`);
      partDescriptions.set(rule.replacementPart, mesh.description);
    }
  }

  // ---- 6. colors --------------------------------------------------------
  const colorOutput = mark('colors', () =>
    findColorCandidates({
      groups,
      visibility,
      catalog: options.catalog,
      prices,
      condition: options.condition,
      safetyLevel: options.safetyLevel,
      partDescriptions,
    }),
  );

  // ---- 7. molds ----------------------------------------------------------
  const moldOutput = mark('molds', () =>
    findMoldCandidates({
      groups,
      visibility,
      catalog: options.catalog,
      prices,
      condition: options.condition,
      safetyLevel: options.safetyLevel,
      partDescriptions,
    }),
  );

  // ---- 8. savings --------------------------------------------------------
  const candidates = mark('savings', () => {
    const all = [...colorOutput.candidates, ...moldOutput.candidates];
    return resolveConflicts(all);
  });

  const currency = firstCurrency(prices) ?? 'USD';
  const originalCost = calculateCost(instances, prices, options.condition, currency);

  const rejections = summarizeRejections([...colorOutput.rejected, ...moldOutput.rejected]);

  const rootFile = document.files.find((f) => f.name === document.rootFile) ?? document.files[0];
  const title = sanitizeText(rootFile?.description ?? rootFile?.headerName ?? options.fileName, 120);
  const author = rootFile?.author ? sanitizeText(rootFile.author, 80) : null;

  const providerDiagnostics = (options.priceProvider as { diagnostics?: { verifiedLive: boolean; failures: readonly string[] } })
    .diagnostics;

  const pricingNotes: string[] = [];
  if (options.priceProvider.id === 'demo') {
    pricingNotes.push(
      'Demo prices are a synthetic dataset built into the app. They are not real BrickLink prices.',
    );
  } else {
    pricingNotes.push(
      'Estimated market parts cost from the BrickLink Price Guide. Excludes shipping, seller ' +
        'minimums, lot availability and tax.',
    );
    if (providerDiagnostics && !providerDiagnostics.verifiedLive) {
      pricingNotes.push(
        'No successful BrickLink response yet in this session. Check that the credentials are ' +
          'correct and that the server IP is registered with BrickLink.',
      );
    }
  }
  if (originalCost.unpricedLots.length > 0) {
    pricingNotes.push(
      `${originalCost.unpricedLots.length} lot${originalCost.unpricedLots.length === 1 ? '' : 's'} ` +
        `(${originalCost.unpricedPieceCount} piece${originalCost.unpricedPieceCount === 1 ? '' : 's'}) ` +
        `could not be priced and are excluded from both totals.`,
    );
  }

  const result: AnalysisResult = {
    id: options.id ?? randomUUID(),
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    model: {
      fileName: options.fileName,
      title: title || options.fileName,
      author,
      isMpd: document.isMpd,
      partCount: summary.partCount,
      uniqueLotCount: summary.uniqueLotCount,
      uniquePartCount: summary.uniquePartCount,
      stepCount: summary.stepCount,
      submodelCount: summary.submodelCount,
      byteSize: Buffer.byteLength(options.source, 'utf8'),
    },
    parse: {
      warnings: [...document.warnings, ...resolved.warnings],
      malformedLineCount: document.warnings.filter((w) => w.code === 'malformed_line').length,
      unresolvedSubmodels: resolved.unresolvedSubmodels,
      truncated: resolved.truncated,
      truncationReason: resolved.truncationReason,
    },
    geometry: {
      distinctPartCount: scene.stats.distinctPartCount,
      totalTriangles: scene.stats.totalTriangles,
      sceneBuildMs: scene.stats.buildMs,
      missingParts: [...missingByPart.values()].sort((a, b) => b.count - a.count),
      incompletePartCount: [...meshes.values()].filter(
        (m) => m.truncated || m.missingReferences.length > 0,
      ).length,
    },
    visibility: {
      counts: visibilityCounts,
      totalRays: visibilityAnalysis.stats.totalRays,
      verifiedInstances: visibilityAnalysis.stats.verifiedInstances,
      elapsedMs: visibilityAnalysis.stats.elapsedMs,
      workerCount: visibilityAnalysis.workerCount,
      scope:
        'Visibility is assessed against the completed model exactly as supplied. Detachable ' +
        'sections, hinged panels and partly built states are not modeled.',
    },
    pricing: {
      sourceId: options.priceProvider.id,
      sourceLabel: options.priceProvider.label,
      isLive: options.priceProvider.isLive,
      isDemoData: options.priceProvider.id === 'demo',
      condition: options.condition,
      currency,
      requested: prices.stats.requested,
      resolved: prices.stats.resolved,
      unresolved: prices.stats.unresolved,
      elapsedMs: prices.stats.elapsedMs,
      liveVerified: providerDiagnostics ? providerDiagnostics.verifiedLive : null,
      liveFailures: providerDiagnostics?.failures ?? [],
      notes: pricingNotes,
    },
    catalog: options.catalog.status,
    safetyLevel: options.safetyLevel,
    originalCost,
    candidates,
    defaultEnabledIds: candidates.filter((c) => c.enabledByDefault).map((c) => c.id),
    rejections,
    timings,
    totalMs: Date.now() - started,
  };

  return { result, document, instances, meshes, scene, visibility, prices, groups };
}

/**
 * Two candidates that would rewrite the same line cannot both be enabled.
 * They are both kept so the user can choose, but they are marked as conflicting
 * and only the larger saving is on by default.
 */
function resolveConflicts(candidates: OptimizationCandidate[]): OptimizationCandidate[] {
  const byCommand = new Map<string, OptimizationCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.commandRef.fileIndex}:${candidate.commandRef.commandIndex}`;
    const list = byCommand.get(key);
    if (list) list.push(candidate);
    else byCommand.set(key, [candidate]);
  }

  const out: OptimizationCandidate[] = [];
  for (const list of byCommand.values()) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    list.sort((a, b) => b.savings - a.savings);
    list.forEach((candidate, index) => {
      out.push({
        ...candidate,
        conflictsWith: list.filter((c) => c.id !== candidate.id).map((c) => c.id),
        enabledByDefault: index === 0,
      });
    });
  }

  out.sort((a, b) => b.savings - a.savings || a.id.localeCompare(b.id));
  return out;
}

function summarizeRejections(rejected: readonly RejectedCommand[]): RejectionSummary[] {
  const counts = new Map<string, { commands: number; pieces: number }>();
  for (const item of rejected) {
    for (const blocker of item.blockers) {
      const entry = counts.get(blocker) ?? { commands: 0, pieces: 0 };
      entry.commands++;
      entry.pieces += item.quantity;
      counts.set(blocker, entry);
    }
  }
  return [...counts.entries()]
    .map(([reason, entry]) => ({
      reason,
      label: BLOCKER_LABELS[reason] ?? reason,
      commandCount: entry.commands,
      pieceCount: entry.pieces,
    }))
    .sort((a, b) => b.pieceCount - a.pieceCount);
}

function firstCurrency(prices: PriceBook): string | null {
  for (const [, quote] of prices.entries()) {
    if (quote) return quote.currency;
  }
  return null;
}

/**
 * Apply the enabled changes to the flattened instance list, so the optimized
 * cost is calculated exactly the same way the original one was rather than by
 * subtracting savings (which would drift by a cent or two through rounding).
 */
export function applyToInstances(
  instances: readonly PartInstance[],
  candidates: readonly OptimizationCandidate[],
  enabledIds: ReadonlySet<string>,
): PartInstance[] {
  const byInstance = new Map<string, OptimizationCandidate>();
  const usedCommands = new Set<string>();
  for (const candidate of candidates) {
    if (!enabledIds.has(candidate.id)) continue;
    const commandKey = `${candidate.commandRef.fileIndex}:${candidate.commandRef.commandIndex}`;
    if (usedCommands.has(commandKey)) continue;
    usedCommands.add(commandKey);
    for (const instanceId of candidate.instanceIds) byInstance.set(instanceId, candidate);
  }

  return instances.map((instance) => {
    const candidate = byInstance.get(instance.instanceId);
    if (!candidate) return instance;
    return {
      ...instance,
      partId: candidate.replacementPartId,
      colorId: candidate.replacementColorId,
      declaredColorId: candidate.replacementColorId,
    };
  });
}

export function computeSavings(
  originalTotal: number,
  optimizedTotal: number,
  candidates: readonly OptimizationCandidate[],
  enabledIds: ReadonlySet<string>,
  currency: string,
): SavingsSummary {
  const enabled = candidates.filter((c) => enabledIds.has(c.id));
  const savings = round2(originalTotal - optimizedTotal);
  return {
    originalCost: round2(originalTotal),
    optimizedCost: round2(optimizedTotal),
    savings,
    savingsPercent: originalTotal > 0 ? round2((savings / originalTotal) * 100) : 0,
    currency,
    candidateCount: candidates.length,
    enabledCount: enabled.length,
    disabledCount: candidates.length - enabled.length,
    changedPieceCount: enabled.reduce((sum, c) => sum + c.quantity, 0),
    uniqueSubstitutionCount: new Set(
      enabled.map(
        (c) => `${c.originalPartId}|${c.originalColorId}>${c.replacementPartId}|${c.replacementColorId}`,
      ),
    ).size,
  };
}

export { BLOCKER_LABELS };
