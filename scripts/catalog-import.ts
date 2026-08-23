/**
 * Imports the Rebrickable catalogue into data/catalog/rebrickable/.
 *
 *   npm run catalog:import
 *
 * WHAT IT IS FOR
 * --------------
 * The app ships an offline catalogue derived from LDraw Official Model
 * Repository files, which is real data but covers only ~2,000 parts. This
 * replaces it with Rebrickable's full catalogue, which is what "did this part
 * ever exist in this colour" should really be answered from.
 *
 * SOURCE AND TERMS
 * ----------------
 * https://rebrickable.com/downloads/ - free for any purpose including
 * commercial, provided Rebrickable is acknowledged as the source of the data.
 * Automated download is permitted AT MOST ONCE PER DAY, which this script
 * enforces locally.
 *
 * A Rebrickable API key is NOT required for the CSV downloads. It is only used,
 * if present, to resolve external ids (BrickLink/LDraw/LEGO part numbers) for
 * parts whose numbering diverges - see docs/RESEARCH.md section 10.
 */

import { createGunzip } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

const CDN = 'https://cdn.rebrickable.com/media/downloads';
const OUT_DIR = path.join(process.cwd(), 'data', 'catalog', 'rebrickable');
const STAMP = path.join(OUT_DIR, '.last-import');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function fetchCsvGz(table: string): Promise<string> {
  const url = `${CDN}/${table}.csv.gz`;
  process.stdout.write(`  ${table}.csv.gz ... `);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.pipe(gunzip);
  for await (const chunk of gunzip) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  console.log(`${(text.length / 1024 / 1024).toFixed(1)} MB`);
  return text;
}

/** Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function columnIndex(header: readonly string[], name: string): number {
  const index = header.indexOf(name);
  if (index === -1) throw new Error(`Expected a "${name}" column, found: ${header.join(', ')}`);
  return index;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  if (!process.argv.includes('--force') && existsSync(STAMP)) {
    const last = Number(readFileSync(STAMP, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < ONE_DAY_MS) {
      const hours = ((ONE_DAY_MS - (Date.now() - last)) / 3_600_000).toFixed(1);
      console.log(
        `Rebrickable permits at most one automated download per day. Last import was ` +
          `${new Date(last).toISOString()}; try again in ${hours} hours, or pass --force if you ` +
          `are certain.`,
      );
      return;
    }
  }

  console.log('Downloading Rebrickable catalogue CSVs from https://rebrickable.com/downloads/ ...');
  const [inventoryParts, inventories, sets, partRelationships] = await Promise.all([
    fetchCsvGz('inventory_parts'),
    fetchCsvGz('inventories'),
    fetchCsvGz('sets'),
    fetchCsvGz('part_relationships'),
  ]);

  // --- which colours does each part exist in -------------------------------
  const inventoryRows = parseCsv(inventories);
  const inventoryHeader = inventoryRows[0]!;
  const invId = columnIndex(inventoryHeader, 'id');
  const invSet = columnIndex(inventoryHeader, 'set_num');
  const inventoryToSet = new Map<string, string>();
  for (let i = 1; i < inventoryRows.length; i++) {
    const row = inventoryRows[i]!;
    inventoryToSet.set(row[invId]!, row[invSet]!);
  }

  const setRows = parseCsv(sets);
  console.log(`  ${setRows.length - 1} sets, ${inventoryToSet.size} inventories`);

  const partRows = parseCsv(inventoryParts);
  const partHeader = partRows[0]!;
  const pInv = columnIndex(partHeader, 'inventory_id');
  const pPart = columnIndex(partHeader, 'part_num');
  const pColor = columnIndex(partHeader, 'color_id');

  const colorsByPart = new Map<string, Set<number>>();
  for (let i = 1; i < partRows.length; i++) {
    const row = partRows[i]!;
    const partNum = row[pPart]!.toLowerCase();
    const colorId = Number(row[pColor]);
    if (!Number.isFinite(colorId)) continue;
    const set = colorsByPart.get(partNum) ?? new Set<number>();
    set.add(colorId);
    colorsByPart.set(partNum, set);
    void row[pInv];
  }

  // --- alternate molds -----------------------------------------------------
  const relRows = parseCsv(partRelationships);
  const relHeader = relRows[0]!;
  const rType = columnIndex(relHeader, 'rel_type');
  const rChild = columnIndex(relHeader, 'child_part_num');
  const rParent = columnIndex(relHeader, 'parent_part_num');

  const moldRules = [];
  for (let i = 1; i < relRows.length; i++) {
    const row = relRows[i]!;
    // Only rel_type M: "alternate mold which can be used as a functional
    // drop-in replacement". A (alternate) is explicitly NOT guaranteed
    // compatible and is not imported.
    if (row[rType] !== 'M') continue;
    moldRules.push({
      originalPart: row[rChild]!.toLowerCase(),
      replacementPart: row[rParent]!.toLowerCase(),
      type: 'mold_variant' as const,
      geometryCompatible: true,
      confidence: 0.94,
      source: 'Rebrickable part_relationships.csv, rel_type M (alternate mold, functional drop-in replacement)',
      note:
        'Rebrickable records these two part numbers as alternate molds of the same element, ' +
        'usable as drop-in replacements for each other.',
      bidirectional: true,
      appearanceImpact: 'subtle' as const,
    });
  }

  // ---------------------------------------------------------------------------
  // NOTE ON REBRICKABLE COLOUR IDS
  // Rebrickable uses its own colour numbering, which is NOT the LDraw numbering
  // this app works in. Importing the colour sets without translating them would
  // silently corrupt every colour-validity check, so the mapping is applied via
  // colors.csv, which carries no LDraw column - meaning a translation table is
  // required. Until one is present, colour data is written to a SEPARATE file
  // and is not loaded by the app; the mold rules, which are colour-independent,
  // are safe to use immediately.
  // ---------------------------------------------------------------------------
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Rebrickable catalogue downloads',
    attribution: 'Data source: Rebrickable (https://rebrickable.com/downloads/)',
    warning:
      'colorsByRebrickableColorId uses REBRICKABLE colour ids, not LDraw colour ids. The app ' +
      'does not consume it until a verified Rebrickable-to-LDraw colour mapping is supplied.',
    partCount: colorsByPart.size,
    moldRuleCount: moldRules.length,
    moldRules,
    colorsByRebrickableColorId: Object.fromEntries(
      [...colorsByPart.entries()].map(([partNum, colors]) => [partNum, [...colors].sort((a, b) => a - b)]),
    ),
  };

  writeFileSync(path.join(OUT_DIR, 'catalog-import.json'), JSON.stringify(payload));
  writeFileSync(STAMP, String(Date.now()));

  console.log('');
  console.log(`Wrote data/catalog/rebrickable/catalog-import.json`);
  console.log(`  ${colorsByPart.size.toLocaleString()} parts with colour data`);
  console.log(`  ${moldRules.length.toLocaleString()} alternate-mold rules (rel_type M)`);
  console.log('');
  console.log('Data source: Rebrickable (https://rebrickable.com/downloads/).');
  console.log('');
  console.log(
    'IMPORTANT: the colour data uses Rebrickable colour ids, which are not LDraw colour ids.\n' +
      'The app therefore keeps using its LDraw-native bundled catalogue for colour validity and\n' +
      'only adopts the mold rules from this import. See docs/RESEARCH.md section 10.',
  );
}

void main();
