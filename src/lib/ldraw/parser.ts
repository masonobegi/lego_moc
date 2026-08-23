/**
 * LDraw / MPD parser.
 *
 * Implements the line types and META handling described in the LDraw File
 * Format Specification (https://ldraw.org/article/218.html) and the MPD
 * specification (https://www.ldraw.org/article/47.html). See docs/RESEARCH.md
 * sections 1-3 for the exact rules this implements and why.
 *
 * Invariants this parser guarantees:
 *  - Every source line produces exactly one LDrawCommand, in order.
 *  - Every command keeps its original text in `raw`, so an unmodified document
 *    serializes back byte-for-byte.
 *  - A line we cannot understand becomes a `malformed` command and a warning.
 *    It is never dropped and never throws.
 */

import { LIMITS } from '../security/limits';
import type { Mat3, Vec3 } from './math';
import type {
  LDrawCommand,
  LDrawDocument,
  MetaCommand,
  ModelFile,
  ParseWarning,
} from './types';

/** Color 16: inherit the color of the referencing line. */
export const COLOR_INHERIT = 16;
/** Color 24: complement/edge color of the referencing line. */
export const COLOR_EDGE = 24;
/** Direct ("0x2RRGGBB") colors are stored as this value + the RGB triple. */
export const DIRECT_COLOR_BASE = 0x2000000;

export function isDirectColor(colorId: number): boolean {
  return colorId >= DIRECT_COLOR_BASE;
}

export function directColorToHex(colorId: number): string {
  return `#${(colorId - DIRECT_COLOR_BASE).toString(16).padStart(6, '0')}`;
}

export interface ParseOptions {
  /** Name to give the implicit block of a plain `.ldr`. Defaults to `model.ldr`. */
  sourceName?: string;
}

/**
 * Normalize an LDraw sub-file reference for lookup:
 * lowercase, backslashes to forward slashes, whitespace trimmed.
 * Reference resolution in LDraw is case-insensitive and `\` is the historical
 * path separator.
 */
