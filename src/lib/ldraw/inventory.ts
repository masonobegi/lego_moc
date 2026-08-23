/**
 * Counting part instances into lots.
 *
 * A "lot" is one (part, color) pair - the unit BrickLink sells in and the unit
 * every parts list in this app is expressed in. Turning a flat list of part
 * instances into lots is a two-line loop, which is exactly why it had been
 * written separately in the price engine, the Wanted List exporter and the
 * inventory delta.
 *
 * Three copies of the same two lines is not a style problem. If any one of them
 * ever keys lots differently from the others, the cost summary, the Wanted List
 * and the delta start describing different orders while all looking correct.
 * One implementation, used everywhere.
 */

import type { PartInstance } from './types';

export interface LotCount {
  readonly partId: string;
  readonly colorId: number;
  readonly quantity: number;
}

export function lotKey(partId: string, colorId: number): string {
  return `${partId}|${colorId}`;
}

/** Lots keyed by `lotKey`, quantities summed. Order follows first appearance. */
export function countLots(instances: readonly PartInstance[]): Map<string, LotCount> {
  const counts = new Map<string, { partId: string; colorId: number; quantity: number }>();
  for (const instance of instances) {
    const key = lotKey(instance.partId, instance.colorId);
    const existing = counts.get(key);
    if (existing) existing.quantity++;
    else counts.set(key, { partId: instance.partId, colorId: instance.colorId, quantity: 1 });
  }
  return counts;
}
