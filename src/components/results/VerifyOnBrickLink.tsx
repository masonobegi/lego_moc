'use client';

import { useEffect, useState } from 'react';

import { compareDeliveredCosts } from '@/lib/analysis/metrics';
import type { DeliveredCostComparison } from '@/lib/analysis/types';
import { money } from './format';

interface Props {
  readonly analysisId: string;
  readonly currency: string;
  /** Our estimated part-price saving, for the prediction-error comparison. */
  readonly predictedSavings: number;
  readonly onExport: (kind: 'wanted-list-original' | 'wanted-list') => void;
  readonly busyKind: string | null;
}

/**
 * The step that turns an estimate into an answer.
 *
 * Everything else in this app produces an estimate of what the PARTS cost.
 * BrickLink is the only system that knows which sellers have what, what they
 * charge to ship, and what their minimum orders are - and it already has good
 * machinery for turning a Wanted List into an order. Rather than reimplement
 * that badly, this hands the user two lists and asks them to price both.
 *
 * The numbers they type back in are the only figures in the app that reflect a
 * real order. They are stored on this machine, in the analysis record the app
 * already keeps, and are sent nowhere.
 */
export function VerifyOnBrickLink({
  analysisId,
  currency,
  predictedSavings,
  onExport,
  busyKind,
}: Props) {
  const [originalText, setOriginalText] = useState('');
  const [optimizedText, setOptimizedText] = useState('');
  const [saved, setSaved] = useState<DeliveredCostComparison | null>(null);
  const storageKey = `brickthrift:delivered:${analysisId}`;

  // Kept in the browser rather than on the server: it is the user's own note
  // about their own order, and it should survive a reload without needing an
  // account or a round trip.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DeliveredCostComparison;
      if (typeof parsed?.originalDeliveredEstimate === 'number') {
        setSaved(parsed);
        setOriginalText(String(parsed.originalDeliveredEstimate));
        setOptimizedText(String(parsed.optimizedDeliveredEstimate));
      }
    } catch {
      // A private window, cleared site data, or storage disabled. Not a problem.
    }
  }, [storageKey]);

  const original = Number.parseFloat(originalText);
  const optimized = Number.parseFloat(optimizedText);
  const bothEntered =
    Number.isFinite(original) && Number.isFinite(optimized) && original > 0 && optimized > 0;

  const comparison = bothEntered
    ? compareDeliveredCosts({
        originalDeliveredEstimate: original,
        optimizedDeliveredEstimate: optimized,
        currency,
        predictedSavings,
      })
    : null;

  useEffect(() => {
    if (!comparison) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(comparison));
      setSaved(comparison);
    } catch {
      // Storage unavailable. The figures still show; they just will not persist.
    }
  }, [comparison, storageKey]);

  const cheaper = comparison !== null && comparison.difference > 0;

  return (
    <section className="panel p-5" data-testid="verify-on-bricklink">
      <h2 className="text-[0.95rem] font-semibold">
        Want to know whether you actually save money after shipping?
      </h2>
      <p className="mt-1.5 text-[0.79rem] leading-relaxed text-[var(--text-dim)]">
        Our figure is what the <strong className="font-medium">parts</strong> cost at typical market
        prices. It does not know which sellers BrickLink will choose for you, what they charge to
        ship, or whether a color change pushes your order onto an extra seller. BrickLink does. Price
        both lists there and compare.
      </p>

      <ol className="mt-4 space-y-2.5 text-[0.8rem] leading-relaxed">
        <Step n={1}>
          <button
            type="button"
            onClick={() => onExport('wanted-list-original')}
            disabled={busyKind !== null}
            className="underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--accent)] disabled:opacity-50"
          >
            Export the <strong className="font-medium">Original</strong> Wanted List
          </button>{' '}
          &mdash; your model exactly as you uploaded it.
        </Step>
        <Step n={2}>
          Import it into BrickLink and record the order total it gives you.
          <span className="mt-0.5 block text-[0.74rem] text-[var(--text-faint)]">
            On BrickLink: Want &rarr; Upload Wanted List &rarr; choose the XML file, then use their
            purchasing tools to price the list.
          </span>
        </Step>
        <Step n={3}>
          <button
            type="button"
            onClick={() => onExport('wanted-list')}
            disabled={busyKind !== null}
            className="underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--accent)] disabled:opacity-50"
          >
            Export the <strong className="font-medium">Optimized</strong> Wanted List
          </button>{' '}
          &mdash; with the changes you have switched on.
        </Step>
        <Step n={4}>Import that one and price it the same way.</Step>
        <Step n={5}>Compare the two totals. That difference is your real answer.</Step>
      </ol>

      {/* ---- the user's own measurement ---- */}
      <div className="mt-5 border-t border-[var(--line)] pt-4">
        <p className="label">Optional: record what BrickLink told you</p>
        <p className="mt-1.5 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
          Stays in this browser. Nothing is uploaded.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            id="delivered-original"
            label="Original BrickLink estimate"
            currency={currency}
            value={originalText}
            onChange={setOriginalText}
          />
          <Field
            id="delivered-optimized"
            label="Optimized BrickLink estimate"
            currency={currency}
            value={optimizedText}
            onChange={setOptimizedText}
          />
        </div>

        {comparison && (
          <div
            data-testid="delivered-comparison"
            className="mt-4 border border-[var(--line-strong)] p-4"
          >
            <p className="label">Verified estimated checkout savings</p>
            <p
              className={`tnum mt-1.5 text-[1.6rem] font-semibold leading-none ${
                cheaper ? 'text-[var(--accent)]' : 'text-[var(--bad)]'
              }`}
            >
              {money(Math.abs(comparison.difference), currency)}{' '}
              <span className="text-[0.95rem] font-medium">
                {cheaper ? 'cheaper' : 'more expensive'}
              </span>
            </p>
            <p className="mt-2.5 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
              From your own BrickLink figures: {money(comparison.originalDeliveredEstimate, currency)}{' '}
              against {money(comparison.optimizedDeliveredEstimate, currency)}. BrickLink presents its
              own order totals as estimates too, so this is not a guaranteed price either &mdash; but
              unlike our figure it does account for sellers, shipping and minimums.
            </p>
            <p className="mt-2 text-[0.77rem] leading-relaxed text-[var(--text-faint)]">
              We predicted {money(predictedSavings, currency)} off the parts bill.{' '}
              {Math.abs(comparison.predictionError) < 0.005 ? (
                <>Our estimate matched what you measured.</>
              ) : comparison.predictionError > 0 ? (
                <>
                  We were optimistic by {money(comparison.predictionError, currency)} &mdash; the
                  difference went to shipping, minimums or how the order split across sellers.
                </>
              ) : (
                <>
                  You did {money(-comparison.predictionError, currency)} better than we predicted.
                </>
              )}
            </p>
          </div>
        )}

        {!comparison && saved === null && (originalText !== '' || optimizedText !== '') && (
          <p className="mt-3 text-[0.77rem] text-[var(--text-faint)]">
            Enter both totals to see the comparison.
          </p>
        )}
      </div>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tnum mt-[0.1rem] shrink-0 text-[0.75rem] font-semibold text-[var(--text-faint)]">
        {n}
      </span>
      <span className="text-[var(--text-dim)]">{children}</span>
    </li>
  );
}

function Field({
  id,
  label,
  currency,
  value,
  onChange,
}: {
  id: string;
  label: string;
  currency: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-[0.75rem] text-[var(--text-faint)]">
        {label}
      </label>
      <div className="mt-1 flex items-center border border-[var(--line-strong)] focus-within:border-[var(--accent)]">
        <span className="px-2.5 text-[0.8rem] text-[var(--text-faint)]">{currency}</span>
        <input
          id={id}
          data-testid={id}
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="tnum w-full bg-transparent py-2 pr-2.5 text-[0.9rem] outline-none"
        />
      </div>
    </div>
  );
}
