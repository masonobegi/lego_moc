/**
 * The shape of a completed analysis. This is what the results page renders,
 * what the exports are generated from, and what is persisted between requests.
 */

import type { CatalogStatus } from '../catalog/types';
import type { ParseWarning } from '../ldraw/types';
import type { CostSummary } from '../pricing/priceEngine';
import type { Condition, PriceSourceId } from '../pricing/types';
import type { OptimizationCandidate, SafetyLevel } from '../optimizer/types';
import type { VisibilityClass } from '../optimizer/visibilityEngine';

export type AnalysisStage =
  | 'parsing'
  | 'resolving'
  | 'geometry'
  | 'visibility'
  | 'pricing'
  | 'colors'
  | 'molds'
  | 'savings';

export const ANALYSIS_STAGES: { id: AnalysisStage; label: string }[] = [
  { id: 'parsing', label: 'Parsing model' },
  { id: 'resolving', label: 'Resolving parts' },
  { id: 'geometry', label: 'Building geometry' },
  { id: 'visibility', label: 'Analysing visibility' },
  { id: 'pricing', label: 'Loading prices' },
  { id: 'colors', label: 'Finding cheaper colours' },
  { id: 'molds', label: 'Checking equivalent molds' },
  { id: 'savings', label: 'Calculating savings' },
];

export interface ModelInfo {
  readonly fileName: string;
  readonly title: string;
  readonly author: string | null;
  readonly isMpd: boolean;
  readonly partCount: number;
  readonly uniqueLotCount: number;
  readonly uniquePartCount: number;
  readonly stepCount: number;
  readonly submodelCount: number;
  readonly byteSize: number;
}

export interface ParseReport {
  readonly warnings: readonly ParseWarning[];
  readonly malformedLineCount: number;
  readonly unresolvedSubmodels: readonly string[];
  readonly truncated: boolean;
  readonly truncationReason: string | null;
}

export interface GeometryReport {
  readonly distinctPartCount: number;
  readonly totalTriangles: number;
  readonly sceneBuildMs: number;
  readonly missingParts: readonly { partId: string; reference: string; count: number }[];
  readonly incompletePartCount: number;
}

export interface VisibilityReport {
  readonly counts: Record<VisibilityClass, number>;
  readonly totalRays: number;
  readonly verifiedInstances: number;
  readonly elapsedMs: number;
  /** Worker threads used. 1 means the analysis ran in-process. */
  readonly workerCount: number;
  readonly scope: string;
}

export interface PricingReport {
  readonly sourceId: PriceSourceId;
  readonly sourceLabel: string;
  readonly isLive: boolean;
  readonly isDemoData: boolean;
  readonly condition: Condition;
  readonly currency: string;
  readonly requested: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly elapsedMs: number;
  readonly liveVerified: boolean | null;
  readonly liveFailures: readonly string[];
  readonly notes: readonly string[];
}

export interface RejectionSummary {
  readonly reason: string;
  readonly label: string;
  readonly commandCount: number;
  readonly pieceCount: number;
}

export interface AnalysisResult {
  readonly id: string;
  readonly createdAt: string;
  readonly schemaVersion: 1;
  readonly model: ModelInfo;
  readonly parse: ParseReport;
  readonly geometry: GeometryReport;
  readonly visibility: VisibilityReport;
  readonly pricing: PricingReport;
  readonly catalog: CatalogStatus;
  readonly safetyLevel: SafetyLevel;
  readonly originalCost: CostSummary;
  readonly candidates: readonly OptimizationCandidate[];
  readonly defaultEnabledIds: readonly string[];
  readonly rejections: readonly RejectionSummary[];
  readonly timings: Record<AnalysisStage, number>;
  readonly totalMs: number;
}

export interface SavingsSummary {
  readonly originalCost: number;
  readonly optimizedCost: number;
  readonly savings: number;
  readonly savingsPercent: number;
  readonly currency: string;
  readonly candidateCount: number;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly changedPieceCount: number;
  readonly uniqueSubstitutionCount: number;
}