export function normalizeReference(reference: string): string {
  return reference.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * Reduce a reference to a bare part id: `s/3001s01.dat` -> `s/3001s01`,
 * `3001.DAT` -> `3001`. Directory components are kept because LDraw
 * distinguishes `parts/3001.dat` from `parts/s/3001s01.dat`.
 */
export function referenceToPartId(reference: string): string {
  const norm = normalizeReference(reference);
  return norm.endsWith('.dat') ? norm.slice(0, -4) : norm;
}

function parseNumber(token: string): number | null {
  // Number() accepts '' and whitespace as 0; guard explicitly.
  if (token.length === 0) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse the color field. Accepts a plain LDraw color code, or a direct color
 * in `0x2RRGGBB` / `#RRGGBB` form.
 */
export function parseColorToken(token: string): number | null {
  if (/^0x2[0-9a-fA-F]{6}$/.test(token)) {
    return DIRECT_COLOR_BASE + Number.parseInt(token.slice(3), 16);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(token)) {
    return DIRECT_COLOR_BASE + Number.parseInt(token.slice(1), 16);
  }
  const value = parseNumber(token);
  if (value === null || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Split a line into whitespace-delimited tokens while recording where each
 * token started, so a trailing filename containing spaces can be recovered
 * from the original text.
 */
function tokenizeWithOffsets(line: string): { tokens: string[]; starts: number[] } {
  const tokens: string[] = [];
  const starts: number[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(line.charCodeAt(i))) i++;
    tokens.push(line.slice(start, i));
    starts.push(start);
  }
  return { tokens, starts };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 11 || code === 12;
}

const GEOMETRY_ARITY: Record<number, { type: 'line' | 'triangle' | 'quad' | 'optionalLine'; coords: number }> = {
  2: { type: 'line', coords: 6 },
  3: { type: 'triangle', coords: 9 },
  4: { type: 'quad', coords: 12 },
  5: { type: 'optionalLine', coords: 12 },
};

function parseLine(raw: string, sourceLine: number): { command: LDrawCommand; warning: ParseWarning | null } {
  if (raw.length > LIMITS.maxLineLength) {
    return {
      command: {
        type: 'malformed',
        raw,
        sourceLine,
        reason: `Line exceeds ${LIMITS.maxLineLength} characters`,
      },
      warning: {
        code: 'malformed_line',
        message: `Line ${sourceLine} is longer than ${LIMITS.maxLineLength} characters and was preserved but not interpreted.`,
        line: sourceLine,
        file: null,
      },
    };
  }

  const { tokens, starts } = tokenizeWithOffsets(raw);

  if (tokens.length === 0) {
    return { command: { type: 'blank', raw, sourceLine }, warning: null };
  }

  const lineType = tokens[0]!;

  // ---- Line type 0: comment or META command -------------------------------
  if (lineType === '0') {
    const textStart = starts.length > 1 ? starts[1]! : raw.length;
    const text = raw.slice(textStart).trimEnd();
    const keyword = tokens.length > 1 ? tokens[1]!.toUpperCase() : '';
    const argsStart = starts.length > 2 ? starts[2]! : raw.length;
    const args = raw.slice(argsStart).trimEnd();
    const command: MetaCommand = { type: 'meta', raw, sourceLine, keyword, args, text };
    return { command, warning: null };
  }

  // ---- Line type 1: sub-file reference ------------------------------------
  if (lineType === '1') {
    // 1 <color> x y z a b c d e f g h i <file>
    // 14 fixed tokens, then the filename which MAY CONTAIN SPACES, so it is
    // taken as the remainder of the line rather than as token 14.
    if (tokens.length < 15) {
      return malformed(raw, sourceLine, 'Line type 1 needs 14 fields followed by a filename');
    }
    const colorId = parseColorToken(tokens[1]!);
    if (colorId === null) {
      return malformed(raw, sourceLine, `Unreadable color value "${tokens[1]}"`);
    }
    const nums: number[] = [];
    for (let i = 2; i < 14; i++) {
      const value = parseNumber(tokens[i]!);
      if (value === null) {
        return malformed(raw, sourceLine, `Unreadable number "${tokens[i]}" in field ${i + 1}`);
      }
      nums.push(value);
    }
    const file = raw.slice(starts[14]!).trim();
    if (file.length === 0) {
      return malformed(raw, sourceLine, 'Line type 1 has no filename');
    }
    const position: Vec3 = { x: nums[0]!, y: nums[1]!, z: nums[2]! };
    const matrix: Mat3 = [
      nums[3]!, nums[4]!, nums[5]!,
      nums[6]!, nums[7]!, nums[8]!,
      nums[9]!, nums[10]!, nums[11]!,
    ];
    return {
      command: { type: 'part', raw, sourceLine, colorId, position, matrix, file },
      warning: null,
    };
  }

  // ---- Line types 2-5: geometry -------------------------------------------
  const arity = GEOMETRY_ARITY[Number(lineType)];
  if (arity && /^[2-5]$/.test(lineType)) {
    const expected = arity.coords + 2;
    if (tokens.length < expected) {
      return malformed(
        raw,
        sourceLine,
        `Line type ${lineType} needs ${expected} fields, found ${tokens.length}`,
      );
    }
    const colorId = parseColorToken(tokens[1]!);
    if (colorId === null) {
      return malformed(raw, sourceLine, `Unreadable color value "${tokens[1]}"`);
    }
    const coords: number[] = [];
    for (let i = 2; i < expected; i++) {
      const value = parseNumber(tokens[i]!);
      if (value === null) {
        return malformed(raw, sourceLine, `Unreadable number "${tokens[i]}" in field ${i + 1}`);
      }
      coords.push(value);
    }
    return {
      command: { type: arity.type, raw, sourceLine, colorId, coords },
      warning: null,
    };
  }

  return malformed(raw, sourceLine, `Unknown line type "${lineType}"`);
}

function malformed(
  raw: string,
  sourceLine: number,
  reason: string,
): { command: LDrawCommand; warning: ParseWarning } {
  return {
    command: { type: 'malformed', raw, sourceLine, reason },
    warning: {
      code: 'malformed_line',
      message: `Line ${sourceLine}: ${reason}. The line was preserved unchanged.`,
      line: sourceLine,
      file: null,
    },
  };
}

interface FileBuilder {
  name: string;
  isAnonymous: boolean;
  commands: LDrawCommand[];
}

/** Header fields we lift out of a block for display. */
function extractHeader(commands: LDrawCommand[]): {
  headerName: string | null;
  author: string | null;
  description: string | null;
} {
  let headerName: string | null = null;
  let author: string | null = null;
  let description: string | null = null;

  for (const command of commands) {
    if (command.type !== 'meta') {
      // The header block ends at the first non-meta, non-blank line.
      if (command.type !== 'blank') break;
      continue;
    }
    if (command.keyword === 'NAME:' && headerName === null) {
      headerName = command.args;
    } else if (command.keyword === 'AUTHOR:' && author === null) {
      author = command.args;
    } else if (
      description === null &&
      command.keyword !== 'FILE' &&
      command.text.length > 0 &&
      !command.keyword.startsWith('!') &&
      !command.keyword.startsWith('//') &&
      !command.keyword.endsWith(':')
    ) {
      description = command.text;
    }
  }
  return { headerName, author, description };
}

/**
 * Parse an LDraw `.ldr` or `.mpd` document.
 *
 * Never throws on content: malformed lines become `malformed` commands with a
 * warning. It throws only when a hard limit in src/lib/security/limits.ts is
 * exceeded.
 */
export function parseLDraw(source: string, options: ParseOptions = {}): LDrawDocument {
  const sourceName = options.sourceName ?? 'model.ldr';

  // Strip a UTF-8 BOM: real LDraw files exported by Windows tools often have one.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const lineEnding: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(text);

  const rawLines = text.split(/\r\n|\n|\r/);
  // A trailing newline produces a final empty element which is not a real line.
  if (trailingNewline && rawLines[rawLines.length - 1] === '') rawLines.pop();

  if (rawLines.length > LIMITS.maxLines) {
    throw new Error(
      `Model has ${rawLines.length.toLocaleString()} lines, over the ${LIMITS.maxLines.toLocaleString()} line limit.`,
    );
  }

  // Warnings are returned to the browser and written to disk, so a file with a
  // million bad lines must not produce a million warning objects. Everything
  // past the cap is counted, not kept.
  const MAX_WARNINGS = 200;
  const warnings: ParseWarning[] = [];
  let suppressedWarnings = 0;
  let malformedLineCount = 0;
  const addWarning = (warning: ParseWarning): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(warning);
    else suppressedWarnings++;
  };
  const builders: FileBuilder[] = [];
  let current: FileBuilder | null = null;
  let sawNamedFile = false;

  const startAnonymous = (): FileBuilder => {
    const builder: FileBuilder = { name: '', isAnonymous: true, commands: [] };
    builders.push(builder);
    return builder;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const { command, warning } = parseLine(raw, i + 1);
    if (warning) {
      if (warning.code === 'malformed_line') malformedLineCount++;
      addWarning(warning);
    }

    if (command.type === 'meta' && command.keyword === 'FILE') {
      if (builders.length + 1 > LIMITS.maxFiles) {
        throw new Error(
          `Model declares more than ${LIMITS.maxFiles.toLocaleString()} sub-files, which exceeds the supported limit.`,
        );
      }
      const name = command.args.trim();
      current = { name, isAnonymous: false, commands: [command] };
      builders.push(current);
      sawNamedFile = true;
      continue;
    }

    if (command.type === 'meta' && command.keyword === 'NOFILE') {
      if (current === null || current.isAnonymous) {
        addWarning({
          code: 'nofile_without_file',
          message: `Line ${i + 1}: 0 NOFILE appears outside a 0 FILE block. It was preserved but ignored.`,
          line: i + 1,
          file: null,
        });
      }
      if (current === null) current = startAnonymous();
      current.commands.push(command);
      // Content after NOFILE belongs to no sub-file.
      current = startAnonymous();
      continue;
    }

    if (current === null) current = startAnonymous();
    current.commands.push(command);
  }

  // Drop trailing anonymous blocks that hold nothing but blank lines, but only
  // when they were created by NOFILE bookkeeping and the document is an MPD.
  // Blank lines still need preserving, so we merge rather than delete.
  const merged: FileBuilder[] = [];
  for (const builder of builders) {
    const previous = merged[merged.length - 1];
    const isBlankOnly = builder.commands.every((c) => c.type === 'blank');
    if (
      builder.isAnonymous &&
      isBlankOnly &&
      previous !== undefined &&
      merged.length > 0
    ) {
      previous.commands.push(...builder.commands);
      continue;
    }
    merged.push(builder);
  }

  const seenNames = new Set<string>();
  const files: ModelFile[] = merged.map((builder, index) => {
    const name = builder.isAnonymous
      ? index === 0 && !sawNamedFile
        ? sourceName
        : `${sourceName}#anonymous${index}`
      : builder.name;
    if (!builder.isAnonymous) {
      const key = normalizeReference(name);
      if (seenNames.has(key)) {
        addWarning({
          code: 'duplicate_file_name',
          message: `Sub-file "${name}" is declared more than once. References resolve to the first declaration.`,
          line: builder.commands[0]?.sourceLine ?? -1,
          file: name,
        });
      }
      seenNames.add(key);
    }
    const header = extractHeader(builder.commands);
    return {
      name,
      isAnonymous: builder.isAnonymous,
      commands: builder.commands,
      headerName: header.headerName,
      author: header.author,
      description: header.description,
    };
  });

  const hasContent = files.some((file) => file.commands.some((c) => c.type !== 'blank'));
  if (!hasContent) {
    addWarning({
      code: 'empty_document',
      message: 'The file contained no LDraw content: every line was blank.',
      line: 0,
      file: null,
    });
  }
  if (files.length === 0) {
    files.push({
      name: sourceName,
      isAnonymous: true,
      commands: [],
      headerName: null,
      author: null,
      description: null,
    });
  }

  if (suppressedWarnings > 0) {
    warnings.push({
      code: 'truncated',
      message:
        `${suppressedWarnings.toLocaleString()} further warnings were suppressed. ` +
        `The lines they refer to were still preserved unchanged.`,
      line: -1,
      file: null,
    });
  }

  const firstNamed = files.find((f) => !f.isAnonymous);
  const rootFile = firstNamed ? firstNamed.name : files[0]!.name;

  return {
    files,
    rootFile,
    isMpd: sawNamedFile,
    lineEnding,
    trailingNewline,
    warnings,
    malformedLineCount,
    suppressedWarningCount: suppressedWarnings,
    sourceName,
  };
}
