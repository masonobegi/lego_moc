'use client';

import { useState } from 'react';

import { LDRAW_COLORS } from '@/lib/ldraw/colors.generated';
import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { Swatch } from './Swatch';
import { VISIBILITY_STYLE, confidenceLabel, money } from './format';

const COLOR_HEX: Record<number, string> = Object.fromEntries(
  LDRAW_COLORS.map((c) => [c.code, c.value]),
);

interface Props {
  readonly candidate: OptimizationCandidate;
  readonly enabled: boolean;
  readonly currency: string;
  readonly selected: boolean;
  readonly conflictActive: boolean;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onSelect: (candidate: OptimizationCandidate) => void;
}

export function ChangeRow({
  candidate,
  enabled,
  currency,
  selected,
  conflictActive,
  onToggle,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const visibility = VISIBILITY_STYLE[candidate.visibility.classification] ?? {
    label: candidate.visibility.classification,
    className: 'text-[var(--text-dim)] border-[var(--line)]',
  };
  const isMold = candidate.kind === 'mold_equivalent';

  return (
    <li
      className={`panel-2 overflow-hidden transition-colors ${
        selected ? 'border-[color-mix(in_srgb,var(--accent)_50%,var(--line))]' : ''
      } ${enabled ? '' : 'opacity-[0.62]'}`}
    >
      <div className="flex items-start gap-3 p-3.5">
        <input
          type="checkbox"
          checked={enabled}
          disabled={conflictActive && !enabled}
          onChange={(event) => onToggle(candidate.id, event.target.checked)}
          aria-label={`Apply: ${candidate.partDescription} ${candidate.originalColorName} to ${candidate.replacementColorName}`}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] disabled:opacity-40"
        />

        <button
          type="button"
          onClick={() => onSelect(candidate)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[0.86rem] font-medium">{candidate.partDescription}</span>
            <span className="font-mono text-[0.72rem] text-[var(--text-faint)]">
              {candidate.partId}
            </span>
            {candidate.quantity > 1 && (
              <span className="tnum rounded border border-[var(--line-strong)] px-1.5 py-px text-[0.68rem] text-[var(--text-dim)]">
                x{candidate.quantity}
              </span>
            )}
            {isMold && (
              <span className="rounded border border-[color-mix(in_srgb,var(--good)_35%,var(--line))] px-1.5 py-px text-[0.66rem] uppercase tracking-wide text-[var(--good)]">
                Mold
              </span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[0.8rem] text-[var(--text-dim)]">
            {isMold ? (
              <span className="font-mono text-[0.76rem]">
                {candidate.originalPartId} <Arrow /> {candidate.replacementPartId}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Swatch hex={colorHexOf(candidate, 'from')} />
                {candidate.originalColorName}
                <Arrow />
                <Swatch hex={colorHexOf(candidate, 'to')} />
                <span className="text-[var(--text)]">{candidate.replacementColorName}</span>
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.76rem] text-[var(--text-faint)]">
            <span>
              Step {candidate.stepIndex + 1}
              {candidate.parentModel ? ` of ${candidate.parentModel}` : ''}
            </span>
            <span className="tnum">
              {money(candidate.originalTotal, currency)} <Arrow />{' '}
              {money(candidate.replacementTotal, currency)}
            </span>
            <span className={`rounded border px-1.5 py-px ${visibility.className}`}>
              {visibility.label}
            </span>
            <span className="tnum">{confidenceLabel(candidate.confidence)} confidence</span>
          </div>
        </button>

        <div className="shrink-0 text-right">
          <div className="tnum text-[0.95rem] font-semibold text-[var(--accent)]">
            {money(candidate.savings, currency)}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 text-[0.73rem] text-[var(--text-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-dim)]"
          >
            {expanded ? 'Hide why' : 'Why?'}
          </button>
        </div>
      </div>

      {conflictActive && !enabled && (
        <p className="border-t border-[var(--line)] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] px-3.5 py-2 text-[0.75rem] text-[var(--warn)]">
          Another change already rewrites this same line. Switch that one off to enable this.
        </p>
      )}

      {expanded && (
        <div className="border-t border-[var(--line)] bg-[var(--panel)] px-3.5 py-3.5">
          <p className="text-[0.79rem] font-medium text-[var(--text)]">{candidate.reason}</p>
          <ul className="mt-2.5 space-y-2">
            {candidate.evidence.map((line, i) => (
              <li key={i} className="flex gap-2.5 text-[0.78rem] leading-relaxed text-[var(--text-dim)]">
                <span className="mt-[0.5em] h-1 w-1 shrink-0 rounded-full bg-[var(--text-faint)]" />
                {line}
              </li>
            ))}
          </ul>

          <dl className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-1.5 text-[0.75rem] sm:grid-cols-3">
            <Detail label="Rays cast" value={candidate.visibility.totalRays.toLocaleString()} />
            <Detail
              label="Triangles probed"
              value={
                candidate.visibility.trianglesTotal > 0
                  ? `${candidate.visibility.trianglesCovered.toLocaleString()} / ${candidate.visibility.trianglesTotal.toLocaleString()}`
                  : 'n/a'
              }
            />
            <Detail label="Pieces affected" value={String(candidate.quantity)} />
            <Detail
              label="Unit price"
              value={`${money(candidate.originalUnitPrice, currency)} to ${money(candidate.replacementUnitPrice, currency)}`}
            />
            {candidate.moldRule && (
              <Detail label="Rule source" value={candidate.moldRule.source} wide />
            )}
          </dl>

          {candidate.alternatives.length > 0 && (
            <div className="mt-3.5">
              <p className="text-[0.73rem] uppercase tracking-wide text-[var(--text-faint)]">
                Other cheaper colours found
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.76rem] text-[var(--text-dim)]">
                {candidate.alternatives.map((alt) => (
                  <li key={alt.colorId} className="tnum">
                    {alt.colorName} &middot; saves {money(alt.saving, currency)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Detail({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 sm:col-span-3' : ''}>
      <dt className="text-[var(--text-faint)]">{label}</dt>
      <dd className="tnum mt-0.5 text-[var(--text-dim)]">{value}</dd>
    </div>
  );
}

function Arrow() {
  return <span className="text-[var(--text-faint)]">&rarr;</span>;
}

/**
 * The candidate carries colour ids; the swatch needs a hex. The colour table is
 * small and static, so it is resolved on the client rather than fattening every
 * candidate in the payload.
 */
function colorHexOf(candidate: OptimizationCandidate, side: 'from' | 'to'): string {
  const id = side === 'from' ? candidate.originalColorId : candidate.replacementColorId;
  return COLOR_HEX[id] ?? '#888888';
}
