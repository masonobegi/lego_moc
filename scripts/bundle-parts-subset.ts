/**
 * Copies the minimum set of LDraw part files the app needs to work out of the
 * box into public/ldraw.
 *
 * `npm install && npm run dev` has to produce a working app, and the full LDraw
 * parts library is over 500 MB, which does not belong in a git repository. So
 * the repository ships the transitive closure of the parts used by the built-in
 * fixtures and the demo price table - a few megabytes - and
 * `npm run parts:fetch` installs the full library for real models.
 *
 * Usage:
 *   npm run parts:bundle -- /path/to/ldraw
 *
 * LICENCE: the copied files are part of the LDraw Parts Library, licensed
 * CC BY 2.0. Their original headers, including `0 !LICENSE` and `0 Author:`,
 * are copied byte for byte, and CAreadme.txt / CAlicense.txt sit alongside
 * them. See NOTICE.md.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseLDraw } from '../src/lib/ldraw/parser';
import { DEMO_BASE_PRICES } from '../src/lib/pricing/demoData';
import { normalizeLookupPath, SEARCH_ROOTS } from '../src/lib/geometry/partSource';

const OUT_ROOT = path.join(process.cwd(), 'public', 'ldraw');

function buildIndex(libraryRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (prefix === '' && !['parts', 'p'].includes(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dat')) continue;
      const withPrefix = normalizeLookupPath(prefix + entry.name);
      const withoutRoot = normalizeLookupPath(withPrefix.replace(/^(parts|p)\//, ''));
      const absolute = path.join(dir, entry.name);
      if (!index.has(withPrefix)) index.set(withPrefix, absolute);
      if (!index.has(withoutRoot)) index.set(withoutRoot, absolute);
    }
  };
  for (const root of SEARCH_ROOTS) walk(path.join(libraryRoot, root), root, 0);
  return index;
}

function resolve(index: Map<string, string>, reference: string): string | null {
  return index.get(normalizeLookupPath(reference)) ?? null;
}

/** Where a resolved absolute path should live under public/ldraw. */
function relativeTarget(libraryRoot: string, absolute: string): string {
  const relative = path.relative(libraryRoot, absolute).split(path.sep).join('/');
  return relative;
}

function main(): void {
  const libraryRoot = process.argv[2];
  if (!libraryRoot) {
    console.error('Usage: npm run parts:bundle -- <path-to-ldraw-library-root>');
    process.exit(1);
  }

  const index = buildIndex(libraryRoot);
  console.log(`Indexed ${index.size} library entries from ${libraryRoot}`);

  // Seeds: every part referenced by a fixture, plus every part in the demo
  // price table, plus both sides of every mold rule.
  const seeds = new Set<string>();

  const fixturesDir = path.join(process.cwd(), 'test-models');
  for (const file of readdirSync(fixturesDir)) {
    if (!/\.(ldr|mpd)$/i.test(file)) continue;
    const document = parseLDraw(readFileSync(path.join(fixturesDir, file), 'utf8'), { sourceName: file });
    const submodels = new Set(
      document.files.filter((f) => !f.isAnonymous).map((f) => f.name.trim().toLowerCase()),
    );
    for (const modelFile of document.files) {
      for (const command of modelFile.commands) {
        if (command.type !== 'part') continue;
        if (submodels.has(command.file.trim().toLowerCase())) continue;
        seeds.add(command.file);
      }
    }
  }

  for (const partId of DEMO_BASE_PRICES.keys()) seeds.add(`${partId}.dat`);

  const moldRules = JSON.parse(
    readFileSync(path.join(process.cwd(), 'data', 'catalog', 'mold-rules.json'), 'utf8'),
  ) as { rules: { originalPart: string; replacementPart: string }[] };
  for (const rule of moldRules.rules) {
    seeds.add(`${rule.originalPart}.dat`);
    seeds.add(`${rule.replacementPart}.dat`);
  }

  // Transitive closure.
  const copied = new Map<string, string>();
  const missing = new Set<string>();
  const queue = [...seeds];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const reference = queue.pop()!;
    const key = normalizeLookupPath(reference);
    if (seen.has(key)) continue;
    seen.add(key);

    const absolute = resolve(index, reference);
    if (!absolute) {
      missing.add(reference);
      continue;
    }
    copied.set(relativeTarget(libraryRoot, absolute), absolute);

    const document = parseLDraw(readFileSync(absolute, 'utf8'), { sourceName: reference });
    for (const modelFile of document.files) {
      for (const command of modelFile.commands) {
        if (command.type === 'part') queue.push(command.file);
      }
    }
  }

  let bytes = 0;
  for (const [relative, absolute] of copied) {
    const target = path.join(OUT_ROOT, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(absolute, target);
    bytes += readFileSync(absolute).byteLength;
  }

  const manifest = {
    generatedFrom: libraryRoot,
    seedCount: seeds.size,
    fileCount: copied.size,
    approximateBytes: bytes,
    missing: [...missing].sort(),
    notice:
      'These files are part of the LDraw Parts Library and are redistributed under CC BY 2.0. ' +
      'See CAreadme.txt and CAlicense.txt in this directory, and NOTICE.md in the repository root. ' +
      'Run "npm run parts:fetch" to install the complete library.',
  };
  writeFileSync(path.join(OUT_ROOT, 'bundled-parts.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `Copied ${copied.size} files (${(bytes / 1024 / 1024).toFixed(1)} MB) into public/ldraw ` +
      `from ${seeds.size} seed references.`,
  );
  if (missing.size > 0) {
    console.log(`Could not resolve ${missing.size} references: ${[...missing].slice(0, 10).join(', ')}`);
  }
}

main();
