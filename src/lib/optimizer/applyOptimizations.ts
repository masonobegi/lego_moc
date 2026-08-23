/**
 * Produces the optimized document.
 *
 * This is where the promise "the exported file really is different" is kept.
 * It edits the SAME line the candidate identified, in place, changing only the
 * color field and/or the part reference. Nothing is inserted, removed or
 * reordered, so:
 *
 *   - `0 STEP` boundaries keep exactly the parts they had;
 *   - submodel structure is untouched;
 *   - every other line, including comments and unknown META commands, keeps its
 *     original bytes.
 *
 * The uploaded source document is never mutated: a new document is built with
 * copied command arrays, so "Reset to original" is always available.
 */

import { referenceToPartId } from '../ldraw/parser';
import type { LDrawDocument, ModelFile, PartCommand } from '../ldraw/types';
import { commandRefKey } from '../ldraw/types';
import type { OptimizationCandidate } from './types';

export interface ApplyResult {
  readonly document: LDrawDocument;
  readonly appliedCount: number;
  readonly changedPieceCount: number;
  /** Candidates that could not be applied, with a reason. */
  readonly skipped: readonly { candidateId: string; reason: string }[];
}

/**
 * Rewrite the part id inside an LDraw reference, keeping any directory prefix,
 * the original extension and its case. `3068a.dat` -> `3068b.dat`.
 */
export function replacePartInReference(reference: string, newPartId: string): string {
  const separator = reference.lastIndexOf('\\') >= 0 ? '\\' : reference.lastIndexOf('/') >= 0 ? '/' : '';
  const cut = Math.max(reference.lastIndexOf('\\'), reference.lastIndexOf('/'));
  const prefix = cut >= 0 ? reference.slice(0, cut) + separator : '';
  const filename = cut >= 0 ? reference.slice(cut + 1) : reference;
  const dot = filename.lastIndexOf('.');
  const extension = dot >= 0 ? filename.slice(dot) : '.dat';
  return `${prefix}${newPartId}${extension}`;
}

export function applyOptimizations(
  document: LDrawDocument,
  candidates: readonly OptimizationCandidate[],
  enabledIds: ReadonlySet<string>,
): ApplyResult {
  const skipped: { candidateId: string; reason: string }[] = [];
  const byCommand = new Map<string, OptimizationCandidate>();

  for (const candidate of candidates) {
    if (!enabledIds.has(candidate.id)) continue;
    const key = commandRefKey(candidate.commandRef);
    const existing = byCommand.get(key);
    if (existing) {
      // Two changes cannot both rewrite the same line. Keep the bigger saving.
      const loser = existing.savings >= candidate.savings ? candidate : existing;
      const winner = existing.savings >= candidate.savings ? existing : candidate;
      byCommand.set(key, winner);
      skipped.push({
        candidateId: loser.id,
        reason: `Conflicts with ${winner.id}: both would rewrite the same line. The larger saving was kept.`,
      });
      continue;
    }
    byCommand.set(key, candidate);
  }

  // Copy the command arrays so the original document is never touched.
  const files: ModelFile[] = document.files.map((file) => ({ ...file, commands: [...file.commands] }));

  let appliedCount = 0;
  let changedPieceCount = 0;

  for (const candidate of byCommand.values()) {
    const file = files[candidate.commandRef.fileIndex];
    if (!file) {
      skipped.push({ candidateId: candidate.id, reason: 'Target sub-file no longer exists.' });
      continue;
    }
    const command = file.commands[candidate.commandRef.commandIndex];
    if (!command || command.type !== 'part') {
      skipped.push({ candidateId: candidate.id, reason: 'Target line is not a part reference.' });
      continue;
    }

    const isPartSwap = candidate.replacementPartId !== candidate.originalPartId;
    const isColorChange = candidate.replacementColorId !== candidate.originalColorId;

    // Validate whichever field the change actually depends on.
    //
    // A pure mold swap does not touch the color at all, and its line may
    // legitimately carry color 16 (inherit) - whose EFFECTIVE color is what the
    // candidate recorded, not what is written on the line. Checking the written
    // color against the effective one used to make every such change fail this
    // guard, so it was priced, counted in the savings and then silently dropped
    // from the export.
    if (isColorChange && command.colorId !== candidate.originalColorId) {
      skipped.push({
        candidateId: candidate.id,
        reason: `Target line has color ${command.colorId}, expected ${candidate.originalColorId}.`,
      });
      continue;
    }
    if (isPartSwap && referenceToPartId(command.file) !== candidate.originalPartId) {
      skipped.push({
        candidateId: candidate.id,
        reason:
          `Target line references ${command.file}, expected part ${candidate.originalPartId}.`,
      });
      continue;
    }

    const newFile = isPartSwap
      ? replacePartInReference(command.file, candidate.replacementPartId)
      : command.file;

    const replacement: PartCommand = {
      type: 'part',
      // raw is cleared so the serializer regenerates this one line from its
      // fields. Every other line still emits its original bytes.
      raw: null,
      sourceLine: command.sourceLine,
      // A pure part swap must leave the color field exactly as written,
      // including colour 16.
      colorId: isColorChange ? candidate.replacementColorId : command.colorId,
      position: command.position,
      matrix: command.matrix,
      file: newFile,
    };

    file.commands[candidate.commandRef.commandIndex] = replacement;
    appliedCount++;
    changedPieceCount += candidate.quantity;
  }

  return {
    document: { ...document, files },
    appliedCount,
    changedPieceCount,
    skipped,
  };
}
