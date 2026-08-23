'use client';

import { useMemo, useState } from 'react';

import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { ChangeRow } from './ChangeRow';
import { count, money } from './format';

type SortKey = 'savings' | 'step' | 'part' | 'confidence';
type KindFilter = 'all' | 'hidden_color' | 'mold_equivalent';
type StateFilter = 'all' | 'enabled' | 'disabled';

interface Props {
  readonly candidates: readonly OptimizationCandidate[];
  readonly enabledIds: ReadonlySet<string>;
  readonly currency: string;
  readonly selectedId: string | null;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onSelect: (candidate: OptimizationCandidate) => void;
  readonly onBulk: (action: 'none' | 'safe' | 'reset') => void;
}

export function ChangeList({
  candidates,
  enabledIds,
  currency,
  selectedId,
  onToggle,
  onSelect,
  onBulk,
}: Props) {
  const [sort, setSort] = useState<SortKey>('savings');
  const [kind, setKind] = useState<KindFilter>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [minConfidence, setMinConfidence] = useState(0);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = candidates.filter((candidate) => {
      if (kind !== 'all' && candidate.kind !== kind) return false;
      if (state === 'enabled' && !enabledIds.has(candidate.id)) return false;
      if (state === 'disabled' && enabledIds.has(candidate.id)) return false;
      if (candidate.confidence * 100 < minConfidence) return false;
      if (needle.length > 0) {
        const haystack =
          `${candidate.partId} ${candidate.partDescription} ${candidate.originalColorName} ` +
          `${candidate.replacementColorName} ${candidate.parentModel} ${candidate.replacementPartId}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'step':
          return a.parentModel.localeCompare(b.parentModel) || a.stepIndex - b.stepIndex;
        case 'part':
          return a.partId.localeCompare(b.partId, undefined, { numeric: true });
        case 'confidence':
          return b.confidence - a.confidence || b.savings - a.savings;
        default:
          return b.savings - a.savings;
      }
    });
    return sorted;
  }, [candidates, enabledIds, kind, minConfidence, query, sort, state]);

  const visibleSavings = filtered
    .filter((c) => enabledIds.has(c.id))
    .reduce((sum, c) => sum + c.savings, 0);

  /** A candidate is blocked when a conflicting change on the same line is on. */
  const conflictActive = useMemo(() => {
    const blocked = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.conflictsWith.length === 0) continue;
      if (candidate.conflictsWith.some((other) => enabledIds.has(other))) blocked.add(candidate.id);
    }
    return blocked;
  }, [candidates, enabledIds]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <div>
          <h2 className="text-[0.95rem] font-semibold">Proposed changes</h2>
          <p className="tnum mt-0.5 text-[0.76rem] text-[var(--text-faint)]">
            {count(filtered.length)} shown &middot; {count(enabledIds.size)} of{' '}
            {count(candidates.length)} enabled &middot; {money(visibleSavings, currency)} from those
            shown
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <BulkButton onClick={() => onBulk('safe')}>Enable safe changes</BulkButton>
          <BulkButton onClick={() => onBulk('none')}>Disable all</BulkButton>
          <BulkButton onClick={() => onBulk('reset')}>Reset to original</BulkButton>
        </div>
      </div>

      <div className="grid gap-2.5 border-b border-[var(--line)] px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Sort by">
          <Select value={sort} onChange={(v) => setSort(v as SortKey)}>
            <option value="savings">Largest savings</option>
            <option value="step">Step number</option>
            <option value="part">Part number</option>
            <option value="confidence">Confidence</option>
          </Select>
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(v) => setKind(v as KindFilter)}>
            <option value="all">All types</option>
            <option value="hidden_color">Hidden colour</option>
            <option value="mold_equivalent">Equivalent mold</option>
          </Select>
        </Field>
        <Field label="State">
          <Select value={state} onChange={(v) => setState(v as StateFilter)}>
            <option value="all">Enabled and disabled</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </Select>
        </Field>
        <Field label={`Min confidence: ${minConfidence}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={minConfidence}
            onChange={(event) => setMinConfidence(Number(event.target.value))}
            className="mt-2 w-full"
            aria-label="Minimum confidence"
          />
        </Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by part number, description, colour or submodel"
            className="w-full rounded-[2px] border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-[0.83rem] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--line-strong)]"
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <p className="px-1 py-8 text-center text-[0.85rem] text-[var(--text-faint)]">
            {candidates.length === 0
              ? 'No safe savings were found in this model. That is a real result, not an error - see the analysis details below for why each part was left alone.'
              : 'No changes match these filters.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((candidate) => (
              <ChangeRow
                key={candidate.id}
                candidate={candidate}
                enabled={enabledIds.has(candidate.id)}
                conflictActive={conflictActive.has(candidate.id)}
                currency={currency}
                selected={selectedId === candidate.id}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BulkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[2px] border border-[var(--line-strong)] px-2.5 py-1.5 text-[0.76rem] text-[var(--text-dim)] transition-colors hover:border-[var(--text-faint)] hover:text-[var(--text)]"
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="mt-1 w-full rounded-[2px] border border-[var(--line)] bg-[var(--panel-2)] px-2.5 py-1.5 text-[0.82rem] outline-none focus:border-[var(--line-strong)]"
    >
      {children}
    </select>
  );
}
