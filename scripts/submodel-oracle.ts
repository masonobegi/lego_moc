/**
 * Oracle: what is submodel splitting actually worth?
 *
 *   npx tsx scripts/submodel-oracle.ts <models-dir> [--parts-library <dir>] [--limit N] [--out FILE]
 *
 * The optimizer refuses to recolor a line when the submodel containing it is
 * used more than once and at least one copy is visible. Editing that line would
 * change every copy, so the refusal is correct - but it is also the single
 * largest category of pieces it declines to touch after "you can just see it".
 *
 * The obvious next feature is to split such submodels so the hidden copies can
 * be recolored independently. That is a structural rewrite of the model file:
 * it changes the build's sub-file layout, and therefore its instructions. Before
 * anyone spends weeks on it, this measures the ceiling.
 *
 * Method
 * ------
 * Run the real pipeline. For every command group where SOME instances are
 * hidden and some are not, construct a synthetic group containing only the
 * hidden instances - which is exactly what a perfect split would produce - and
 * hand it to the unmodified `findColorCandidates` and `applyPracticality`.
 *
 * Using the production functions rather than a re-implementation is the point.
 * The oracle is then bounded by the same colour-validity rules, the same safety
 * level, the same availability and minimum-saving rules as the shipped product,
 * so the number it produces is the ceiling for THIS product rather than for an
 * imaginary one.
 *
 * It is a genuine upper bound in one further respect: a perfect split is
 * assumed to be free. In reality splitting a submodel used four times turns one
 * sub-file into two or more, changes the instruction structure, and may not be
 * something a builder wants at all.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeModel, applyToInstances, computeSavings } from '../src/lib/analysis/pipeline';
import { NodePartSource } from '../src/lib/geometry/nodePartSource';
import { ChainedPartSource } from '../src/lib/geometry/partSource';
import type { CommandGroup } from '../src/lib/optimizer/candidates';
import { alternativeColorsToPrice, findColorCandidates } from '../src/lib/optimizer/colorOptimizer';
import { applyPracticality } from '../src/lib/optimizer/practicality';
import { buildPriceBook, calculateCost, type PriceRequest } from '../src/lib/pricing/priceEngine';
import { DemoPriceProvider } from '../src/lib/pricing/demoProvider';
import { getCatalog } from '../src/lib/runtime/services';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const modelsDir = process.argv[2];
if (!modelsDir || !existsSync(modelsDir)) {
  console.error('Usage: tsx scripts/submodel-oracle.ts <models-dir> [--parts-library <dir>] [--limit N] [--out FILE]');
  process.exit(1);
}

const partsLibraryArg = arg('--parts-library');
const libraries = [
  // Comma-separated, so a corpus prepared by normalize-inlined-parts.ts can
  // pass both the real library and its extracted-parts directory.
  ...(partsLibraryArg ? partsLibraryArg.split(',').map((d) => d.trim()).filter(Boolean) : []),
  path.join(process.cwd(), 'public', 'ldraw-full'),
  path.join(process.cwd(), 'public', 'ldraw'),
].filter((dir) => existsSync(dir));
const partSource = new ChainedPartSource(libraries.map((dir) => new NodePartSource(dir)));
const catalog = getCatalog();

const limit = Number(arg('--limit') ?? '0');
const outFile = arg('--out') ?? path.join(process.cwd(), 'docs', 'submodel-oracle-results.json');

const files = readdirSync(modelsDir).filter((f) => /\.(ldr|mpd)$/i.test(f)).sort();
const selected = limit > 0 ? files.slice(0, limit) : files;

interface Row {
  file: string;
  parts: number;
  originalCost: number;
  currentSavings: number;
  currentSavingsPercent: number;
  /** Pieces in command groups where some copies are hidden and some are not. */
  mixedPieces: number;
  /** Of those, the ones actually hidden - what a perfect split could reach. */
  mixedHiddenPieces: number;
  oracleAdditionalSavings: number;
  oracleAdditionalPercent: number;
  theoreticalTotal: number;
  theoreticalTotalPercent: number;
  seconds: number;
}

