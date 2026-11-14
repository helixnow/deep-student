import { forgettingCurveConstants, retrievability } from './fsrs-scheduler.ts';

export type ExamPhase =
  | 'foundation'
  | 'reinforce'
  | 'sprint'
  | 'maintenance'
  | 'unscheduled';

export interface ExamHorizonConfig {
  spaceId: string | null;
  rootFolderId: string | null;
  examDate: string | null;
  sprintBudgetMinutes: number;
  baseTargetRetention: number;
  defaultDeckId: string | null;
  dayRolloverHour: number;
}

export interface ExamHorizonConfigPatch {
  spaceId?: string | null;
  rootFolderId?: string | null;
  examDate?: string | null;
  sprintBudgetMinutes?: number;
  baseTargetRetention?: number;
  defaultDeckId?: string | null;
}

export interface ExamReadinessSnapshot {
  spaceId: string | null;
  examDate: string | null;
  daysUntilExam: number | null;
  phase: ExamPhase;
  effectiveTargetRetention: number;
  dailyNewCardQuota: number;
  newIntakeFrozen: boolean;
  predictedExamRetrievability: number | null;
  currentRetrievability: number | null;
  totalActiveItems: number;
  selectedSprintCount: number;
  estimatedSprintMinutes: number;
  estimatedSprintSeconds: number;
  deferredBacklogCount: number;
  breakdown: {
    fsrsDueCount: number;
    fsrsNewCount: number;
    mistakeDueCount: number;
    mindmapWeakCount: number;
  };
  computedAtMs: number;
}

export interface SprintSourceAnchor {
  anchorUri: string | null;
  kind: 'pdf' | 'media' | 'note' | 'mindmap' | 'qbank';
  resourceId: string;
  label: string | null;
  page: number | null;
  startMs: number | null;
  blockId: string | null;
  nodeId: string | null;
  questionId: string | null;
  quote: string | null;
}

export interface SprintItemTriageMeta {
  utilityScore: number;
  currentRetrievability: number;
  examRetrievabilityBefore: number;
  importance: number;
  estimatedSeconds: number;
  conceptTags: string[];
}

export interface SprintFsrsCardItem {
  kind: 'fsrs_card';
  sprintItemId: string;
  cardStateId: string;
  ankiCardId: string;
  deckName: string | null;
  cardFormat: 'qa' | 'cloze' | 'image_occlusion';
  front: string;
  back: string;
  fields: Record<string, string>;
  templateId: string | null;
  state: number;
  lapses: number;
  reps: number;
  stability: number | null;
  difficulty: number | null;
  sourceAnchor: SprintSourceAnchor | null;
  triage: SprintItemTriageMeta;
}

export interface SprintMistakeQuestionOption {
  key: string;
  content: string;
}

export interface SprintMistakeItem {
  kind: 'mistake_question';
  sprintItemId: string;
  planId: string;
  examId: string;
  examName: string | null;
  questionId: string;
  originalQuestionId: string;
  isVariant: boolean;
  variantBadgeReason: 'high_lapses' | 'repeated_wrong' | null;
  questionType: string;
  content: string;
  options: SprintMistakeQuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structuredData: unknown;
  originalPromptPreview: string | null;
  originalAnswerPreview: string | null;
  lapsesCount: number;
  repetitions: number;
  intervalDays: number;
  sourceAnchor: SprintSourceAnchor | null;
  triage: SprintItemTriageMeta;
}

export interface SprintMindmapBlankRange {
  start: number;
  end: number;
}

export interface SprintMindmapClozeItem {
  kind: 'mindmap_cloze';
  sprintItemId: string;
  mindmapId: string;
  mindmapTitle: string;
  nodeId: string;
  ancestorPath: string[];
  siblingHints: string[];
  fullText: string;
  maskedText: string;
  blankedRanges: SprintMindmapBlankRange[];
  noteExcerpt: string | null;
  smoothedErrorRate: number;
  attempts: number;
  misses: number;
  sourceAnchor: SprintSourceAnchor;
  triage: SprintItemTriageMeta;
}

export type SprintQueueItem =
  | SprintFsrsCardItem
  | SprintMistakeItem
  | SprintMindmapClozeItem;

export interface ClientMindmapReciteSignal {
  mindmapId: string;
  nodeId: string;
  attempts: number;
  misses: number;
  lastReviewedAtMs: number | null;
}

export interface BuildDailySprintRequest {
  spaceId: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  clientMindmapSignals?: ClientMindmapReciteSignal[] | null;
  enableAiVariants?: boolean;
  maxLiveVariants?: number;
}

export interface DailySprintPlan {
  planSessionId: string;
  config: ExamHorizonConfig;
  readinessBefore: ExamReadinessSnapshot;
  items: SprintQueueItem[];
  deferredBacklogCount: number;
  generatedVariantsCount: number;
  createdAtMs: number;
}

export interface GenerateMistakeVariantRequest {
  questionId: string;
  planId?: string | null;
  forceRegenerate?: boolean;
}

export interface GenerateMistakeVariantResult {
  variantQuestionId: string;
  originalQuestionId: string;
  isVariant: boolean;
  fromCache: boolean;
  content: string;
  options: SprintMistakeQuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structuredData: unknown;
  questionType: string;
  fallbackReason: string | null;
}

export interface SprintCompletedItemRecord {
  sprintItemId: string;
  kind: 'fsrs_card' | 'mistake_question' | 'mindmap_cloze';
  rating: 1 | 2 | 3 | 4;
  passed: boolean;
  elapsedMs: number;
  conceptTags: string[];
  cardStateId: string | null;
  ankiCardId: string | null;
  planId: string | null;
  questionId: string | null;
  originalQuestionId: string | null;
  isVariant: boolean;
  mindmapId: string | null;
  nodeId: string | null;
  alreadyCommittedInline: boolean;
}

export interface SettleSprintSessionRequest {
  planSessionId: string;
  spaceId: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  readinessBefore: ExamReadinessSnapshot;
  totalElapsedSeconds: number;
  completedItems: SprintCompletedItemRecord[];
  clientMindmapSignalsAfter?: ClientMindmapReciteSignal[] | null;
}

export interface ConceptMasteryDelta {
  concept: string;
  scoreAfter: number;
  outcome: 'improved' | 'steady' | 'needs_reinforce';
}

