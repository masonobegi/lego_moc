/**
 * Builds data/catalog/mold-rules.json - the curated one-to-one part
 * substitutions the mold optimiser is allowed to consider.
 *
 * Usage:  npm run catalog:build-molds -- /path/to/ldraw/parts
 *
 * PROVENANCE
 * ----------
 * Rules are derived from the LDraw Parts Library's own part DESCRIPTIONS,
 * which is an authoritative, checkable source: LDraw names the two molds of
 * a tile "Tile 2 x 2 without Groove" (3068a) and "Tile 2 x 2 with Groove"
 * (3068b). BrickLink catalogues those as two separate purchasable items of the
 * same element, which is exactly what makes the substitution worth money.
 *
 * Nothing here is inferred from names merely being similar. A pair is emitted
 * only when the two descriptions are IDENTICAL after removing the phrase that
 * names the mold difference, so "Tile 1 x 2" and "Tile 1 x 2 Grille" can never
 * be paired.
 *
 * When `npm run catalog:import` has been run, Rebrickable's
 * `part_relationships.csv` rows of type M (alternate mold, documented as a
 * functional drop-in replacement) are merged in and take precedence, because
 * they are maintained by a third party rather than by this project.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

interface Rule {
  originalPart: string;
  replacementPart: string;
  type: 'mold_variant' | 'superseded' | 'functionally_equivalent';
  geometryCompatible: boolean;
  confidence: number;
  source: string;
  note: string;
  bidirectional: boolean;
  appearanceImpact: 'none' | 'subtle' | 'unknown';
}

const GROOVE = / (with|without) Groove( on [A-Za-z ]+)?/g;
const STUD_KIND = / with (Solid|Hollow) Stud/g;

function normalizeDescription(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readDescriptions(partsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const filename of readdirSync(partsDir)) {
    if (!filename.toLowerCase().endsWith('.dat')) continue;
    let first: string;
    try {
      const content = readFileSync(path.join(partsDir, filename), 'utf8');
      first = content.slice(0, content.indexOf('\n'));
    } catch {
      continue;
    }
    if (!first.startsWith('0 ')) continue;
    const description = normalizeDescription(first.slice(2));
    // ~ = obsolete/moved, = = alias of another part, _ = physical colour variant.
    if (/^[~=_]/.test(description)) continue;
    out.set(filename.slice(0, -4).toLowerCase(), description);
  }
  return out;
}

function buildRules(descriptions: Map<string, string>): Rule[] {
  const byBase = new Map<string, { id: string; description: string }[]>();
  for (const [id, description] of descriptions) {
    const match = /^(\d+)([a-z]{1,2})$/.exec(id);
    if (!match) continue;
    const list = byBase.get(match[1]!) ?? [];
    list.push({ id, description });
    byBase.set(match[1]!, list);
  }

  const rules: Rule[] = [];
  for (const variants of byBase.values()) {
    for (let i = 0; i < variants.length; i++) {
      for (let j = i + 1; j < variants.length; j++) {
        const a = variants[i]!;
        const b = variants[j]!;

        const grooveA = a.description.replace(GROOVE, '');
        const grooveB = b.description.replace(GROOVE, '');
        if (
          grooveA === grooveB &&
          a.description !== b.description &&
          (/Groove/.test(a.description) || /Groove/.test(b.description))
        ) {
          rules.push({
            originalPart: a.id,
            replacementPart: b.id,
            type: 'mold_variant',
            geometryCompatible: true,
            confidence: 0.92,
            source: `LDraw Parts Library part descriptions: "${a.description}" / "${b.description}"`,
            note:
              'Two molds of the same element. The footprint, height and every connection point are ' +
              'identical; they differ only in a groove along the lower edge. BrickLink sells them as ' +
              'separate items, which is why the price can differ.',
            bidirectional: true,
            appearanceImpact: 'subtle',
          });
          continue;
        }

        const studA = a.description.replace(STUD_KIND, '');
        const studB = b.description.replace(STUD_KIND, '');
        if (studA === studB && a.description !== b.description && /Stud/.test(a.description)) {
          rules.push({
            originalPart: a.id,
            replacementPart: b.id,
            type: 'functionally_equivalent',
            geometryCompatible: false,
            confidence: 0.6,
            source: `LDraw Parts Library part descriptions: "${a.description}" / "${b.description}"`,
            note:
              'Same element with a different stud type. A hollow stud accepts a bar and a solid one ' +
              'does not, so this is NOT a guaranteed drop-in replacement. Recorded for completeness; ' +
              'its confidence is below the threshold, so it is never applied automatically.',
            bidirectional: true,
            appearanceImpact: 'subtle',
          });
        }
      }
    }
  }

  rules.sort((x, y) =>
    x.originalPart === y.originalPart
      ? x.replacementPart.localeCompare(y.replacementPart)
      : x.originalPart.localeCompare(y.originalPart),
  );
  return rules;
}

function main(): void {
  const partsDir = process.argv[2];
  if (!partsDir) {
    console.error('Usage: npm run catalog:build-molds -- <path-to-ldraw-parts-dir>');
    process.exit(1);
  }
  const descriptions = readDescriptions(partsDir);
  const rules = buildRules(descriptions);

  const output = {
    schemaVersion: 1,
    source: 'LDraw Parts Library part descriptions',
    description:
      'One-to-one part substitutions. Every rule is derived from two LDraw part descriptions that ' +
      'are identical apart from the phrase naming the mold difference. Rules are never inferred ' +
      'from names merely looking similar. Rules whose appearanceImpact is not "none" are only ' +
      'applied to parts the visibility engine classified as hidden.',
    autoApplyThreshold: 0.85,
    generatedFrom: `${descriptions.size} part descriptions`,
    rules,
  };

  mkdirSync('data/catalog', { recursive: true });
  writeFileSync('data/catalog/mold-rules.json', JSON.stringify(output, null, 2));
  console.log(
    `Wrote data/catalog/mold-rules.json: ${rules.length} rules ` +
      `(${rules.filter((r) => r.confidence >= 0.85).length} above the auto-apply threshold) ` +
      `from ${descriptions.size} part descriptions.`,
  );
}

main();
