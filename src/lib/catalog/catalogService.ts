/**
 * Assembles the catalog from whichever sources are available.
 *
 * Colour availability comes from the bundled OMR-derived data
 * (data/catalog/bundled-catalog.json), which is always present and is keyed by
 * LDraw colour ids. An additional LDraw-native colour source can be supplied
 * through `ldrawNativeColors` and takes precedence.
 *
 * Mold equivalence rules come from data/catalog/mold-rules.json, plus anything
 * `npm run catalog:import` pulled from Rebrickable's part_relationships.csv.
 *
 * A part/colour combination that appears in NEITHER source is treated as
 * "not known to exist" and is never proposed. That biases the product towards
 * missing savings rather than recommending a colour that was never produced,
 * which is the trade the brief asks for.
 */

import type {
  CatalogMapping,
  CatalogService,
  CatalogSourceId,
  CatalogStatus,
  ColorAvailability,
  ColorMapping,
  EquivalentPartRule,
} from './types';
import { mapPartId, type ExternalIdTable } from './partMapping';
import { mapLDrawColorToBrickLink } from './colorMapping';

interface BundledEntry {
  n: number;
  sets: string[];
}

export interface BundledCatalogFile {
  schemaVersion: number;
  source: string;
  sourceUrl: string;
  licence: string;
  description: string;
  modelFileCount: number;
  setCount: number;
  partCount: number;
  pairCount: number;
  parts: Record<string, Record<string, BundledEntry>>;
}

export interface MoldRulesFile {
  schemaVersion: number;
  source: string;
  description: string;
  autoApplyThreshold: number;
  rules: EquivalentPartRule[];
}

export interface CatalogInputs {
  bundled: BundledCatalogFile;
  moldRules: MoldRulesFile;
  /**
   * Colour availability from a source that uses LDRAW colour ids.
   *
   * Deliberately not wired to the Rebrickable import: that data is keyed by
   * Rebrickable colour ids, and treating them as LDraw ids would silently
   * corrupt every colour-validity decision. The hook exists so a verified
   * LDraw-native colour source can be dropped in without touching the
   * optimiser. See docs/RESEARCH.md section 10.
   */
  ldrawNativeColors?: {
    source: string;
    label: string;
    /** part id -> LDRAW colour ids known to exist. */
    colorsByPart: ReadonlyMap<string, ReadonlySet<number>>;
    externalIds?: ExternalIdTable;
  };
  /** BrickLink colour ids resolved by name against the live API, when available. */
  brickLinkColorOverrides?: ReadonlyMap<number, number>;
}

export class DefaultCatalogService implements CatalogService {
  readonly status: CatalogStatus;
  private readonly bundled: BundledCatalogFile;
  private readonly extraColors: CatalogInputs['ldrawNativeColors'];
  private readonly rulesByPart: Map<string, EquivalentPartRule[]>;
  private readonly colorOverrides: ReadonlyMap<number, number> | undefined;
  private readonly externalIds: ExternalIdTable | undefined;

  constructor(inputs: CatalogInputs) {
    this.bundled = inputs.bundled;
    this.extraColors = inputs.ldrawNativeColors;
    this.colorOverrides = inputs.brickLinkColorOverrides;
    this.externalIds = inputs.ldrawNativeColors?.externalIds;

    const allRules = inputs.moldRules.rules;
    this.rulesByPart = new Map();
    for (const rule of allRules) {
      push(this.rulesByPart, rule.originalPart, rule);
      if (rule.bidirectional) {
        push(this.rulesByPart, rule.replacementPart, {
          ...rule,
          originalPart: rule.replacementPart,
          replacementPart: rule.originalPart,
        });
      }
    }
    for (const list of this.rulesByPart.values()) {
      list.sort((a, b) => b.confidence - a.confidence);
    }

    const usingExtra = this.extraColors !== undefined;
    const sourceId: CatalogSourceId = usingExtra ? 'rebrickable' : 'bundled-omr';
    const limitations: string[] = [];
    if (!usingExtra) {
      limitations.push(
        `Colour availability comes from ${this.bundled.setCount} official LEGO sets modelled in the ` +
          `LDraw Official Model Repository, covering ${this.bundled.partCount.toLocaleString()} parts. ` +
          `That is real data but far narrower than Rebrickable's full catalogue, so many parts will ` +
          `have no cheaper colour proposed simply because we cannot prove one exists.`,
      );
      limitations.push(
        'Run "npm run catalog:import" for Rebrickable\'s alternate-mold rules. Note that its ' +
          'colour data uses Rebrickable colour ids, so it is NOT used for colour validity.',
      );
    }
    limitations.push(
      'A part/colour combination that is not in the catalogue is never proposed, even if the price ' +
        'data suggests it would be cheaper.',
    );

    this.status = {
      sourceId,
      label: usingExtra ? this.extraColors!.label : 'Bundled LDraw OMR catalogue',
      description: usingExtra ? this.extraColors!.source : this.bundled.description,
      partCount: usingExtra ? this.extraColors!.colorsByPart.size : this.bundled.partCount,
      pairCount: usingExtra
        ? [...this.extraColors!.colorsByPart.values()].reduce((sum, set) => sum + set.size, 0)
        : this.bundled.pairCount,
      moldRuleCount: allRules.length,
      limitations,
    };
  }

  availableColors(partId: string): readonly ColorAvailability[] | null {
    const id = partId.toLowerCase();

    const fromExtra = this.extraColors?.colorsByPart.get(id);
    if (fromExtra) {
      return [...fromExtra].sort((a, b) => a - b).map((colorId) => ({
        colorId,
        evidence: {
          source: 'rebrickable' as CatalogSourceId,
          // The extra source records existence, not which set it came from.
          sets: [],
          observations: 1,
        },
      }));
    }

    const record = this.bundled.parts[id];
    if (!record) return null;
    return Object.entries(record)
      .map(([code, entry]) => ({
        colorId: Number(code),
        evidence: {
          source: 'bundled-omr' as CatalogSourceId,
          sets: entry.sets,
          observations: entry.n,
        },
      }))
      .sort((a, b) => a.colorId - b.colorId);
  }

  isKnownCombination(partId: string, colorId: number): boolean {
    const colors = this.availableColors(partId);
    if (!colors) return false;
    return colors.some((c) => c.colorId === colorId);
  }

  mapPart(partId: string): CatalogMapping {
    return mapPartId(partId, this.externalIds);
  }

  mapColor(colorId: number): ColorMapping {
    return mapLDrawColorToBrickLink(colorId, this.colorOverrides);
  }

  equivalents(partId: string): readonly EquivalentPartRule[] {
    return this.rulesByPart.get(partId.toLowerCase()) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
