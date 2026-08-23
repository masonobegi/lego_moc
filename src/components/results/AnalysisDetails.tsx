'use client';

import type { AnalysisResult } from '@/lib/analysis/types';
import { SAFETY_LEVELS } from '@/lib/optimizer/types';
import { count } from './format';

const VISIBILITY_ROWS: { key: keyof AnalysisResult['visibility']['counts']; label: string; tone: string }[] = [
  { key: 'HIDDEN', label: 'Hidden', tone: 'var(--good)' },
  { key: 'LIKELY_HIDDEN', label: 'Likely hidden', tone: 'var(--good)' },
  { key: 'UNCERTAIN', label: 'Uncertain', tone: 'var(--warn)' },
  { key: 'LIKELY_VISIBLE', label: 'Likely visible', tone: 'var(--warn)' },
  { key: 'VISIBLE', label: 'Visible', tone: 'var(--bad)' },
];

export function AnalysisDetails({ result }: { result: AnalysisResult }) {
  const total = Object.values(result.visibility.counts).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="panel p-5">
        <h2 className="text-[0.95rem] font-semibold">Visibility</h2>
        <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[var(--text-dim)]">
          {count(result.visibility.totalRays)} rays cast against real part geometry.{' '}
          {count(result.visibility.verifiedInstances)} parts survived the first screen and went
          through the dense verification pass
          {result.visibility.workerCount > 1
            ? `, spread across ${result.visibility.workerCount} worker threads`
            : ''}
          .
        </p>

        <ul className="mt-4 space-y-2">
          {VISIBILITY_ROWS.map((row) => {
            const value = result.visibility.counts[row.key];
            return (
              <li key={row.key} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-[0.79rem] text-[var(--text-dim)]">{row.label}</span>
                <span className="h-1.5 flex-1 overflow-hidden bg-[var(--panel-2)]">
                  <span
                    className="block h-full"
                    style={{ width: `${(value / total) * 100}%`, background: row.tone }}
                  />
                </span>
                <span className="tnum w-14 shrink-0 text-right text-[0.79rem]">{count(value)}</span>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-[0.75rem] leading-relaxed text-[var(--text-faint)]">
          {result.visibility.scope}
        </p>
      </section>

      <section className="panel p-5">
        <h2 className="text-[0.95rem] font-semibold">Why parts were left alone</h2>
        {result.rejections.length === 0 ? (
          <p className="mt-2 text-[0.8rem] text-[var(--text-dim)]">
            Nothing was rejected for a recorded reason.
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {result.rejections.map((rejection) => (
              <li key={rejection.reason} className="flex items-start justify-between gap-4">
                <span className="text-[0.8rem] leading-relaxed text-[var(--text-dim)]">
                  {rejection.label}
                </span>
                <span className="tnum shrink-0 text-[0.78rem] text-[var(--text-faint)]">
                  {count(rejection.pieceCount)} pc
                </span>
              </li>
            ))}
          </ul>
        )}
        {result.rejections.some((r) => r.reason === 'mixed_visibility') && (
          <p className="mt-4 rounded-[2px] border border-[var(--line)] bg-[var(--panel-2)] p-3 text-[0.75rem] leading-relaxed text-[var(--text-faint)]">
            &ldquo;Reused submodel where at least one copy is visible&rdquo; is usually the biggest
            missed opportunity in a real model. Those parts are genuinely hidden, but they share a
            line with a copy that is not, and changing that line would recolour the visible one.
            Splitting the submodel would fix it - and would change your build instructions, so this
            version does not do it.
          </p>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="text-[0.95rem] font-semibold">Model and parsing</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-[0.8rem]">
          <Row label="File" value={result.model.fileName} />
          <Row label="Format" value={result.model.isMpd ? 'MPD (multi-part)' : 'LDR (single file)'} />
          <Row label="Parts" value={count(result.model.partCount)} />
          <Row label="Unique part/colour lots" value={count(result.model.uniqueLotCount)} />
          <Row label="Build steps" value={count(result.model.stepCount)} />
          <Row label="Submodels" value={count(result.model.submodelCount)} />
          <Row label="Distinct parts with geometry" value={count(result.geometry.distinctPartCount)} />
          <Row label="Triangles" value={count(result.geometry.totalTriangles)} />
          <Row label="Safety level" value={SAFETY_LEVELS[result.safetyLevel].label} />
          <Row label="Analysis time" value={`${(result.totalMs / 1000).toFixed(1)}s`} />
        </dl>

        {result.geometry.missingParts.length > 0 && (
          <div className="mt-4 rounded-[2px] border border-[color-mix(in_srgb,var(--warn)_35%,var(--line))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-3">
            <p className="text-[0.79rem] font-medium text-[var(--warn)]">
              {count(result.geometry.missingParts.length)} part
              {result.geometry.missingParts.length === 1 ? '' : 's'} could not be found in the LDraw
              library
            </p>
            <p className="mt-1.5 text-[0.76rem] leading-relaxed text-[var(--text-dim)]">
              The model was imported normally, but these parts have no geometry, so their visibility
              could not be assessed and they were never changed. Run{' '}
              <code className="font-mono">npm run parts:fetch</code> to install the complete library.
            </p>
            <p className="mt-2 font-mono text-[0.72rem] text-[var(--text-faint)]">
              {result.geometry.missingParts.slice(0, 12).map((p) => `${p.reference} (x${p.count})`).join(', ')}
              {result.geometry.missingParts.length > 12 ? ', ...' : ''}
            </p>
          </div>
        )}

        {result.parse.unresolvedSubmodels.length > 0 && (
          <div className="mt-3 rounded-[2px] border border-[color-mix(in_srgb,var(--warn)_35%,var(--line))] p-3">
            <p className="text-[0.79rem] font-medium text-[var(--warn)]">
              This model references files that were not included
            </p>
            <p className="mt-1.5 font-mono text-[0.72rem] text-[var(--text-faint)]">
              {result.parse.unresolvedSubmodels.slice(0, 8).join(', ')}
            </p>
          </div>
        )}

        {result.parse.malformedLineCount > 0 && (
          <p className="mt-3 text-[0.77rem] text-[var(--text-dim)]">
            {count(result.parse.malformedLineCount)} line
            {result.parse.malformedLineCount === 1 ? '' : 's'} could not be interpreted. They were
            preserved unchanged and carried through to the export.
          </p>
        )}

        {result.parse.truncated && (
          <p className="mt-3 rounded-[2px] border border-[color-mix(in_srgb,var(--bad)_35%,var(--line))] p-3 text-[0.77rem] text-[var(--bad)]">
            {result.parse.truncationReason}
          </p>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="text-[0.95rem] font-semibold">Data sources</h2>

        <div className="mt-3">
          <p className="text-[0.8rem] font-medium">
            Prices: {result.pricing.sourceLabel}
            {result.pricing.isDemoData && (
              <span className="ml-2 rounded-[2px] border border-[color-mix(in_srgb,var(--warn)_45%,var(--line))] px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-[var(--warn)]">
                Demo price data
              </span>
            )}
          </p>
          <ul className="mt-2 space-y-1.5">
            {result.pricing.notes.map((note) => (
              <li key={note} className="text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
                {note}
              </li>
            ))}
          </ul>
          <p className="tnum mt-2 text-[0.75rem] text-[var(--text-faint)]">
            {count(result.pricing.resolved)} of {count(result.pricing.requested)} price lookups
            resolved &middot; {result.pricing.condition} condition &middot; {result.pricing.currency}
          </p>
        </div>

        <div className="mt-4 border-t border-[var(--line)] pt-4">
          <p className="text-[0.8rem] font-medium">Catalogue: {result.catalog.label}</p>
          <p className="mt-1.5 text-[0.77rem] leading-relaxed text-[var(--text-dim)]">
            {count(result.catalog.partCount)} parts, {count(result.catalog.pairCount)} verified
            part/colour combinations, {count(result.catalog.moldRuleCount)} equivalent-mold rules.
          </p>
          <ul className="mt-2 space-y-1.5">
            {result.catalog.limitations.map((limitation) => (
              <li key={limitation} className="text-[0.75rem] leading-relaxed text-[var(--text-faint)]">
                {limitation}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--text-faint)]">{label}</dt>
      <dd className="tnum truncate text-right text-[var(--text-dim)]" title={value}>
        {value}
      </dd>
    </>
  );
}
