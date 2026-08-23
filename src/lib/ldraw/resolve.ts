/**
 * Flattens a parsed LDraw document into the list of physical part instances
 * that make up the completed model.
 *
 * The subtle part is instance identity. A submodel referenced three times
 * produces three physical instances from ONE line type 1. Those three
 * instances share a `commandRef`, because that line is the only place a change
 * can be written. The optimizer relies on this: it groups candidates by
 * commandRef and refuses a change unless every instance sharing that command is
 * safe. See src/lib/optimizer/candidates.ts.
 */

import { LIMITS } from '../security/limits';
import { IDENTITY_MAT3, composeTransform, type Mat3, type Vec3 } from './math';
import { COLOR_EDGE, COLOR_INHERIT, normalizeReference, referenceToPartId } from './parser';
import type {
  CommandRef,
  LDrawDocument,
  ModelFile,
  ParseWarning,
  PartInstance,
  ResolvedModel,
} from './types';

interface Frame {
  fileIndex: number;
  matrix: Mat3;
  position: Vec3;
  color: number;
  depth: number;
  path: string;
  modelPath: readonly string[];
  /** File indices currently on the reference path, for cycle detection. */
  ancestors: ReadonlySet<number>;
}

/**
 * Build the lookup from a reference string to a sub-file index.
 *
 * Per the MPD spec, in-document sub-files take precedence over library parts of
 * the same name, matching is case-insensitive, and `\` is equivalent to `/`.
 * When a name is declared twice the first declaration wins.
 */
export function buildFileIndex(document: LDrawDocument): Map<string, number> {
  const index = new Map<string, number>();
  document.files.forEach((file, i) => {
    if (file.isAnonymous && !(i === 0 && !document.isMpd)) return;
    const key = normalizeReference(file.name);
    if (!index.has(key)) index.set(key, i);
  });
  return index;
}

export interface ResolveOptions {
  /** Stop after this many instances. Defaults to LIMITS.maxInstances. */
  maxInstances?: number;
  maxDepth?: number;
  /**
   * Stop after visiting this many sub-file frames.
   *
   * The instance cap alone is not enough. Cycle detection uses the current DFS
   * PATH, so a sub-file reachable by several routes is legitimately re-expanded
   * once per route - a diamond-shaped reference graph is exponential in depth.
   * A document of nothing but submodels referencing each other, containing no
   * library parts at all, produces no instances and so never trips the instance
   * cap while expanding forever. This bounds the walk itself.
   */
  maxFrames?: number;
}

