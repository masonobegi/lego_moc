'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ANALYSIS_STAGES, type AnalysisStage } from '@/lib/analysis/types';
import { SAFETY_LEVELS, type SafetyLevel } from '@/lib/optimizer/types';

type Phase = 'idle' | 'inspecting' | 'detected' | 'analyzing' | 'error';

interface Inspection {
  fileName: string;
  title: string;
  author: string | null;
  isMpd: boolean;
  byteSize: number;
  partCount: number;
  uniqueLotCount: number;
  uniquePartCount: number;
  stepCount: number;
  submodelCount: number;
  malformedLineCount: number;
  unresolvedSubmodels: string[];
  truncated: boolean;
  truncationReason: string | null;
  warnings: string[];
}

export function AnalyzeForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>('extremely_conservative');
  const [completedStages, setCompletedStages] = useState<AnalysisStage[]>([]);
  const [currentStage, setCurrentStage] = useState<AnalysisStage | null>(null);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setFile(null);
    setInspection(null);
    setCompletedStages([]);
    setCurrentStage(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  /** Step one: read the model and report what is in it. Cheap and quick. */
  const inspect = useCallback(async (candidate: File) => {
    setPhase('inspecting');
    setError(null);
    setFile(candidate);
    setInspection(null);

    const form = new FormData();
    form.append('file', candidate);

    try {
      const response = await fetch('/api/inspect', { method: 'POST', body: form });
      const body = (await response.json()) as Inspection & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Could not read that file (HTTP ${response.status}).`);
      setInspection(body);
      setPhase('detected');
    } catch (caught) {
      setError((caught as Error).message);
      setPhase('error');
    }
  }, []);

  /** Step two: the expensive part, with real per-stage progress. */
  const analyze = useCallback(async () => {
    if (!file) return;
    setPhase('analyzing');
    setError(null);
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
        throw new Error(message ?? `The analysis failed (HTTP ${response.status}).`);
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
  }, [file, router, safetyLevel]);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const dropped = event.dataTransfer.files.item(0);
      if (dropped) void inspect(dropped);
    },
    [inspect],
  );

  // ---- analyzing --------------------------------------------------------
  if (phase === 'analyzing') {
    return (
      <div className="panel p-8">
        <p className="label">Analyzing</p>
        <h2 className="mt-2 truncate text-[1.1rem] font-semibold">{file?.name}</h2>
        <ol className="mt-7 space-y-2.5">
          {ANALYSIS_STAGES.map((stage) => {
            const done = completedStages.includes(stage.id);
            const active = currentStage === stage.id;
            return (
              <li key={stage.id} className="flex items-center gap-3 text-[0.88rem]">
                <StageIcon done={done} active={active} />
                <span className={active ? 'text-[var(--text)]' : 'text-[var(--text-faint)]'}>
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-7 text-[0.78rem] leading-relaxed text-[var(--text-faint)]">
          Each stage is reported when it actually begins. Visibility analysis is the slow one: it
          casts millions of rays through real part geometry, and a large MOC can take a minute.
        </p>
      </div>
    );
  }

  return (
    <div className="panel p-8">
      {/* ---- drop zone ---- */}
      {phase !== 'detected' && (
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
          className={`flex cursor-pointer flex-col items-center justify-center border border-dashed px-6 py-14 text-center transition-colors ${
            dragging ? 'border-[var(--accent)] bg-[var(--panel-2)]' : 'border-[var(--line-strong)] hover:border-[var(--text-faint)]'
          }`}
        >
          {phase === 'inspecting' ? (
            <>
              <Spinner />
              <p className="mt-4 text-[0.95rem]">Reading {file?.name}</p>
            </>
          ) : (
            <>
              <svg width="28" height="28" viewBox="0 0 30 30" fill="none" aria-hidden className="text-[var(--text-faint)]">
                <path d="M15 20V6m0 0-5 5m5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 18v4a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <p className="mt-4 text-[1rem] font-medium">Drop your LEGO model here</p>
              <p className="mt-1.5 text-[0.84rem] text-[var(--text-dim)]">
                or click to browse. Supported: <code className="font-mono">.ldr</code>{' '}
                <code className="font-mono">.mpd</code>
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".ldr,.mpd"
            className="hidden"
            onChange={(event) => {
              const chosen = event.target.files?.item(0);
              if (chosen) void inspect(chosen);
            }}
          />
        </div>
      )}

      {/* ---- model detected ---- */}
      {phase === 'detected' && inspection && (
        <div data-testid="model-detected">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="label">Model detected</p>
              <h2 className="mt-2 truncate text-[1.15rem] font-semibold">{inspection.title}</h2>
              <p className="mt-1 truncate font-mono text-[0.78rem] text-[var(--text-faint)]">
                {inspection.fileName}
                {inspection.author ? ` · ${inspection.author}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="shrink-0 border border-[var(--line-strong)] px-2.5 py-1 text-[0.76rem] text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
            >
              Choose another
            </button>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <Stat label="Parts" value={inspection.partCount} />
            <Stat label="Unique part/color combinations" value={inspection.uniqueLotCount} />
            <Stat label="Build steps" value={inspection.stepCount} />
            <Stat label="Submodels" value={inspection.submodelCount} />
          </dl>

          {(inspection.malformedLineCount > 0 ||
            inspection.unresolvedSubmodels.length > 0 ||
            inspection.truncated) && (
            <div className="mt-5 border border-[color-mix(in_srgb,var(--warn)_38%,var(--line))] p-3.5">
              <p className="text-[0.82rem] font-medium text-[var(--warn)]">
                Noted while reading this file
              </p>
              <ul className="mt-2 space-y-1.5 text-[0.79rem] leading-relaxed text-[var(--text-dim)]">
                {inspection.malformedLineCount > 0 && (
                  <li>
                    {inspection.malformedLineCount} line
                    {inspection.malformedLineCount === 1 ? '' : 's'} could not be interpreted. They
                    are preserved unchanged and carried through to the export.
                  </li>
                )}
                {inspection.unresolvedSubmodels.length > 0 && (
                  <li>
                    This model references {inspection.unresolvedSubmodels.length} file
                    {inspection.unresolvedSubmodels.length === 1 ? '' : 's'} that {inspection.unresolvedSubmodels.length === 1 ? 'was' : 'were'}{' '}
                    not included:{' '}
                    <span className="font-mono text-[0.75rem]">
                      {inspection.unresolvedSubmodels.slice(0, 5).join(', ')}
                    </span>
                    . Those parts cannot be analyzed and will never be changed.
                  </li>
                )}
                {inspection.truncated && <li>{inspection.truncationReason}</li>}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={() => void analyze()}
            data-testid="analyze-button"
            className="mt-6 w-full bg-[var(--accent)] px-5 py-2.5 text-[0.92rem] font-semibold text-[#14100a] transition-colors hover:bg-[#eeb552]"
          >
            Analyze model
          </button>
          <p className="mt-2.5 text-center text-[0.76rem] text-[var(--text-faint)]">
            {inspection.partCount > 2000
              ? 'A model this size usually takes 10 to 30 seconds.'
              : 'This usually takes a few seconds.'}
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 border border-[color-mix(in_srgb,var(--bad)_45%,var(--line))] p-4">
          <p className="text-[0.86rem] font-medium text-[var(--bad)]">Could not analyze that file</p>
          <p className="mt-1.5 text-[0.83rem] leading-relaxed text-[var(--text-dim)]">{error}</p>
        </div>
      )}

      <fieldset className="mt-7">
        <legend className="label">Safety level</legend>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {(Object.keys(SAFETY_LEVELS) as SafetyLevel[]).map((level) => {
            const config = SAFETY_LEVELS[level];
            const selected = safetyLevel === level;
            return (
              <label
                key={level}
                className={`cursor-pointer border p-4 transition-colors ${
                  selected
                    ? 'border-[color-mix(in_srgb,var(--accent)_45%,var(--line))] bg-[var(--panel-2)]'
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
                  />
                  <span className="text-[0.88rem] font-medium">{config.label}</span>
                  {level === 'extremely_conservative' && (
                    <span className="border border-[var(--line-strong)] px-1.5 py-0.5 text-[0.64rem] uppercase tracking-wide text-[var(--text-faint)]">
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[0.74rem] leading-tight text-[var(--text-faint)]">{label}</dt>
      <dd className="tnum mt-1 text-[1.35rem] font-semibold leading-none">
        {value.toLocaleString('en-US')}
      </dd>
    </div>
  );
}

function StageIcon({ done, active }: { done: boolean; active: boolean }) {
  if (done) {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--good)]" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (active) {
    return (
      <span className="h-[15px] w-[15px] shrink-0 animate-spin rounded-full border-[1.6px] border-[var(--line-strong)] border-t-[var(--accent)]" />
    );
  }
  return <span className="h-[15px] w-[15px] shrink-0 border border-[var(--line-strong)]" />;
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-[1.6px] border-[var(--line-strong)] border-t-[var(--accent)]" />
  );
}
