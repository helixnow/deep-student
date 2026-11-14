/** FSRS 复习服务的数据形状与默认调度配置（Rust `fsrs_review_service.rs` 的镜像）。 */
import { rs, toRustJson } from '../../../platform/serde-compat/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { hasLoneSurrogate, parseJsonTokens, structF64, structInteger } from './serde-json.ts';

export const FSRS_PARAMS_VERSION = 'fsrs-rs-6.6';
export const DEFAULT_DECK_ID = 'deck_default';
export const DEFAULT_DESIRED_RETENTION = 0.9;
export const DEFAULT_NEW_PER_DAY = 20;
export const DEFAULT_REVIEWS_PER_DAY = 200;
export const DEFAULT_LEECH_THRESHOLD = 8;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_MINUTE = 60_000;

export interface FsrsCardState {
  id: string;
  ankiCardId: string;
  deckId: string | null;
  state: number;
  stability: number | null;
  difficulty: number | null;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  dueMs: number;
  lastReviewMs: number | null;
  suspended: boolean;
  fsrsParamsVersion: string;
  desiredRetention: number | null;
  createdAt: string;
  updatedAt: string;
  leech: boolean;
  buriedUntilMs: number | null;
  learningStep: number;
}

export interface FsrsEnqueuedCard {
  id: string;
  ankiCardId: string;
  front: string;
  back: string;
  tags: string[];
  text?: string | null;
  templateId?: string | null;
  extraFields: Record<string, string>;
  images: string[];
  isErrorCard: boolean;
  errorContent?: string | null;
}

export interface FsrsDueCard extends FsrsCardState {
  front: string;
  back: string;
  tags: string[];
  text?: string | null;
  templateId?: string | null;
  extraFields: Record<string, string>;
  images: string[];
  isErrorCard: boolean;
  errorContent?: string | null;
}

export interface FsrsEnqueueResult {
  enqueued: number;
  skipped: number;
  enqueuedStateIds: string[];
  states: FsrsCardState[];
  reviewCards: FsrsEnqueuedCard[];
}

export interface FsrsLibraryEnqueueCard {
  cardId: string;
  expectedContentVersion: string;
}

/** 外部导入卡片的初始 FSRS 调度快照（Rust `FsrsImportedSchedule`）。 */
export interface FsrsImportedSchedule {
  state: number; stability: number | null; difficulty: number | null;
  elapsedDays: number; scheduledDays: number; reps: number; lapses: number;
  dueMs: number; lastReviewMs: number | null; suspended: boolean;
}
/** `review.enqueueImportedCardsInTx` 的入参。 */
export interface FsrsImportedCard { cardId: string; seed: FsrsImportedSchedule | null }
/** Rust `FsrsImportEnqueueSummary`。 */
export interface FsrsImportEnqueueSummary {
  enqueued: number; skipped: number; withHistory: number; suspended: number;
}
export interface FsrsLibraryContentVersionConflict {
  cardId: string;
  expectedVersion: string;
  currentVersion: string;
}

export type FsrsLibraryEnqueueOutcome =
  | { status: 'enqueued'; result: FsrsEnqueueResult }
  | { status: 'conflict'; conflicts: FsrsLibraryContentVersionConflict[] }
  | { status: 'not_found'; cardIds: string[] }
  | { status: 'blocked'; reason: string; cardIds: string[] };

export interface FsrsRateResult {
  cardState: FsrsCardState;
  logId: string;
  scheduledDays: number;
  dueMs: number;
  buriedSiblings: string[];
}

export interface FsrsPreviewInterval { rating: number; scheduledDays: number; dueMs: number; intervalMs: number }
export interface FsrsPreviewResult { intervals: FsrsPreviewInterval[] }

export interface FsrsUndoResult { state: FsrsCardState; changed: boolean; undoneLogId: string }
export interface FsrsSuspendResult { state: FsrsCardState; changed: boolean }
export interface FsrsBuryResult { state: FsrsCardState; changed: boolean }
export interface FsrsResetResult { state: FsrsCardState; clearedLogs: number }

