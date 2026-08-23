'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AnalysisResult, SavingsSummary } from '@/lib/analysis/types';
import type { OptimizationCandidate } from '@/lib/optimizer/types';
import { ModelViewer, type SelectedPart } from '@/components/viewer/ModelViewer';
import { AnalysisDetails } from './AnalysisDetails';
import { ChangeList } from './ChangeList';
import { ExportPanel } from './ExportPanel';
import { Swatch } from './Swatch';
import { VISIBILITY_STYLE, confidenceLabel, count, money, percent } from './format';

type ViewMode = 'optimized' | 'original' | 'split';

interface Props {
  readonly result: AnalysisResult;
  readonly initialSavings: SavingsSummary;
}

export function ResultsView({ result, initialSavings }: Props) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(result.defaultEnabledIds),
  );
  const [savings, setSavings] = useState(initialSavings);
  const [recosting, setRecosting] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('optimized');
  const [selectedCandidate, setSelectedCandidate] = useState<OptimizationCandidate | null>(null);
  const [selectedPart, setSelectedPart] = useState<SelectedPart | null>(null);
  const [viewerInfo, setViewerInfo] = useState<{ instanceCount: number; omitted: number } | null>(null);

  const geometryUrl = `/api/results/${result.id}/geometry`;
  const candidateById = useMemo(
    () => new Map(result.candidates.map((c) => [c.id, c])),
    [result.candidates],
  );

  // ---- recost, debounced -------------------------------------------------
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const seq = ++requestSeq.current;
      setRecosting(true);
      void fetch(`/api/results/${result.id}/recost`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabledIds: [...enabledIds] }),
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('recost failed'))))
        .then((body: { savings: SavingsSummary }) => {
          // Ignore a response that a later toggle has already superseded.
          if (seq === requestSeq.current) setSavings(body.savings);
        })
        .catch(() => {
          /* Keep the last good figure rather than showing a wrong one. */
        })
        .finally(() => {
          if (seq === requestSeq.current) setRecosting(false);
        });
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabledIds, result.id]);

  const toggle = useCallback(
    (id: string, enabled: boolean) => {
      setEnabledIds((previous) => {
        const next = new Set(previous);
        if (enabled) {
          const candidate = candidateById.get(id);
          // Only one change may rewrite a given line.
          for (const other of candidate?.conflictsWith ?? []) next.delete(other);
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    [candidateById],
  );

  const bulk = useCallback(
    (action: 'none' | 'safe' | 'reset') => {
      if (action === 'none') {
        setEnabledIds(new Set());
        return;
      }
      if (action === 'reset') {
        setEnabledIds(new Set());
        setViewMode('original');
        return;
      }
      setEnabledIds(new Set(result.defaultEnabledIds));
      setViewMode('optimized');
    },
    [result.defaultEnabledIds],
  );

  const highlightInstanceIds = useMemo(
    () => selectedCandidate?.instanceIds ?? [],
    [selectedCandidate],
  );

  const onSelectCandidate = useCallback((candidate: OptimizationCandidate) => {
    setSelectedCandidate((previous) => (previous?.id === candidate.id ? null : candidate));
    setSelectedPart(null);
  }, []);

  const onSelectPart = useCallback(
    (part: SelectedPart | null) => {
      setSelectedPart(part);
      if (part?.candidateId) {
        const candidate = candidateById.get(part.candidateId);
        if (candidate) setSelectedCandidate(candidate);
      } else {
        setSelectedCandidate(null);
      }
    },
    [candidateById],
  );

  const enabledArray = useMemo(() => [...enabledIds], [enabledIds]);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-8">
      {/* ---- headline ---- */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[1.5rem] font-semibold tracking-tight">{result.model.title}</h1>
          <span className="font-mono text-[0.78rem] text-[var(--text-faint)]">
            {result.model.fileName}
          </span>
        </div>
        {result.model.author && (
          <p className="mt-1 text-[0.8rem] text-[var(--text-faint)]">by {result.model.author}</p>
        )}

        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="panel flex flex-wrap items-end gap-x-10 gap-y-5 p-6">
            <Figure label="Original estimated parts cost" value={money(savings.originalCost, savings.currency)} />
            <Figure label="Optimised" value={money(savings.optimizedCost, savings.currency)} />
            <div>
              <p className="text-[0.73rem] uppercase tracking-[0.13em] text-[var(--text-faint)]">
                Potential savings
              </p>
              <p className="tnum mt-1.5 flex items-baseline gap-2.5 text-[2rem] font-semibold leading-none text-[var(--accent)]">
                {money(savings.savings, savings.currency)}
                <span className="text-[1.05rem] font-medium opacity-80">
                  {percent(savings.savingsPercent)}
                </span>
                {recosting && (
                  <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--line-strong)] border-t-[var(--accent)]" />
                )}
              </p>
            </div>
          </div>

          <div className="panel flex flex-col justify-center gap-1.5 p-6">
            <p className="tnum text-[0.85rem]">
              <strong className="font-semibold">{count(result.candidates.length)}</strong> candidate
              change{result.candidates.length === 1 ? '' : 's'}
            </p>
            <p className="tnum text-[0.85rem] text-[var(--text-dim)]">
              {count(savings.enabledCount)} enabled &middot; {count(savings.disabledCount)} disabled
            </p>
            <p className="tnum text-[0.85rem] text-[var(--text-dim)]">
              {count(savings.changedPieceCount)} piece
              {savings.changedPieceCount === 1 ? '' : 's'} affected &middot;{' '}
              {count(savings.uniqueSubstitutionCount)} unique substitution
              {savings.uniqueSubstitutionCount === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {result.pricing.isDemoData ? (
            <Badge tone="warn">
              DEMO PRICE DATA &mdash; synthetic figures, not real BrickLink prices
            </Badge>
          ) : (
            <Badge tone="neutral">{result.pricing.sourceLabel}</Badge>
          )}
          <Badge tone="neutral">Estimated market parts cost, excludes shipping and tax</Badge>
          <Badge tone="neutral">{result.catalog.label}</Badge>
          {result.originalCost.unpricedLots.length > 0 && (
            <Badge tone="warn">
              {count(result.originalCost.unpricedLots.length)} lot
              {result.originalCost.unpricedLots.length === 1 ? '' : 's'} unpriced and excluded
            </Badge>
          )}
        </div>
      </header>

      {/* ---- viewer + change list ---- */}
      <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="panel flex min-h-[520px] flex-col overflow-hidden xl:sticky xl:top-[4.5rem] xl:max-h-[calc(100vh-6rem)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5">
            <div className="flex rounded-md border border-[var(--line-strong)] p-0.5">
              {(
                [
                  ['optimized', 'Optimised'],
                  ['original', 'Original'],
                  ['split', 'Compare'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={`rounded px-2.5 py-1 text-[0.78rem] transition-colors ${
                    viewMode === mode
                      ? 'bg-[var(--accent)] font-medium text-[#1a1206]'
                      : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="tnum text-[0.74rem] text-[var(--text-faint)]">
              {viewerInfo
                ? `${count(viewerInfo.instanceCount)} parts drawn${
                    viewerInfo.omitted > 0 ? `, ${count(viewerInfo.omitted)} omitted` : ''
                  }`
                : 'Click a part to inspect it'}
            </p>
          </div>

          <div className="relative min-h-0 flex-1">
            {viewMode === 'split' ? (
              <div className="grid h-full grid-cols-2 divide-x divide-[var(--line)]">
                <div className="relative">
                  <SplitLabel>Original</SplitLabel>
                  <ModelViewer
                    url={geometryUrl}
                    showOptimized={false}
                    enabledCandidateIds={enabledIds}
                    highlightInstanceIds={highlightInstanceIds}
                    className="h-full w-full"
                  />
                </div>
                <div className="relative">
                  <SplitLabel>Optimised</SplitLabel>
                  <ModelViewer
                    url={geometryUrl}
                    showOptimized
                    enabledCandidateIds={enabledIds}
                    highlightInstanceIds={highlightInstanceIds}
                    onSelect={onSelectPart}
                    className="h-full w-full"
                  />
                </div>
              </div>
            ) : (
              <ModelViewer
                url={geometryUrl}
                showOptimized={viewMode === 'optimized'}
                enabledCandidateIds={enabledIds}
                highlightInstanceIds={highlightInstanceIds}
                onSelect={onSelectPart}
                onLoaded={(info) =>
                  setViewerInfo({ instanceCount: info.instanceCount, omitted: info.omitted })
                }
                className="h-full w-full"
              />
            )}
          </div>

          {(selectedPart || selectedCandidate) && (
            <SelectionPanel
              part={selectedPart}
              candidate={selectedCandidate}
              currency={savings.currency}
              enabled={selectedCandidate ? enabledIds.has(selectedCandidate.id) : false}
              onClear={() => {
                setSelectedPart(null);
                setSelectedCandidate(null);
              }}
            />
          )}
        </section>

        <section className="panel flex max-h-[calc(100vh-6rem)] min-h-[520px] flex-col overflow-hidden">
          <ChangeList
            candidates={result.candidates}
            enabledIds={enabledIds}
            currency={savings.currency}
            selectedId={selectedCandidate?.id ?? null}
            onToggle={toggle}
            onSelect={onSelectCandidate}
            onBulk={bulk}
          />
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="xl:col-start-2">
          <ExportPanel
            analysisId={result.id}
            enabledIds={enabledArray}
            isMpd={result.model.isMpd}
            enabledCount={savings.enabledCount}
          />
        </div>
      </div>

      <div className="mt-5">
        <h2 className="mb-3 text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
          Analysis details
        </h2>
        <AnalysisDetails result={result} />
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.73rem] uppercase tracking-[0.13em] text-[var(--text-faint)]">{label}</p>
      <p className="tnum mt-1.5 text-[1.55rem] font-semibold leading-none">{value}</p>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'warn' | 'neutral' }) {
  const className =
    tone === 'warn'
      ? 'border-[color-mix(in_srgb,var(--warn)_45%,var(--line))] text-[var(--warn)]'
      : 'border-[var(--line-strong)] text-[var(--text-faint)]';
  return (
    <span className={`rounded border px-2 py-0.5 text-[0.7rem] font-medium ${className}`}>
      {children}
    </span>
  );
}

function SplitLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-3 top-3 z-10 rounded bg-[var(--panel)]/85 px-2 py-1 text-[0.7rem] uppercase tracking-wide text-[var(--text-faint)] backdrop-blur">
      {children}
    </span>
  );
}

function SelectionPanel({
  part,
  candidate,
  currency,
  enabled,
  onClear,
}: {
  part: SelectedPart | null;
  candidate: OptimizationCandidate | null;
  currency: string;
  enabled: boolean;
  onClear: () => void;
}) {
  const visibility = part?.visibility ?? candidate?.visibility.classification ?? null;
  const style = visibility ? VISIBILITY_STYLE[visibility] : null;

  return (
    <div className="border-t border-[var(--line)] bg-[var(--panel-2)] px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {part ? (
            <>
              <p className="text-[0.86rem] font-medium">
                {part.description ?? part.partId}{' '}
                <span className="font-mono text-[0.74rem] text-[var(--text-faint)]">
                  {part.partId}
                </span>
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-[var(--text-dim)]">
                <span className="flex items-center gap-1.5">
                  <Swatch hex={part.colorHex} />
                  {part.colorName}
                </span>
                <span>Step {part.step}</span>
                <span className="truncate">{part.subModel}</span>
                {style && (
                  <span className={`rounded border px-1.5 py-px text-[0.72rem] ${style.className}`}>
                    {style.label}
                  </span>
                )}
              </div>
            </>
          ) : (
            candidate && (
              <p className="text-[0.86rem] font-medium">
                {candidate.partDescription}{' '}
                <span className="font-mono text-[0.74rem] text-[var(--text-faint)]">
                  {candidate.partId}
                </span>
              </p>
            )
          )}

          {candidate && (
            <p className="tnum mt-2 text-[0.78rem]">
              <span className="text-[var(--text-dim)]">
                {candidate.kind === 'mold_equivalent'
                  ? `${candidate.originalPartId} → ${candidate.replacementPartId}`
                  : `${candidate.originalColorName} → ${candidate.replacementColorName}`}
              </span>
              <span className="mx-2 text-[var(--text-faint)]">·</span>
              <span className="text-[var(--accent)]">
                saves {money(candidate.savings, currency)}
              </span>
              <span className="mx-2 text-[var(--text-faint)]">·</span>
              <span className="text-[var(--text-dim)]">
                {confidenceLabel(candidate.confidence)} confidence
              </span>
              <span className="mx-2 text-[var(--text-faint)]">·</span>
              <span className={enabled ? 'text-[var(--good)]' : 'text-[var(--text-faint)]'}>
                {enabled ? 'applied' : 'not applied'}
              </span>
            </p>
          )}

          {!candidate && part && (
            <p className="mt-2 text-[0.77rem] text-[var(--text-faint)]">
              No change is proposed for this part.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="shrink-0 rounded border border-[var(--line-strong)] px-2 py-1 text-[0.72rem] text-[var(--text-faint)] hover:text-[var(--text)]"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