export interface SprintSessionSettlement {
  planSessionId: string;
  readinessBefore: ExamReadinessSnapshot;
  readinessAfter: ExamReadinessSnapshot;
  readinessDeltaPctPoints: number | null;
  totalCompleted: number;
  passedCount: number;
  againCount: number;
  totalElapsedSeconds: number;
  studyTimeRecordedSeconds: number;
  masteryEventsWritten: number;
  byKind: {
    fsrsCards: number;
    mistakes: number;
    variantsSolved: number;
    mindmapNodes: number;
  };
  conceptDeltas: ConceptMasteryDelta[];
}

export interface GetExamReadinessRequest {
  spaceId: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  clientMindmapSignals?: ClientMindmapReciteSignal[] | null;
}

// ============================================================================
// Pure Candidate Inputs for Exam-Horizon Triage & Readiness
// ============================================================================

export interface FsrsTriageCandidate {
  kind: 'fsrs_card';
  cardStateId: string;
  ankiCardId: string;
  deckName: string | null;
  cardFormat: 'qa' | 'cloze' | 'image_occlusion';
  front: string;
  back: string;
  fields: Record<string, string>;
  templateId: string | null;
  state: number;
  lapses: number;
  reps: number;
  stability: number | null;
  difficulty: number | null;
  isDue: boolean;
  isBuried?: boolean;
  daysSinceLastReview: number;
  daysOverdue: number;
  historicalMeanSeconds?: number | null;
  historicalReviewCount?: number;
  conceptMasteryScore?: number | null;
  inActiveSpaceScope?: boolean;
  hasExamPriorityTag?: boolean;
  conceptTags: string[];
  sourceAnchor: SprintSourceAnchor | null;
}

export interface MistakeTriageCandidate {
  kind: 'mistake_question';
  planId: string;
  examId: string;
  examName: string | null;
  questionId: string;
  originalQuestionId: string;
  isVariant: boolean;
  variantBadgeReason: 'high_lapses' | 'repeated_wrong' | null;
  questionType: string;
  content: string;
  options: SprintMistakeQuestionOption[] | null;
  answer: string | null;
  explanation: string | null;
  structuredData: unknown;
  originalPromptPreview: string | null;
  originalAnswerPreview: string | null;
  status: 'new' | 'learning' | 'reviewing' | 'graduated' | 'suspended';
  lapsesCount: number;
  consecutiveFailures: number;
  isDifficult: boolean;
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  isDue: boolean;
  daysSinceLastReview: number | null;
  daysOverdue: number;
  historicalMeanSeconds?: number | null;
  historicalReviewCount?: number;
  conceptMasteryScore?: number | null;
  inActiveSpaceScope?: boolean;
  hasExamPriorityTag?: boolean;
  conceptTags: string[];
  sourceAnchor: SprintSourceAnchor | null;
}

export interface MindmapTriageCandidate {
  kind: 'mindmap_cloze';
  mindmapId: string;
  mindmapTitle: string;
  nodeId: string;
  ancestorPath: string[];
  siblingHints: string[];
  fullText: string;
  maskedText: string;
  blankedRanges: SprintMindmapBlankRange[];
  noteExcerpt: string | null;
  attempts: number;
  misses: number;
  daysSinceLastReview: number;
  priority?: number | null;
  isWeakCandidate?: boolean;
  historicalMeanSeconds?: number | null;
  historicalReviewCount?: number;
  conceptMasteryScore?: number | null;
  inActiveSpaceScope?: boolean;
  hasExamPriorityTag?: boolean;
  conceptTags: string[];
  sourceAnchor: SprintSourceAnchor;
}

export type TriageCandidateInput =
  | FsrsTriageCandidate
  | MistakeTriageCandidate
  | MindmapTriageCandidate;

export interface ExamHorizonTriageInput {
  config: ExamHorizonConfig;
  nowMs: number;
  candidates: readonly TriageCandidateInput[];
  fsrsParams?: readonly number[];
  deckNewPerDay?: number;
  newIntroducedToday?: number;
  offsetMinutes?: number;
}

export interface ExamHorizonTriageResult {
  snapshot: ExamReadinessSnapshot;
  selectedItems: SprintQueueItem[];
  deferredBacklogCount: number;
}

// ============================================================================
// Pure Math & Sanitization Helpers
// ============================================================================

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

export const DEFAULT_SPRINT_BUDGET_MINUTES = 15;
export const MIN_SPRINT_BUDGET_MINUTES = 5;
export const MAX_SPRINT_BUDGET_MINUTES = 120;
export const DEFAULT_BASE_TARGET_RETENTION = 0.88;
export const DEFAULT_DAY_ROLLOVER_HOUR = 4;

const EXAM_TAG_RE = /(?:^|#|\s)(?:exam|重点|必考|核心|high[-_]?yield)(?:$|\s)/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function sanitizeRolloverHour(dayRolloverHour: number | null | undefined): number {
  if (dayRolloverHour === null || dayRolloverHour === undefined || !Number.isFinite(dayRolloverHour)) {
    return DEFAULT_DAY_ROLLOVER_HOUR;
  }
  return clamp(Math.trunc(dayRolloverHour), 0, 23);
}

export function sanitizeSprintBudgetMinutes(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return DEFAULT_SPRINT_BUDGET_MINUTES;
  }
  return clamp(Math.round(minutes), MIN_SPRINT_BUDGET_MINUTES, MAX_SPRINT_BUDGET_MINUTES);
}

export function sanitizeBaseTargetRetention(
  retention: number | null | undefined,
  fallback = DEFAULT_BASE_TARGET_RETENTION,
): number {
  if (retention === null || retention === undefined || !Number.isFinite(retention)) {
    return round4(clamp(Number.isFinite(fallback) ? fallback : DEFAULT_BASE_TARGET_RETENTION, 0.80, 0.97));
  }
  return round4(clamp(retention, 0.80, 0.97));
}

export interface ParsedYmd {
  year: number;
  month: number;
  day: number;
  normalized: string;
}

export function parseExamDateYmd(examDate: string | null | undefined): ParsedYmd | null {
  if (typeof examDate !== 'string') return null;
  const trimmed = examDate.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month - 1, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const normalized = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, normalized };
}