export interface FsrsSchedulerConfig {
  newPerDay: number;
  reviewsPerDay: number;
  learnAheadMinutes: number;
  desiredRetention: number;
  leechThreshold: number;
  leechAction: string;
  enableFuzz: boolean;
  learningSteps: number[];
  relearningSteps: number[];
  maximumInterval: number;
  dayRolloverHour: number;
  fsrsParams: number[];
  fsrsOptimizedAtMs: number | null;
  fsrsOptimizedReviewCount: number | null;
  buryNewSiblings: boolean;
  buryReviewSiblings: boolean;
  reviewOrder: string;
  newReviewOrder: string;
  maxAnswerSeconds: number;
}

export type FsrsSchedulerConfigUpdate = {
  [K in keyof Omit<FsrsSchedulerConfig, 'fsrsOptimizedAtMs' | 'fsrsOptimizedReviewCount'>]?:
    Omit<FsrsSchedulerConfig, 'fsrsOptimizedAtMs' | 'fsrsOptimizedReviewCount'>[K] | null;
};

export function defaultSchedulerConfig(): FsrsSchedulerConfig {
  return {
    newPerDay: DEFAULT_NEW_PER_DAY,
    reviewsPerDay: DEFAULT_REVIEWS_PER_DAY,
    learnAheadMinutes: 15,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
    leechThreshold: DEFAULT_LEECH_THRESHOLD,
    leechAction: 'suspend',
    enableFuzz: true,
    learningSteps: [1, 10],
    relearningSteps: [10],
    maximumInterval: 36_500,
    dayRolloverHour: 4,
    fsrsParams: [],
    fsrsOptimizedAtMs: null,
    fsrsOptimizedReviewCount: null,
    buryNewSiblings: true,
    buryReviewSiblings: true,
    reviewOrder: 'due',
    newReviewOrder: 'after',
    maxAnswerSeconds: 60,
  };
}

export interface FsrsModelEvaluation { logLoss: number; rmseBins: number }

export interface FsrsOptimizeResult {
  status: string;
  cardCount: number;
  itemCount: number;
  reviewCount: number;
  current: FsrsModelEvaluation | null;
  optimized: FsrsModelEvaluation | null;
  params: number[];
  recomputedCards: number;
}

export interface FsrsStats {
  total: number;
  due: number;
  dueReview: number;
  dueLearning: number;
  dueNew: number;
  newCount: number;
  learning: number;
  review: number;
  relearning: number;
  suspended: number;
  reviewsToday: number;
  buried: number;
  leech: number;
  newRemainingToday: number;
  reviewsRemainingToday: number;
  backlog: number;
  backlogReview: number;
  backlogNew: number;
  learningWaiting: number;
}

export interface FsrsDailyReviewStat {
  date: string;
  total: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  newIntroduced: number;
  studyMs: number;
}

export interface FsrsTrueRetentionRow {
  period: string;
  youngReviews: number;
  youngPassed: number;
  matureReviews: number;
  maturePassed: number;
}

export interface FsrsMemoryDistributions {
  cards: number;
  difficulty: number[];
  stability: number[];
  retrievability: number[];
}

export interface FsrsRatingDistribution { again: number; hard: number; good: number; easy: number; total: number }
export interface FsrsStateBreakdown {
  newCount: number; learning: number; review: number; relearning: number;
  suspended: number; buried: number; leech: number; total: number;
}
export interface FsrsRetentionStats {
  youngReviews: number; youngPassed: number; matureReviews: number; maturePassed: number;
  overallPassRate: number; youngPassRate: number; maturePassRate: number;
}
export interface FsrsDailyLimitsStatus {
  newPerDay: number; reviewsPerDay: number; newIntroducedToday: number; reviewsDoneToday: number;
  newRemainingToday: number; reviewsRemainingToday: number;
}
export interface FsrsDueForecastDay { date: string; count: number }

