/**
 * LDraw part id  <->  BrickLink / Rebrickable / LEGO design id.
 *
 * There is no free, official, complete crosswalk between the catalogues
 * (docs/RESEARCH.md section 10). For the large majority of ordinary elements
 * the three agree - `3001` is Brick 2 x 4 everywhere - but they diverge for:
 *
 *   printed parts   LDraw `3626bp01`   BrickLink `3626bpb0001`
 *   stickered parts LDraw `3068bd01`   BrickLink uses a different scheme
 *   assemblies      LDraw models some things as one part that BrickLink sells
 *                   as several
 *
 * So this returns an explicit confidence with every mapping, and callers that
 * spend money on the answer (live BrickLink pricing, Wanted List export) refuse
 * anything below `identity`. Guessing is not an option here: a wrong id would
 * silently price the wrong part.
 */

import type { CatalogMapping, MappingConfidence } from './types';

/** A plain design number, optionally with a mold-variant letter: 3001, 3068b, 44301a. */
const PLAIN_ID = /^[0-9]{1,7}[a-z]{0,2}$/;
/** Printed decoration: 3626bp01, 973pb1234. LDraw and BrickLink number these differently. */
const PRINTED_ID = /^[0-9]{1,7}[a-z]{0,2}p[0-9a-z]+$/;
/** Sticker: 3068bd01. */
const STICKER_ID = /^[0-9]{1,7}[a-z]{0,2}d[0-9a-z]+$/;
/** LDraw shortcut/assembly parts, numbered `cNN`, and unofficial `uNNNN` parts. */
const SHORTCUT_ID = /^[0-9]{1,7}[a-z]{0,2}c[0-9]+$/;
const UNOFFICIAL_ID = /^u[0-9]+/;

/**
 * Curated exceptions, applied before the pattern rules.
 * Kept deliberately small: every entry is a claim we are asserting, so it has
 * to be one we can stand behind.
 */
const CURATED: ReadonlyMap<string, { brickLink: string; note: string }> = new Map([
  [
    '6141',
    {
      brickLink: '4073',
      note: 'LDraw renamed Plate Round 1 x 1 from 4073 to 6141 in 2015; BrickLink still lists it as 4073.',
    },
  ],
  [
    '4073',
    {
      brickLink: '4073',
      note: 'LDraw 4073 is an alias of 6141; BrickLink uses 4073.',
    },
  ],
]);

export interface ExternalIdTable {
  /** LDraw part id -> external ids, from Rebrickable `external_ids`. */
  readonly byLDrawId: ReadonlyMap<string, { bricklink?: string; rebrickable?: string; lego?: string }>;
  readonly source: string;
}

export function mapPartId(partId: string, external?: ExternalIdTable): CatalogMapping {
  const id = partId.trim().toLowerCase();

  const unmapped = (note: string): CatalogMapping => ({
    ldrawPartId: id,
    brickLinkPartId: null,
    rebrickablePartId: null,
    legoDesignId: null,
    confidence: 'unmapped' as MappingConfidence,
    note,
  });

  if (id.length === 0) return unmapped('Empty part id.');
  if (id.includes('/')) {
    return unmapped('This is an LDraw sub-part, not a purchasable element.');
  }

  const fromExternal = external?.byLDrawId.get(id);
  if (fromExternal?.bricklink) {
    return {
      ldrawPartId: id,
      brickLinkPartId: fromExternal.bricklink,
      rebrickablePartId: fromExternal.rebrickable ?? null,
      legoDesignId: fromExternal.lego ?? null,
      confidence: 'verified',
      note: `Mapped via Rebrickable external ids (${external!.source}).`,
    };
  }

  const curated = CURATED.get(id);
  if (curated) {
    return {
      ldrawPartId: id,
      brickLinkPartId: curated.brickLink,
      rebrickablePartId: curated.brickLink,
      legoDesignId: null,
      confidence: 'verified',
      note: curated.note,
    };
  }

  if (UNOFFICIAL_ID.test(id)) {
    return unmapped('Unofficial LDraw part; there is no matching BrickLink catalogue entry.');
  }
  if (PRINTED_ID.test(id)) {
    return unmapped(
      'Printed part. LDraw and BrickLink number printed decorations differently, so the id cannot ' +
        'be mapped reliably without a catalogue lookup. Run "npm run catalog:import" with a ' +
        'Rebrickable API key to resolve these.',
    );
  }
  if (STICKER_ID.test(id)) {
    return unmapped('Stickered part; LDraw and BrickLink number these differently.');
  }
  if (SHORTCUT_ID.test(id)) {
    return unmapped(
      'LDraw shortcut/assembly part. BrickLink may sell this as several separate items, so it ' +
        'cannot be priced as one.',
    );
  }
  if (PLAIN_ID.test(id)) {
    return {
      ldrawPartId: id,
      brickLinkPartId: id,
      rebrickablePartId: id,
      legoDesignId: id.replace(/[a-z]+$/, ''),
      confidence: 'identity',
      note:
        'LDraw, BrickLink and Rebrickable use the same number for this element. Verified for ' +
        'ordinary elements; not confirmed against a live catalogue.',
    };
  }
  return unmapped(`Unrecognised LDraw part id format "${partId}".`);
}
