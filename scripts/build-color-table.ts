/**
 * Generates src/lib/ldraw/colors.generated.ts from an LDraw LDConfig.ldr.
 *
 * Run with:  npm run colors:build [-- path/to/LDConfig.ldr]
 *
 * The generated file is committed so the app never depends on the parts library
 * being present just to name a color. LDConfig.ldr is part of the LDraw Parts
 * Library and is licensed CC BY 2.0; see public/ldraw/CAreadme.txt and NOTICE.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CANDIDATES = [
  'public/ldraw/LDConfig.ldr',
  'public/ldraw-full/LDConfig.ldr',
];

function findInput(): string {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  for (const candidate of DEFAULT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not find LDConfig.ldr. Pass a path explicitly, or run "npm run parts:fetch" first.`,
  );
}

type Finish =
  | 'solid' | 'transparent' | 'chrome' | 'pearlescent' | 'rubber'
  | 'matte_metallic' | 'metal' | 'glitter' | 'speckle' | 'milky';

interface Parsed {
  code: number;
  name: string;
  value: string;
  edge: string;
  alpha: number;
  finish: Finish;
  legoId: number | null;
}

function parseLDConfig(text: string): Parsed[] {
  const colors: Parsed[] = [];
  let pendingLegoId: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    // LDConfig annotates each color with a "// LEGOID <n> - <name>" comment
    // on the preceding line.
    const legoMatch = /^0\s+\/\/\s*LEGOID\s+(\d+)/i.exec(line);
    if (legoMatch) {
      pendingLegoId = Number(legoMatch[1]);
      continue;
    }

    if (!/^0\s+!COLOUR\s/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    // 0 !COLOUR <name> CODE n VALUE #hex EDGE #hex ...
    const name = tokens[2] ?? '';
    const get = (key: string): string | null => {
      const i = tokens.findIndex((t, idx) => idx > 2 && t.toUpperCase() === key);
      return i === -1 ? null : (tokens[i + 1] ?? null);
    };
    const has = (key: string): boolean =>
      tokens.some((t, idx) => idx > 2 && t.toUpperCase() === key);

    const code = Number(get('CODE'));
    if (!Number.isInteger(code)) continue;
    const value = (get('VALUE') ?? '#888888').toUpperCase();
    const edge = (get('EDGE') ?? '#333333').toUpperCase();
    const alphaRaw = get('ALPHA');
    const alpha = alphaRaw === null ? 255 : Math.max(0, Math.min(255, Number(alphaRaw)));

    let finish: Finish = 'solid';
    if (has('CHROME')) finish = 'chrome';
    else if (has('PEARLESCENT')) finish = 'pearlescent';
    else if (has('RUBBER')) finish = 'rubber';
    else if (has('MATTE_METALLIC')) finish = 'matte_metallic';
    else if (has('METAL')) finish = 'metal';
    else if (/glitter/i.test(line)) finish = 'glitter';
    else if (/speckle/i.test(line)) finish = 'speckle';
    else if (/^Milky/i.test(name)) finish = 'milky';
    if (alpha < 255 && finish === 'solid') finish = 'transparent';

    colors.push({
      code,
      name: name.replace(/_/g, ' '),
      value,
      edge,
      alpha,
      finish,
      legoId: pendingLegoId,
    });
    pendingLegoId = null;
  }

  colors.sort((a, b) => a.code - b.code);
  return colors;
}

const input = findInput();
const text = readFileSync(input, 'utf8');
const colors = parseLDConfig(text);
if (colors.length < 50) {
  throw new Error(`Only parsed ${colors.length} colors from ${input}; that looks wrong.`);
}

const versionMatch = /^0\s+!LDRAW_ORG\s+Configuration\s+(.*)$/im.exec(text);
const source = versionMatch ? `LDConfig.ldr (${versionMatch[1]!.trim()})` : 'LDConfig.ldr';

const out = `/* eslint-disable */
// GENERATED FILE - do not edit by hand.
// Produced by scripts/build-color-table.ts from ${path.basename(input)}.
// Source: LDraw Parts Library, ${source}. Licensed CC BY 2.0 - see NOTICE.md.

import type { LDrawColor } from './colors';

export const LDRAW_COLOR_SOURCE = ${JSON.stringify(source)};

export const LDRAW_COLORS: readonly LDrawColor[] = ${JSON.stringify(colors, null, 0)
  .replace(/\},\{/g, '},\n  {')
  .replace(/^\[/, '[\n  ')
  .replace(/\]$/, ',\n]')};
`;

const outPath = 'src/lib/ldraw/colors.generated.ts';
writeFileSync(outPath, out);
console.log(`Wrote ${colors.length} colors to ${outPath} from ${input}`);
console.log(`Transparent colors: ${colors.filter((c) => c.alpha < 255).length}`);
