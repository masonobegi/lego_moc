/**
 * The single entry point every analysis goes through: an upload, a /dev fixture
 * and the test-suite all call this. There is no separate "demo path".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { analyzeModel, applyToInstances, computeSavings } from '../analysis/pipeline';
import type { AnalysisResult, AnalysisStage, SavingsSummary } from '../analysis/types';
import { calculateCost, type CostSummary } from '../pricing/priceEngine';
import { DEFAULT_SAFETY_LEVEL, type SafetyLevel } from '../optimizer/types';
import { validateUpload, sanitizeFilename } from '../security/limits';
import { getRuntimeConfig } from './config';
import { getCatalog, getPartSource, getPriceCache, getPriceProvider } from './services';
import { saveAnalysis, type StoredAnalysis } from './store';

export interface AnalyzeRequest {
  readonly source: string;
  readonly fileName: string;
  readonly safetyLevel?: SafetyLevel;
  /** Called as each stage begins, so the UI can report real progress. */
  readonly onStage?: (stage: AnalysisStage) => void;
}

export interface AnalyzeResponse {
  readonly result: AnalysisResult;
  readonly savings: SavingsSummary;
  readonly optimizedCost: CostSummary;
}

export async function runAnalysis(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const config = getRuntimeConfig();
  const fileName = validateUpload(request.fileName, Buffer.byteLength(request.source, 'utf8'));
  const provider = getPriceProvider(config);

  const output = await analyzeModel({
    source: request.source,
    fileName,
    partSource: getPartSource(config),
    catalog: getCatalog(config),
    priceProvider: provider,
    condition: config.condition,
    safetyLevel: request.safetyLevel ?? DEFAULT_SAFETY_LEVEL,
    // Demo prices cost nothing to look up, so every catalogued colour is
    // evaluated. Live BrickLink calls are rate limited, so the search is
    // narrowed to the colours that are actually likely to be cheaper.
    exhaustiveColorSearch: provider.id === 'demo',
    onStage: request.onStage,
  });

  if (provider.isLive) getPriceCache(config).flush();

  const enabled = new Set(output.result.defaultEnabledIds);
  const optimizedInstances = applyToInstances(output.instances, output.result.candidates, enabled);
  const optimizedCost = calculateCost(
    optimizedInstances,
    output.prices,
    config.condition,
    output.result.pricing.currency,
  );
  const savings = computeSavings(
    output.result.originalCost.total,
    optimizedCost.total,
    output.result.candidates,
    enabled,
    output.result.pricing.currency,
  );

  const record: StoredAnalysis = {
    result: output.result,
    source: request.source,
    quotes: [...output.prices.entries()],
  };
  saveAnalysis(record);

  return { result: output.result, savings, optimizedCost };
}

const FIXTURES = [
  { id: 'exposed-brick.ldr', label: 'Exposed brick', expectation: 'No change. The red brick is in plain sight.' },
  { id: 'buried-brick.ldr', label: 'Buried brick', expectation: 'Red to black. The brick is sealed inside a box.' },
  { id: 'partially-visible.ldr', label: 'Partially visible', expectation: 'No change. A strip of the brick shows through the roof.' },
  { id: 'gap-visible.ldr', label: 'Visible through a gap', expectation: 'No change. Visible only through a one-stud window.' },
  { id: 'multi-step.mpd', label: 'Multi-step build', expectation: 'Red to black, and the part stays in step 3.' },
  { id: 'submodel.mpd', label: 'Nested submodels', expectation: 'Red to black, two submodel levels down.' },
  { id: 'multiple-instances.mpd', label: 'Reused submodels', expectation: 'Only the submodel whose every copy is hidden changes.' },
  { id: 'transparent-window.mpd', label: 'Transparent wall', expectation: 'Only the brick in the opaque box changes.' },
] as const;

export type FixtureId = (typeof FIXTURES)[number]['id'];

export function listFixtures(): readonly { id: string; label: string; expectation: string }[] {
  return FIXTURES;
}

export function readFixture(id: string): { source: string; fileName: string } | null {
  const safe = sanitizeFilename(id);
  if (!FIXTURES.some((f) => f.id === safe)) return null;
  const config = getRuntimeConfig();
  try {
    const source = readFileSync(path.join(config.repoRoot, 'test-models', safe), 'utf8');
    return { source, fileName: safe };
  } catch {
    return null;
  }
}
