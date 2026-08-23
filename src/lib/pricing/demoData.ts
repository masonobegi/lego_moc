/**
 * DEMO PRICE DATA
 * ===============
 *
 * These numbers are NOT real marketplace prices. They are a deterministic,
 * synthetic dataset that exists so the whole optimizer can be exercised with no
 * API credentials at all. They are labeled `DEMO PRICE DATA` everywhere they
 * are shown and every quote derived from them carries `source: 'demo'`.
 *
 * They are shaped to make the optimizer's behavior easy to see and to test:
 *   - Red is deliberately the most expensive common color.
 *   - Black is deliberately the cheapest.
 *   - Blue sits in between.
 *   - Superseded molds (3068a, 3069a, 3070a, 2412a) are priced well above the
 *     current mold, which is the usual real-world direction and gives the mold
 *     optimizer something to find.
 *
 * A price is `basePrice[part] * colorFactor[color]`, rounded to cents, with a
 * small table of exact overrides. Parts with no base price fall back to a
 * volume-derived estimate (see demoProvider.ts) rather than to an invented
 * constant, and the quote says which of the two produced it.
 */

/** Base price per part, in demo dollars, roughly tracking element size. */
export const DEMO_BASE_PRICES: ReadonlyMap<string, number> = new Map([
  // bricks
  ['3005', 0.06], ['3004', 0.08], ['3622', 0.10], ['3010', 0.11], ['3009', 0.14], ['3008', 0.18],
  ['3003', 0.10], ['3002', 0.13], ['3001', 0.15], ['2456', 0.22], ['3007', 0.30],
  ['3062b', 0.09], ['3062a', 0.26], ['3245c', 0.24], ['2465', 0.34],
  // plates
  ['3024', 0.04], ['3023', 0.05], ['3623', 0.06], ['3710', 0.07], ['3666', 0.09], ['3460', 0.12],
  ['3022', 0.07], ['3021', 0.09], ['3020', 0.11], ['3795', 0.15], ['3034', 0.19], ['3832', 0.26],
  ['3031', 0.18], ['3032', 0.25], ['3035', 0.33], ['3958', 0.38], ['3036', 0.48], ['3033', 0.55],
  ['6141', 0.05], ['4073', 0.05], ['3794b', 0.08], ['3794a', 0.29],
  // tiles - the "a" molds are the superseded ones and are priced accordingly
  ['3070b', 0.05], ['3070a', 0.28],
  ['3069b', 0.06], ['3069a', 0.31],
  ['3068b', 0.09], ['3068a', 0.42],
  ['2412b', 0.09], ['2412a', 0.35],
  ['6636', 0.11], ['4162', 0.13], ['87079', 0.12],
  // slopes
  ['3040b', 0.10], ['3039', 0.14], ['3037', 0.17], ['3038', 0.21], ['3665', 0.10], ['3660', 0.13],
  ['4286', 0.12], ['3298', 0.14], ['3300', 0.16],
  // technic and specials
  ['3700', 0.11], ['3701', 0.13], ['3702', 0.16], ['3703', 0.22], ['32523', 0.12], ['32524', 0.18],
  ['3894', 0.16], ['3895', 0.24], ['6541', 0.09], ['4274', 0.06], ['32062', 0.07],
  // windows, doors, panels
  ['60592', 0.35], ['60601', 0.22], ['60594', 0.48], ['60596', 0.62], ['60593', 0.42],
  ['4864b', 0.14], ['87552', 0.22], ['2362b', 0.16],
  // brackets, headlight, misc very common parts
  ['4070', 0.11], ['99207', 0.14], ['99780', 0.13], ['44728', 0.15], ['2436b', 0.19],
  ['3937', 0.09], ['3938', 0.10], ['4085c', 0.11],
  ['3960', 0.16], ['3961', 0.18], ['4740', 0.14], ['3626c', 0.55], ['3626b', 0.68], ['3626a', 1.10],
  ['3901', 0.30], ['3815', 0.35], ['3818', 0.14], ['3819', 0.14], ['3820', 0.16], ['3821', 0.16],
]);

/**
 * Color price multipliers. Red is deliberately expensive and black
 * deliberately cheap, per the product brief's worked example.
 *
 * The blue factor is 1.27 rather than a rounder number so that
 * 3001 Blue lands exactly on the 0.19 the brief specifies.
 */
export const DEMO_COLOR_FACTORS: ReadonlyMap<number, number> = new Map([
  [0, 0.80],    // Black            - cheapest
  [71, 1.00],   // Light Bluish Gray - the reference color
  [72, 1.10],   // Dark Bluish Gray
  [1, 1.27],    // Blue             - moderate
  [15, 1.45],   // White
  [70, 1.60],   // Reddish Brown
  [19, 1.70],   // Tan
  [14, 1.85],   // Yellow
  [2, 2.05],    // Green
  [25, 2.20],   // Orange
  [7, 2.40],    // Light Gray (old mould color, long retired)
  [8, 2.55],    // Dark Gray (old)
  [288, 2.90],  // Dark Green
  [320, 3.60],  // Dark Red
  [4, 5.00],    // Red              - deliberately the expensive one
  [28, 1.95],   // Dark Tan
  [84, 2.30],   // Medium Nougat
  [92, 2.15],   // Nougat
  [272, 2.75],  // Dark Blue
  [321, 2.60],  // Dark Azure
  [322, 2.45],  // Medium Azure
  [191, 2.35],  // Bright Light Orange
  [226, 2.25],  // Bright Light Yellow
  [212, 2.20],  // Bright Light Blue
  [308, 2.85],  // Dark Brown
  [330, 2.50],  // Olive Green
  [378, 2.10],  // Sand Green
  [379, 2.30],  // Sand Blue
  [484, 3.10],  // Dark Orange
  [27, 2.65],   // Lime
  [26, 3.30],   // Magenta
  [22, 3.05],   // Purple
  [85, 3.15],   // Dark Purple
  [5, 3.40],    // Dark Pink
  [29, 3.25],   // Bright Pink
  [31, 2.95],   // Lavender
  [30, 3.05],   // Medium Lavender
  [47, 5.90],   // Trans-Clear
  [36, 6.40],   // Trans-Red
  [34, 6.20],   // Trans-Green
  [33, 6.60],   // Trans-Dark Blue
  [46, 6.10],   // Trans-Yellow
  [57, 6.80],   // Trans-Orange
  [40, 6.50],   // Trans-Black
  [383, 4.80],  // Chrome Silver
  [80, 5.20],   // Metallic Silver
]);

/** The default multiplier for a color with no factor of its own. */
export const DEMO_DEFAULT_COLOR_FACTOR = 2.75;

/**
 * Exact prices that override the base x factor calculation.
 * Kept for values the product brief specifies verbatim and for the tests that
 * assert them.
 */
export const DEMO_PRICE_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['3001|4', 0.75],
  ['3001|0', 0.12],
  ['3001|1', 0.19],
]);

export const DEMO_CURRENCY = 'USD';
export const DEMO_DATA_LABEL = 'DEMO PRICE DATA';
export const DEMO_DATA_DISCLAIMER =
  'Demo prices are a synthetic, deterministic dataset built into this app so it runs with no API ' +
  'credentials. They are not real BrickLink prices and must not be used to plan a purchase.';

/** Used-condition prices are modeled as a flat discount on new. */
export const DEMO_USED_DISCOUNT = 0.62;
