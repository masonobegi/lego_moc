/**
 * Performance benchmark.
 *
 *   npm run bench                        # synthetic models at 100 .. 10,000 parts
 *   npm run bench -- --real              # also any real models in test-models/omr
 *   npm run bench -- --single-threaded   # measure the in-process path
 *
 * Results go to docs/PERFORMANCE.md when run with --write.
 *
 * The synthetic models are built the way a real MOC is: a solid block of bricks
 * with an interior, so a realistic proportion of parts are genuinely hidden and
 * the expensive verification pass actually runs. Benchmarking a flat sheet of
 * bricks would make the numbers look far better than they are.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import path from 'node:path';

import { analyzeModel } from '../src/lib/analysis/pipeline';
import { DefaultCatalogService, type BundledCatalogFile, type MoldRulesFile } from '../src/lib/catalog/catalogService';
import { NodePartSource } from '../src/lib/geometry/nodePartSource';
import { ChainedPartSource } from '../src/lib/geometry/partSource';
import { DemoPriceProvider } from '../src/lib/pricing/demoProvider';

const ROOT = process.cwd();

const catalog = new DefaultCatalogService({
  bundled: JSON.parse(readFileSync(path.join(ROOT, 'data/catalog/bundled-catalog.json'), 'utf8')) as BundledCatalogFile,
  moldRules: JSON.parse(readFileSync(path.join(ROOT, 'data/catalog/mold-rules.json'), 'utf8')) as MoldRulesFile,
});

const libraries = [path.join(ROOT, 'public', 'ldraw-full'), path.join(ROOT, 'public', 'ldraw')].filter(
  (dir) => existsSync(dir),
);
const partSource = new ChainedPartSource(libraries.map((dir) => new NodePartSource(dir)));

/**
 * A solid rectangular block of 2x4 bricks.
 *
 * This is deliberately the WORST CASE for the analyser, not a flattering one.
 * Roughly half the bricks in a solid block are fully enclosed, so the expensive
 * per-triangle verification pass runs on about half the model - a higher
 * proportion than a real MOC, where 20-40% is typical. Benchmarking a flat
 * sheet or an open frame would make these numbers look far better than the
 * software actually is.
 *
 * Interior bricks are red (expensive in the demo dataset) and the outer shell
 * is light bluish gray, so the optimiser has real work to do as well.
 */
function syntheticModel(targetParts: number): string {
  // A 2x4 brick is 80 x 24 x 40 LDU. Choose counts so the block is roughly
  // cubic in physical space rather than in brick count.
  const ratio = { x: 1, y: 80 / 24, z: 80 / 40 };
  const base = Math.cbrt(targetParts / (ratio.y * ratio.z));
  const nx = Math.max(3, Math.round(base * ratio.x));
  const ny = Math.max(3, Math.round(base * ratio.y));
  const nz = Math.max(3, Math.round(base * ratio.z));

  const lines: string[] = [
    '0 Synthetic Benchmark Block',
    '0 Name: bench.ldr',
    `0 // ${nx} x ${ny} x ${nz} solid block of 2x4 bricks`,
    '',
  ];

  let placed = 0;
  let sinceStep = 0;
  outer: for (let iy = 0; iy < ny; iy++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        if (placed >= targetParts) break outer;
        const interior = ix > 0 && ix < nx - 1 && iy > 0 && iy < ny - 1 && iz > 0 && iz < nz - 1;
        const colour = interior ? 4 : 71;
        const x = ix * 80;
        const y = -iy * 24;
        const z = iz * 40;
        lines.push(`1 ${colour} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 3001.dat`);
        placed++;
        sinceStep++;
        if (sinceStep >= 60) {
          lines.push('0 STEP');
          sinceStep = 0;
        }
      }
    }
  }
  lines.push('0 STEP');
  return lines.join('\n') + '\n';
}

interface Row {
  label: string;
  parts: number;
  distinctParts: number;
  triangles: number;
  parseMs: number;
  geometryMs: number;
  visibilityMs: number;
  pricingMs: number;
  optimiseMs: number;
  totalMs: number;
  rays: number;
  hidden: number;
  workers: number;
  peakRssMb: number;
}

