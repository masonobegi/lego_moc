/**
 * Business validation study.
 *
 *   npx tsx scripts/validation-study.ts <models-dir> [--parts-library <dir>] [--limit N] [--out FILE]
 *
 * Runs a corpus of real LDraw models through the optimizer and records, per
 * model, everything `docs/VALIDATION_PLAN.md` needs to decide whether automatic
 * hidden-color optimization is worth paying for. It computes the distribution
 * statistics and prints them; it does not decide anything, and it does not know
 * what the criteria are, so it cannot be tuned toward passing them.
 *
 * The savings it reports are DEMO prices unless a live BrickLink provider is
 * configured, and the plan says plainly what that does and does not license you
 * to conclude.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeModel, applyToInstances, computeSavings } from '../src/lib/analysis/pipeline';
import { buildQualityMetrics } from '../src/lib/analysis/metrics';
import { scoreModelValue } from '../src/lib/analysis/valueScore';
import { NodePartSource } from '../src/lib/geometry/nodePartSource';
import { ChainedPartSource } from '../src/lib/geometry/partSource';
import { calculateCost } from '../src/lib/pricing/priceEngine';
import { DemoPriceProvider } from '../src/lib/pricing/demoProvider';
import { getCatalog } from '../src/lib/runtime/services';

interface Row {
  file: string;
  parts: number;
  uniqueLots: number;
  originalCost: number;
  optimizedCost: number;
  savings: number;
  savingsPercent: number;
  highConfidenceSavings: number;
  candidates: number;
  colorCandidates: number;
  moldCandidates: number;
  colorSavings: number;
  moldSavings: number;
  changedPieces: number;
  changedPiecePercent: number;
  hiddenPieces: number;
  hiddenPiecePercent: number;
  rejectedCandidates: number;
  missingParts: number;
  rating: string;
  seconds: number;
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const modelsDir = process.argv[2];
if (!modelsDir || !existsSync(modelsDir)) {
  console.error('Usage: tsx scripts/validation-study.ts <models-dir> [--parts-library <dir>] [--limit N] [--out FILE]');
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
const outFile = arg('--out') ?? path.join(process.cwd(), 'docs', 'validation-results.json');

const files = readdirSync(modelsDir)
  .filter((f) => /\.(ldr|mpd)$/i.test(f))
  .sort();
const selected = limit > 0 ? files.slice(0, limit) : files;

console.log(`${selected.length} models from ${modelsDir}`);
console.log(`Parts library: ${libraries.join(', ')}\n`);

const rows: Row[] = [];
const failures: { file: string; error: string }[] = [];

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
    const metrics = buildQualityMetrics(result, savings);
    const score = scoreModelValue(savings, (n) => `$${n.toFixed(2)}`);
    const seconds = (Date.now() - started) / 1000;

    const row: Row = {
      file,
      parts: result.model.partCount,
      uniqueLots: result.model.uniqueLotCount,
      originalCost: metrics.originalEstimatedPartCost,
      optimizedCost: metrics.optimizedEstimatedPartCost,
      savings: metrics.estimatedPartSavings,
      savingsPercent: metrics.savingsPercent,
      highConfidenceSavings: metrics.highConfidenceEstimatedPartSavings,
      candidates: metrics.candidateCount,
      // Split out, because the brief's question is whether SAME-PART,
      // DIFFERENT-COLOR optimization alone is worth anything. Mold equivalence
      // is a second, much smaller feature and must not be allowed to carry the
      // headline number.
      colorCandidates: result.candidates.filter((c) => c.kind === 'hidden_color').length,
      moldCandidates: result.candidates.filter((c) => c.kind === 'mold_equivalent').length,
      colorSavings:
        Math.round(
          result.candidates
            .filter((c) => c.kind === 'hidden_color' && enabled.has(c.id))
            .reduce((sum, c) => sum + c.savings, 0) * 100,
        ) / 100,
      moldSavings:
        Math.round(
          result.candidates
            .filter((c) => c.kind === 'mold_equivalent' && enabled.has(c.id))
            .reduce((sum, c) => sum + c.savings, 0) * 100,
        ) / 100,
      changedPieces: metrics.changedPieceCount,
      changedPiecePercent: metrics.changedPiecePercent,
      hiddenPieces: metrics.hiddenPieceCount,
      hiddenPiecePercent: metrics.hiddenPiecePercent,
      rejectedCandidates: metrics.rejectedCandidateCount,
      missingParts: result.geometry.missingParts.length,
      rating: score.rating,
      seconds: Math.round(seconds * 10) / 10,
    };
    rows.push(row);
    console.log(
      `[${String(index + 1).padStart(3)}/${selected.length}] ${file.slice(0, 44).padEnd(45)} ` +
        `${String(row.parts).padStart(5)}p  $${row.originalCost.toFixed(2).padStart(8)}  ` +
        `save $${row.savings.toFixed(2).padStart(7)} (${row.savingsPercent.toFixed(1).padStart(5)}%)  ` +
        `${row.hiddenPiecePercent.toFixed(0).padStart(3)}% hidden  ${row.seconds.toFixed(0)}s  ${row.rating}`,
    );
  } catch (error) {
    failures.push({ file, error: (error as Error).message });
    console.log(`[${String(index + 1).padStart(3)}/${selected.length}] ${file.slice(0, 44).padEnd(45)} FAILED: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower);
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

const savings = rows.map((r) => r.savings).sort((a, b) => a - b);
const percents = rows.map((r) => r.savingsPercent).sort((a, b) => a - b);
const share = (predicate: (r: Row) => boolean): number =>
  rows.length === 0 ? 0 : Math.round((rows.filter(predicate).length / rows.length) * 1000) / 10;

const summary = {
  generatedAt: new Date().toISOString(),
  corpus: { directory: modelsDir, modelsAttempted: selected.length, modelsAnalyzed: rows.length },
  priceSource: 'demo',
  meanSavings: rows.length ? Math.round((savings.reduce((a, b) => a + b, 0) / rows.length) * 100) / 100 : 0,
  medianSavings: Math.round(quantile(savings, 0.5) * 100) / 100,
  meanSavingsPercent:
    rows.length ? Math.round((percents.reduce((a, b) => a + b, 0) / rows.length) * 10) / 10 : 0,
  medianSavingsPercent: Math.round(quantile(percents, 0.5) * 10) / 10,
  savingsPercentile25: Math.round(quantile(savings, 0.25) * 100) / 100,
  savingsPercentile75: Math.round(quantile(savings, 0.75) * 100) / 100,
  savingsPercentPercentile25: Math.round(quantile(percents, 0.25) * 10) / 10,
  savingsPercentPercentile75: Math.round(quantile(percents, 0.75) * 10) / 10,
  shareOver5: share((r) => r.savings > 5),
  shareOver10: share((r) => r.savings > 10),
  shareOver20: share((r) => r.savings > 20),
  shareOver50: share((r) => r.savings > 50),
  shareZero: share((r) => r.savings === 0),
  shareOver10Percent: share((r) => r.savingsPercent >= 10),
  correlationPartsToSavings: Math.round(pearson(rows.map((r) => r.parts), rows.map((r) => r.savings)) * 1000) / 1000,
  correlationPartsToSavingsPercent:
    Math.round(pearson(rows.map((r) => r.parts), rows.map((r) => r.savingsPercent)) * 1000) / 1000,
  correlationHiddenToSavingsPercent:
    Math.round(pearson(rows.map((r) => r.hiddenPiecePercent), rows.map((r) => r.savingsPercent)) * 1000) / 1000,
  ratings: rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.rating] = (acc[r.rating] ?? 0) + 1;
    return acc;
  }, {}),
  colorShareOfSavings:
    rows.reduce((a, r) => a + r.savings, 0) > 0
      ? Math.round(
          (rows.reduce((a, r) => a + r.colorSavings, 0) / rows.reduce((a, r) => a + r.savings, 0)) * 1000,
        ) / 10
      : 0,
  medianAnalysisSeconds: Math.round(quantile(rows.map((r) => r.seconds).sort((a, b) => a - b), 0.5) * 10) / 10,
  failures,
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2));

console.log('\n=== distribution ===');
for (const [key, value] of Object.entries(summary)) {
  if (key === 'failures' || key === 'ratings' || key === 'corpus') continue;
  console.log(`  ${key.padEnd(34)} ${JSON.stringify(value)}`);
}
console.log(`  ratings                            ${JSON.stringify(summary.ratings)}`);
console.log(`\n${rows.length} analyzed, ${failures.length} failed. Written to ${outFile}`);