export function logicalLocalDateParts(
  nowMs: number,
  dayRolloverHour = DEFAULT_DAY_ROLLOVER_HOUR,
  offsetMinutes?: number,
): { year: number; month: number; day: number } {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : 0;
  const rollover = sanitizeRolloverHour(dayRolloverHour);
  if (offsetMinutes !== undefined && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(safeNowMs + offsetMinutes * MS_PER_MINUTE - rollover * MS_PER_HOUR);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    };
  }
  const local = new Date(safeNowMs);
  const year = local.getFullYear();
  const monthIndex = local.getMonth();
  const date = local.getDate();
  const hour = local.getHours();
  const adjusted = new Date(Date.UTC(year, monthIndex, date - (hour < rollover ? 1 : 0)));
  return {
    year: adjusted.getUTCFullYear(),
    month: adjusted.getUTCMonth() + 1,
    day: adjusted.getUTCDate(),
  };
}

export function logicalLocalDateKey(
  nowMs: number,
  dayRolloverHour = DEFAULT_DAY_ROLLOVER_HOUR,
  offsetMinutes?: number,
): string {
  const parts = logicalLocalDateParts(nowMs, dayRolloverHour, offsetMinutes);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function computeDaysUntilExam(
  nowMs: number,
  examDate: string | null | undefined,
  dayRolloverHour = DEFAULT_DAY_ROLLOVER_HOUR,
  offsetMinutes?: number,
): number | null {
  const parsedExam = parseExamDateYmd(examDate);
  if (parsedExam === null) return null;
  const nowParts = logicalLocalDateParts(nowMs, dayRolloverHour, offsetMinutes);
  const examUtcMs = Date.UTC(parsedExam.year, parsedExam.month - 1, parsedExam.day);
  const nowUtcMs = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const diff = Math.round((examUtcMs - nowUtcMs) / MS_PER_DAY);
  return Object.is(diff, -0) ? 0 : diff;
}

export function resolveExamPhase(daysUntilExam: number | null): ExamPhase {
  if (daysUntilExam === null || !Number.isFinite(daysUntilExam)) return 'unscheduled';
  if (daysUntilExam > 30) return 'foundation';
  if (daysUntilExam >= 8) return 'reinforce';
  if (daysUntilExam >= 0) return 'sprint';
  return 'maintenance';
}

export function computeEffectiveTargetRetention(
  daysUntilExam: number | null,
  baseTargetRetention = DEFAULT_BASE_TARGET_RETENTION,
): number {
  const safeBase = sanitizeBaseTargetRetention(baseTargetRetention);
  const phase = resolveExamPhase(daysUntilExam);
  if (phase === 'unscheduled') {
    return round4(clamp(safeBase, 0.80, 0.97));
  }
  if (phase === 'maintenance') {
    return 0.88;
  }
  const r0 = clamp(safeBase, 0.85, 0.94);
  const d = daysUntilExam ?? 0;
  if (phase === 'foundation') {
    return round4(Math.max(0.88, r0));
  }
  if (phase === 'reinforce') {
    const rStart = Math.max(0.88, r0);
    const rMid = Math.max(0.92, r0);
    const ratio = clamp((30 - d) / 22, 0, 1);
    return round4(rStart + (rMid - rStart) * ratio);
  }
  const rSprintStart = Math.max(0.925, r0);
  const ratio = clamp(d - 1, 0, 6) / 6;
  return round4(0.94 - (0.94 - rSprintStart) * ratio);
}

export function computeExamBufferDays(daysUntilExam: number): number {
  if (!Number.isFinite(daysUntilExam) || daysUntilExam < 0) return 0;
  const d = Math.trunc(daysUntilExam);
  if (d >= 10) return 5;
  if (d >= 4) return 3;
  return d;
}

export interface NewCardQuotaComputation {
  dailyNewCardQuota: number;
  remainingNewCardQuota: number;
  newIntakeFrozen: boolean;
  bufferDays: number;
}

export function computeDailyNewCardQuota(params: {
  daysUntilExam: number | null;
  unseenCount: number;
  deckNewPerDay?: number;
  newIntroducedToday?: number;
}): NewCardQuotaComputation {
  const unseen = Math.max(0, Math.floor(Number.isFinite(params.unseenCount) ? params.unseenCount : 0));
  const deckCap = Math.max(
    0,
    Math.floor(Number.isFinite(params.deckNewPerDay ?? 20) ? (params.deckNewPerDay ?? 20) : 20),
  );
  const introducedToday = Math.max(
    0,
    Math.floor(Number.isFinite(params.newIntroducedToday ?? 0) ? (params.newIntroducedToday ?? 0) : 0),
  );

  const d = params.daysUntilExam;
  if (d === null || !Number.isFinite(d) || d < 0) {
    const quota = Math.min(unseen + introducedToday, deckCap);
    return {
      dailyNewCardQuota: quota,
      remainingNewCardQuota: Math.min(unseen, Math.max(0, quota - introducedToday)),
      newIntakeFrozen: false,
      bufferDays: 0,
    };
  }

  const bufferDays = computeExamBufferDays(d);
  if (d <= bufferDays) {
    return {
      dailyNewCardQuota: 0,
      remainingNewCardQuota: 0,
      newIntakeFrozen: true,
      bufferDays,
    };
  }

  const burnWindow = Math.max(1, d - bufferDays);
  const burnPerDay = Math.ceil((unseen + introducedToday) / burnWindow);
  const ceiling = Math.max(deckCap, 40);
  const quota = Math.min(unseen + introducedToday, ceiling, burnPerDay);
  return {
    dailyNewCardQuota: quota,
    remainingNewCardQuota: Math.min(unseen, Math.max(0, quota - introducedToday)),
    newIntakeFrozen: false,
    bufferDays,
  };
}

export function forecastHorizonDays(daysUntilExam: number | null): number {
  if (daysUntilExam !== null && Number.isFinite(daysUntilExam) && daysUntilExam >= 0) {
    return daysUntilExam;
  }
  return 7;
}

export function projectFsrsRetrievability(params: {
  state: number;
  stability: number | null | undefined;
  daysSinceLastReview: number;
  horizonDays: number;
  fsrsParams?: readonly number[];
}): { currentRetrievability: number; examRetrievability: number } {
  if (params.state === 0 || params.stability == null || !Number.isFinite(params.stability) || params.stability <= 0) {
    return { currentRetrievability: 0.15, examRetrievability: 0.15 };
  }
  const rawStability = params.stability;
  const safeStability =
    rawStability !== null &&
    rawStability !== undefined &&
    Number.isFinite(rawStability) &&
    rawStability > 0
      ? rawStability
      : 0.5;
  const tNow = Number.isFinite(params.daysSinceLastReview)
    ? Math.max(0, params.daysSinceLastReview)
    : 0;
  const horizon = Number.isFinite(params.horizonDays) ? Math.max(0, params.horizonDays) : 7;
  const [decay, factor] = forgettingCurveConstants(params.fsrsParams ?? []);
  const rNow = clamp(retrievability(tNow, safeStability, decay, factor), 0, 1);
  const rExam = clamp(retrievability(tNow + horizon, safeStability, decay, factor), 0, 1);
  return {
    currentRetrievability: round6(rNow),
    examRetrievability: round6(rExam),
  };
}

export function computeSm2EffectiveStability(params: {
  status: string;
  consecutiveFailures: number;
  intervalDays: number;
  easeFactor: number;
}): number {
  const failures = Number.isFinite(params.consecutiveFailures) ? params.consecutiveFailures : 0;
  if (params.status === 'new' || failures > 0) {
    return 0.35;
  }
  const safeInterval = Number.isFinite(params.intervalDays) ? Math.max(0, params.intervalDays) : 0;
  const safeEase = Number.isFinite(params.easeFactor) ? params.easeFactor : 2.5;
  return Math.max(0.6, safeInterval * (0.85 + 0.10 * clamp(safeEase - 1.3, 0, 1.5)));
}

export function projectMistakeRetrievability(params: {
  status: string;
  consecutiveFailures: number;
  intervalDays: number;
  easeFactor: number;
  daysSinceLastReview: number | null;
  daysOverdue: number;
  horizonDays: number;
  fsrsParams?: readonly number[];
}): { currentRetrievability: number; examRetrievability: number; effectiveStability: number } {
  const stability = computeSm2EffectiveStability(params);
  const safeOverdue = Number.isFinite(params.daysOverdue) ? Math.max(0, params.daysOverdue) : 0;
  const tNow =
    params.daysSinceLastReview !== null && Number.isFinite(params.daysSinceLastReview)
      ? Math.max(0, params.daysSinceLastReview)
      : Math.max(1, safeOverdue + 1);
  const horizon = Number.isFinite(params.horizonDays) ? Math.max(0, params.horizonDays) : 7;
  const [decay, factor] = forgettingCurveConstants(params.fsrsParams ?? []);
  const rNow = clamp(retrievability(tNow, stability, decay, factor), 0, 1);
  const rExam = clamp(retrievability(tNow + horizon, stability, decay, factor), 0, 1);
  return {
    currentRetrievability: round6(rNow),
    examRetrievability: round6(rExam),
    effectiveStability: stability,
  };
}

export function computeMindmapSmoothedErrorRate(attempts: number, misses: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  const safeMisses = Number.isFinite(misses)
    ? Math.min(safeAttempts, Math.max(0, Math.floor(misses)))
    : 0;
  return round6((safeMisses + 1) / (safeAttempts + 2));
}

export function projectMindmapNodeRetrievability(params: {
  attempts: number;
  misses: number;
  daysSinceLastReview: number;
  horizonDays: number;
  fsrsParams?: readonly number[];
}): {
  currentRetrievability: number;
  examRetrievability: number;
  smoothedErrorRate: number;
  effectiveStability: number;
} {
  const safeAttempts = Number.isFinite(params.attempts) ? Math.max(0, Math.floor(params.attempts)) : 0;
  const safeMisses = Number.isFinite(params.misses)
    ? Math.min(safeAttempts, Math.max(0, Math.floor(params.misses)))
    : 0;
  const errorRate = (safeMisses + 1) / (safeAttempts + 2);
  const stability = Math.max(
    0.5,
    1.5 * (1 + Math.max(0, safeAttempts - safeMisses)) * (1 - 0.55 * errorRate),
  );
  const deltaT = Number.isFinite(params.daysSinceLastReview)
    ? Math.max(0, params.daysSinceLastReview)
    : 0;
  const horizon = Number.isFinite(params.horizonDays) ? Math.max(0, params.horizonDays) : 7;
  const [decay, factor] = forgettingCurveConstants(params.fsrsParams ?? []);
  const rNow = clamp((1 - errorRate) * retrievability(deltaT, stability, decay, factor), 0.05, 0.98);
  const rExam = clamp(
    (1 - errorRate) * retrievability(deltaT + horizon, stability, decay, factor),
    0.05,
    0.98,
  );
  return {
    currentRetrievability: round6(rNow),
    examRetrievability: round6(rExam),
    smoothedErrorRate: round6(errorRate),
    effectiveStability: stability,
  };
}

export function compressIntervalForExamHorizon(params: {
  scheduledDays: number;
  stabilityAfter: number;
  daysUntilExam: number | null;
  effectiveTargetRetention?: number;
  baseTargetRetention?: number;
  fsrsParams?: readonly number[];
}): number {
  const rawScheduled = Number.isFinite(params.scheduledDays)
    ? Math.max(1, Math.round(params.scheduledDays))
    : 1;
  const d = params.daysUntilExam;
  if (d === null || !Number.isFinite(d) || d < 2) {
    return rawScheduled;
  }
  const phase = resolveExamPhase(d);
  if (phase !== 'reinforce' && phase !== 'sprint') {
    return rawScheduled;
  }
  if (rawScheduled <= d) {
    return rawScheduled;
  }
  const safeStability =
    Number.isFinite(params.stabilityAfter) && params.stabilityAfter > 0
      ? params.stabilityAfter
      : 0.5;
  const targetR =
    params.effectiveTargetRetention !== undefined && Number.isFinite(params.effectiveTargetRetention)
      ? sanitizeBaseTargetRetention(params.effectiveTargetRetention)
      : computeEffectiveTargetRetention(d, params.baseTargetRetention ?? DEFAULT_BASE_TARGET_RETENTION);
  const [decay, factor] = forgettingCurveConstants(params.fsrsParams ?? []);
  const projectedExamR = retrievability(d, safeStability, decay, factor);
  if (projectedExamR < targetR - 0.03) {
    return clamp(Math.floor(d * 0.75), 1, rawScheduled);
  }
  return rawScheduled;
}

// ============================================================================
// Smart Triage Scoring & Two-Pass Modality-Balanced Knapsack
// ============================================================================

const CHOICE_QUESTION_TYPES = new Set(['single_choice', 'multiple_choice', 'true_false']);

export function estimateCandidateDurationSeconds(candidate: TriageCandidateInput): number {
  const histCount = candidate.historicalReviewCount ?? 0;
  const histSeconds = candidate.historicalMeanSeconds;
  if (
    histCount >= 3 &&
    histSeconds !== null &&
    histSeconds !== undefined &&
    Number.isFinite(histSeconds) &&
    histSeconds > 0
  ) {
    return clamp(Math.round(histSeconds), 8, 120);
  }
  if (candidate.kind === 'fsrs_card') {
    if (candidate.cardFormat === 'image_occlusion') return 18;
    if (candidate.state === 0 || candidate.lapses >= 3) return 18;
    return 14;
  }
  if (candidate.kind === 'mindmap_cloze') {
    return 20;
  }
  if (candidate.isVariant || !CHOICE_QUESTION_TYPES.has(candidate.questionType)) {
    return 50;
  }
  return 38;
}

function hasExamTag(tags: readonly string[]): boolean {
  return tags.some((tag) => EXAM_TAG_RE.test(tag));
}

export function computeCandidateImportance(
  candidate: TriageCandidateInput,
  smoothedErrorRate = 0,
): number {
  const masteryScore = candidate.conceptMasteryScore;
  const deltaMastery =
    masteryScore !== null &&
    masteryScore !== undefined &&
    Number.isFinite(masteryScore)
      ? 0.55 * (1 - clamp(masteryScore, 0, 1))
      : 0;

  let isLeechOrDifficult = false;
  if (candidate.kind === 'fsrs_card') {
    isLeechOrDifficult = candidate.lapses >= 3;
  } else if (candidate.kind === 'mistake_question') {
    isLeechOrDifficult = candidate.lapsesCount >= 3 || candidate.isDifficult;
  } else {
    isLeechOrDifficult = smoothedErrorRate >= 0.65;
  }
  const deltaLeech = isLeechOrDifficult ? 0.25 : 0;

  const priorityBoost =
    candidate.kind === 'mindmap_cloze' &&
    candidate.priority !== null &&
    candidate.priority !== undefined &&
    candidate.priority >= 1 &&
    candidate.priority <= 2;

  const deltaExamTag =
    candidate.inActiveSpaceScope === true ||
    candidate.hasExamPriorityTag === true ||
    priorityBoost ||
    hasExamTag(candidate.conceptTags)
      ? 0.20
      : 0;

  return round4(clamp(1.0 + deltaMastery + deltaLeech + deltaExamTag, 0.5, 2.0));
}

interface EvaluatedCandidate {
  input: TriageCandidateInput;
  item: SprintQueueItem;
  isDueCandidate: boolean;
  isUnseenCard: boolean;
  isEmergencyUnseen: boolean;
  utilityScore: number;
  examRetrievabilityBefore: number;
  currentRetrievability: number;
  importance: number;
  estimatedSeconds: number;
}

function compareEvaluatedCandidates(a: EvaluatedCandidate, b: EvaluatedCandidate): number {
  if (b.utilityScore !== a.utilityScore) return b.utilityScore - a.utilityScore;
  if (a.examRetrievabilityBefore !== b.examRetrievabilityBefore) {
    return a.examRetrievabilityBefore - b.examRetrievabilityBefore;
  }
  return a.item.sprintItemId < b.item.sprintItemId
    ? -1
    : a.item.sprintItemId > b.item.sprintItemId
      ? 1
      : 0;
}

function noteIdentityOf(item: SprintQueueItem): string | null {
  if (item.sourceAnchor?.kind === 'note' && item.sourceAnchor.resourceId) {
    return `note:${item.sourceAnchor.resourceId}`;
  }
  if (item.kind === 'fsrs_card') {
    const noteId = item.fields.AnkiNoteId ?? item.fields._note_key;
    if (typeof noteId === 'string' && noteId.trim().length > 0) {
      return `anki_note:${noteId.trim()}`;
    }
  }
  return null;
}

function conflictsAdjacent(prev: SprintQueueItem | undefined, next: SprintQueueItem): boolean {
  if (prev === undefined) return false;
  if (prev.kind === 'mistake_question' && next.kind === 'mistake_question') {
    if (prev.originalQuestionId === next.originalQuestionId) return true;
  }
  if (prev.kind === 'mindmap_cloze' && next.kind === 'mindmap_cloze') {
    if (
      prev.mindmapId === next.mindmapId &&
      prev.ancestorPath.join('\u001f') === next.ancestorPath.join('\u001f')
    ) {
      return true;
    }
  }
  const prevNote = noteIdentityOf(prev);
  const nextNote = noteIdentityOf(next);
  if (prevNote !== null && prevNote === nextNote) {
    return true;
  }
  return false;
}

function takeNextFromPool<T extends SprintQueueItem>(
  pool: T[],
  prev: SprintQueueItem | undefined,
): T | undefined {
  if (pool.length === 0) return undefined;
  for (let i = 0; i < pool.length; i += 1) {
    const candidate = pool[i]!;
    if (!conflictsAdjacent(prev, candidate)) {
      pool.splice(i, 1);
      return candidate;
    }
  }
  return pool.shift();
}

/**
 * Reorders selected Sprint items into 3 : 1 : 1 micro-cycles
 * (up to 3 fsrs_card -> 1 mistake_question -> 1 mindmap_cloze),
 * preserving descending utility within each modality and avoiding adjacent
 * duplicate originalQuestionId, mindmapId+ancestorPath, or shared noteId.
 */
export function interleaveSprintQueue(items: readonly SprintQueueItem[]): SprintQueueItem[] {
  if (items.length <= 1) return [...items];

  const byUtility = [...items].sort((a, b) => {
    if (b.triage.utilityScore !== a.triage.utilityScore) {
      return b.triage.utilityScore - a.triage.utilityScore;
    }
    if (a.triage.examRetrievabilityBefore !== b.triage.examRetrievabilityBefore) {
      return a.triage.examRetrievabilityBefore - b.triage.examRetrievabilityBefore;
    }
    return a.sprintItemId < b.sprintItemId ? -1 : a.sprintItemId > b.sprintItemId ? 1 : 0;
  });

  const fsrsPool: SprintFsrsCardItem[] = [];
  const mistakePool: SprintMistakeItem[] = [];
  const mindmapPool: SprintMindmapClozeItem[] = [];

  for (const item of byUtility) {
    if (item.kind === 'fsrs_card') fsrsPool.push(item);
    else if (item.kind === 'mistake_question') mistakePool.push(item);
    else mindmapPool.push(item);
  }

  const out: SprintQueueItem[] = [];
  while (fsrsPool.length > 0 || mistakePool.length > 0 || mindmapPool.length > 0) {
    for (let k = 0; k < 3 && fsrsPool.length > 0; k += 1) {
      const picked = takeNextFromPool(fsrsPool, out[out.length - 1]);
      if (picked !== undefined) out.push(picked);
    }
    if (mistakePool.length > 0) {
      const picked = takeNextFromPool(mistakePool, out[out.length - 1]);
      if (picked !== undefined) out.push(picked);
    }
    if (mindmapPool.length > 0) {
      const picked = takeNextFromPool(mindmapPool, out[out.length - 1]);
      if (picked !== undefined) out.push(picked);
    }
  }

  // Deterministic post-pass: relocate any remaining adjacent conflict into the
  // earliest conflict-free slot when all pools but one were exhausted at the tail.
  for (let i = 1; i < out.length; i += 1) {
    const current = out[i]!;
    if (!conflictsAdjacent(out[i - 1], current)) continue;
    for (let pos = 0; pos < out.length; pos += 1) {
      if (pos === i || pos === i - 1) continue;
      const left = pos > 0 ? out[pos - 1] : undefined;
      const right = out[pos];
      if (!conflictsAdjacent(left, current) && (right === undefined || !conflictsAdjacent(current, right))) {
        out.splice(i, 1);
        const insertAt = pos > i ? pos - 1 : pos;
        out.splice(insertAt, 0, current);
        break;
      }
    }
  }

  return out;
}

export function runExamHorizonTriage(input: ExamHorizonTriageInput): ExamHorizonTriageResult {
  const safeNowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const rolloverHour = sanitizeRolloverHour(input.config.dayRolloverHour);
  const budgetMinutes = sanitizeSprintBudgetMinutes(input.config.sprintBudgetMinutes);
  const budgetSeconds = budgetMinutes * 60;
  const baseRetention = sanitizeBaseTargetRetention(input.config.baseTargetRetention);
  const parsedExam = parseExamDateYmd(input.config.examDate);
  const normalizedExamDate = parsedExam?.normalized ?? null;

  const daysUntilExam = computeDaysUntilExam(
    safeNowMs,
    normalizedExamDate,
    rolloverHour,
    input.offsetMinutes,
  );
  const phase = resolveExamPhase(daysUntilExam);
  const effectiveTargetRetention = computeEffectiveTargetRetention(daysUntilExam, baseRetention);
  const horizonDays = forecastHorizonDays(daysUntilExam);

  let fsrsDueCount = 0;
  let fsrsNewCount = 0;
  let mistakeDueCount = 0;
  let mindmapWeakCount = 0;

  for (const candidate of input.candidates) {
    if (candidate.kind === 'fsrs_card') {
      if (candidate.state === 0 && !candidate.isBuried) fsrsNewCount += 1;
      else if (candidate.isDue) fsrsDueCount += 1;
    } else if (candidate.kind === 'mistake_question') {
      if (candidate.isDue && candidate.status !== 'suspended') mistakeDueCount += 1;
    } else {
      const errRate = computeMindmapSmoothedErrorRate(candidate.attempts, candidate.misses);
      const isWeak =
        candidate.isWeakCandidate ??
        (errRate >= 0.45 || (candidate.attempts === 0 && candidate.blankedRanges.length > 0));
      if (isWeak) mindmapWeakCount += 1;
    }
  }

  const quotaInfo = computeDailyNewCardQuota({
    daysUntilExam,
    unseenCount: fsrsNewCount,
    deckNewPerDay: input.deckNewPerDay ?? 20,
    newIntroducedToday: input.newIntroducedToday ?? 0,
  });

  const totalOverdueDueCount = fsrsDueCount + mistakeDueCount + mindmapWeakCount;
  const isBankruptcyStorm = totalOverdueDueCount > 80;

  let weightedExamRSum = 0;
  let weightedNowRSum = 0;
  let importanceSum = 0;

  const eligibleDuePool: EvaluatedCandidate[] = [];
  const eligibleStandardNewPool: EvaluatedCandidate[] = [];
  const eligibleEmergencyNewPool: EvaluatedCandidate[] = [];

  for (const candidate of input.candidates) {
    if (candidate.kind === 'mistake_question' && candidate.status === 'suspended') {
      continue;
    }

    let rNow = 0.15;
    let rExam = 0.15;
    let mmErrorRate = 0;

    if (candidate.kind === 'fsrs_card') {
      const projected = projectFsrsRetrievability({
        state: candidate.state,
        stability: candidate.stability,
        daysSinceLastReview: candidate.daysSinceLastReview,
        horizonDays,
        fsrsParams: input.fsrsParams,
      });
      rNow = projected.currentRetrievability;
      rExam = projected.examRetrievability;
    } else if (candidate.kind === 'mistake_question') {
      const projected = projectMistakeRetrievability({
        status: candidate.status,
        consecutiveFailures: candidate.consecutiveFailures,
        intervalDays: candidate.intervalDays,
        easeFactor: candidate.easeFactor,
        daysSinceLastReview: candidate.daysSinceLastReview,
        daysOverdue: candidate.daysOverdue,
        horizonDays,
        fsrsParams: input.fsrsParams,
      });
      rNow = projected.currentRetrievability;
      rExam = projected.examRetrievability;
    } else {
      const projected = projectMindmapNodeRetrievability({
        attempts: candidate.attempts,
        misses: candidate.misses,
        daysSinceLastReview: candidate.daysSinceLastReview,
        horizonDays,
        fsrsParams: input.fsrsParams,
      });
      rNow = projected.currentRetrievability;
      rExam = projected.examRetrievability;
      mmErrorRate = projected.smoothedErrorRate;
    }

    const importance = computeCandidateImportance(candidate, mmErrorRate);
    const estimatedSeconds = estimateCandidateDurationSeconds(candidate);

    weightedExamRSum += importance * rExam;
    weightedNowRSum += importance * rNow;
    importanceSum += importance;
    // Temporarily buried cards still count towards readiness, but cannot enter today's queue.
    if (candidate.kind === 'fsrs_card' && candidate.isBuried) continue;

    const riskGap = Math.max(0, effectiveTargetRetention - rExam);
    let baseMultiplier = 0;
    let isDueCandidate = false;
    let isUnseenCard = false;
    let overdueDays = 0;

    if (candidate.kind === 'fsrs_card') {
      if (candidate.state === 0) {
        isUnseenCard = true;
        baseMultiplier = quotaInfo.newIntakeFrozen && importance < 1.25 ? 0 : 0.85;
      } else if (candidate.isDue) {
        isDueCandidate = true;
        overdueDays = Number.isFinite(candidate.daysOverdue) ? Math.max(0, candidate.daysOverdue) : 0;
        baseMultiplier = candidate.state === 3 ? 1.22 : 1.05;
      }
    } else if (candidate.kind === 'mistake_question') {
      if (candidate.isDue) {
        isDueCandidate = true;
        overdueDays = Number.isFinite(candidate.daysOverdue) ? Math.max(0, candidate.daysOverdue) : 0;
        baseMultiplier =
          candidate.consecutiveFailures >= 2 || candidate.lapsesCount >= 2 ? 1.35 : 1.22;
      }
    } else {
      const isWeak =
        candidate.isWeakCandidate ??
        (mmErrorRate >= 0.45 || (candidate.attempts === 0 && candidate.blankedRanges.length > 0));
      if (isWeak) {
        isDueCandidate = true;
        overdueDays = Number.isFinite(candidate.daysSinceLastReview)
          ? Math.max(0, candidate.daysSinceLastReview)
          : 0;
        baseMultiplier = mmErrorRate >= 0.50 ? 1.18 : 1.05;
      }
    }

    if (!isDueCandidate && !isUnseenCard) {
      continue;
    }
    if (baseMultiplier <= 0) {
      continue;
    }

    if (isBankruptcyStorm && isDueCandidate) {
      baseMultiplier *= 0.85 + 0.30 * Math.exp(-overdueDays / 30);
    }

    const wExam = baseMultiplier * (1 + 0.8 * riskGap);
    const rawUtility =
      (wExam * Math.max(0.04, 1 - rNow) * importance) / Math.max(8, estimatedSeconds);
    const utilityScore = round6(rawUtility);

    const triageMeta: SprintItemTriageMeta = {
      utilityScore,
      currentRetrievability: rNow,
      examRetrievabilityBefore: rExam,
      importance,
      estimatedSeconds,
      conceptTags: [...candidate.conceptTags],
    };

    let queueItem: SprintQueueItem;
    if (candidate.kind === 'fsrs_card') {
      queueItem = {
        kind: 'fsrs_card',
        sprintItemId: `fsrs:${candidate.cardStateId}`,
        cardStateId: candidate.cardStateId,
        ankiCardId: candidate.ankiCardId,
        deckName: candidate.deckName ?? null,
        cardFormat: candidate.cardFormat,
        front: candidate.front,
        back: candidate.back,
        fields: { ...candidate.fields },
        templateId: candidate.templateId ?? null,
        state: candidate.state,
        lapses: candidate.lapses,
        reps: candidate.reps,
        stability:
          candidate.stability !== null &&
          candidate.stability !== undefined &&
          Number.isFinite(candidate.stability)
            ? Math.max(0, candidate.stability)
            : null,
        difficulty:
          candidate.difficulty !== null &&
          candidate.difficulty !== undefined &&
          Number.isFinite(candidate.difficulty)
            ? clamp(candidate.difficulty, 1, 10)
            : null,
        sourceAnchor: candidate.sourceAnchor ?? null,
        triage: triageMeta,
      };
    } else if (candidate.kind === 'mistake_question') {
      queueItem = {
        kind: 'mistake_question',
        sprintItemId: `mistake:${candidate.planId}`,
        planId: candidate.planId,
        examId: candidate.examId,
        examName: candidate.examName ?? null,
        questionId: candidate.questionId,
        originalQuestionId: candidate.originalQuestionId,
        isVariant: candidate.isVariant,
        variantBadgeReason: candidate.variantBadgeReason ?? null,
        questionType: candidate.questionType,
        content: candidate.content,
        options: candidate.options ? candidate.options.map((opt) => ({ ...opt })) : null,
        answer: candidate.answer ?? null,
        explanation: candidate.explanation ?? null,
        structuredData: candidate.structuredData === undefined ? null : candidate.structuredData,
        originalPromptPreview: candidate.originalPromptPreview ?? null,
        originalAnswerPreview: candidate.originalAnswerPreview ?? null,
        lapsesCount: candidate.lapsesCount,
        repetitions: candidate.repetitions,
        intervalDays: candidate.intervalDays,
        sourceAnchor: candidate.sourceAnchor ?? null,
        triage: triageMeta,
      };
    } else {
      queueItem = {
        kind: 'mindmap_cloze',
        sprintItemId: `mindmap:${candidate.mindmapId}:${candidate.nodeId}`,
        mindmapId: candidate.mindmapId,
        mindmapTitle: candidate.mindmapTitle,
        nodeId: candidate.nodeId,
        ancestorPath: [...candidate.ancestorPath],
        siblingHints: [...candidate.siblingHints],
        fullText: candidate.fullText,
        maskedText: candidate.maskedText,
        blankedRanges: candidate.blankedRanges.map((r) => ({ start: r.start, end: r.end })),
        noteExcerpt: candidate.noteExcerpt ?? null,
        smoothedErrorRate: mmErrorRate,
        attempts: Number.isFinite(candidate.attempts) ? Math.max(0, Math.floor(candidate.attempts)) : 0,
        misses: Number.isFinite(candidate.misses) && Number.isFinite(candidate.attempts)
          ? Math.max(0, Math.min(Math.floor(candidate.attempts), Math.floor(candidate.misses))) : 0,
        sourceAnchor: candidate.sourceAnchor,
        triage: triageMeta,
      };
    }

    const evaluated: EvaluatedCandidate = {
      input: candidate,
      item: queueItem,
      isDueCandidate,
      isUnseenCard,
      isEmergencyUnseen: isUnseenCard && importance >= 1.25,
      utilityScore,
      examRetrievabilityBefore: rExam,
      currentRetrievability: rNow,
      importance,
      estimatedSeconds,
    };

    if (isDueCandidate) {
      eligibleDuePool.push(evaluated);
    } else if (quotaInfo.newIntakeFrozen) {
      if (evaluated.isEmergencyUnseen) {
        eligibleEmergencyNewPool.push(evaluated);
      }
    } else if (quotaInfo.remainingNewCardQuota > 0) {
      eligibleStandardNewPool.push(evaluated);
    }
  }

  eligibleDuePool.sort(compareEvaluatedCandidates);
  eligibleStandardNewPool.sort(compareEvaluatedCandidates);
  eligibleEmergencyNewPool.sort(compareEvaluatedCandidates);

  const selectedIds = new Set<string>();
  const selectedEvaluated: EvaluatedCandidate[] = [];
  let usedSeconds = 0;
  let usedNewCards = 0;

  const dueFsrs = eligibleDuePool.filter((c) => c.item.kind === 'fsrs_card');
  const dueMistakes = eligibleDuePool.filter((c) => c.item.kind === 'mistake_question');
  const dueMindmaps = eligibleDuePool.filter((c) => c.item.kind === 'mindmap_cloze');
  const activeDueModalities =
    (dueFsrs.length > 0 ? 1 : 0) +
    (dueMistakes.length > 0 ? 1 : 0) +
    (dueMindmaps.length > 0 ? 1 : 0);

  // Pass 1: Cross-Modal Floor Reservation when due items span >= 2 modalities
  if (activeDueModalities >= 2) {
    const reserveFromModality = (pool: readonly EvaluatedCandidate[], floorRatio: number): void => {
      const modalityCap = Math.floor(budgetSeconds * floorRatio);
      let modalitySeconds = 0;
      for (const cand of pool) {
        if (selectedIds.has(cand.item.sprintItemId)) continue;
        if (
          modalitySeconds + cand.estimatedSeconds <= modalityCap &&
          usedSeconds + cand.estimatedSeconds <= budgetSeconds
        ) {
          selectedIds.add(cand.item.sprintItemId);
          selectedEvaluated.push(cand);
          modalitySeconds += cand.estimatedSeconds;
          usedSeconds += cand.estimatedSeconds;
        } else if (modalityCap - modalitySeconds < 8) {
          break;
        }
      }
    };

    reserveFromModality(dueMistakes, 0.25);
    reserveFromModality(dueMindmaps, 0.15);
    reserveFromModality(dueFsrs, 0.45);
  }

  // Pass 2: Global Marginal-Gain Fill
  if (!quotaInfo.newIntakeFrozen) {
    const combinedPool = [...eligibleDuePool, ...eligibleStandardNewPool].sort(
      compareEvaluatedCandidates,
    );
    for (const cand of combinedPool) {
      if (selectedIds.has(cand.item.sprintItemId)) continue;
      if (cand.isUnseenCard && usedNewCards >= quotaInfo.remainingNewCardQuota) {
        continue;
      }
      if (usedSeconds + cand.estimatedSeconds <= budgetSeconds) {
        selectedIds.add(cand.item.sprintItemId);
        selectedEvaluated.push(cand);
        usedSeconds += cand.estimatedSeconds;
        if (cand.isUnseenCard) usedNewCards += 1;
      } else if (budgetSeconds - usedSeconds < 8) {
        break;
      }
    }
  } else {
    // Frozen pre-exam buffer: pack all fitting due items first
    let dueExhaustedAllFit = true;
    for (const cand of eligibleDuePool) {
      if (selectedIds.has(cand.item.sprintItemId)) continue;
      if (usedSeconds + cand.estimatedSeconds <= budgetSeconds) {
        selectedIds.add(cand.item.sprintItemId);
        selectedEvaluated.push(cand);
        usedSeconds += cand.estimatedSeconds;
      } else {
        dueExhaustedAllFit = false;
        if (budgetSeconds - usedSeconds < 8) break;
      }
    }
    // Only if due reviews did not fill sprintBudgetSeconds, allow up to 3 emergency unseen items
    if (dueExhaustedAllFit && usedSeconds < budgetSeconds && eligibleEmergencyNewPool.length > 0) {
      let emergencyUsed = 0;
      for (const cand of eligibleEmergencyNewPool) {
        if (emergencyUsed >= 3) break;
        if (usedSeconds + cand.estimatedSeconds <= budgetSeconds) {
          selectedIds.add(cand.item.sprintItemId);
          selectedEvaluated.push(cand);
          usedSeconds += cand.estimatedSeconds;
          emergencyUsed += 1;
        }
      }
    }
  }

  // Always select at least 1 item if candidate pool C is non-empty
  if (selectedEvaluated.length === 0) {
    const fallbackFirst =
      eligibleDuePool[0] ??
      (!quotaInfo.newIntakeFrozen ? eligibleStandardNewPool[0] : eligibleEmergencyNewPool[0]);
    if (fallbackFirst !== undefined) {
      selectedIds.add(fallbackFirst.item.sprintItemId);
      selectedEvaluated.push(fallbackFirst);
      usedSeconds += fallbackFirst.estimatedSeconds;
    }
  }

  const interleavedItems = interleaveSprintQueue(selectedEvaluated.map((entry) => entry.item));
  const selectedDueCount = selectedEvaluated.filter((entry) => entry.isDueCandidate).length;
  const totalDueCandidates = eligibleDuePool.length;
  const deferredBacklogCount = Math.max(0, totalDueCandidates - selectedDueCount);

  const totalActiveItems = importanceSum > 0 ? input.candidates.filter(
    (c) => !(c.kind === 'mistake_question' && c.status === 'suspended'),
  ).length : 0;

  const predictedExamRetrievability =
    totalActiveItems > 0 && importanceSum > 0
      ? round4(clamp(weightedExamRSum / importanceSum, 0, 1))
      : null;
  const currentRetrievability =
    totalActiveItems > 0 && importanceSum > 0
      ? round4(clamp(weightedNowRSum / importanceSum, 0, 1))
      : null;

  const estimatedSprintSeconds = usedSeconds;
  const estimatedSprintMinutes =
    interleavedItems.length === 0 ? 0 : Math.max(1, Math.round(estimatedSprintSeconds / 60));

  const snapshot: ExamReadinessSnapshot = {
    spaceId: input.config.spaceId ?? null,
    examDate: normalizedExamDate,
    daysUntilExam,
    phase,
    effectiveTargetRetention,
    dailyNewCardQuota: quotaInfo.dailyNewCardQuota,
    newIntakeFrozen: quotaInfo.newIntakeFrozen,
    predictedExamRetrievability,
    currentRetrievability,
    totalActiveItems,
    selectedSprintCount: interleavedItems.length,
    estimatedSprintMinutes,
    estimatedSprintSeconds,
    deferredBacklogCount,
    breakdown: {
      fsrsDueCount,
      fsrsNewCount,
      mistakeDueCount,
      mindmapWeakCount,
    },
    computedAtMs: safeNowMs,
  };

  return {
    snapshot,
    selectedItems: interleavedItems,
    deferredBacklogCount,
  };
}