export interface FsrsReviewStatistics {
  model?: 'fsrs-7';
  generatedAtMs: number;
  dayStartMs: number;
  days: number;
  dailyReviews: FsrsDailyReviewStat[];
  ratingDistribution: FsrsRatingDistribution;
  stateBreakdown: FsrsStateBreakdown;
  retention: FsrsRetentionStats;
  dailyLimits: FsrsDailyLimitsStatus;
  dueForecast: FsrsDueForecastDay[];
  scheduledForecast: FsrsDueForecastDay[];
  trueRetention: FsrsTrueRetentionRow[];
  memoryDistributions: FsrsMemoryDistributions;
}

export type FsrsForgettingCurve = { decay: number; factor: number } | { model: 'fsrs-7' } | Fsrs7Curve;
export interface Fsrs7Curve { model: 'fsrs-7'; stabilityFast: number; difficulty: number }

export interface FsrsMemoryCard {
  cardStateId: string;
  ankiCardId: string;
  deckId: string | null;
  front: string;
  text?: string | null;
  extraFields: Record<string, string>;
  state: number;
  stability: number | null;
  difficulty: number | null;
  lastReviewMs: number | null;
  dueMs: number;
  reps: number;
  lapses: number;
  lastRating: number | null;
  curve?: FsrsForgettingCurve;
  desiredRetention?: number;
}

export interface FsrsTrueRetention { windowDays: number; reviews: number; passed: number }

export interface FsrsMemoryOverview {
  generatedAtMs: number;
  desiredRetention: number;
  curve: FsrsForgettingCurve;
  recent: FsrsMemoryCard[];
  memorizedCount: number;
  averageRetrievability: number | null;
  trueRetention: FsrsTrueRetention;
}

export interface FsrsMemoryReview {
  logId: string;
  reviewMs: number;
  rating: number;
  stateBefore: number;
  stateAfter: number;
  stabilityAfter: number | null;
  difficultyAfter: number | null;
  dueAfterMs: number | null;
  curve?: FsrsForgettingCurve;
}

export interface FsrsCardMemoryHistory {
  generatedAtMs: number;
  desiredRetention: number;
  curve: FsrsForgettingCurve;
  card: FsrsMemoryCard;
  reviews: FsrsMemoryReview[];
}

export interface FsrsPendingMasteryReview { logId: string; ankiCardId: string; rating: number; revert: boolean }

export interface FsrsFeedbackRow {
  ankiCardId: string;
  front: string;
  templateId: string | null;
  tags: string[];
  state: number;
  stability: number | null;
  lapses: number;
  reps: number;
  dueMs: number;
  lastReviewMs: number | null;
}

export interface FsrsAgentLatestReviewSnapshot {
  logId: string; rating: number; reviewMs: number; undoable: boolean;
}
export interface FsrsAgentReviewStateSnapshot {
  ankiCardId: string;
  cardStateId: string;
  state: number;
  suspended: boolean;
  dueMs: number;
  lastReviewMs: number | null;
  /** Exact i64 CAS token inside Host; only the outer IPC wire converts it to a JSON number. */
  reviewVersion: bigint;
  latestReview: FsrsAgentLatestReviewSnapshot | null;
}
export type FsrsAgentReviewMutationOutcome =
  | { status: 'updated'; state: FsrsAgentReviewStateSnapshot; changed: boolean }
  | { status: 'conflict'; current: FsrsAgentReviewStateSnapshot }
  | { status: 'blocked'; reason: string; current: FsrsAgentReviewStateSnapshot }
  | { status: 'not_found' };

export interface FsrsStateBeforeSnapshot {
  snapshotVersion: 1;
  cardStateId: string;
  ankiCardId: string;
  deckId: string | null;
  state: number;
  stability: number | null;
  difficulty: number | null;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  dueMs: number;
  lastReviewMs: number | null;
  suspended: boolean;
  fsrsParamsVersion: string;
  desiredRetention: number | null;
  leech: boolean;
  buriedUntilMs: number | null;
  learningStep: number;
}

