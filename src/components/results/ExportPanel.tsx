'use client';

import { useState } from 'react';

interface Props {
  readonly analysisId: string;
  readonly enabledIds: readonly string[];
  readonly isMpd: boolean;
  readonly enabledCount: number;
}

const EXPORTS = [
  {
    kind: 'ldraw',
    title: 'Optimized model',
    body: 'The same file with only the changed lines rewritten. Build steps, submodels and every other line are untouched.',
  },
  {
    kind: 'report',
    title: 'Optimization report (JSON)',
    body: 'Costs, savings and every change with its evidence and confidence, including the ones you switched off.',
  },
  {
    kind: 'csv',
    title: 'Change log (CSV)',
    body: 'One row per proposed change: step, part, colors, prices, savings, reason, confidence, enabled.',
  },
  {
    kind: 'wanted-list',
    title: 'BrickLink Wanted List (XML)',
    body: 'The optimized inventory in BrickLink XML. Lots whose BrickLink id could not be resolved are excluded and listed.',
  },
] as const;

export function ExportPanel({ analysisId, enabledIds, isMpd, enabledCount }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (kind: string): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch(`/api/results/${analysisId}/export?kind=${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabledIds }),
      });
      if (!response.ok) {
        const message = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => null);
        throw new Error(message ?? `Export failed (HTTP ${response.status}).`);
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match?.[1] ?? `brickthrift-${kind}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel p-5">
      <h2 className="text-[0.95rem] font-semibold">Downloads</h2>
      <p className="mt-1.5 text-[0.79rem] leading-relaxed text-[var(--text-dim)]">
        Every download reflects the {enabledCount} change{enabledCount === 1 ? '' : 's'} you
        currently have switched on. Your uploaded file is never modified.
      </p>

      <ul className="mt-4 space-y-2.5">
        {EXPORTS.map((item) => (
          <li key={item.kind} data-testid={`export-${item.kind}`} className="panel-2 p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[0.85rem] font-medium">
                  {item.kind === 'ldraw' ? `${item.title} (${isMpd ? '.mpd' : '.ldr'})` : item.title}
                </p>
                <p className="mt-1 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
                  {item.body}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void download(item.kind)}
                disabled={busy !== null}
                className="shrink-0 rounded-[2px] border border-[var(--line-strong)] px-3 py-1.5 text-[0.78rem] font-medium text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
              >
                {busy === item.kind ? 'Preparing...' : 'Download'}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-[0.8rem] text-[var(--bad)]">{error}</p>}

      <div className="mt-4 rounded-[2px] border border-[var(--line)] bg-[var(--panel-2)] p-3.5">
        <h3 className="text-[0.8rem] font-medium">Taking this back into BrickLink Studio</h3>
        <ol className="mt-2 space-y-1.5 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
          <li>1. Download the optimized model above.</li>
          <li>
            2. In Studio: <span className="text-[var(--text)]">File &rarr; Import &rarr; Import Model</span>,
            and choose the downloaded file.
          </li>
          <li>
            3. Your <code className="font-mono">0 STEP</code> boundaries survive the round trip, so
            Studio&apos;s Instruction Maker produces instructions for the optimized model.
          </li>
        </ol>
        <p className="mt-2.5 text-[0.74rem] leading-relaxed text-[var(--text-faint)]">
          BrickThrift does not generate instructions itself. It preserves the step structure so the
          tool that does can pick it up.
        </p>
      </div>
    </section>
  );
}
