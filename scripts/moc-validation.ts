/**
 * Community-MOC validation, reported separately from the official-set baseline.
 *
 *   npx tsx scripts/moc-validation.ts <models-dir> --metadata <file.json> \
 *     [--parts-library <dir>] [--baseline docs/validation-results.json] [--out FILE]
 *
 * The optimizer is not touched. This runs the same pipeline, at the same safety
 * level, with the same price source as the official-set study, so the two
 * populations are measured by identical code and can be compared.
 *
 * The population statistics for the baseline are recomputed here from that
 * study's per-model rows rather than copied from its summary, so both sides of
 * every comparison come out of the same function. A difference between the two
 * columns is then a difference between the model populations, not between two
 * slightly different definitions of "median".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeModel, applyToInstances, computeSavings } from '../src/lib/analysis/pipeline';
import { NodePartSource } from '../src/lib/geometry/nodePartSource';
import { ChainedPartSource } from '../src/lib/geometry/partSource';
import { calculateCost } from '../src/lib/pricing/priceEngine';
import { DemoPriceProvider } from '../src/lib/pricing/demoProvider';
import { getCatalog } from '../src/lib/runtime/services';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

interface ModelMetadata {
  file: string;
  name: string;
  source: string;
  designer: string | null;
  category: string;
  fileType: string;
  note?: string;
}

interface Row {
  file: string;
  name: string;
  source: string;
  designer: string | null;
  category: string;
  fileType: string;
  parts: number;
  originalCost: number;
  optimizedCost: number;
  savings: number;
  savingsPercent: number;
  highConfidenceSavings: number;
  hiddenPieces: number;
  hiddenPiecePercent: number;
  safeSubstitutions: number;
  changedPieces: number;
  savingsPerChangedPiece: number | null;
  seconds: number;
}

/** Everything the brief asks for about one population. */
function describe(rows: readonly {
  savings: number;
  savingsPercent: number;
  parts: number;
  hiddenPiecePercent: number;
  changedPieces: number;
  highConfidenceSavings: number;
}[]) {
  const n = rows.length;
  if (n === 0) return null;
  const savings = rows.map((r) => r.savings).sort((a, b) => a - b);
  const percents = rows.map((r) => r.savingsPercent).sort((a, b) => a - b);
  const hidden = rows.map((r) => r.hiddenPiecePercent).sort((a, b) => a - b);

  const q = (sorted: number[], p: number): number => {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const value = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
    return Math.round(value * 100) / 100;
  };
  const share = (predicate: (r: (typeof rows)[number]) => boolean): number =>
    Math.round((rows.filter(predicate).length / n) * 1000) / 10;
  const mean = (values: number[]): number =>
    Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

  return {
    models: n,
    medianSavings: q(savings, 0.5),
    meanSavings: mean(savings),
    medianSavingsPercent: q(percents, 0.5),
    meanSavingsPercent: mean(percents),
    savingsPercentile25: q(savings, 0.25),
    savingsPercentile75: q(savings, 0.75),
    savingsPercentile90: q(savings, 0.9),
    percentPercentile25: q(percents, 0.25),
    percentPercentile75: q(percents, 0.75),
    percentPercentile90: q(percents, 0.9),
    shareZeroSavings: share((r) => r.savings === 0),
    shareOver5: share((r) => r.savings > 5),
    shareOver10: share((r) => r.savings > 10),
    shareOver20: share((r) => r.savings > 20),
    shareOver50: share((r) => r.savings > 50),
    shareAtLeast5Percent: share((r) => r.savingsPercent >= 5),
    shareAtLeast10Percent: share((r) => r.savingsPercent >= 10),
    shareAtLeast20Percent: share((r) => r.savingsPercent >= 20),
    medianHiddenPiecePercent: q(hidden, 0.5),
    meanHiddenPiecePercent: mean(hidden),
    totalHighConfidenceSavings: Math.round(rows.reduce((a, r) => a + r.highConfidenceSavings, 0) * 100) / 100,
  };
}

function segmentBySize<T extends { parts: number }>(rows: readonly T[]) {
  const bands: { label: string; min: number; max: number }[] = [
    { label: 'small (<250 parts)', min: 0, max: 249 },
    { label: 'medium (250-999)', min: 250, max: 999 },
    { label: 'large (1000-2999)', min: 1000, max: 2999 },
    { label: 'very large (3000+)', min: 3000, max: Infinity },
  ];
  return bands.map((band) => ({
    band: band.label,
    ...(describe(rows.filter((r) => r.parts >= band.min && r.parts <= band.max) as never) ?? { models: 0 }),
  }));
}

// ---------------------------------------------------------------------------

