import type { Metadata } from 'next';

import { AnalyzeForm } from '@/components/AnalyzeForm';

export const metadata: Metadata = { title: 'Optimise a model' };

export default function OptimizePage() {
  return (
    <div className="mx-auto max-w-[1100px] px-5 py-14">
      <h1 className="text-[1.9rem] font-semibold tracking-tight">Optimise a model</h1>
      <p className="mt-3 max-w-[64ch] text-[0.95rem] leading-relaxed text-[var(--text-dim)]">
        Your file is parsed and analysed on the server that is running this app. It is never
        modified: the optimised model is produced as a separate download.
      </p>

      <div className="mt-9 grid gap-8 lg:grid-cols-[1.35fr_1fr]">
        <AnalyzeForm />

        <aside className="space-y-5">
          <div className="panel p-6">
            <h2 className="text-[0.95rem] font-semibold">Coming from BrickLink Studio?</h2>
            <p className="mt-2.5 text-[0.85rem] leading-relaxed text-[var(--text-dim)]">
              Studio&apos;s own <code className="font-mono">.io</code> format is not read by this
              version. Export your model to LDraw first:
            </p>
            <ol className="mt-4 space-y-2 text-[0.85rem] text-[var(--text-dim)]">
              {['File', 'Export As', 'Export Model, choosing .ldr or .mpd'].map((step, i) => (
                <li key={step} className="flex gap-2.5">
                  <span className="tnum shrink-0 font-mono text-[0.78rem] text-[var(--accent)]">
                    {i + 1}.
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[0.82rem] leading-relaxed text-[var(--text-faint)]">
              Keep <code className="font-mono">.mpd</code> if your model uses submodels: it keeps
              them in one file, and BrickThrift preserves that structure exactly.
            </p>
          </div>

          <div className="panel p-6">
            <h2 className="text-[0.95rem] font-semibold">What you get back</h2>
            <ul className="mt-3 space-y-2.5 text-[0.85rem] leading-relaxed text-[var(--text-dim)]">
              {[
                'An interactive 3D view of the model, with each proposed change highlighted in place.',
                'A change list you can switch on and off one at a time, with the cost updating as you go.',
                'An optimised .ldr or .mpd that keeps your build steps and submodels intact.',
                'A JSON report, a CSV change log and a BrickLink Wanted List.',
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
