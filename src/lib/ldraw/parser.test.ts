import { describe, expect, it } from 'vitest';

import { parseLDraw, parseColorToken, referenceToPartId, normalizeReference, DIRECT_COLOR_BASE } from './parser';
import type { MetaCommand, PartCommand } from './types';

describe('parseLDraw: line types', () => {
  it('parses a part reference with the documented field order', () => {
    // 1 <color> x y z a b c d e f g h i <file>
    const document = parseLDraw('1 4 10 20 30 1 2 3 4 5 6 7 8 9 3001.dat');
    const command = document.files[0]!.commands[0] as PartCommand;
    expect(command.type).toBe('part');
    expect(command.colorId).toBe(4);
    expect(command.position).toEqual({ x: 10, y: 20, z: 30 });
    expect(command.matrix).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(command.file).toBe('3001.dat');
  });

  it('keeps a filename that contains spaces', () => {
    // Real OMR models rely on this.
    const source = '1 16 0 0 0 1 0 0 0 1 0 0 0 1 10182 - Ground floor.ldr';
    const command = parseLDraw(source).files[0]!.commands[0] as PartCommand;
    expect(command.file).toBe('10182 - Ground floor.ldr');
  });

  it('parses geometry line types with the right arity', () => {
    const source = [
      '2 24 0 0 0 1 1 1',
      '3 16 0 0 0 1 0 0 0 1 0',
      '4 16 0 0 0 1 0 0 1 1 0 0 1 0',
      '5 24 0 0 0 1 0 0 0 1 0 1 1 0',
    ].join('\n');
    const commands = parseLDraw(source).files[0]!.commands;
    expect(commands.map((c) => c.type)).toEqual(['line', 'triangle', 'quad', 'optionalLine']);
    const triangle = commands[1]!;
    const quadrilateral = commands[2]!;
    if (triangle.type !== 'triangle' || quadrilateral.type !== 'quad') {
      throw new Error('expected a triangle and a quad');
    }
    expect(triangle.coords).toHaveLength(9);
    expect(quadrilateral.coords).toHaveLength(12);
  });

  it('treats a blank line as blank and a bare 0 as meta', () => {
    const document = parseLDraw('\n0\n0 // hello');
    expect(document.files[0]!.commands.map((c) => c.type)).toEqual(['blank', 'meta', 'meta']);
  });

  it('recognises STEP and keeps its original text', () => {
    const command = parseLDraw('0 STEP').files[0]!.commands[0] as MetaCommand;
    expect(command.keyword).toBe('STEP');
    expect(command.raw).toBe('0 STEP');
  });

  it('parses direct colors in both documented spellings', () => {
    expect(parseColorToken('0x2FF0000')).toBe(DIRECT_COLOR_BASE + 0xff0000);
    expect(parseColorToken('#00FF00')).toBe(DIRECT_COLOR_BASE + 0x00ff00);
    expect(parseColorToken('16')).toBe(16);
    expect(parseColorToken('nonsense')).toBeNull();
  });
});

describe('parseLDraw: malformed input', () => {
  it('never throws and never drops a line', () => {
    const source = [
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 4 0 0 0 1 0 0 0 1 0 0 3001.dat',
      '9 not a real line type',
      '3 16 0 0 0 1 0 0 0 x 0',
      '1 notacolor 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
    ].join('\n');
    const document = parseLDraw(source);
    expect(document.files[0]!.commands).toHaveLength(5);
    expect(document.files[0]!.commands.filter((c) => c.type === 'malformed')).toHaveLength(4);
    expect(document.warnings.length).toBe(4);
    // Every malformed line keeps its exact original text.
    for (const command of document.files[0]!.commands) {
      if (command.type === 'malformed') expect(command.raw).not.toBeNull();
    }
  });

  it('records an empty document rather than failing', () => {
    const document = parseLDraw('');
    expect(document.warnings.some((w) => w.code === 'empty_document')).toBe(true);
    expect(document.files).toHaveLength(1);
  });

  it('strips a UTF-8 BOM', () => {
    const document = parseLDraw('﻿0 Title\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
    expect(document.files[0]!.commands[0]!.type).toBe('meta');
    expect((document.files[0]!.commands[0] as MetaCommand).text).toBe('Title');
  });
});

describe('parseLDraw: MPD', () => {
  const MPD = [
    '0 FILE main.ldr',
    '0 Main',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
    '0 STEP',
    '',
    '0 FILE sub.ldr',
    '0 Sub',
    '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  ].join('\n');

  it('splits into named sub-files with the first as the root', () => {
    const document = parseLDraw(MPD);
    expect(document.isMpd).toBe(true);
    expect(document.files.map((f) => f.name)).toEqual(['main.ldr', 'sub.ldr']);
    expect(document.rootFile).toBe('main.ldr');
  });

  it('includes the 0 FILE line in its own block so serialization is exact', () => {
    const document = parseLDraw(MPD);
    const first = document.files[0]!.commands[0] as MetaCommand;
    expect(first.keyword).toBe('FILE');
    expect(first.args).toBe('main.ldr');
  });

  it('treats a plain .ldr as one anonymous block named after the file', () => {
    const document = parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', { sourceName: 'x.ldr' });
    expect(document.isMpd).toBe(false);
    expect(document.files[0]!.name).toBe('x.ldr');
    expect(document.files[0]!.isAnonymous).toBe(true);
  });

  it('ends a block at 0 NOFILE', () => {
    const document = parseLDraw(
      ['0 FILE a.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 NOFILE', '0 loose comment'].join('\n'),
    );
    const named = document.files.filter((f) => !f.isAnonymous);
    expect(named).toHaveLength(1);
    // The NOFILE line belongs to the block it closes.
    const last = named[0]!.commands[named[0]!.commands.length - 1] as MetaCommand;
    expect(last.keyword).toBe('NOFILE');
  });

  it('warns about a duplicate sub-file name', () => {
    const document = parseLDraw(['0 FILE a.ldr', '0 FILE A.LDR'].join('\n'));
    expect(document.warnings.some((w) => w.code === 'duplicate_file_name')).toBe(true);
  });

  it('extracts header fields', () => {
    const document = parseLDraw(
      ['0 FILE a.ldr', '0 My Model', '0 Name: a.ldr', '0 Author: Someone [nick]'].join('\n'),
    );
    expect(document.files[0]!.description).toBe('My Model');
    expect(document.files[0]!.headerName).toBe('a.ldr');
    expect(document.files[0]!.author).toBe('Someone [nick]');
  });
});

describe('reference normalization', () => {
  it('is case-insensitive and treats backslash as a separator', () => {
    expect(normalizeReference('S\\3001S01.DAT')).toBe('s/3001s01.dat');
    expect(referenceToPartId('3001.DAT')).toBe('3001');
    expect(referenceToPartId('s\\3001s01.dat')).toBe('s/3001s01');
  });
});

describe('line endings', () => {
  it('detects CRLF and a trailing newline', () => {
    const document = parseLDraw('0 a\r\n0 b\r\n');
    expect(document.lineEnding).toBe('\r\n');
    expect(document.trailingNewline).toBe(true);
    expect(document.files[0]!.commands).toHaveLength(2);
  });

  it('detects the absence of a trailing newline', () => {
    expect(parseLDraw('0 a\n0 b').trailingNewline).toBe(false);
  });
});
