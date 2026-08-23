/**
 * Optimized LDraw export.
 *
 * The exported file is produced by re-serializing the document after the
 * enabled changes have been written into it. Every line the optimizer did not
 * touch is emitted with its original bytes, so the output differs from the
 * input by exactly the lines that were changed and nothing else.
 *
 * A header block is prepended recording what was changed, because a file that
 * silently differs from the designer's original would be worse than useless
 * six months later. LDraw `0` lines are comments, so this is valid in any
 * reader, and it sits above the first `0 FILE` so MPD structure is unaffected.
 */

import { serializeDocument } from '../ldraw/serializer';
import type { LDrawDocument } from '../ldraw/types';
import { applyOptimizations } from '../optimizer/applyOptimizations';
import type { OptimizationCandidate } from '../optimizer/types';

export interface LDrawExportOptions {
  readonly document: LDrawDocument;
  readonly candidates: readonly OptimizationCandidate[];
  readonly enabledIds: ReadonlySet<string>;
  readonly modelName: string;
  readonly priceSourceLabel: string;
  readonly includeHeader?: boolean;
}

export interface LDrawExportResult {
  readonly text: string;
  readonly fileName: string;
  readonly appliedCount: number;
  readonly changedPieceCount: number;
  readonly skipped: readonly { candidateId: string; reason: string }[];
}

export function exportOptimizedLDraw(options: LDrawExportOptions): LDrawExportResult {
  const applied = applyOptimizations(options.document, options.candidates, options.enabledIds);
  const body = serializeDocument(applied.document);

  const eol = options.document.lineEnding;
  const header =
    options.includeHeader === false
      ? ''
      : buildHeader(options, applied.appliedCount, applied.changedPieceCount).join(eol) + eol;

  const base = options.modelName.replace(/\.(ldr|mpd)$/i, '');
  const extension = options.document.isMpd ? '.mpd' : '.ldr';

  return {
    text: header + body,
    fileName: `${base}-optimized${extension}`,
    appliedCount: applied.appliedCount,
    changedPieceCount: applied.changedPieceCount,
    skipped: applied.skipped,
  };
}

function buildHeader(
  options: LDrawExportOptions,
  appliedCount: number,
  changedPieceCount: number,
): string[] {
  const enabled = options.candidates.filter((c) => options.enabledIds.has(c.id));
  const colorChanges = enabled.filter((c) => c.kind === 'hidden_color').length;
  const moldChanges = enabled.filter((c) => c.kind === 'mold_equivalent').length;

  const lines = [
    '0 // ---------------------------------------------------------------------',
    '0 // Optimized by BrickThrift.',
    `0 // Source model: ${options.modelName}`,
    `0 // ${appliedCount} line(s) changed, affecting ${changedPieceCount} physical part(s).`,
    `0 //   ${colorChanges} hidden-color substitution(s), ${moldChanges} equivalent-mold substitution(s).`,
    `0 // Price source: ${options.priceSourceLabel}`,
    '0 // Build steps, submodel structure and part positions are unchanged: only',
    '0 // the color and part fields of the listed lines were rewritten in place.',
    '0 //',
  ];

  for (const candidate of enabled.slice(0, 200)) {
    const change =
      candidate.originalPartId === candidate.replacementPartId
        ? `${candidate.originalColorName} -> ${candidate.replacementColorName}`
        : `${candidate.originalPartId} -> ${candidate.replacementPartId}`;
    lines.push(
      `0 // ${candidate.parentModel} step ${candidate.stepIndex + 1}: ${candidate.partDescription} ` +
        `${change} (x${candidate.quantity})`,
    );
  }
  if (enabled.length > 200) {
    lines.push(`0 // ...and ${enabled.length - 200} more, see the CSV change log.`);
  }

  lines.push('0 // ---------------------------------------------------------------------');
  return lines;
}
