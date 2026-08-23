/**
 * Builds data/catalog/bundled-catalog.json - the offline fallback catalog that
 * tells the optimiser which colours a part has actually been produced in.
 *
 * WHY THIS EXISTS
 * ---------------
 * The authoritative source is Rebrickable's `inventory_parts.csv`, fetched by
 * `npm run catalog:import`. That needs network access to rebrickable.com. When
 * it has not been run, the app still must not invent colours, so it falls back
 * to this file.
 *
 * The data is derived from the LDraw Official Model Repository: 100+ LDraw
 * files of real official LEGO sets. Every (part, colour) pair recorded here was
 * observed in at least one official set, and the set numbers are kept so the UI
 * can cite the evidence. It is REAL data with narrower coverage than
 * Rebrickable, not a guess.
 *
 * Usage:
 *   npm run catalog:build-bundled -- /path/to/ldraw/models
 *
 * The OMR files are CC BY 2.0 and individually authored; this script emits only
 * derived aggregate data (part id, colour id, set number, count) and does not
 * copy any model into the repository. See docs/RESEARCH.md section 12.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseLDraw, referenceToPartId } from '../src/lib/ldraw/parser';
import { isSubstitutableColor } from '../src/lib/ldraw/colors';

const MAX_SETS_PER_PAIR = 4;

interface Entry {
  n: number;
  sets: string[];
}

function setNumberFromFilename(filename: string): string {
  const base = path.basename(filename).replace(/\.(mpd|ldr)$/i, '');
  const match = /^(\d{3,7}(?:-\d+)?)/.exec(base.trim());
  return match ? match[1]! : base.slice(0, 24).trim();
}

function main(): void {
  const modelsDir = process.argv[2];
  if (!modelsDir) {
    console.error('Usage: npm run catalog:build-bundled -- <path-to-ldraw-models-dir>');
    process.exit(1);
  }

  const files = readdirSync(modelsDir).filter((f) => /\.(mpd|ldr)$/i.test(f));
  if (files.length === 0) {
    console.error(`No .mpd or .ldr files found in ${modelsDir}`);
    process.exit(1);
  }

  const parts = new Map<string, Map<number, Entry>>();
  const sets = new Set<string>();

  for (const file of files) {
    const setNumber = setNumberFromFilename(file);
    sets.add(setNumber);
    const text = readFileSync(path.join(modelsDir, file), 'utf8');
    const document = parseLDraw(text, { sourceName: file });

    // Names declared inside the document are submodels, not catalogue parts.
    const submodels = new Set(
      document.files.filter((f) => !f.isAnonymous).map((f) => f.name.trim().toLowerCase()),
    );

    for (const modelFile of document.files) {
      for (const command of modelFile.commands) {
        if (command.type !== 'part') continue;
        if (submodels.has(command.file.trim().toLowerCase())) continue;
        if (!/\.dat$/i.test(command.file)) continue;
        if (!isSubstitutableColor(command.colorId)) continue;

        const partId = referenceToPartId(command.file);
        // Sub-part references (`s/...`) never appear at model level; skip if seen.
        if (partId.includes('/')) continue;

        let byColor = parts.get(partId);
        if (!byColor) {
          byColor = new Map();
          parts.set(partId, byColor);
        }
        let entry = byColor.get(command.colorId);
        if (!entry) {
          entry = { n: 0, sets: [] };
          byColor.set(command.colorId, entry);
        }
        entry.n++;
        if (entry.sets.length < MAX_SETS_PER_PAIR && !entry.sets.includes(setNumber)) {
          entry.sets.push(setNumber);
        }
      }
    }
  }

  const outParts: Record<string, Record<string, Entry>> = {};
  const sortedPartIds = [...parts.keys()].sort();
  let pairCount = 0;
  for (const partId of sortedPartIds) {
    const byColor = parts.get(partId)!;
    const record: Record<string, Entry> = {};
    for (const colorId of [...byColor.keys()].sort((a, b) => a - b)) {
      record[String(colorId)] = byColor.get(colorId)!;
      pairCount++;
    }
    outParts[partId] = record;
  }

  const output = {
    schemaVersion: 1,
    source: 'LDraw Official Model Repository',
    sourceUrl: 'https://library.ldraw.org/omr',
    licence: 'Derived from CC BY 2.0 LDraw OMR model files. Attribution: LDraw.org and the individual model authors.',
    description:
      'Part/colour combinations observed in official LEGO sets modelled in LDraw. Used as evidence ' +
      'that a given part has genuinely been produced in a given colour. Coverage is limited to the ' +
      'sets in the OMR sample and is narrower than Rebrickable; a pair missing here is not proof ' +
      'that it does not exist, so the optimiser simply never proposes it.',
    modelFileCount: files.length,
    setCount: sets.size,
    partCount: sortedPartIds.length,
    pairCount,
    parts: outParts,
  };

  mkdirSync('data/catalog', { recursive: true });
  const outPath = 'data/catalog/bundled-catalog.json';
  writeFileSync(outPath, JSON.stringify(output));
  console.log(
    `Wrote ${outPath}: ${sortedPartIds.length} parts, ${pairCount} part/colour pairs, ` +
      `from ${files.length} model files covering ${sets.size} sets.`,
  );
}

main();
