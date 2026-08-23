/**
 * Rebuilds the derived state an export or a re-costing needs from a stored
 * analysis, without re-running the expensive parts.
 *
 * Parsing and resolving a large MPD takes tens of milliseconds, so it is
 * cheaper and far simpler to redo it than to serialize the object graph. The
 * visibility pass and the price lookups - the expensive parts - are NOT redone:
 * their results were stored.
 */

import { parseLDraw } from '../ldraw/parser';
import { resolveModel } from '../ldraw/resolve';
import type { LDrawDocument, PartInstance } from '../ldraw/types';
import { PriceBook } from '../pricing/priceEngine';
import type { StoredAnalysis } from './store';

export interface Rehydrated {
  readonly document: LDrawDocument;
  readonly instances: PartInstance[];
  readonly prices: PriceBook;
}

export function rehydrate(record: StoredAnalysis): Rehydrated {
  const document = parseLDraw(record.source, { sourceName: record.result.model.fileName });
  const resolved = resolveModel(document);

  const prices = new PriceBook({
    requested: record.result.pricing.requested,
    resolved: record.result.pricing.resolved,
    unresolved: record.result.pricing.unresolved,
    elapsedMs: record.result.pricing.elapsedMs,
    providerId: record.result.pricing.sourceId,
    providerLabel: record.result.pricing.sourceLabel,
    isLive: record.result.pricing.isLive,
  });
  for (const [key, quote] of record.quotes) {
    const [partId, colorText, condition] = key.split('|');
    if (partId === undefined || colorText === undefined || condition === undefined) continue;
    prices.set(partId, Number(colorText), condition as 'new' | 'used', quote);
  }

  return { document, instances: resolved.instances, prices };
}

/**
 * Which candidate ids should be treated as enabled, given what the client sent.
 * Unknown ids are dropped rather than trusted: the request body is untrusted
 * input and must not be able to name a change the analysis never proposed.
 */
export function resolveEnabledIds(
  record: StoredAnalysis,
  requested: readonly string[] | undefined,
): Set<string> {
  const known = new Set(record.result.candidates.map((c) => c.id));
  if (!requested) return new Set(record.result.defaultEnabledIds);

  const enabled = new Set<string>();
  const usedCommands = new Set<string>();
  // Preserve the analysis's own ordering so conflict resolution is deterministic.
  for (const candidate of record.result.candidates) {
    if (!requested.includes(candidate.id) || !known.has(candidate.id)) continue;
    const commandKey = `${candidate.commandRef.fileIndex}:${candidate.commandRef.commandIndex}`;
    if (usedCommands.has(commandKey)) continue;
    usedCommands.add(commandKey);
    enabled.add(candidate.id);
  }
  return enabled;
}
