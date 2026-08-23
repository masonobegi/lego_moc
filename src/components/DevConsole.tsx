'use client';

import { useCallback, useEffect, useState } from 'react';

import type { AnalysisResult, AnalysisStage, SavingsSummary } from '@/lib/analysis/types';
import { ANALYSIS_STAGES } from '@/lib/analysis/types';
import { count, money } from '@/components/results/format';

interface Fixture {
  id: string;
  label: string;
  expectation: string;
}

interface StatusPayload {
  priceSource: string;
  requestedPriceSource: string;
  priceSourceFallbackReason: string | null;
  isDemoData: boolean;
  condition: string;
  guideType: string;
  currency: string;
  partsLibrary: {
    bundledPath: string;
    bundledEntries: number;
    fullPath: string | null;
    fullEntries: number;
    usingFullLibrary: boolean;
  };
  colors: { source: string; count: number };
  catalog: { label: string; partCount: number; pairCount: number; moldRuleCount: number };
  colorMappingEntries: number;
}

export function DevConsole() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [stage, setStage] = useState<AnalysisStage | null>(null);
  const [result, setResult] = useState<{ result: AnalysisResult; savings: SavingsSummary } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/fixtures')
      .then((r) => r.json())
      .then((body: { fixtures: Fixture[] }) => setFixtures(body.fixtures))
      .catch(() => setFixtures([]));
    void fetch('/api/status')
      .then((r) => r.json())
      .then((body: StatusPayload) => setStatus(body))
      .catch(() => setStatus(null));
  }, []);

  const run = useCallback(async (fixture: string) => {
    setRunning(fixture);
    setError(null);
    setResult(null);
    setStage(null);
    try {
      const response = await fetch('/api/analyze?stream=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixture }),
      });
      if (!response.ok || !response.body) {
        const message = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => null);
        throw new Error(message ?? `Analysis failed (HTTP ${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (!line) continue;
          const event = JSON.parse(line) as
            | { type: 'stage'; stage: AnalysisStage }
            | { type: 'done'; result: AnalysisResult; savings: SavingsSummary }
            | { type: 'error'; error: string };
          if (event.type === 'stage') setStage(event.stage);
          else if (event.type === 'done') setResult({ result: event.result, savings: event.savings });
          else throw new Error(event.error);
        }
      }
      setStage(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(null);
    }
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <section className="panel p-5">
          <h2 className="text-[0.95rem] font-semibold">Test fixtures</h2>
          <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[var(--text-dim)]">
            Each runs through the same pipeline an upload does. Files live in{' '}
            <code className="font-mono">test-models/</code>.
          </p>
          <ul className="mt-4 space-y-2">
            {fixtures.map((fixture) => (
              <li key={fixture.id}>
                <button
                  type="button"
                  onClick={() => void run(fixture.id)}
                  disabled={running !== null}
                  className="w-full rounded-[2px] border border-[var(--line)] p-3 text-left transition-colors hover:border-[var(--line-strong)] disabled:opacity-50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[0.85rem] font-medium">{fixture.label}</span>
                    {running === fixture.id && (
                      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--line-strong)] border-t-[var(--accent)]" />
                    )}
                  </span>
                  <span className="mt-1 block font-mono text-[0.7rem] text-[var(--text-faint)]">
                    {fixture.id}
                  </span>
                  <span className="mt-1.5 block text-[0.76rem] leading-relaxed text-[var(--text-dim)]">
                    Expected: {fixture.expectation}
                  </span>
                </button>
              </li>
            ))}
            {fixtures.length === 0 && (
              <li className="text-[0.8rem] text-[var(--text-faint)]">No fixtures found.</li>
            )}
          </ul>
        </section>

        {status && (
          <section className="panel p-5">
            <h2 className="text-[0.95rem] font-semibold">Environment</h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-[0.78rem]">
              <Row
                label="Price source"
                value={`${status.priceSource}${status.isDemoData ? ' (DEMO PRICE DATA)' : ''}`}
              />
              {status.priceSourceFallbackReason && (
                <p className="col-span-2 rounded-[2px] border border-[color-mix(in_srgb,var(--warn)_40%,var(--line))] p-2 text-[0.74rem] leading-relaxed text-[var(--warn)]">
                  {status.priceSourceFallbackReason}
                </p>
              )}
              <Row label="Condition" value={status.condition} />
              <Row label="Currency" value={status.currency} />
              <Row
                label="Parts library"
                value={
                  status.partsLibrary.usingFullLibrary
                    ? `full (${count(status.partsLibrary.fullEntries)} entries)`
                    : `bundled subset (${count(status.partsLibrary.bundledEntries)} entries)`
                }
              />
              <Row label="Colours" value={`${count(status.colors.count)} from ${status.colors.source}`} />
              <Row label="Catalogue" value={status.catalog.label} />
              <Row
                label="Catalogue size"
                value={`${count(status.catalog.partCount)} parts, ${count(status.catalog.pairCount)} pairs`}
              />
              <Row label="Mold rules" value={count(status.catalog.moldRuleCount)} />
              <Row label="Colour mappings" value={count(status.colorMappingEntries)} />
            </dl>
            {!status.partsLibrary.usingFullLibrary && (
              <p className="mt-3 rounded-[2px] border border-[var(--line)] bg-[var(--panel-2)] p-2.5 text-[0.73rem] leading-relaxed text-[var(--text-faint)]">
                Only the bundled part subset is installed. That covers the fixtures and common
                elements; run <code className="font-mono">npm run parts:fetch</code> before analysing
                a real MOC.
              </p>
            )}
          </section>
        )}
      </div>

      <section className="panel min-h-[420px] self-start p-5">
        <h2 className="text-[0.95rem] font-semibold">Run output</h2>

        {stage && (
          <p className="mt-3 flex items-center gap-2.5 text-[0.84rem] text-[var(--text-dim)]">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-[var(--line-strong)] border-t-[var(--accent)]" />
            {ANALYSIS_STAGES.find((s) => s.id === stage)?.label ?? stage}
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-[2px] border border-[color-mix(in_srgb,var(--bad)_40%,var(--line))] p-3 text-[0.83rem] text-[var(--bad)]">
            {error}
          </p>
        )}

        {!result && !stage && !error && (
          <p className="mt-3 text-[0.84rem] text-[var(--text-faint)]">
            Pick a fixture to run it.
          </p>
        )}

        {result && <RunReport result={result.result} savings={result.savings} />}
      </section>
    </div>
  );
}

function RunReport({ result, savings }: { result: AnalysisResult; savings: SavingsSummary }) {
  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <span className="text-[1.05rem] font-semibold">{result.model.fileName}</span>
        <span className="tnum text-[0.85rem] text-[var(--text-dim)]">
          {money(savings.originalCost, savings.currency)} &rarr;{' '}
          <span className="font-semibold text-[var(--accent)]">
            {money(savings.optimizedCost, savings.currency)}
          </span>{' '}
          &middot; saves {money(savings.savings, savings.currency)} ({savings.savingsPercent}%)
        </span>
        <a
          href={`/results/${result.id}`}
          className="text-[0.83rem] font-medium text-[var(--accent)] hover:underline"
        >
          Open full results &rarr;
        </a>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.79rem] sm:grid-cols-[auto_1fr_auto_1fr] sm:gap-x-6">
        <Row label="Parts" value={count(result.model.partCount)} />
        <Row label="Lots" value={count(result.model.uniqueLotCount)} />
        <Row label="Steps" value={count(result.model.stepCount)} />
        <Row label="Submodels" value={count(result.model.submodelCount)} />
        <Row label="Triangles" value={count(result.geometry.totalTriangles)} />
        <Row label="Rays cast" value={count(result.visibility.totalRays)} />
        <Row label="Worker threads" value={String(result.visibility.workerCount)} />
        <Row label="Runtime" value={`${(result.totalMs / 1000).toFixed(2)}s`} />
        <Row label="Price source" value={result.pricing.sourceId} />
      </dl>

      <div>
        <h3 className="text-[0.8rem] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Stage timings
        </h3>
        <ul className="mt-2 space-y-1">
          {ANALYSIS_STAGES.map((stage) => {
            const ms = result.timings[stage.id] ?? 0;
            const share = result.totalMs > 0 ? (ms / result.totalMs) * 100 : 0;
            return (
              <li key={stage.id} className="flex items-center gap-3 text-[0.77rem]">
                <span className="w-40 shrink-0 text-[var(--text-dim)]">{stage.label}</span>
                <span className="h-1.5 flex-1 overflow-hidden bg-[var(--panel-2)]">
                  <span
                    className="block h-full bg-[var(--accent)]"
                    style={{ width: `${Math.max(share, ms > 0 ? 1 : 0)}%` }}
                  />
                </span>
                <span className="tnum w-16 shrink-0 text-right text-[var(--text-faint)]">
                  {ms} ms
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="text-[0.8rem] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Visibility classifications
        </h3>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.79rem] text-[var(--text-dim)]">
          {Object.entries(result.visibility.counts).map(([key, value]) => (
            <li key={key} className="tnum">
              {key}: {count(value)}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-[0.8rem] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Candidates ({count(result.candidates.length)})
        </h3>
        {result.candidates.length === 0 ? (
          <p className="mt-2 text-[0.79rem] text-[var(--text-faint)]">
            None proposed. See rejections below.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {result.candidates.map((candidate) => (
              <li key={candidate.id} className="font-mono text-[0.74rem] text-[var(--text-dim)]">
                [{candidate.kind}] {candidate.partId} {candidate.originalColorName} &rarr;{' '}
                {candidate.replacementColorName}
                {candidate.originalPartId !== candidate.replacementPartId
                  ? ` / ${candidate.originalPartId} → ${candidate.replacementPartId}`
                  : ''}{' '}
                x{candidate.quantity} step {candidate.stepIndex + 1} of {candidate.parentModel}{' '}
                saves {money(candidate.savings, savings.currency)} conf{' '}
                {(candidate.confidence * 100).toFixed(2)}%
              </li>
            ))}
          </ul>
        )}
      </div>

      {result.rejections.length > 0 && (
        <div>
          <h3 className="text-[0.8rem] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
            Rejections
          </h3>
          <ul className="mt-2 space-y-1 text-[0.77rem] text-[var(--text-dim)]">
            {result.rejections.map((rejection) => (
              <li key={rejection.reason} className="tnum">
                {rejection.label}: {count(rejection.commandCount)} line
                {rejection.commandCount === 1 ? '' : 's'}, {count(rejection.pieceCount)} piece
                {rejection.pieceCount === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-[var(--text-faint)]">{label}</dt>
      <dd className="tnum truncate text-right text-[var(--text-dim)]" title={value}>
        {value}
      </dd>
    </>
  );
}
