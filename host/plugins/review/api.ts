import type {} from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type * as Wire from '../../../contracts/ipc/generated/L15-review-analytics.ts';
import type {
  FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot, FsrsImportEnqueueSummary,
  FsrsImportedCard, FsrsLibraryEnqueueCard, FsrsLibraryEnqueueOutcome,
} from './src/fsrs-types.ts';
import type { ProcessReviewResult, ReviewPlan, ReviewStats } from './src/review-plan-types.ts';
import type { RemoteCallMeta } from './src/dailySprintService.ts';
import type {
  BuildDailySprintRequest,
  ClientMindmapReciteSignal,
  ConceptMasteryDelta,
  DailySprintPlan,
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamPhase,
  ExamReadinessSnapshot,
  GenerateMistakeVariantRequest,
  GenerateMistakeVariantResult,
  GetExamReadinessRequest,
  SettleSprintSessionRequest,
  SprintCompletedItemRecord,
  SprintFsrsCardItem,
  SprintItemTriageMeta,
  SprintMindmapBlankRange,
  SprintMindmapClozeItem,
  SprintMistakeItem,
  SprintMistakeQuestionOption,
  SprintQueueItem,
  SprintSessionSettlement,
  SprintSourceAnchor,
} from './src/examHorizonScheduler.ts';

export type * from '../../../contracts/ipc/generated/L15-review-analytics.ts';
export type {
  BuildDailySprintRequest,
  ClientMindmapReciteSignal,
  ConceptMasteryDelta,
  DailySprintPlan,
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamPhase,
  ExamReadinessSnapshot,
  GenerateMistakeVariantRequest,
  GenerateMistakeVariantResult,
  GetExamReadinessRequest,
  RemoteCallMeta,
  SettleSprintSessionRequest,
  SprintCompletedItemRecord,
  SprintFsrsCardItem,
  SprintItemTriageMeta,
  SprintMindmapBlankRange,
  SprintMindmapClozeItem,
  SprintMistakeItem,
  SprintMistakeQuestionOption,
  SprintQueueItem,
  SprintSessionSettlement,
  SprintSourceAnchor,
};
export type {
  FsrsAgentReviewMutationOutcome, FsrsAgentReviewStateSnapshot, FsrsImportEnqueueSummary,
  FsrsImportedCard, FsrsImportedSchedule, FsrsLibraryEnqueueCard,
  FsrsLibraryEnqueueOutcome,
} from './src/fsrs-types.ts';
export type {
  ProcessReviewResult, ReviewHistory, ReviewPlan, ReviewPlanStatus, ReviewStats,
} from './src/review-plan-types.ts';
export type { SM2Result } from './src/review-plan.ts';
export {
  ReviewQuality, calculateEaseFactor, calculateNextReview, calculateNextReviewAdvanced,
  calculateNextReviewDate, calculateNextReviewDateFromLast, calculateNextReviewTimestamp,
  daysOverdue, isDueForReview, DEFAULT_EASE_FACTOR, FIRST_INTERVAL, MAX_INTERVAL,
  MIN_EASE_FACTOR, PASSING_GRADE, SECOND_INTERVAL,
} from './src/review-plan.ts';
export { prepareMediaTextForGeneration, containsMediaAnchor, mediaCitationSecondsFor, mediaFileName, MEDIA_QUESTION_REQUIREMENTS, MEDIA_CARD_REQUIREMENTS } from './src/media-source.ts';
export { range as studyTimeRange, addSeconds as addStudyTimeSeconds, totalSeconds as totalStudyTimeSeconds } from './repository/study-time.ts';
export type MasterySource = 'qbank' | 'fsrs' | 'insight';
export type MasteryOutcome = 'correct' | 'wrong' | { rating: number };
export interface MasteryEvent {
  id: string;
  createdAt: string;
  source: MasterySource;
  conceptKey: string;
  itemId: string;
  outcome: string;
  weight: number;
  signal?: number;
}
export interface MasteryWeakPointEvidence {
  score: number;
  total: number;
  wrongCount: number;
  recentWrongSummary: string;
}
export interface MasteryProfileSink {
  upsertWeakPointFromMastery(conn: SqlExecutor, concept: string, evidence: MasteryWeakPointEvidence): void;
  removeWeakPointFromMastery(conn: SqlExecutor, concept: string): void;
}
export interface MasteryService {
  recordQbankAnswer(questionId: string, tags: string[], correct: boolean): Wire.MasteryState;
  recordQbankAnswerWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): Wire.MasteryState;
  recordQbankVerdictCorrectionWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): Wire.MasteryState;
  recordQbankVerdictCorrection(submissionId: string, questionId: string, tags: string[], correct: boolean): Wire.MasteryState;
  recordFsrsRating(cardId: string, tags: string[], rating: number): Wire.MasteryState | null;
  recordFsrsRatingForLog(logId: string, cardId: string, tags: string[], rating: number): Wire.MasteryState | null;
  revertFsrsRatingForLog(logId: string): Wire.MasteryState | null;
  recordEvent(source: MasterySource, concept: string, itemId: string, outcome: MasteryOutcome, operationId?: string): Wire.MasteryState;
  recomputeState(concept: string): Wire.MasteryState;
  /**
   * Rust `record_recall_verdict_to_mastery`（dstu-research/src/insight/recall.rs:426-448）：
   * 在调用方连接上 INSERT OR IGNORE 一条 insight 证据；不 recompute、不回流 profile。
   * `now` 为调用方的 `repo::now_iso()`；失败抛 `Database: 写入 mastery 证据失败: …`。
   */
  recordInsightRecallVerdictWithConn(
    conn: SqlExecutor, insightId: string, sessionId: string, success: boolean, now: string,
  ): void;
  recomputeAllStatesWithConn(conn: SqlExecutor): number;
  syncLearnerProfile(state: Wire.MasteryState): void;
  syncAllLearnerProfiles(): number;
  getState(concept: string): Wire.MasteryState | null;
  weakConcepts(limit: number): Wire.MasteryState[];
  overviewSummary(limit: number): Wire.MasteryOverviewSummary;
  todayPriorityReview(limit: number): Wire.MasteryPriorityReviewItem[];
  listEvents(concept: string, limit: number): MasteryEvent[];
}
/**
 * reviewPlan@1：L14 练习提交/改判后使用的 SM-2 复习计划入口。
 *
 * L14 `gradingHostOf` 经 `ctx.get('reviewPlan')` 解析；返回类型与
 * `ReviewPlanService` 的公开方法一致。
 */
