/**
 * LDraw color definitions.
 *
 * The authoritative source is `LDConfig.ldr`, distributed with the LDraw parts
 * library, which declares each color with the `0 !COLOUR` language extension:
 *
 *   0 !COLOUR <name> CODE <code> VALUE <#RRGGBB> EDGE <#RRGGBB> [ALPHA <0-255>]
 *             [LUMINANCE <n>] [CHROME|PEARLESCENT|RUBBER|MATTE_METALLIC|METAL|MATERIAL ...]
 *
 * The table is generated from that file into `colors.generated.ts` by
 * `npm run colors:build`, so the app has the full official palette available
 * synchronously on both server and client with no file I/O.
 *
 * `ALPHA` below 255 is what makes a color transparent, and that is the single
 * signal the visibility engine uses to decide a part cannot hide anything.
 */

import { LDRAW_COLORS, LDRAW_COLOR_SOURCE } from './colors.generated';
import { DIRECT_COLOR_BASE, directColorToHex, isDirectColor } from './parser';

export type ColorFinish =
  | 'solid'
  | 'transparent'
  | 'chrome'
  | 'pearlescent'
  | 'rubber'
  | 'matte_metallic'
  | 'metal'
  | 'glitter'
  | 'speckle'
  | 'milky';

export interface LDrawColor {
  readonly code: number;
  readonly name: string;
  /** `#RRGGBB`. */
  readonly value: string;
  readonly edge: string;
  /** 0-255. 255 for opaque colors. */
  readonly alpha: number;
  readonly finish: ColorFinish;
  /** LEGO's own color number where LDConfig records one. */
  readonly legoId: number | null;
}

const BY_CODE = new Map<number, LDrawColor>();
for (const color of LDRAW_COLORS) BY_CODE.set(color.code, color);

export const COLOR_TABLE_SOURCE = LDRAW_COLOR_SOURCE;

/** Every color in the official LDConfig, in code order. */
export function allColors(): readonly LDrawColor[] {
  return LDRAW_COLORS;
}

export function getColor(code: number): LDrawColor | null {
  if (isDirectColor(code)) {
    const hex = directColorToHex(code);
    return {
      code,
      name: `Direct color ${hex.toUpperCase()}`,
      value: hex,
      edge: '#333333',
      alpha: 255,
      finish: 'solid',
      legoId: null,
    };
  }
  return BY_CODE.get(code) ?? null;
}

export function colorName(code: number): string {
  return getColor(code)?.name ?? `Unknown color ${code}`;
}

export function colorHex(code: number): string {
  return getColor(code)?.value ?? '#888888';
}

/**
 * Whether a color lets light through, and therefore cannot hide a part behind
 * it. Deliberately inclusive: milky and glitter colors are treated as
 * see-through too, because being wrong in that direction only costs a saving,
 * while being wrong the other way recolors a visible brick.
 */
export function isTransparentColor(code: number): boolean {
  const color = getColor(code);
  if (!color) return false;
  if (color.alpha < 255) return true;
  return color.finish === 'transparent' || color.finish === 'milky' || color.finish === 'glitter';
}

/** Colors that are not real materials and can never be substituted. */
export function isSentinelColor(code: number): boolean {
  return code === 16 || code === 24;
}

export function isSubstitutableColor(code: number): boolean {
  return !isSentinelColor(code) && !isDirectColor(code) && BY_CODE.has(code);
}

export { DIRECT_COLOR_BASE, isDirectColor };
