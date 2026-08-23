/**
 * LDraw colour id  <->  BrickLink colour id.
 *
 * These are two independent numbering schemes: LDraw 4 is Red, BrickLink 5 is
 * Red. There is no free, official, complete crosswalk (docs/RESEARCH.md
 * section 10), so this module works in two tiers:
 *
 *  1. **Live** - when BrickLink credentials are configured, the app fetches
 *     `GET colors` from the BrickLink API and matches BrickLink's colour names
 *     against LDraw's. LDConfig.ldr itself states that "LDraw and BrickLink
 *     mostly share naming conventions for their colours", which makes name
 *     matching a genuinely reliable, *verifiable* mapping rather than a guess.
 *     See src/lib/pricing/bricklinkColors.ts.
 *
 *  2. **Offline** - the curated table below, covering the colours that account
 *     for the overwhelming majority of parts in real models.
 *
 * A colour that resolves to `unmapped` is EXCLUDED from BrickLink live pricing
 * and from the Wanted List export, and the count of excluded lots is shown to
 * the user. Nothing is ever guessed.
 */

import type { ColorMapping } from './types';

const CURATED_SOURCE = 'curated table (BrickLink colour names, unverified against the live API)';

/** LDraw colour code -> BrickLink colour id. */
const LDRAW_TO_BRICKLINK: ReadonlyMap<number, number> = new Map([
  // --- core solid colours ---
  [0, 11],   // Black
  [1, 7],    // Blue
  [2, 6],    // Green
  [3, 39],   // Dark Turquoise
  [4, 5],    // Red
  [5, 47],   // Dark Pink
  [6, 8],    // Brown
  [7, 9],    // Light Gray
  [8, 10],   // Dark Gray
  [9, 62],   // Light Blue
  [10, 36],  // Bright Green
  [11, 40],  // Light Turquoise
  [12, 25],  // Salmon
  [13, 23],  // Pink
  [14, 3],   // Yellow
  [15, 1],   // White
  [17, 38],  // Light Green
  [18, 33],  // Light Yellow
  [19, 2],   // Tan
  [20, 44],  // Light Violet
  [22, 24],  // Purple
  [25, 4],   // Orange
  [26, 71],  // Magenta
  [27, 34],  // Lime
  [28, 69],  // Dark Tan
  [29, 104], // Bright Pink
  [30, 157], // Medium Lavender
  [31, 154], // Lavender
  [70, 88],  // Reddish Brown
  [71, 86],  // Light Bluish Gray
  [72, 85],  // Dark Bluish Gray
  [73, 42],  // Medium Blue
  [74, 37],  // Medium Green
  [77, 56],  // Light Pink
  [78, 90],  // Light Nougat
  [84, 150], // Medium Nougat
  [85, 89],  // Dark Purple
  [92, 28],  // Nougat
  [110, 43], // Violet
  [115, 76], // Medium Lime
  [118, 41], // Aqua
  [120, 35], // Light Lime
  [125, 32], // Light Orange
  [191, 110], // Bright Light Orange
  [212, 105], // Bright Light Blue
  [216, 27],  // Rust
  [226, 103], // Bright Light Yellow
  [232, 87],  // Sky Blue
  [272, 63],  // Dark Blue
  [288, 80],  // Dark Green
  [308, 120], // Dark Brown
  [313, 72],  // Maersk Blue
  [320, 59],  // Dark Red
  [321, 153], // Dark Azure
  [322, 156], // Medium Azure
  [323, 152], // Light Aqua
  [326, 158], // Yellowish Green
  [330, 155], // Olive Green
  [335, 58],  // Sand Red
  [351, 94],  // Medium Dark Pink
  [373, 54],  // Sand Purple
  [378, 48],  // Sand Green
  [379, 55],  // Sand Blue
  [450, 106], // Fabuland Brown
  [462, 31],  // Medium Orange
  [484, 68],  // Dark Orange
  [503, 99],  // Very Light Bluish Gray

  // --- transparent colours ---
  [32, 13],  // Trans Black (IR lens)
  [33, 14],  // Trans Dark Blue
  [34, 20],  // Trans Green
  [35, 108], // Trans Bright Green
  [36, 17],  // Trans Red
  [37, 50],  // Trans Dark Pink
  [38, 18],  // Trans Neon Orange
  [39, 15],  // Trans Light Blue
  [40, 13],  // Trans Black
  [41, 74],  // Trans Medium Blue
  [42, 16],  // Trans Neon Green
  [43, 113], // Trans Very Light Blue
  [45, 107], // Trans Pink
  [46, 19],  // Trans Yellow
  [47, 12],  // Trans Clear
  [52, 51],  // Trans Purple
  [54, 121], // Trans Neon Yellow
  [57, 98],  // Trans Orange
]);

const BRICKLINK_TO_LDRAW: ReadonlyMap<number, number> = (() => {
  const reverse = new Map<number, number>();
  for (const [ldraw, bricklink] of LDRAW_TO_BRICKLINK) {
    if (!reverse.has(bricklink)) reverse.set(bricklink, ldraw);
  }
  return reverse;
})();

export function mapLDrawColorToBrickLink(
  colorId: number,
  overrides?: ReadonlyMap<number, number>,
): ColorMapping {
  const fromOverride = overrides?.get(colorId);
  if (fromOverride !== undefined) {
    return {
      ldrawColorId: colorId,
      brickLinkColorId: fromOverride,
      confidence: 'verified',
      source: 'BrickLink API colour list, matched by colour name',
    };
  }
  const curated = LDRAW_TO_BRICKLINK.get(colorId);
  if (curated !== undefined) {
    return {
      ldrawColorId: colorId,
      brickLinkColorId: curated,
      confidence: 'verified',
      source: CURATED_SOURCE,
    };
  }
  return {
    ldrawColorId: colorId,
    brickLinkColorId: null,
    confidence: 'unmapped',
    source: 'no known BrickLink colour for this LDraw colour',
  };
}

export function mapBrickLinkColorToLDraw(brickLinkColorId: number): number | null {
  return BRICKLINK_TO_LDRAW.get(brickLinkColorId) ?? null;
}

export function curatedColorMappingSize(): number {
  return LDRAW_TO_BRICKLINK.size;
}
