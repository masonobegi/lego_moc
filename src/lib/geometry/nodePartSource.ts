/**
 * Filesystem-backed PartSource. Server-only.
 *
 * Two behaviors worth knowing about:
 *  - Lookups are case-insensitive. The library mixes `.dat` and `.DAT` and
 *    references do not reliably match the on-disk case, so each root directory
 *    is indexed once (lazily) into a lowercase map.
 *  - Every reference is validated by `isSafeReference` before it touches the
 *    filesystem, so a hostile model cannot read outside the library root.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { SEARCH_ROOTS, isSafeReference, normalizeLookupPath, type PartSource } from './partSource';

export class NodePartSource implements PartSource {
  readonly description: string;
  private index: Map<string, string> | null = null;
  private indexing: Promise<Map<string, string>> | null = null;

  constructor(private readonly root: string) {
    this.description = `filesystem:${root}`;
  }

  static exists(root: string): boolean {
    return existsSync(root);
  }

  private async buildIndex(): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    for (const searchRoot of SEARCH_ROOTS) {
      const dir = path.join(this.root, searchRoot);
      await this.indexDirectory(dir, searchRoot, index, 0);
    }
    return index;
  }

  private async indexDirectory(
    dir: string,
    prefix: string,
    index: Map<string, string>,
    depth: number,
  ): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Only descend into the sub-directories LDraw actually uses.
        if (prefix === '' && !['parts', 'p', 'models'].includes(entry.name.toLowerCase())) continue;
        await this.indexDirectory(path.join(dir, entry.name), `${prefix}${entry.name}/`, index, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.dat') && !lower.endsWith('.ldr') && !lower.endsWith('.mpd')) continue;
      const withPrefix = normalizeLookupPath(prefix + entry.name);
      const withoutRoot = normalizeLookupPath(withPrefix.replace(/^(parts|p|models)\//, ''));
      const absolute = path.join(dir, entry.name);
      if (!index.has(withPrefix)) index.set(withPrefix, absolute);
      if (!index.has(withoutRoot)) index.set(withoutRoot, absolute);
    }
  }

  private async ensureIndex(): Promise<Map<string, string>> {
    if (this.index) return this.index;
    if (!this.indexing) {
      this.indexing = this.buildIndex().then((index) => {
        this.index = index;
        return index;
      });
    }
    return this.indexing;
  }

  async read(reference: string): Promise<string | null> {
    if (!isSafeReference(reference)) return null;
    const index = await this.ensureIndex();
    const normalized = normalizeLookupPath(reference);
    const absolute = index.get(normalized);
    if (!absolute) return null;
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      return null;
    }
  }

  /** Number of indexed files. Used by the /dev page diagnostics. */
  async size(): Promise<number> {
    const index = await this.ensureIndex();
    return index.size;
  }
}