const modelsDir = process.argv[2];
const metadataFile = arg('--metadata');
if (!modelsDir || !existsSync(modelsDir)) {
  console.error('Usage: tsx scripts/moc-validation.ts <models-dir> --metadata <file.json> [...]');
  process.exit(1);
}

const metadata: ModelMetadata[] = metadataFile
  ? (JSON.parse(readFileSync(metadataFile, 'utf8')) as ModelMetadata[])
  : [];
const metaByFile = new Map(metadata.map((m) => [m.file, m]));

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

const outFile = arg('--out') ?? path.join(process.cwd(), 'docs', 'moc-validation-results.json');
const baselineFile = arg('--baseline') ?? path.join(process.cwd(), 'docs', 'validation-results.json');

const files = readdirSync(modelsDir).filter((f) => /\.(ldr|mpd)$/i.test(f)).sort();
console.log(`${files.length} community models from ${modelsDir}\n`);

const rows: Row[] = [];
const failures: { file: string; error: string }[] = [];

for (const [index, file] of files.entries()) {
  const started = Date.now();
  const meta = metaByFile.get(file);
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
    const result = output.result;
    const enabled = new Set(result.defaultEnabledIds);
    const optimized = calculateCost(
      applyToInstances(output.instances, result.candidates, enabled),
      output.prices,
      'new',
      result.pricing.currency,
    );
    const savings = computeSavings(
      result.originalCost.total,
      optimized.total,
      result.candidates,
      enabled,
      result.pricing.currency,
    );
    const hidden = result.visibility.counts.HIDDEN + result.visibility.counts.LIKELY_HIDDEN;
    const parts = result.model.partCount;

    const row: Row = {
      file,
      name: meta?.name ?? file,
      source: meta?.source ?? 'unknown',
      designer: meta?.designer ?? null,
      category: meta?.category ?? 'unknown',
      fileType: meta?.fileType ?? path.extname(file).slice(1),
      parts,
      originalCost: savings.originalCost,
      optimizedCost: savings.optimizedCost,
      savings: savings.savings,
      savingsPercent: savings.savingsPercent,
      highConfidenceSavings: savings.highConfidenceSavings,
      hiddenPieces: hidden,
      hiddenPiecePercent: parts > 0 ? Math.round((hidden / parts) * 1000) / 10 : 0,
      safeSubstitutions: savings.candidateCount,
      changedPieces: savings.changedPieceCount,
      savingsPerChangedPiece:
        savings.changedPieceCount > 0
          ? Math.round((savings.savings / savings.changedPieceCount) * 1000) / 1000
          : null,
      seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    };
    rows.push(row);
    console.log(
      `[${index + 1}/${files.length}] ${row.name.slice(0, 34).padEnd(35)} ${String(row.parts).padStart(5)}p  ` +
        `$${row.originalCost.toFixed(2).padStart(8)}  save $${row.savings.toFixed(2).padStart(7)} ` +
        `(${row.savingsPercent.toFixed(2).padStart(5)}%)  hidden ${row.hiddenPiecePercent.toFixed(1).padStart(4)}%  ` +
        `${row.changedPieces} pieces  ${row.seconds.toFixed(0)}s`,
    );
  } catch (error) {
    failures.push({ file, error: (error as Error).message });
    console.log(`[${index + 1}/${files.length}] ${file} FAILED: ${(error as Error).message}`);
  }
}

// ---- the official-set baseline, recomputed by the same function ------------
let baselineRows: Row[] = [];
if (existsSync(baselineFile)) {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as { rows: Record<string, number>[] };
  baselineRows = baseline.rows.map((r) => ({
    ...(r as unknown as Row),
    savingsPerChangedPiece:
      (r.changedPieces ?? 0) > 0 ? Math.round((r.savings! / r.changedPieces!) * 1000) / 1000 : null,
  }));
}

const report = {
  generatedAt: new Date().toISOString(),
  priceSource: 'demo',
  safetyLevel: 'extremely_conservative',
  community: {
    corpus: { directory: modelsDir, modelsAnalyzed: rows.length, failures },
    population: describe(rows as never),
    bySize: segmentBySize(rows),
    rows,
  },
  officialBaseline: {
    corpus: { source: baselineFile, modelsAnalyzed: baselineRows.length },
    population: describe(baselineRows as never),
    bySize: segmentBySize(baselineRows),
  },
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log('\n=== COMMUNITY MOCs ===');
console.log(JSON.stringify(report.community.population, null, 2));
console.log('\n=== OFFICIAL SETS (baseline, same code) ===');
console.log(JSON.stringify(report.officialBaseline.population, null, 2));
console.log(`\nWritten to ${outFile}`);
