/**
 * LDraw serializer.
 *
 * Two guarantees, both covered by tests in src/lib/ldraw/roundtrip.test.ts:
 *
 *  1. **Byte-exact** for untouched content. Every command keeps its original
 *     source text in `raw`; the serializer emits that text verbatim. Parsing a
 *     file and serializing it without changes reproduces the input byte for
 *     byte, including whitespace, comments, blank lines and unknown META
 *     commands.
 *
 *  2. **Semantically exact** when regeneration is forced. Setting
 *     `regenerate: true` discards every `raw` and rebuilds each line from its
 *     parsed fields. Re-parsing that output yields a semantically identical
 *     document. This is the real test of the writer, and it is what runs for
 *     any line the optimiser actually modified.
 */

import { DIRECT_COLOR_BASE, isDirectColor } from './parser';
import type { LDrawCommand, LDrawDocument, ModelFile } from './types';

export interface SerializeOptions {
  /** Ignore `raw` and rebuild every line from parsed fields. */
  regenerate?: boolean;
  /** Override the document's detected line ending. */
  lineEnding?: '\n' | '\r\n';
}

/**
 * Format a number the way LDraw files conventionally do: integers without a
 * decimal point, fractions without trailing zeros, and no exponent notation
 * (some readers do not accept `1e-7`).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  // 6 decimals is well beyond LDraw's practical precision (1 LDU = 0.4 mm).
  let text = value.toFixed(6);
  text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (text === '-0') return '0';
  return text;
}

export function formatColor(colorId: number): string {
  if (isDirectColor(colorId)) {
    return `0x2${(colorId - DIRECT_COLOR_BASE).toString(16).padStart(6, '0').toUpperCase()}`;
  }
  return String(colorId);
}

export function serializeCommand(command: LDrawCommand, regenerate = false): string {
  if (!regenerate && command.raw !== null) return command.raw;

  switch (command.type) {
    case 'blank':
      return '';
    case 'meta': {
      if (command.text.length === 0) return '0';
      return `0 ${command.text}`;
    }
    case 'part': {
      const m = command.matrix;
      const p = command.position;
      return [
        '1',
        formatColor(command.colorId),
        formatNumber(p.x),
        formatNumber(p.y),
        formatNumber(p.z),
        formatNumber(m[0]),
        formatNumber(m[1]),
        formatNumber(m[2]),
        formatNumber(m[3]),
        formatNumber(m[4]),
        formatNumber(m[5]),
        formatNumber(m[6]),
        formatNumber(m[7]),
        formatNumber(m[8]),
        command.file,
      ].join(' ');
    }
    case 'line':
    case 'triangle':
    case 'quad':
    case 'optionalLine': {
      const lineType =
        command.type === 'line' ? '2' : command.type === 'triangle' ? '3' : command.type === 'quad' ? '4' : '5';
      return [lineType, formatColor(command.colorId), ...command.coords.map(formatNumber)].join(' ');
    }
    case 'malformed':
      // A line we could not interpret is never rewritten, only echoed.
      return command.raw ?? '';
  }
}

export function serializeFile(file: ModelFile, options: SerializeOptions = {}): string {
  const eol = options.lineEnding ?? '\n';
  return file.commands.map((c) => serializeCommand(c, options.regenerate ?? false)).join(eol);
}

export function serializeDocument(document: LDrawDocument, options: SerializeOptions = {}): string {
  const eol = options.lineEnding ?? document.lineEnding;
  const lines: string[] = [];
  for (const file of document.files) {
    for (const command of file.commands) {
      lines.push(serializeCommand(command, options.regenerate ?? false));
    }
  }
  const body = lines.join(eol);
  return document.trailingNewline && body.length > 0 ? body + eol : body;
}
