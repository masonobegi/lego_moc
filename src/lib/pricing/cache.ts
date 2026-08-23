/**
 * Price cache.
 *
 * BrickLink allows 5,000 API requests per day and has no bulk price endpoint,
 * so one request is needed per part+color+condition. A 400-lot model is 400
 * requests, and re-analyzing the same model must not spend them again. Caching
 * is a functional requirement, not an optimization.
 *
 * Entries are held in memory and mirrored to a JSON file under `.brickthrift/`
 * so a dev-server restart does not throw the day's budget away.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PriceQuote } from './types';

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  expired: number;
}

interface CacheEntry {
  quote: PriceQuote;
  storedAt: number;
}

export class PriceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private dirty = false;
  readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, expired: 0 };

  constructor(
    private readonly ttlMs: number,
    private readonly filePath: string | null = null,
  ) {
    if (filePath) this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (now - entry.storedAt <= this.ttlMs) this.entries.set(key, entry);
      }
    } catch {
      // A missing or corrupt cache file is not an error; start empty.
    }
  }

  get(key: string): PriceQuote | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.stats.expired++;
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return entry.quote;
  }

  set(key: string, quote: PriceQuote): void {
    this.entries.set(key, { quote, storedAt: Date.now() });
    this.stats.writes++;
    this.dirty = true;
  }

  get size(): number {
    return this.entries.size;
  }

  flush(): void {
    if (!this.filePath || !this.dirty) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.entries)));
      this.dirty = false;
    } catch {
      // Persisting the cache is best-effort; failing to write must not break a request.
    }
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
  }
}