export function resolveModel(document: LDrawDocument, options: ResolveOptions = {}): ResolvedModel {
  const maxInstances = options.maxInstances ?? LIMITS.maxInstances;
  const maxDepth = options.maxDepth ?? LIMITS.maxDepth;
  const maxFrames = options.maxFrames ?? LIMITS.maxExpansionFrames;

  const fileIndex = buildFileIndex(document);
  const rootIndex = fileIndex.get(normalizeReference(document.rootFile)) ?? 0;

  const instances: PartInstance[] = [];
  const warnings: ParseWarning[] = [];
  const unresolvedSubmodels = new Set<string>();
  const visitedFiles = new Set<number>();
  const cyclesReported = new Set<string>();

  let truncated = false;
  let truncationReason: string | null = null;

  const stack: Frame[] = [
    {
      fileIndex: rootIndex,
      matrix: IDENTITY_MAT3,
      position: { x: 0, y: 0, z: 0 },
      color: COLOR_INHERIT,
      depth: 0,
      path: '',
      modelPath: [document.files[rootIndex]?.name ?? document.rootFile],
      ancestors: new Set([rootIndex]),
    },
  ];

  let framesVisited = 0;

  // Iterative DFS. Explicit stack rather than recursion so a deeply nested
  // hostile document cannot blow the JS call stack.
  while (stack.length > 0) {
    if (++framesVisited > maxFrames) {
      truncated = true;
      truncationReason =
        `Expanding this model's submodel references exceeded ${maxFrames.toLocaleString()} steps. ` +
        `That usually means submodels reference each other in a way that multiplies out ` +
        `exponentially. Analysis was stopped at that point.`;
      break;
    }
    const frame = stack.pop()!;
    const file: ModelFile | undefined = document.files[frame.fileIndex];
    if (!file) continue;
    visitedFiles.add(frame.fileIndex);

    let stepIndex = 0;
    // Collect this frame's child references first so we can push them in
    // reverse and keep document order in the output.
    const children: Frame[] = [];

    for (let commandIndex = 0; commandIndex < file.commands.length; commandIndex++) {
      const command = file.commands[commandIndex]!;

      if (command.type === 'meta' && command.keyword === 'STEP') {
        stepIndex++;
        continue;
      }
      if (command.type !== 'part') continue;

      const declaredColorId = command.colorId;
      const effectiveColor =
        declaredColorId === COLOR_INHERIT
          ? frame.color
          : declaredColorId === COLOR_EDGE
            ? COLOR_EDGE
            : declaredColorId;

      const ref: CommandRef = { fileIndex: frame.fileIndex, commandIndex };
      const childPath = frame.path === '' ? `${frame.fileIndex}.${commandIndex}` : `${frame.path}/${frame.fileIndex}.${commandIndex}`;

      const targetIndex = fileIndex.get(normalizeReference(command.file));

      if (targetIndex !== undefined) {
        // ---- Submodel reference -------------------------------------------
        if (frame.ancestors.has(targetIndex)) {
          const key = `${frame.fileIndex}->${targetIndex}`;
          if (!cyclesReported.has(key)) {
            cyclesReported.add(key);
            warnings.push({
              code: 'truncated',
              message:
                `Sub-file "${command.file}" refers back to "${file.name}", which would recurse forever. ` +
                `The reference was skipped; the rest of the model was imported normally.`,
              line: command.sourceLine,
              file: file.name,
            });
          }
          continue;
        }
        if (frame.depth + 1 > maxDepth) {
          truncated = true;
          truncationReason = `Submodel nesting deeper than ${maxDepth} levels was not expanded.`;
          continue;
        }
        const composed = composeTransform(frame.matrix, frame.position, command.matrix, command.position);
        const nextAncestors = new Set(frame.ancestors);
        nextAncestors.add(targetIndex);
        children.push({
          fileIndex: targetIndex,
          matrix: composed.matrix,
          position: composed.position,
          color: effectiveColor,
          depth: frame.depth + 1,
          path: childPath,
          modelPath: [...frame.modelPath, document.files[targetIndex]!.name],
          ancestors: nextAncestors,
        });
        continue;
      }

      // ---- Library part reference -----------------------------------------
      const partId = referenceToPartId(command.file);
      if (!command.file.toLowerCase().endsWith('.dat')) {
        // A non-.dat reference that is not a sub-file in this document: the
        // model depends on an external file we do not have.
        unresolvedSubmodels.add(command.file);
      }

      if (instances.length >= maxInstances) {
        truncated = true;
        truncationReason = `Model expands to more than ${maxInstances.toLocaleString()} parts; analysis was stopped at that point.`;
        break;
      }

      const composed = composeTransform(frame.matrix, frame.position, command.matrix, command.position);
      instances.push({
        instanceId: childPath,
        partId,
        partFile: command.file,
        colorId: effectiveColor,
        declaredColorId,
        position: composed.position,
        transformation: composed.matrix,
        stepIndex,
        parentModel: file.name,
        modelPath: frame.modelPath,
        depth: frame.depth,
        commandRef: ref,
      });
    }

    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    if (truncated && truncationReason?.startsWith('Model expands')) break;
  }

  const rootFile = document.files[rootIndex];
  const rootStepCount = rootFile ? countSteps(rootFile) : 0;

  return {
    document,
    instances,
    unresolvedSubmodels: [...unresolvedSubmodels],
    rootStepCount,
    submodelCount: Math.max(0, visitedFiles.size - 1),
    warnings,
    truncated,
    truncationReason,
  };
}

/**
 * Number of build steps in a sub-file. A file with no `0 STEP` is one step.
 * A trailing `0 STEP` does not create an empty extra step.
 */
export function countSteps(file: ModelFile): number {
  let steps = 0;
  let contentSinceStep = false;
  for (const command of file.commands) {
    if (command.type === 'meta' && command.keyword === 'STEP') {
      if (contentSinceStep) steps++;
      contentSinceStep = false;
      continue;
    }
    if (command.type === 'part') contentSinceStep = true;
  }
  if (contentSinceStep) steps++;
  return steps;
}

/** Distinct `partId + colorId` combinations, i.e. the number of BrickLink "lots". */
export function countUniqueLots(instances: readonly PartInstance[]): number {
  const set = new Set<string>();
  for (const instance of instances) set.add(`${instance.partId}|${instance.colorId}`);
  return set.size;
}

export interface ModelSummary {
  partCount: number;
  uniqueLotCount: number;
  uniquePartCount: number;
  stepCount: number;
  submodelCount: number;
  unresolvedSubmodels: string[];
  truncated: boolean;
  truncationReason: string | null;
}

export function summarizeModel(resolved: ResolvedModel): ModelSummary {
  const uniqueParts = new Set<string>();
  for (const instance of resolved.instances) uniqueParts.add(instance.partId);
  return {
    partCount: resolved.instances.length,
    uniqueLotCount: countUniqueLots(resolved.instances),
    uniquePartCount: uniqueParts.size,
    stepCount: totalStepCount(resolved),
    submodelCount: resolved.submodelCount,
    unresolvedSubmodels: resolved.unresolvedSubmodels,
    truncated: resolved.truncated,
    truncationReason: resolved.truncationReason,
  };
}

/**
 * Total build steps across every sub-file that is actually reachable, which is
 * what a builder following the instructions would experience.
 */
export function totalStepCount(resolved: ResolvedModel): number {
  const reachable = new Set<number>();
  for (const instance of resolved.instances) reachable.add(instance.commandRef.fileIndex);
  let total = 0;
  for (const index of reachable) {
    const file = resolved.document.files[index];
    if (file) total += countSteps(file);
  }
  return total;
}