export function stateBeforeSnapshot(state: FsrsCardState): FsrsStateBeforeSnapshot {
  return {
    snapshotVersion: 1,
    cardStateId: state.id,
    ankiCardId: state.ankiCardId,
    deckId: state.deckId,
    state: state.state,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsedDays: state.elapsedDays,
    scheduledDays: state.scheduledDays,
    reps: state.reps,
    lapses: state.lapses,
    dueMs: state.dueMs,
    lastReviewMs: state.lastReviewMs,
    suspended: state.suspended,
    fsrsParamsVersion: state.fsrsParamsVersion,
    desiredRetention: state.desiredRetention,
    leech: state.leech,
    buriedUntilMs: state.buriedUntilMs,
    learningStep: state.learningStep,
  };
}

/** Rust `FsrsStateBeforeSnapshot`（fsrs_review_service.rs:857-884）的序列化形状。 */
const SNAPSHOT_SCHEMA = rs.struct({
  snapshot_version: rs.u8,
  card_state_id: rs.string,
  anki_card_id: rs.string,
  deck_id: rs.option(rs.string),
  state: rs.i32,
  stability: rs.option(rs.f64),
  difficulty: rs.option(rs.f64),
  elapsed_days: rs.f64,
  scheduled_days: rs.f64,
  reps: rs.i32,
  lapses: rs.i32,
  due_ms: rs.i64,
  last_review_ms: rs.option(rs.i64),
  suspended: rs.bool,
  fsrs_params_version: rs.string,
  desired_retention: rs.option(rs.f64),
  leech: rs.bool,
  buried_until_ms: rs.option(rs.i64),
  learning_step: rs.u32,
}, { renameAll: 'camelCase', name: 'FsrsStateBeforeSnapshot' });

/** `serde_json::to_string(&FsrsStateBeforeSnapshot)`（fsrs_review_service.rs:2144）：f64 整数值写 `92.0`。 */
export function encodeStateBeforeSnapshot(snapshot: FsrsStateBeforeSnapshot): string {
  return toRustJson(snapshot, SNAPSHOT_SCHEMA);
}

type SnapshotFieldKind = 'u8' | 'u32' | 'i32' | 'i64' | 'f64' | 'string' | 'bool';
interface SnapshotField {
  key: keyof FsrsStateBeforeSnapshot;
  kind: SnapshotFieldKind;
  optional: boolean;
  /** `#[serde(default)]` value used when the field is absent. */
  fallback?: boolean | number | null;
}

/** Field order and types of Rust `FsrsStateBeforeSnapshot` (fsrs_review_service.rs:857-884). */
const SNAPSHOT_FIELDS: readonly SnapshotField[] = [
  { key: 'snapshotVersion', kind: 'u8', optional: false },
  { key: 'cardStateId', kind: 'string', optional: false },
  { key: 'ankiCardId', kind: 'string', optional: false },
  { key: 'deckId', kind: 'string', optional: true },
  { key: 'state', kind: 'i32', optional: false },
  { key: 'stability', kind: 'f64', optional: true },
  { key: 'difficulty', kind: 'f64', optional: true },
  { key: 'elapsedDays', kind: 'f64', optional: false },
  { key: 'scheduledDays', kind: 'f64', optional: false },
  { key: 'reps', kind: 'i32', optional: false },
  { key: 'lapses', kind: 'i32', optional: false },
  { key: 'dueMs', kind: 'i64', optional: false },
  { key: 'lastReviewMs', kind: 'i64', optional: true },
  { key: 'suspended', kind: 'bool', optional: false },
  { key: 'fsrsParamsVersion', kind: 'string', optional: false },
  { key: 'desiredRetention', kind: 'f64', optional: true },
  { key: 'leech', kind: 'bool', optional: false, fallback: false },
  { key: 'buriedUntilMs', kind: 'i64', optional: true, fallback: null },
  { key: 'learningStep', kind: 'u32', optional: false, fallback: 0 },
];

