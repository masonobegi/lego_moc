import { describe, expect, it } from 'vitest';

import { ChainedPartSource, MemoryPartSource, isSafeReference, normalizeLookupPath } from './partSource';

describe('isSafeReference', () => {
  it('rejects anything that could escape the library root', () => {
    expect(isSafeReference('../../etc/passwd')).toBe(false);
    expect(isSafeReference('..\\..\\windows\\system32')).toBe(false);
    expect(isSafeReference('/etc/passwd')).toBe(false);
    expect(isSafeReference('C:\\windows\\x.dat')).toBe(false);
    expect(isSafeReference('')).toBe(false);
    expect(isSafeReference('a'.repeat(300))).toBe(false);
    expect(isSafeReference('parts/3001.dat\u0000.txt')).toBe(false);
  });

  it('accepts the shapes real LDraw references take', () => {
    expect(isSafeReference('3001.dat')).toBe(true);
    expect(isSafeReference('s\\3001s01.dat')).toBe(true);
    expect(isSafeReference('48/4-4cyli.dat')).toBe(true);
    expect(isSafeReference('stud4a.dat')).toBe(true);
    expect(isSafeReference('4-4disc.dat')).toBe(true);
  });
});

describe('MemoryPartSource', () => {
  const source = new MemoryPartSource({
    'parts/3001.dat': 'brick',
    'p/stud.dat': 'stud',
    'parts/s/3001s01.dat': 'sub',
  });

  it('resolves through each search root', async () => {
    await expect(source.read('3001.dat')).resolves.toBe('brick');
    await expect(source.read('stud.dat')).resolves.toBe('stud');
    await expect(source.read('s\\3001s01.dat')).resolves.toBe('sub');
  });

  it('is case insensitive', async () => {
    await expect(source.read('3001.DAT')).resolves.toBe('brick');
  });

  it('returns null rather than throwing for an unknown or unsafe reference', async () => {
    await expect(source.read('nope.dat')).resolves.toBeNull();
    await expect(source.read('../../etc/passwd')).resolves.toBeNull();
  });
});

describe('ChainedPartSource', () => {
  it('prefers the first source that has the file', async () => {
    const chained = new ChainedPartSource([
      new MemoryPartSource({ '3001.dat': 'first' }, 'first'),
      new MemoryPartSource({ '3001.dat': 'second', '3002.dat': 'only-second' }, 'second'),
    ]);
    await expect(chained.read('3001.dat')).resolves.toBe('first');
    await expect(chained.read('3002.dat')).resolves.toBe('only-second');
  });
});

describe('normalizeLookupPath', () => {
  it('lowercases and normalises separators', () => {
    expect(normalizeLookupPath('  S\\3001S01.DAT ')).toBe('s/3001s01.dat');
    expect(normalizeLookupPath('./3001.dat')).toBe('3001.dat');
  });
});
