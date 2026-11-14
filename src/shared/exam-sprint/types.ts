export type ExamPhase =
  | 'foundation'   // D > 30 days before exam
  | 'reinforce'    // 8 <= D <= 30 days before exam
  | 'sprint'       // 0 <= D <= 7 days before exam (includes D-Day D = 0)
  | 'maintenance'  // D < 0 days (post-exam maintenance)
  | 'unscheduled'; // examDate === null

export interface ExamHorizonConfig {
  /** Study Space ID (=== SessionGroup.id), or null for Inbox / global default scope */
  spaceId: string | null;
  /** Target VFS root folder ID (fld_*) when scoped to a Study Space, or null */
  rootFolderId: string | null;
  /** Target exam calendar date in local 'YYYY-MM-DD', or null if unscheduled */
  examDate: string | null;
  /** Daily sprint time budget in minutes (clamped to [5, 120], default 15) */
  sprintBudgetMinutes: number;
  /** Baseline target retention in [0.80, 0.97] (default 0.88; dynamically ramped up to 0.94 in sprint phase) */
  baseTargetRetention: number;
  /** Optional bound deck filter (Anki deck path / ID), or null for all decks in scope */
  defaultDeckId: string | null;
  /** Logical day rollover hour in [0, 23] (default 4, matching FsrsSchedulerConfig.dayRolloverHour) */
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
  /** Signed calendar days until exam (D > 0 pre-exam, D = 0 D-Day, D < 0 post-exam, null when unscheduled) */
  daysUntilExam: number | null;
  phase: ExamPhase;
  /** Effective desired retention R_target(D) in [0.85, 0.95] */
  effectiveTargetRetention: number;
  /** Burn-down daily new-card quota computed for today */
  dailyNewCardQuota: number;
  /** True when inside pre-exam buffer (0 <= D <= deltaBuffer) where standard unseen intake is frozen */
  newIntakeFrozen: boolean;
  /**
   * Weighted expected retrievability E[R(T_exam)] in [0, 1] across active scope items
   * (when unscheduled, forecasted at +7 days horizon; null ONLY when totalActiveItems === 0).
   */
  predictedExamRetrievability: number | null;
  /** Current immediate retrievability E[R(T_now)] in [0, 1], or null when totalActiveItems === 0 */
  currentRetrievability: number | null;
  /** Counts feeding today's Sprint */
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
  /** ds-anchor://v1/... URI when available (C2 W01 compatible) */
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
  sprintItemId: string; // 'fsrs:' + cardStateId
  cardStateId: string;
  ankiCardId: string;
  deckName: string | null;
  cardFormat: 'qa' | 'cloze' | 'image_occlusion';
  front: string;
  back: string;
  fields: Record<string, string>;
  templateId: string | null;
  state: number; // 0 new, 1 learning, 2 review, 3 relearning
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
  sprintItemId: string; // 'mistake:' + planId
  planId: string;
  examId: string;
  examName: string | null;
  /** Active question presented to learner (either original or AI isomorphic variant) */
  questionId: string;
  /** Canonical root mistake question ID (equals questionId when isVariant === false) */
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
  sprintItemId: string; // 'mindmap:' + mindmapId + ':' + nodeId
  mindmapId: string;
  mindmapTitle: string;
  nodeId: string;
  /** Ancestor titles from root down to immediate parent */
  ancestorPath: string[];
  /** Up to 4 immediate sibling node labels for structural memory cues (masked if identical to target) */
  siblingHints: string[];
  /** Full unmasked node text */
  fullText: string;
  /** Masked text with '［ ？ ］' replacing blankedRanges (or auto-masked key phrase) */
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
  /** Optional localStorage recite stats forwarded from frontend so Host triage scores exact user misses */
  clientMindmapSignals?: ClientMindmapReciteSignal[] | null;
  /** Whether Host may opportunistically attach cached AI variants (and generate up to maxLiveVariants) */
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
  /** Rating 1 (Again) | 2 (Hard) | 3 (Good) | 4 (Easy) */
  rating: 1 | 2 | 3 | 4;
  passed: boolean;
  elapsedMs: number;
  conceptTags: string[];
  /** Kind-specific identifiers for settlement verification & mastery writeback */
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
  /** Verified percentage-point delta: (after - before) * 100, e.g. +2.7 */
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
