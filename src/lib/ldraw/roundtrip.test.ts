import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLDraw } from './parser';
import { formatNumber, serializeDocument } from './serializer';
import { resolveModel } from './resolve';
import type { LDrawDocument, PartInstance } from './types';

const FIXTURE_DIR = path.join(process.cwd(), 'test-models');
const FIXTURES = readdirSync(FIXTURE_DIR).filter((f) => /\.(ldr|mpd)$/i.test(f));

/**
 * The semantic content of a document: everything that determines what gets
 * built. Two documents with the same fingerprint describe the same model, even
 * if their whitespace differs.
 */
function fingerprint(document: LDrawDocument): string {
  const parts: string[] = [`root=${document.rootFile}`, `mpd=${document.isMpd}`];
  document.files.forEach((file) => {
    parts.push(`FILE ${file.name} anon=${file.isAnonymous}`);
    file.commands.forEach((command) => {
      switch (command.type) {
        case 'part':
          parts.push(
            `1 ${command.colorId} ${command.position.x},${command.position.y},${command.position.z} ` +
              `${command.matrix.join(',')} ${command.file}`,
          );
          break;
        case 'meta':
          parts.push(`0 ${command.text}`);
          break;
        case 'line':
        case 'triangle':
        case 'quad':
        case 'optionalLine':
          parts.push(`${command.type} ${command.colorId} ${command.coords.join(',')}`);
          break;
        case 'malformed':
          parts.push(`malformed ${command.raw}`);
          break;
        case 'blank':
          parts.push('blank');
          break;
      }
    });
  });
  return parts.join('\n');
}

function instanceFingerprint(instances: readonly PartInstance[]): string {
  return instances
    .map(
      (i) =>
        `${i.instanceId}|${i.partId}|${i.colorId}|${i.stepIndex}|${i.parentModel}|` +
        `${i.position.x},${i.position.y},${i.position.z}|${i.transformation.join(',')}`,
    )
    .join('\n');
}

describe('serializer: byte-exact round trip', () => {
  it.each(FIXTURES)('%s survives parse and serialize unchanged', (fixture) => {
    const source = readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8');
    const document = parseLDraw(source, { sourceName: fixture });
    expect(serializeDocument(document)).toBe(source);
  });

  it('preserves unusual whitespace, comments and unknown META commands', () => {
    const source = [
      '0 FILE  weird.ldr  ',
      '0 !SOMETHING nobody has heard of  ',
      '0    // indented comment',
      '',
      '   1   4   0 0 0   1 0 0 0 1 0 0 0 1   3001.dat   ',
      '0 ROTSTEP 30 45 0 ABS',
      '0 BUFEXCHG A STORE',
      '0 STEP',
      '0 NOFILE',
      'this line is not LDraw at all',
    ].join('\r\n');
    const document = parseLDraw(source);
    expect(serializeDocument(document)).toBe(source);
  });
});