export interface ReviewPlanPort {
  getOrCreatePlan(questionId: string, examId: string): ReviewPlan;
  getPlanByQuestion(questionId: string): ReviewPlan | null;
  advanceFromPractice(planId: string): ProcessReviewResult;
  /** `ReviewPlanService::get_review_stats`（学习概览 `sm2Review` 来源）。 */
  getReviewStats(examId: string | null): ReviewStats;
}

/** review@1: scheduling service shared by Anki, chatanki and learning overview. */
export interface ReviewService {
  enqueueCards(cardIds: string[]): Wire.FsrsEnqueueResult;
  enqueueCardsForSession(
    cardIds: readonly string[], sessionId: string, documentId: string | null,
  ): Wire.FsrsEnqueueResult;
  enqueueCardsForLibrary(
    scope: string, cards: readonly FsrsLibraryEnqueueCard[],
  ): FsrsLibraryEnqueueOutcome;
  getDue(limit?: number | null): Wire.FsrsDueCard[];
  getStats(): Wire.FsrsStats;
  getReviewStatistics(days?: number | null): Wire.FsrsReviewStatistics;
  getCardState(stateId: string): Wire.FsrsCardState | null;
  getCardConceptTags(cardId: string): string[];
  getCardTags(cardId: string): string[];
  getEnqueuedCards(result: Wire.FsrsEnqueueResult): Wire.FsrsEnqueuedCard[];
  getReviewStatesForSession(
    cardIds: readonly string[], sessionId: string,
  ): FsrsAgentReviewStateSnapshot[];
  getReviewStatesForLibrary(
    scope: string, cardIds: readonly string[],
  ): FsrsAgentReviewStateSnapshot[];
  /** CAS inputs accept legacy integer numbers or exact bigint i64s; snapshots retain bigint until IPC. */
  setSuspendedForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ): FsrsAgentReviewMutationOutcome;
  setSuspendedForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, suspended: boolean,
  ): FsrsAgentReviewMutationOutcome;
  undoLastReviewForSession(
    cardId: string, sessionId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome;
  undoLastReviewForLibrary(
    scope: string, cardId: string, expectedReviewVersion: number | bigint, expectedLogId: string,
  ): FsrsAgentReviewMutationOutcome;
  /** L16 事务内 FSRS 清理：调用方负责事务与 `anki_cards` 行删除。 */
  cleanupCardDeletionInTx(conn: SqlExecutor, cardIds: readonly string[]): void;
  cleanupTaskDeletionInTx(conn: SqlExecutor, taskId: string): void;
  cleanupDocumentDeletionInTx(conn: SqlExecutor, documentId: string): void;
  /** Rust `enqueue_imported_cards_in_tx`：在调用方的 APKG 导入事务内建档。 */
  enqueueImportedCardsInTx(
    conn: SqlExecutor, cards: readonly FsrsImportedCard[],
  ): FsrsImportEnqueueSummary;
  getSchedulerConfig(): Wire.FsrsSchedulerConfig;
  updateSchedulerConfig(update: Wire.FsrsSchedulerConfigUpdate): Wire.FsrsSchedulerConfig;
  suspendCard(stateId: string): Wire.FsrsSuspendResult;
  unsuspendCard(stateId: string): Wire.FsrsSuspendResult;
  undoLastReview(logId: string, stateId: string): Wire.FsrsUndoResult;
  getExamHorizonConfig(spaceId?: string | null, call?: RemoteCallMeta): ExamHorizonConfig;
  updateExamHorizonConfig(patch: ExamHorizonConfigPatch, call?: RemoteCallMeta): ExamHorizonConfig;
  getExamReadiness(
    spaceIdOrRequest?: string | null | GetExamReadinessRequest,
    call?: RemoteCallMeta,
  ): ExamReadinessSnapshot;
  buildDailySprintPlan(
    request: BuildDailySprintRequest,
    call?: RemoteCallMeta,
  ): Promise<DailySprintPlan>;
  generateMistakeVariant(
    request: GenerateMistakeVariantRequest,
    call?: RemoteCallMeta,
  ): Promise<GenerateMistakeVariantResult>;
  settleSprintSession(
    request: SettleSprintSessionRequest,
    call?: RemoteCallMeta,
  ): SprintSessionSettlement;
}

export const masteryService = { name: 'mastery', version: '1.0.0' } as const;
export const reviewService = { name: 'review', version: '1.0.0' } as const;
export const reviewPlanService = { name: 'reviewPlan', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    mastery: MasteryService;
    review: ReviewService;
    reviewPlan: ReviewPlanPort;
    /** 扩展点由 memory lane 提供（Rust `dstu-memory::memory::mastery_hook`）；缺失时按 Rust no-op。 */
    masteryProfileSink: MasteryProfileSink;
  }
}
