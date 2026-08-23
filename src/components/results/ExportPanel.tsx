'use client';

import { useState } from 'react';

import type { SavingsSummary } from '@/lib/analysis/types';
import { count, money } from './format';
import { VerifyOnBrickLink } from './VerifyOnBrickLink';

interface Props {
  readonly analysisId: string;
  readonly enabledIds: readonly string[];
  readonly isMpd: boolean;
  readonly enabledCount: number;
  readonly savings: SavingsSummary;
  readonly orderSummary: { lots: number; pieces: number; unpriced: number } | null;
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
    kind: 'wanted-list-original',
    title: 'Original BrickLink Wanted List (XML)',
    body: 'The untouched inventory, exactly as you uploaded it. Price this one on BrickLink first.',
  },
  {
    kind: 'wanted-list',
    title: 'Optimized BrickLink Wanted List (XML)',
    body: 'The same inventory with your enabled changes applied. Price this one second and compare the two totals.',
  },
  {
    kind: 'changed-parts-csv',
    title: 'Changed parts only (CSV)',
    body: 'Just the lots that differ: what to buy more of, what to buy fewer of, and what you no longer need at all. Both directions, with the quantities.',
  },
  {
    kind: 'changed-parts-wanted-list',
    title: 'Changed parts only (XML)',
    body: 'The extra pieces alone, for topping up an order you have already placed. A Wanted List cannot express a removal, so the parts you no longer need are in the CSV above, not here.',
  },
] as const;

export function ExportPanel({
  analysisId,
  enabledIds,
  isMpd,
  enabledCount,
  savings,
  orderSummary,
}: Props) {
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
      <h2 className="text-[0.95rem] font-semibold">Review and download</h2>
      <p className="mt-1.5 text-[0.79rem] leading-relaxed text-[var(--text-dim)]">
        Nothing below is decided until you download it. Every file reflects exactly the changes you
        currently have switched on, and your uploaded model is never modified.
      </p>

      {/* What you are about to order. This is the last checkpoint before the
          parts list leaves the app, so it states the outcome plainly. */}
      <div className="mt-4 border border-[var(--line-strong)] p-4" data-testid="order-summary">
        <p className="label">You are about to order</p>
        <dl className="tnum mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-[0.83rem] sm:grid-cols-4">
          <Figure label="Lots" value={orderSummary ? count(orderSummary.lots) : '-'} />
          <Figure label="Pieces" value={orderSummary ? count(orderSummary.pieces) : '-'} />
          <Figure
            label="Changes applied"
            value={`${count(savings.enabledCount)} of ${count(savings.candidateCount)}`}
          />
          <Figure
            label="Estimated part cost"
            value={money(savings.optimizedCost, savings.currency)}
            accent
          />
        </dl>
        <p className="mt-3 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
          {savings.enabledCount === 0 ? (
            <>
              No changes are switched on, so the downloads below are your original model and its
              original parts list.
            </>
          ) : (
            <>
              {count(savings.changedPieceCount)} piece
              {savings.changedPieceCount === 1 ? ' changes' : 's change'} color, an estimated{' '}
              <span className="font-semibold text-[var(--accent)]">
                {money(savings.savings, savings.currency)}
              </span>{' '}
              off the parts bill.{' '}
              {savings.changedPieceCount === 1
                ? 'It is a part with no externally visible surface, so the finished model looks the same.'
                : 'Every one of them is a part with no externally visible surface, so the finished model looks the same.'}
            </>
          )}
          {orderSummary && orderSummary.unpriced > 0 && (
            <>
              {' '}
              {count(orderSummary.unpriced)} lot{orderSummary.unpriced === 1 ? '' : 's'} could not be
              priced and {orderSummary.unpriced === 1 ? 'is' : 'are'} excluded from the estimate, but
              {orderSummary.unpriced === 1 ? ' it is' : ' they are'} still in the model and the
              wanted list.
            </>
          )}
        </p>
      </div>

      <ul className="mt-5 space-y-2.5">
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

      <div className="mt-5">
        <VerifyOnBrickLink
          analysisId={analysisId}
          currency={savings.currency}
          predictedSavings={savings.savings}
          onExport={(kind) => void download(kind)}
          busyKind={busy}
        />
      </div>

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

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-[0.72rem] leading-tight text-[var(--text-faint)]">{label}</dt>
      <dd className={`mt-1 text-[0.98rem] font-semibold ${accent ? 'text-[var(--accent)]' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