describe('serializer: semantic round trip when every line is regenerated', () => {
  it.each(FIXTURES)('%s regenerates to a semantically identical document', (fixture) => {
    const source = readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8');
    const first = parseLDraw(source, { sourceName: fixture });

    // Force the writer to rebuild every line from its parsed fields, which is
    // the real test: byte-exactness alone would pass trivially by echoing raw.
    const regenerated = serializeDocument(first, { regenerate: true });
    const second = parseLDraw(regenerated, { sourceName: fixture });

    expect(fingerprint(second)).toBe(fingerprint(first));
  });

  it.each(FIXTURES)('%s resolves to identical part instances after regeneration', (fixture) => {
    const source = readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8');
    const first = parseLDraw(source, { sourceName: fixture });
    const second = parseLDraw(serializeDocument(first, { regenerate: true }), { sourceName: fixture });

    const a = resolveModel(first);
    const b = resolveModel(second);
    expect(instanceFingerprint(b.instances)).toBe(instanceFingerprint(a.instances));
    expect(b.rootStepCount).toBe(a.rootStepCount);
    expect(b.submodelCount).toBe(a.submodelCount);
  });

  it('round-trips a third time without drift', () => {
    const source = readFileSync(path.join(FIXTURE_DIR, 'multiple-instances.mpd'), 'utf8');
    const one = parseLDraw(source);
    const two = parseLDraw(serializeDocument(one, { regenerate: true }));
    const three = parseLDraw(serializeDocument(two, { regenerate: true }));
    expect(serializeDocument(three, { regenerate: true })).toBe(
      serializeDocument(two, { regenerate: true }),
    );
  });

  it('formats numbers without exponents or trailing zeros', () => {
    const source = '1 16 0.0000001 -0 1.500000 1 0 0 0 1 0 0 0 1 3001.dat';
    const regenerated = serializeDocument(parseLDraw(source), { regenerate: true });
    expect(regenerated).not.toMatch(/e[-+]/i);
    expect(regenerated).toContain('1.5');
    expect(regenerated.split(/\s+/)[3]).toBe('0');
  });

  describe('formatNumber precision', () => {
    /**
     * Regression: the writer used to round to six decimals. That looked
     * harmless - 1 LDU is 0.4 mm - but real official models carry rotation
     * matrices built from values like sin(5 degrees) = 0.0871557, and rounding
     * those made a regenerated file no longer semantically identical to its
     * original. Seven of 103 Official Model Repository files failed because of
     * it. Precision the user did not ask us to discard must not be discarded.
     */
    const VALUES = [
      0, 1, -1, 0.5, 1.5,
      0.0871557, 0.996195, -0.00872654, 0.9271838545667874,
      1 / 3, Math.PI, Math.SQRT2,
      1e-7, 1.5e-9, -1e-21, 1e21, 123456789.123456789,
      -139.550351, -38.7101132,
    ];

    it.each(VALUES)('%p survives formatting exactly', (value) => {
      const text = formatNumber(value);
      expect(Number(text)).toBe(Object.is(value, -0) ? 0 : value);
    });

    it('never emits exponent notation', () => {
      for (const value of VALUES) {
        expect(formatNumber(value)).not.toMatch(/e/i);
      }
    });

    it('normalises negative zero', () => {
      expect(formatNumber(-0)).toBe('0');
    });

    it('keeps a rotation matrix intact through a regenerate cycle', () => {
      const source = '1 16 0 0 0 0 0.996195 0.0871557 -1 0 0 0 -0.0871557 0.996195 3700.dat';
      const once = serializeDocument(parseLDraw(source), { regenerate: true });
      expect(once).toBe(source);
    });
  });
});

/**
 * Real LDraw files from the Official Model Repository, when the user has
 * installed them with `npm run parts:fetch -- --models`. These are not
 * committed to the repository, so the suite skips when they are absent.
 */
const OMR_DIR = path.join(FIXTURE_DIR, 'omr');
const OMR_FILES = existsSync(OMR_DIR)
  ? readdirSync(OMR_DIR).filter((f) => /\.(ldr|mpd)$/i.test(f)).slice(0, 25)
  : [];

describe.skipIf(OMR_FILES.length === 0)('round trip against real Official Model Repository files', () => {
  it.each(OMR_FILES)('%s round-trips byte for byte', (file) => {
    const source = readFileSync(path.join(OMR_DIR, file), 'utf8');
    const document = parseLDraw(source, { sourceName: file });
    expect(serializeDocument(document)).toBe(source);
  });

  it.each(OMR_FILES)('%s round-trips semantically when regenerated', (file) => {
    const source = readFileSync(path.join(OMR_DIR, file), 'utf8');
    const first = parseLDraw(source, { sourceName: file });
    const second = parseLDraw(serializeDocument(first, { regenerate: true }), { sourceName: file });
    expect(instanceFingerprint(resolveModel(second).instances)).toBe(
      instanceFingerprint(resolveModel(first).instances),
    );
  });
});
