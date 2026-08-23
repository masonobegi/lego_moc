import { describe, expect, it } from 'vitest';

import {
  LIMITS,
  ModelTooLargeError,
  UnsupportedFileError,
  assertAllowedExtension,
  sanitizeFilename,
  sanitizeText,
  validateUpload,
} from './limits';

describe('sanitizeFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\model.ldr')).toBe('model.ldr');
    expect(sanitizeFilename('/absolute/path/model.mpd')).toBe('model.mpd');
  });

  it('removes control characters and header-breaking characters', () => {
    expect(sanitizeFilename('mo\u0000del\r\n.ldr')).toBe('model.ldr');
    expect(sanitizeFilename('a"b;c$d.ldr')).toBe('a_b_c_d.ldr');
  });

  it('refuses to produce a dotfile or an empty name', () => {
    expect(sanitizeFilename('...')).toBe('model');
    expect(sanitizeFilename('')).toBe('model');
    expect(sanitizeFilename('   ')).toBe('model');
  });

  it('bounds the length', () => {
    expect(sanitizeFilename('a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('sanitizeText', () => {
  it('collapses whitespace and drops control characters', () => {
    expect(sanitizeText('a\u0007 b\n\nc')).toBe('a b c');
  });
  it('bounds the length', () => {
    expect(sanitizeText('x'.repeat(1000), 50).length).toBe(50);
  });
});

describe('extension checking', () => {
  it('accepts only .ldr and .mpd', () => {
    expect(assertAllowedExtension('a.ldr')).toBe('.ldr');
    expect(assertAllowedExtension('a.MPD')).toBe('.mpd');
    expect(() => assertAllowedExtension('a.io')).toThrow(UnsupportedFileError);
    expect(() => assertAllowedExtension('a.dat')).toThrow(UnsupportedFileError);
    expect(() => assertAllowedExtension('a')).toThrow(UnsupportedFileError);
  });

  it('tells .io users what to do instead of just refusing', () => {
    expect(() => assertAllowedExtension('model.io')).toThrow(/Export As/);
  });
});

describe('validateUpload', () => {
  it('rejects an empty file', () => {
    expect(() => validateUpload('a.ldr', 0)).toThrow(UnsupportedFileError);
  });
  it('rejects a file over the size limit', () => {
    expect(() => validateUpload('a.ldr', LIMITS.maxFileBytes + 1)).toThrow(ModelTooLargeError);
  });
  it('returns a sanitized name for a valid upload', () => {
    expect(validateUpload('../evil name.ldr', 100)).toBe('evil name.ldr');
  });
});
