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
 * decimal point, fractions without trailing zeros, and never in exponent
 * notation, because not every LDraw reader accepts `1e-7`.
 *
 * The value is emitted at FULL precision, using the shortest decimal string
 * that parses back to exactly the same double. Rounding to a fixed number of
 * decimals looked harmless - 1 LDU is 0.4 mm, so six decimals is far below any
 * physical relevance - but it silently altered real files: rotation matrices in
 * official models carry values like 0.0871557 (sin 5 degrees), and truncating
 * those made a regenerated file no longer semantically identical to its
 * original. Losing information the user did not ask us to change is not
 * acceptable at any magnitude.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value)) {
    // Above 1e21 JavaScript switches to exponent notation even for integers.
    // Such a coordinate is meaningless in LDraw units, but emitting `1e+21`
    // would produce a line some readers reject, so expand it.
    return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
  }

  const shortest = String(value);
  if (!shortest.includes('e') && !shortest.includes('E')) return shortest;

  // Exponent form: expand to plain decimal with just enough digits to still
  // parse back to the identical double.
  for (let digits = 1; digits <= 100; digits++) {
    const candidate = value.toFixed(digits);
    if (Number(candidate) === value) {
      const trimmed = candidate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      return trimmed === '-0' ? '0' : trimmed;
    }
  }
  return value.toFixed(20);
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