const rows: Row[] = [];
const failures: { file: string; error: string }[] = [];

console.log(`${selected.length} models from ${modelsDir}`);
console.log(`Parts library: ${libraries.join(', ')}\n`);

for (const [index, file] of selected.entries()) {
  const started = Date.now();
  try {
    const output = await analyzeModel({
      source: readFileSync(path.join(modelsDir, file), 'utf8'),
      fileName: file,
      partSource,
      catalog,
      priceProvider: new DemoPriceProvider(),
      condition: 'new',
      safetyLevel: 'extremely_conservative',
      exhaustiveColorSearch: true,
    });

    const { result, instances, visibility, groups, meshes } = output;
    const enabled = new Set(result.defaultEnabledIds);
    const optimized = calculateCost(
      applyToInstances(instances, result.candidates, enabled),
      output.prices,
      'new',
      result.pricing.currency,
    );
    const currentSavings = computeSavings(
      result.originalCost.total,
      optimized.total,
      result.candidates,
      enabled,
      result.pricing.currency,
    ).savings;

    // ---- the split ------------------------------------------------------
    const isHidden = (instanceId: string): boolean => {
      const verdict = visibility.get(instanceId);
      return verdict?.classification === 'HIDDEN' || verdict?.classification === 'LIKELY_HIDDEN';
    };

    let mixedPieces = 0;
    let mixedHiddenPieces = 0;
    const syntheticGroups: CommandGroup[] = [];

    for (const group of groups) {
      const hidden = group.instances.filter((i) => isHidden(i.instanceId));
      // Mixed means genuinely mixed: some hidden, some not. A group where every
      // instance is hidden is already handled by the shipped optimizer, and one
      // where none is hidden is simply visible.
      if (hidden.length === 0 || hidden.length === group.instances.length) continue;
      mixedPieces += group.instances.length;
      mixedHiddenPieces += hidden.length;
      syntheticGroups.push({
        ...group,
        key: `${group.key}#split`,
        instances: hidden,
        quantity: hidden.length,
      });
    }

    let oracleAdditionalSavings = 0;
    if (syntheticGroups.length > 0) {
      // The shipped pipeline prices alternative colors only for groups where
      // every copy is hidden, so nothing in the existing book covers these.
      const requests = new Map<string, PriceRequest>();
      const addRequest = (partId: string, colorId: number): void => {
        requests.set(`${partId}|${colorId}`, { partId, colorId });
      };
      for (const instance of instances) addRequest(instance.partId, instance.colorId);
      for (const group of syntheticGroups) {
        for (const colorId of alternativeColorsToPrice(group, catalog, true)) {
          addRequest(group.partId, colorId);
        }
      }
      const oraclePrices = await buildPriceBook(
        new DemoPriceProvider(),
        [...requests.values()],
        'new',
      );

      const partDescriptions = new Map<string, string | null>();
      for (const [partId, mesh] of meshes) partDescriptions.set(partId, mesh.description);
      for (const group of syntheticGroups) {
        if (!partDescriptions.has(group.partId)) partDescriptions.set(group.partId, null);
      }

      const found = findColorCandidates({
        groups: syntheticGroups,
        visibility,
        catalog,
        prices: oraclePrices,
        condition: 'new',
        safetyLevel: 'extremely_conservative',
        partDescriptions,
      });
      // Same practicality gate the product applies, so the ceiling is the
      // ceiling for this product and not for a more reckless one.
      const practical = applyPracticality(found.candidates);
      oracleAdditionalSavings =
        Math.round(practical.candidates.reduce((sum, c) => sum + c.savings, 0) * 100) / 100;
    }

    const originalCost = result.originalCost.total;
    const row: Row = {
      file,
      parts: result.model.partCount,
      originalCost: Math.round(originalCost * 100) / 100,
      currentSavings,
      currentSavingsPercent: originalCost > 0 ? Math.round((currentSavings / originalCost) * 1000) / 10 : 0,
      mixedPieces,
      mixedHiddenPieces,
      oracleAdditionalSavings,
      oracleAdditionalPercent:
        originalCost > 0 ? Math.round((oracleAdditionalSavings / originalCost) * 1000) / 10 : 0,
      theoreticalTotal: Math.round((currentSavings + oracleAdditionalSavings) * 100) / 100,
      theoreticalTotalPercent:
        originalCost > 0
          ? Math.round(((currentSavings + oracleAdditionalSavings) / originalCost) * 1000) / 10
          : 0,
      seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    };
    rows.push(row);
    console.log(
      `[${String(index + 1).padStart(3)}/${selected.length}] ${file.slice(0, 40).padEnd(41)} ` +
        `${String(row.parts).padStart(5)}p  now $${row.currentSavings.toFixed(2).padStart(7)}  ` +
        `+oracle $${row.oracleAdditionalSavings.toFixed(2).padStart(7)}  ` +
        `= $${row.theoreticalTotal.toFixed(2).padStart(7)} (${row.theoreticalTotalPercent.toFixed(1)}%)  ` +
        `mixedHidden ${String(row.mixedHiddenPieces).padStart(4)}  ${row.seconds.toFixed(0)}s`,
    );
  } catch (error) {
    failures.push({ file, error: (error as Error).message });
    console.log(`[${String(index + 1).padStart(3)}/${selected.length}] ${file.slice(0, 40).padEnd(41)} FAILED: ${(error as Error).message}`);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const totalOriginal = rows.reduce((a, r) => a + r.originalCost, 0);
const totalCurrent = rows.reduce((a, r) => a + r.currentSavings, 0);
const totalOracle = rows.reduce((a, r) => a + r.oracleAdditionalSavings, 0);

const summary = {
  generatedAt: new Date().toISOString(),
  corpus: { directory: modelsDir, modelsAnalyzed: rows.length },
  priceSource: 'demo',
  totalOriginalCost: Math.round(totalOriginal * 100) / 100,
  totalCurrentSavings: Math.round(totalCurrent * 100) / 100,
  totalOracleAdditionalSavings: Math.round(totalOracle * 100) / 100,
  totalTheoretical: Math.round((totalCurrent + totalOracle) * 100) / 100,
  currentSavingsPercentOfCorpus: totalOriginal > 0 ? Math.round((totalCurrent / totalOriginal) * 1000) / 10 : 0,
  theoreticalPercentOfCorpus:
    totalOriginal > 0 ? Math.round(((totalCurrent + totalOracle) / totalOriginal) * 1000) / 10 : 0,
  medianCurrentSavings: Math.round(median(rows.map((r) => r.currentSavings)) * 100) / 100,
  medianOracleAdditional: Math.round(median(rows.map((r) => r.oracleAdditionalSavings)) * 100) / 100,
  medianTheoreticalTotal: Math.round(median(rows.map((r) => r.theoreticalTotal)) * 100) / 100,
  medianTheoreticalPercent: median(rows.map((r) => r.theoreticalTotalPercent)),
  modelsWhereOracleAddsOver5: rows.filter((r) => r.oracleAdditionalSavings > 5).length,
  modelsWhereOracleAddsOver20: rows.filter((r) => r.oracleAdditionalSavings > 20).length,
  modelsWhereOracleAddsNothing: rows.filter((r) => r.oracleAdditionalSavings === 0).length,
  totalMixedHiddenPieces: rows.reduce((a, r) => a + r.mixedHiddenPieces, 0),
  failures,
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2));

console.log('\n=== oracle ===');
for (const [key, value] of Object.entries(summary)) {
  if (key === 'failures' || key === 'corpus') continue;
  console.log(`  ${key.padEnd(34)} ${JSON.stringify(value)}`);
}
console.log(`\nWritten to ${outFile}`);