async function measure(label: string, source: string, fileName: string, singleThreaded: boolean): Promise<Row> {
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  const output = await analyzeModel({
    source,
    fileName,
    partSource,
    catalog,
    priceProvider: new DemoPriceProvider(),
    condition: 'new',
    safetyLevel: 'extremely_conservative',
    exhaustiveColorSearch: true,
    singleThreaded,
  });
  const after = process.memoryUsage().rss;
  const r = output.result;
  return {
    label,
    parts: r.model.partCount,
    distinctParts: r.geometry.distinctPartCount,
    triangles: r.geometry.totalTriangles,
    parseMs: (r.timings.parsing ?? 0) + (r.timings.resolving ?? 0),
    geometryMs: r.timings.geometry ?? 0,
    visibilityMs: r.timings.visibility ?? 0,
    pricingMs: r.timings.pricing ?? 0,
    optimiseMs: (r.timings.colors ?? 0) + (r.timings.molds ?? 0) + (r.timings.savings ?? 0),
    totalMs: r.totalMs,
    rays: r.visibility.totalRays,
    hidden: r.visibility.counts.HIDDEN + r.visibility.counts.LIKELY_HIDDEN,
    workers: r.visibility.workerCount,
    peakRssMb: Math.max(0, Math.round((after - before) / 1024 / 1024)),
  };
}

function formatTable(rows: readonly Row[]): string {
  const header =
    '| Model | Parts | Distinct | Triangles | Parse | Geometry | Visibility | Optimise | **Total** | Rays | Hidden | Threads |\n' +
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const body = rows
    .map(
      (r) =>
        `| ${r.label} | ${r.parts.toLocaleString()} | ${r.distinctParts} | ` +
        `${r.triangles.toLocaleString()} | ${r.parseMs} ms | ${r.geometryMs} ms | ` +
        `${r.visibilityMs} ms | ${r.optimiseMs + r.pricingMs} ms | **${(r.totalMs / 1000).toFixed(2)} s** | ` +
        `${r.rays.toLocaleString()} | ${r.hidden.toLocaleString()} | ${r.workers} |`,
    )
    .join('\n');
  return `${header}\n${body}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const singleThreaded = args.includes('--single-threaded');
  const withReal = args.includes('--real');
  const write = args.includes('--write');

  console.log(`Node ${process.version} on ${cpus()[0]?.model ?? 'unknown CPU'}`);
  console.log(`${availableParallelism()} logical cores, ${(totalmem() / 1024 ** 3).toFixed(1)} GB RAM`);
  console.log(`Parts library: ${libraries.map((l) => path.relative(ROOT, l)).join(', ')}`);
  console.log(singleThreaded ? 'Mode: single-threaded' : 'Mode: worker threads enabled');
  console.log('');

  const rows: Row[] = [];
  for (const size of [100, 1000, 5000, 10000]) {
    process.stdout.write(`Synthetic ${size} parts ... `);
    const row = await measure(`Synthetic ${size}`, syntheticModel(size), 'bench.ldr', singleThreaded);
    rows.push(row);
    console.log(
      `${(row.totalMs / 1000).toFixed(2)} s (${row.rays.toLocaleString()} rays, ` +
        `${row.hidden.toLocaleString()} hidden = ${((row.hidden / row.parts) * 100).toFixed(0)}%)`,
    );
  }

  const realRows: Row[] = [];
  if (withReal) {
    const omr = path.join(ROOT, 'test-models', 'omr');
    if (!existsSync(omr)) {
      console.log('\nNo real models found. Run: npm run parts:fetch -- --mirror --models');
    } else {
      const files = readdirSync(omr)
        .filter((f) => /\.(mpd|ldr)$/i.test(f))
        .map((f) => ({ f, size: readFileSync(path.join(omr, f), 'utf8').split('\n').length }))
        .sort((a, b) => a.size - b.size);
      const picks = [files[Math.floor(files.length * 0.25)], files[Math.floor(files.length * 0.6)], files[files.length - 1]]
        .filter((p): p is { f: string; size: number } => p !== undefined);
      for (const pick of picks) {
        process.stdout.write(`Real ${pick.f} ... `);
        const row = await measure(
          pick.f.replace(/\.(mpd|ldr)$/i, ''),
          readFileSync(path.join(omr, pick.f), 'utf8'),
          pick.f,
          singleThreaded,
        );
        realRows.push(row);
        console.log(`${(row.totalMs / 1000).toFixed(2)} s`);
      }
    }
  }

  console.log('');
  console.log(formatTable(rows));
  if (realRows.length > 0) {
    console.log('');
    console.log(formatTable(realRows));
  }

  if (write) {
    const out = [
      '<!-- Generated by `npm run bench -- --write`. -->',
      '',
      `Measured on Node ${process.version}, ${availableParallelism()} logical cores, ` +
        `${(totalmem() / 1024 ** 3).toFixed(1)} GB RAM. ` +
        `${singleThreaded ? 'Single-threaded.' : 'Worker threads enabled.'}`,
      '',
      '### Synthetic models',
      '',
      formatTable(rows),
      ...(realRows.length > 0 ? ['', '### Real models', '', formatTable(realRows)] : []),
      '',
    ].join('\n');
    writeFileSync(path.join(ROOT, 'docs', 'benchmark-results.md'), out);
    console.log('\nWrote docs/benchmark-results.md');
  }
}

void main();