const INTEGER_RANGES: Record<'u8' | 'u32' | 'i32' | 'i64', readonly [bigint, bigint]> = {
  u8: [0n, 255n],
  u32: [0n, 4294967295n],
  i32: [-2147483648n, 2147483647n],
  i64: [-9223372036854775808n, 9223372036854775807n],
};

const INVALID = Symbol('invalid');

function decodeScalar(kind: SnapshotFieldKind, raw: unknown): unknown {
  switch (kind) {
    case 'string': return typeof raw === 'string' && !hasLoneSurrogate(raw) ? raw : INVALID;
    case 'bool': return typeof raw === 'boolean' ? raw : INVALID;
    case 'f64': return structF64(raw) ?? INVALID;
    default: {
      // serde_json only hands integer types a token without fraction or exponent.
      const value = structInteger(raw);
      if (value === null) return INVALID;
      const [min, max] = INTEGER_RANGES[kind];
      if (value < min || value > max) return INVALID;
      // Millisecond timestamps outside the safe range cannot round-trip through a JS number.
      return Number.isSafeInteger(Number(value)) ? Number(value) : INVALID;
    }
  }
}

function decodeField(field: SnapshotField, present: boolean, raw: unknown): unknown {
  if (!present) {
    if (field.fallback !== undefined) return field.fallback;
    return field.optional ? null : INVALID;
  }
  if (raw === null) return field.optional ? null : INVALID;
  return decodeScalar(field.kind, raw);
}

/**
 * `serde_json::from_str::<FsrsStateBeforeSnapshot>` equivalent: accepts the struct as an
 * object (unknown keys ignored) or a positional array, applies `#[serde(default)]` for
 * pre-V20260722/V20261005 snapshots, and returns null wherever serde would return Err.
 * Values of unknown keys are skipped unchecked, as serde's `ignore_value` does; keys and known
 * string fields are decoded, so unpaired surrogates there fail.
 * Duplicate object keys are not detected (JSON.parse keeps the last one; serde errors).
 */
export function decodeStateBeforeSnapshot(json: string): FsrsStateBeforeSnapshot | null {
  const root = parseJsonTokens(json);
  if (root === undefined || root === null || typeof root !== 'object') return null;
  if (!Array.isArray(root) && Object.keys(root).some(hasLoneSurrogate)) return null;
  const out: Record<string, unknown> = {};
  if (Array.isArray(root)) {
    if (root.length > SNAPSHOT_FIELDS.length) return null;
    for (const [index, field] of SNAPSHOT_FIELDS.entries()) {
      const present = index < root.length;
      // In sequence form only `#[serde(default)]` fields may be missing.
      if (!present && field.fallback === undefined) return null;
      const value = decodeField(field, present, root[index]);
      if (value === INVALID) return null;
      out[field.key] = value;
    }
  } else {
    const object = root as Record<string, unknown>;
    for (const field of SNAPSHOT_FIELDS) {
      const present = Object.hasOwn(object, field.key);
      const value = decodeField(field, present, object[field.key]);
      if (value === INVALID) return null;
      out[field.key] = value;
    }
  }
  return out as unknown as FsrsStateBeforeSnapshot;
}

export function validateSnapshotFor(snapshot: FsrsStateBeforeSnapshot, state: FsrsCardState): boolean {
  const finiteOptional = (value: number | null): boolean => value === null || Number.isFinite(value);
  return snapshot.snapshotVersion === 1
    && snapshot.cardStateId === state.id
    && snapshot.ankiCardId === state.ankiCardId
    && Number.isInteger(snapshot.state) && snapshot.state >= 0 && snapshot.state <= 3
    && finiteOptional(snapshot.stability)
    && finiteOptional(snapshot.difficulty)
    && Number.isFinite(snapshot.elapsedDays) && snapshot.elapsedDays >= 0
    && Number.isFinite(snapshot.scheduledDays) && snapshot.scheduledDays >= 0
    && snapshot.reps >= 0 && snapshot.lapses >= 0
    && rustTrim(snapshot.fsrsParamsVersion).length > 0
    && finiteOptional(snapshot.desiredRetention);
}
