/**
 * Catalog types.
 *
 * The catalog answers three questions the optimiser cannot answer from the
 * model file alone:
 *   1. Which colours has this part actually been produced in?
 *   2. What is this part called in BrickLink's and Rebrickable's catalogues?
 *   3. Which other part is a verified drop-in replacement for this one?
 *
 * Everything is behind an interface so the offline bundled data and the
 * Rebrickable import are interchangeable, and so a future source can be added
 * without touching the optimiser.
 */

export type CatalogSourceId = 'bundled-omr' | 'rebrickable' | 'bricklink';

export interface ColorEvidence {
  readonly source: CatalogSourceId;
  /** Official set numbers the part+colour was observed in, where known. */
  readonly sets: readonly string[];
  /** How many times the combination was observed. */
  readonly observations: number;
}

export interface ColorAvailability {
  readonly colorId: number;
  readonly evidence: ColorEvidence;
}

/**
 * How much we trust a cross-catalogue id mapping.
 *  verified - from a curated table or a Rebrickable `external_ids` lookup
 *  identity - the LDraw id is a plain number/letter form with no known
 *             divergence, so it is used as-is. True for most ordinary elements.
 *  unmapped - we do not have a usable id and must not guess.
 */
export type MappingConfidence = 'verified' | 'identity' | 'unmapped';

export interface CatalogMapping {
  readonly ldrawPartId: string;
  readonly brickLinkPartId: string | null;
  readonly rebrickablePartId: string | null;
  readonly legoDesignId: string | null;
  readonly confidence: MappingConfidence;
  readonly note: string | null;
}

export interface ColorMapping {
  readonly ldrawColorId: number;
  readonly brickLinkColorId: number | null;
  readonly confidence: MappingConfidence;
  readonly source: string;
}

export type EquivalenceType = 'mold_variant' | 'superseded' | 'functionally_equivalent';

/**
 * How much swapping in the replacement changes what the model looks like.
 *  none    - physically the same element, catalogued under two numbers
 *  subtle  - a small visible difference such as a groove along a tile's edge
 *  unknown - not assessed; such a rule is never applied automatically
 *
 * A rule whose impact is not `none` is only ever applied to parts the
 * visibility engine classified as hidden.
 */
export type AppearanceImpact = 'none' | 'subtle' | 'unknown';

/**
 * A one-to-one part substitution. V1 never replaces one part with several, and
 * never proposes a substitution that changes the model's construction.
 */
export interface EquivalentPartRule {
  readonly originalPart: string;
  readonly replacementPart: string;
  readonly type: EquivalenceType;
  /** True only when the two parts occupy the same space and connect identically. */
  readonly geometryCompatible: boolean;
  /** 0-1. Only rules at or above the safety threshold are ever applied. */
  readonly confidence: number;
  /** Where the rule came from, shown verbatim in the UI. */
  readonly source: string;
  /** What differs between the two parts, in plain language. */
  readonly note: string;
  /** True if the rule may be applied in both directions. */
  readonly bidirectional: boolean;
  readonly appearanceImpact: AppearanceImpact;
}

export interface CatalogStatus {
  readonly sourceId: CatalogSourceId;
  readonly label: string;
  readonly description: string;
  readonly partCount: number;
  readonly pairCount: number;
  readonly moldRuleCount: number;
  /** Warnings the UI should surface, e.g. limited coverage. */
  readonly limitations: readonly string[];
}

export interface CatalogService {
  readonly status: CatalogStatus;
  /** Colours the part is known to exist in. `null` means the part is unknown to the catalog. */
  availableColors(partId: string): readonly ColorAvailability[] | null;
  /** Whether a specific part+colour combination is known to exist. */
  isKnownCombination(partId: string, colorId: number): boolean;
  mapPart(partId: string): CatalogMapping;
  mapColor(colorId: number): ColorMapping;
  /** One-to-one replacements for a part, best first. */
  equivalents(partId: string): readonly EquivalentPartRule[];
}
