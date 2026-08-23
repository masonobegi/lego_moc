'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ANALYSIS_STAGES, type AnalysisStage } from '@/lib/analysis/types';
import { SAFETY_LEVELS, type SafetyLevel } from '@/lib/optimizer/types';

type Phase = 'idle' | 'running' | 'error';

interface Props {
  readonly compact?: boolean;
}

export function AnalyzeForm({ compact }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>('extremely_conservative');
  const [completedStages, setCompletedStages] = useState<AnalysisStage[]>([]);
  const [currentStage, setCurrentStage] = useState<AnalysisStage | null>(null);

  const run = useCallback(
    async (file: File) => {
      setPhase('running');
      setError(null);
      setFileName(file.name);
      setCompletedStages([]);
      setCurrentStage(null);

      const form = new FormData();
      form.append('file', file);
      form.append('safetyLevel', safetyLevel);

      try {
        const response = await fetch('/api/analyze?stream=1', { method: 'POST', body: form });
        if (!response.ok || !response.body) {
          const message = await response
            .json()
            .then((body: { error?: string }) => body.error)
            .catch(() => null);
          throw new Error(message ?? `The upload failed (HTTP ${response.status}).`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let resultId: string | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (line.length === 0) continue;
            const event = JSON.parse(line) as
              | { type: 'stage'; stage: AnalysisStage }
              | { type: 'done'; result: { id: string } }
              | { type: 'error'; error: string };

            if (event.type === 'stage') {
              setCurrentStage((previous) => {
                if (previous) setCompletedStages((done2) => [...done2, previous]);
                return event.stage;
              });
            } else if (event.type === 'done') {
              resultId = event.result.id;
            } else {
              throw new Error(event.error);
            }
          }
        }

        if (!resultId) throw new Error('The analysis finished without producing a result.');
        setCurrentStage(null);
        setCompletedStages(ANALYSIS_STAGES.map((s) => s.id));
        router.push(`/results/${resultId}`);
      } catch (caught) {
        setError((caught as Error).message);
        setPhase('error');
      }
    },
    [router, safetyLevel],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files.item(0);
      if (file) void run(file);
    },
    [run],
  );

  if (phase === 'running') {
    return (
      <div className="panel p-8">
        <p className="text-[0.8rem] uppercase tracking-[0.14em] text-[var(--text-faint)]">Analysing</p>
        <h2 className="mt-2 truncate text-[1.15rem] font-semibold">{fileName}</h2>
        <ol className="mt-7 space-y-2.5">
          {ANALYSIS_STAGES.map((stage) => {
            const done = completedStages.includes(stage.id);
            const active = currentStage === stage.id;
            return (
              <li key={stage.id} className="flex items-center gap-3 text-[0.88rem]">
                <StageIcon done={done} active={active} />
                <span className={done ? 'text-[var(--text-faint)]' : active ? 'text-[var(--text)]' : 'text-[var(--text-faint)]'}>
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-7 text-[0.78rem] leading-relaxed text-[var(--text-faint)]">
          Each stage is reported when it actually begins. Visibility analysis is the slow one - it
          casts millions of rays through real part geometry, and a large MOC can take a minute.
        </p>
      </div>
    );
  }

  return (
    <div className={compact ? '' : 'panel p-8'}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Drop a LEGO model here or click to browse"
        className={`flex cursor-pointer flex-col items-center justify-center rounded-[2px] border-2 border-dashed px-6 py-14 text-center transition-colors ${
          dragging
            ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]'
            : 'border-[var(--line-strong)] hover:border-[var(--text-faint)]'
        }`}
      >
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden className="text-[var(--text-faint)]">
          <path d="M15 20V6m0 0-5 5m5-5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 18v4a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <p className="mt-4 text-[1rem] font-medium">Drop your LEGO model here</p>
        <p className="mt-1.5 text-[0.84rem] text-[var(--text-dim)]">
          or click to browse. Supported: <code className="font-mono">.ldr</code>{' '}
          <code className="font-mono">.mpd</code>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".ldr,.mpd"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.item(0);
            if (file) void run(file);
          }}
        />
      </div>

      {error && (
        <div className="mt-4 rounded-[2px] border border-[color-mix(in_srgb,var(--bad)_45%,var(--line))] bg-[color-mix(in_srgb,var(--bad)_9%,transparent)] p-4">
          <p className="text-[0.86rem] font-medium text-[var(--bad)]">Could not analyse that file</p>
          <p className="mt-1.5 text-[0.83rem] leading-relaxed text-[var(--text-dim)]">{error}</p>
        </div>
      )}

      <fieldset className="mt-7">
        <legend className="label">
          Safety level
        </legend>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {(Object.keys(SAFETY_LEVELS) as SafetyLevel[]).map((level) => {
            const config = SAFETY_LEVELS[level];
            const selected = safetyLevel === level;
            return (
              <label
                key={level}
                className={`cursor-pointer rounded-[2px] border p-4 transition-colors ${
                  selected
                    ? 'border-[color-mix(in_srgb,var(--accent)_50%,var(--line))] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]'
                    : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="safetyLevel"
                    value={level}
                    checked={selected}
                    onChange={() => setSafetyLevel(level)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-[0.88rem] font-medium">{config.label}</span>
                  {level === 'extremely_conservative' && (
                    <span className="rounded-[2px] border border-[var(--line-strong)] px-1.5 py-0.5 text-[0.66rem] uppercase tracking-wide text-[var(--text-faint)]">
                      Default
                    </span>
                  )}
                </span>
                <span className="mt-2 block text-[0.8rem] leading-relaxed text-[var(--text-dim)]">
                  {config.description}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

function StageIcon({ done, active }: { done: boolean; active: boolean }) {
  if (done) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--good)]" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (active) {
    return (
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-[1.6px] border-[var(--line-strong)] border-t-[var(--accent)]" />
    );
  }
  return <span className="h-4 w-4 shrink-0 rounded-full border border-[var(--line-strong)]" />;
}
