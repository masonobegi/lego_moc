import type { Metadata } from 'next';

import { DevConsole } from '@/components/DevConsole';

export const metadata: Metadata = { title: 'Development console' };
export const dynamic = 'force-dynamic';

export default function DevPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12">
      <h1 className="text-[1.9rem] font-semibold tracking-tight">Development console</h1>
      <p className="mt-3 max-w-[72ch] text-[0.95rem] leading-relaxed text-[var(--text-dim)]">
        Load a synthetic test model with one click and see exactly what the pipeline did with it:
        parser output, visibility classifications, price source, stage timings and every candidate
        it proposed or rejected. These fixtures go through the same code an upload does.
      </p>
      <div className="mt-9">
        <DevConsole />
      </div>
    </div>
  );
}
