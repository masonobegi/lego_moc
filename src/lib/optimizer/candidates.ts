/**
 * Groups part instances by the command that produced them.
 *
 * This is the structure everything else in the optimiser is built on. A group
 * is the smallest thing that can be changed: one line type 1. If that line sits
 * inside a submodel referenced four times, the group has four instances and a
 * quantity of four, and the change applies to all of them or to none.
 */

import { COLOR_EDGE, COLOR_INHERIT } from '../ldraw/parser';
import { isSubstitutableColor } from '../ldraw/colors';
import { commandRefKey, type CommandRef, type PartInstance } from '../ldraw/types';

export interface CommandGroup {
  readonly key: string;
  readonly commandRef: CommandRef;
  readonly partId: string;
  readonly partFile: string;
  /** Colour as written on the line. */
  readonly declaredColorId: number;
  /**
   * Effective colour, when every instance resolves to the same one.
   * `null` when the line uses colour 16 and different parents give different
   * results - such a line cannot be recoloured in place.
   */
  readonly effectiveColorId: number | null;
  readonly instances: readonly PartInstance[];
  readonly quantity: number;
  readonly parentModel: string;
  readonly stepIndex: number;
  /** True when the line's colour can be rewritten at all. */
  readonly isRecolourable: boolean;
  readonly notRecolourableReason: string | null;
}

export function groupInstancesByCommand(instances: readonly PartInstance[]): CommandGroup[] {
  const groups = new Map<string, PartInstance[]>();
  for (const instance of instances) {
    const key = commandRefKey(instance.commandRef);
    const list = groups.get(key);
    if (list) list.push(instance);
    else groups.set(key, [instance]);
  }

  const out: CommandGroup[] = [];
  for (const [key, list] of groups) {
    const first = list[0]!;
    const colors = new Set(list.map((i) => i.colorId));
    const effectiveColorId = colors.size === 1 ? first.colorId : null;

    let isRecolourable = true;
    let reason: string | null = null;

    if (first.declaredColorId === COLOR_INHERIT) {
      isRecolourable = false;
      reason =
        'This part is drawn in colour 16, meaning it takes its colour from whatever references it. ' +
        'Rewriting it here would change the colour of the submodel as a whole.';
    } else if (first.declaredColorId === COLOR_EDGE) {
      isRecolourable = false;
      reason = 'This part uses LDraw colour 24 (edge colour), which is not a purchasable colour.';
    } else if (!isSubstitutableColor(first.declaredColorId)) {
      isRecolourable = false;
      reason = `LDraw colour ${first.declaredColorId} is a direct colour or is not in the official palette, so no equivalent element exists to buy.`;
    } else if (effectiveColorId === null) {
      isRecolourable = false;
      reason =
        'The instances produced by this line do not all end up the same colour, so a single ' +
        'replacement colour would not be correct for all of them.';
    }

    out.push({
      key,
      commandRef: first.commandRef,
      partId: first.partId,
      partFile: first.partFile,
      declaredColorId: first.declaredColorId,
      effectiveColorId,
      instances: list,
      quantity: list.length,
      parentModel: first.parentModel,
      stepIndex: first.stepIndex,
      isRecolourable,
      notRecolourableReason: reason,
    });
  }

  // Stable order: by file, then by line, so results are reproducible.
  out.sort((a, b) =>
    a.commandRef.fileIndex === b.commandRef.fileIndex
      ? a.commandRef.commandIndex - b.commandRef.commandIndex
      : a.commandRef.fileIndex - b.commandRef.fileIndex,
  );
  return out;
}

export { commandRefKey };
