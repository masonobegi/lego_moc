/**
 * Locates LDraw part files.
 *
 * The LDraw library is a set of directories searched in a defined order:
 *   parts/   official parts          (3001.dat)
 *   parts/s/ part sub-files          (referenced as `s\3001s01.dat`)
 *   p/       primitives              (stud.dat, box5.dat, ...)
 *   p/48/    high-resolution primitives
 *   models/  complete models
 *
 * A reference like `s\3001s01.dat` is written relative to `parts/`, and
 * `48\4-4cyli.dat` relative to `p/`, so a plain concatenation against every
 * root in order resolves both. Matching is case-insensitive, which matters
 * because real files mix `3001.DAT` and `3001.dat`.
 */

export interface PartSource {
  /** Returns the file contents, or null if the reference is not in this source. */
  read(reference: string): Promise<string | null>;
  /** Human-readable description for diagnostics. */
  readonly description: string;
}

export function normalizeLookupPath(reference: string): string {
  return reference.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Reject any reference that tries to escape the library root. */
export function isSafeReference(reference: string): boolean {
  const normalized = normalizeLookupPath(reference);
  if (normalized.length === 0 || normalized.length > 255) return false;
  if (normalized.startsWith('/') || /^[a-z]:/.test(normalized)) return false;
  if (normalized.split('/').some((segment) => segment === '..')) return false;
  // Only characters that appear in real LDraw filenames.
  return /^[a-z0-9._/ +#()-]+$/.test(normalized);
}

/** Search roots, in LDraw's resolution order. */
export const SEARCH_ROOTS = ['parts/', 'p/', 'models/', ''] as const;

/**
 * A source backed by an in-memory map, used for tests and for the small set of
 * parts that ship with the app.
 */
export class MemoryPartSource implements PartSource {
  readonly description: string;
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string> | Map<string, string>, description = 'in-memory') {
    this.description = description;
    this.files = new Map();
    const entries = files instanceof Map ? files.entries() : Object.entries(files);
    for (const [key, value] of entries) {
      this.files.set(normalizeLookupPath(key), value);
    }
  }

  async read(reference: string): Promise<string | null> {
    if (!isSafeReference(reference)) return null;
    const normalized = normalizeLookupPath(reference);
    const direct = this.files.get(normalized);
    if (direct !== undefined) return direct;
    for (const root of SEARCH_ROOTS) {
      const candidate = this.files.get(normalizeLookupPath(root + normalized));
      if (candidate !== undefined) return candidate;
    }
    return null;
  }
}

/** Tries each source in order and returns the first hit. */
export class ChainedPartSource implements PartSource {
  readonly description: string;

  constructor(private readonly sources: readonly PartSource[]) {
    this.description = sources.map((s) => s.description).join(' -> ');
  }

  async read(reference: string): Promise<string | null> {
    for (const source of this.sources) {
      const content = await source.read(reference);
      if (content !== null) return content;
    }
    return null;
  }
}
