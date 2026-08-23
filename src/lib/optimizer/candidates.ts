/**
 * Groups part instances by the command that produced them.
 *
 * This is the structure everything else in the optimizer is built on. A group
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
  /** Color as written on the line. */
  readonly declaredColorId: number;
  /**
   * Effective color, when every instance resolves to the same one.
   * `null` when the line uses color 16 and different parents give different
   * results - such a line cannot be recolored in place.
   */
  readonly effectiveColorId: number | null;
  readonly instances: readonly PartInstance[];
  readonly quantity: number;
  readonly parentModel: string;
  readonly stepIndex: number;
  /** True when the line's color can be rewritten at all. */
  readonly isRecolorable: boolean;
  readonly notRecolorableReason: string | null;
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

    let isRecolorable = true;
    let reason: string | null = null;

    if (first.declaredColorId === COLOR_INHERIT) {
      isRecolorable = false;
      reason =
        'This part is drawn in color 16, meaning it takes its color from whatever references it. ' +
        'Rewriting it here would change the color of the submodel as a whole.';
    } else if (first.declaredColorId === COLOR_EDGE) {
      isRecolorable = false;
      reason = 'This part uses LDraw color 24 (edge color), which is not a purchasable color.';
    } else if (!isSubstitutableColor(first.declaredColorId)) {
      isRecolorable = false;
      reason = `LDraw color ${first.declaredColorId} is a direct color or is not in the official palette, so no equivalent element exists to buy.`;
    } else if (effectiveColorId === null) {
      isRecolorable = false;
      reason =
        'The instances produced by this line do not all end up the same color, so a single ' +
        'replacement color would not be correct for all of them.';
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
      isRecolorable,
      notRecolorableReason: reason,
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
