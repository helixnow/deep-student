// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L15-review-analytics.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_qbank::review_plan_service::BatchCreateResult */
export type BatchCreateResult = {
  created: number;
  skipped: number;
  failed: number;
  plans: ReviewPlan[];
};
/** dstu_vfs::vfs::repos::review_plan_repo::CalendarHeatmapData */
export type CalendarHeatmapData = {
  date: string;
  count: number;
  passed: number;
  failed: number;
};
/** dstu_tutor::essay_grading::custom_modes::CreateModeInput */
export type CreateModeInput = {
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension__De[];
  total_max_score: number;
};
/** dstu_vfs::vfs::repos::review_plan_repo::DueReviewsFilter */
export type DueReviewsFilter = {
  exam_id?: string | null;
  until_date?: string | null;
  status?: ReviewPlanStatus__De[] | null;
  difficult_only?: boolean | null;
  limit?: number | null;
  offset?: number | null;
};
/** dstu_vfs::vfs::repos::review_plan_repo::DueReviewsResult */
export type DueReviewsResult = {
  plans: ReviewPlan[];
  total: number;
  has_more: boolean;
};
/** dstu_research::insight::types::EvidenceKind */
export type EvidenceKind = "chat_message" | "resource" | "note" | "manual";
/** dstu_research::insight::types::EvidenceKind */
export type EvidenceKind__De = ("chat_message" | "resource" | "note" | "manual") | {
  chat_message: null;
} | {
  resource: null;
} | {
  note: null;
} | {
  manual: null;
};
/** dstu_anki::fsrs_review_service::FsrsBuryResult */
export type FsrsBuryResult = {
  state: FsrsCardState;
  changed: boolean;
};
/** dstu_anki::fsrs_review_service::FsrsCardMemoryHistory */
export type FsrsCardMemoryHistory = {
  generatedAtMs: number;
  desiredRetention: number;
  curve: FsrsForgettingCurve;
  card: FsrsMemoryCard;
  reviews: FsrsMemoryReview[];
};
/** dstu_anki::fsrs_review_service::FsrsCardState */
export type FsrsCardState = {
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
};
/** dstu_anki::fsrs_review_service::FsrsDailyLimitsStatus */
export type FsrsDailyLimitsStatus = {
  newPerDay: number;
  reviewsPerDay: number;
  newIntroducedToday: number;
  reviewsDoneToday: number;
  newRemainingToday: number;
  reviewsRemainingToday: number;
};
/** dstu_anki::fsrs_review_service::FsrsDailyReviewStat */
export type FsrsDailyReviewStat = {
  date: string;
  total: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  newIntroduced: number;
  studyMs: number;
};
/** dstu_anki::fsrs_review_service::FsrsDueCard */
export type FsrsDueCard = {
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
  front: string;
  back: string;
  tags: string[];
  text?: string | null;
  templateId?: string | null;
  extraFields: { [key: string]: string };
  images: string[];
  isErrorCard: boolean;
  errorContent?: string | null;
};
/** dstu_anki::fsrs_review_service::FsrsDueForecastDay */
export type FsrsDueForecastDay = {
  date: string;
  count: number;
};
/** dstu_anki::fsrs_review_service::FsrsEnqueueResult */
export type FsrsEnqueueResult = {
  enqueued: number;
  skipped: number;
  enqueuedStateIds: string[];
  states: FsrsCardState[];
  reviewCards: FsrsEnqueuedCard[];
};
/** dstu_anki::fsrs_review_service::FsrsEnqueuedCard */
export type FsrsEnqueuedCard = {
  id: string;
  ankiCardId: string;
  front: string;
  back: string;
  tags: string[];
  text?: string | null;
  templateId?: string | null;
  extraFields: { [key: string]: string };
  images: string[];
  isErrorCard: boolean;
  errorContent?: string | null;
};
/** FsrsForgettingCurve */
export type FsrsForgettingCurve = FsrsLegacyForgettingCurve | {
  model: "fsrs-7";
  stabilityFast?: number;
  difficulty?: number;
};
/** dstu_anki::fsrs_review_service::FsrsForgettingCurve */
export type FsrsLegacyForgettingCurve = {
  decay: number;
  factor: number;
};
/** dstu_anki::fsrs_review_service::FsrsMemoryCard */
export type FsrsMemoryCard = {
  curve?: FsrsForgettingCurve;
  desiredRetention?: number;
  cardStateId: string;
  ankiCardId: string;
  deckId: string | null;
  front: string;
  text?: string | null;
  extraFields: { [key: string]: string };
  state: number;
  stability: number | null;
  difficulty: number | null;
  lastReviewMs: number | null;
  dueMs: number;
  reps: number;
  lapses: number;
  lastRating: number | null;
};
/** dstu_anki::fsrs_review_service::FsrsMemoryDistributions */
export type FsrsMemoryDistributions = {
  cards: number;
  difficulty: number[];
  stability: number[];
  retrievability: number[];
};
/** dstu_anki::fsrs_review_service::FsrsMemoryOverview */
export type FsrsMemoryOverview = {
  generatedAtMs: number;
  desiredRetention: number;
  curve: FsrsForgettingCurve;
  recent: FsrsMemoryCard[];
  memorizedCount: number;
  averageRetrievability: number | null;
  trueRetention: FsrsTrueRetention;
};
/** dstu_anki::fsrs_review_service::FsrsMemoryReview */
export type FsrsMemoryReview = {
  curve?: FsrsForgettingCurve;
  logId: string;
  reviewMs: number;
  rating: number;
  stateBefore: number;
  stateAfter: number;
  stabilityAfter: number | null;
  difficultyAfter: number | null;
  dueAfterMs: number | null;
};
/** dstu_anki::fsrs_review_service::FsrsModelEvaluation */
export type FsrsModelEvaluation = {
  logLoss: number;
  rmseBins: number;
};
/** dstu_anki::fsrs_review_service::FsrsOptimizeResult */
export type FsrsOptimizeResult = {
  status: string;
  cardCount: number;
  itemCount: number;
  reviewCount: number;
  current: FsrsModelEvaluation | null;
  optimized: FsrsModelEvaluation | null;
  params: number[];
  recomputedCards: number;
};
/** dstu_anki::fsrs_review_service::FsrsPreviewInterval */
export type FsrsPreviewInterval = {
  rating: number;
  scheduledDays: number;
  dueMs: number;
  intervalMs: number;
};
/** dstu_anki::fsrs_review_service::FsrsPreviewResult */
export type FsrsPreviewResult = {
  intervals: FsrsPreviewInterval[];
};
/** dstu_anki::fsrs_review_service::FsrsRateResult */
export type FsrsRateResult = {
  cardState: FsrsCardState;
  logId: string;
  scheduledDays: number;
  dueMs: number;
  buriedSiblings: string[];
};
/** dstu_anki::fsrs_review_service::FsrsRatingDistribution */
export type FsrsRatingDistribution = {
  again: number;
  hard: number;
  good: number;
  easy: number;
  total: number;
};
/** dstu_anki::fsrs_review_service::FsrsResetResult */
export type FsrsResetResult = {
  state: FsrsCardState;
  clearedLogs: number;
};
/** dstu_anki::fsrs_review_service::FsrsRetentionStats */
export type FsrsRetentionStats = {
  youngReviews: number;
  youngPassed: number;
  matureReviews: number;
  maturePassed: number;
  overallPassRate: number;
  youngPassRate: number;
  maturePassRate: number;
};
/** dstu_anki::fsrs_review_service::FsrsReviewStatistics */
export type FsrsReviewStatistics = {
  model?: "fsrs-7";
  scheduledForecast?: FsrsDueForecastDay[];
  generatedAtMs: number;
  dayStartMs: number;
  days: number;
  dailyReviews: FsrsDailyReviewStat[];
  ratingDistribution: FsrsRatingDistribution;
  stateBreakdown: FsrsStateBreakdown;
  retention: FsrsRetentionStats;
  dailyLimits: FsrsDailyLimitsStatus;
  dueForecast: FsrsDueForecastDay[];
  trueRetention: FsrsTrueRetentionRow[];
  memoryDistributions: FsrsMemoryDistributions;
};
/** dstu_anki::fsrs_review_service::FsrsSchedulerConfig */
export type FsrsSchedulerConfig = {
  model?: "fsrs-7";
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
};
/** dstu_anki::fsrs_review_service::FsrsSchedulerConfigUpdate */
export type FsrsSchedulerConfigUpdate = {
  learnAheadMinutes?: number | null;
  newPerDay?: number | null;
  reviewsPerDay?: number | null;
  desiredRetention?: number | null;
  leechThreshold?: number | null;
  leechAction?: string | null;
  enableFuzz?: boolean | null;
  learningSteps?: number[] | null;
  relearningSteps?: number[] | null;
  maximumInterval?: number | null;
  dayRolloverHour?: number | null;
  fsrsParams?: number[] | null;
  buryNewSiblings?: boolean | null;
  buryReviewSiblings?: boolean | null;
  reviewOrder?: string | null;
  newReviewOrder?: string | null;
  maxAnswerSeconds?: number | null;
};
/** dstu_anki::fsrs_review_service::FsrsStateBreakdown */
export type FsrsStateBreakdown = {
  newCount: number;
  learning: number;
  review: number;
  relearning: number;
  suspended: number;
  buried: number;
  leech: number;
  total: number;
};
/** dstu_anki::fsrs_review_service::FsrsStats */
export type FsrsStats = {
  dueReview?: number;
  dueLearning?: number;
  dueNew?: number;
  total: number;
  due: number;
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
};
/** dstu_anki::fsrs_review_service::FsrsSuspendResult */
export type FsrsSuspendResult = {
  state: FsrsCardState;
  changed: boolean;
};
/** dstu_anki::fsrs_review_service::FsrsTrueRetention */
export type FsrsTrueRetention = {
  windowDays: number;
  reviews: number;
  passed: number;
};
/** dstu_anki::fsrs_review_service::FsrsTrueRetentionRow */
export type FsrsTrueRetentionRow = {
  period: string;
  youngReviews: number;
  youngPassed: number;
  matureReviews: number;
  maturePassed: number;
};
/** dstu_anki::fsrs_review_service::FsrsUndoResult */
export type FsrsUndoResult = {
  state: FsrsCardState;
  changed: boolean;
  undoneLogId: string;
};
/** dstu_tutor::essay_grading::types::GradingMode */
export type GradingMode = {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension[];
  total_max_score: number;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
};
/** dstu_tutor::essay_grading::types::GradingRequest */
export type GradingRequest = {
  session_id: string;
  stream_session_id: string;
  round_number: number;
  input_text: string;
  topic?: string | null;
  mode_id?: string | null;
  model_config_id?: string | null;
  essay_type: string;
  grade_level: string;
  custom_prompt?: string | null;
  previous_result?: string | null;
  previous_input?: string | null;
  image_base64_list?: string[] | null;
  topic_image_base64_list?: string[] | null;
  response_language?: string | null;
};
/** dstu_tutor::essay_grading::types::GradingResponse */
export type GradingResponse = {
  round_id: string;
  session_id: string;
  round_number: number;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: string;
};
/** dstu_tutor::essay_grading::types::GradingRoundResponse */
export type GradingRoundResponse = {
  id: string;
  session_id: string;
  round_number: number;
  input_text: string;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: string;
};
/** dstu_research::insight::types::InsightCard */
export type InsightCard = {
  id: string;
  title: string;
  ownership: InsightOwnership;
  verification_state: VerificationState;
  status: InsightStatus;
  recall_count: number;
  shown_count: number;
  useful_count: number;
  last_recalled_at: string | null;
  created_at: string;
  updated_at: string | null;
  current_revision: InsightRevision | null;
};
/** dstu_research::insight::types::InsightCorrectInput */
export type InsightCorrectInput = {
  title?: string | null;
  situation?: string | null;
  stuck_point?: string | null;
  turning_point?: string | null;
  rule?: string | null;
  validity_conditions?: string | null;
  edit_note?: string | null;
};
/** dstu_research::insight::types::InsightDraftInput */
export type InsightDraftInput = {
  title: string;
  situation: string;
  stuck_point: string;
  turning_point: string;
  rule: string;
  validity_conditions: string;
  ownership: InsightOwnership__De;
  evidence: InsightEvidenceInput[];
};
/** dstu_research::insight::types::InsightEvent */
export type InsightEvent = {
  id: string;
  insight_id: string | null;
  session_id: string | null;
  message_id: string | null;
  event_type: InsightEventType;
  help_level: string;
  quality_signal: number | null;
  need_signal: number | null;
  benefit_signal: number | null;
  payload_json: string | null;
  created_at: string;
};
/** dstu_research::insight::types::InsightEventType */
export type InsightEventType = "recall_candidate" | "shown_existence" | "recall_attempt" | "shown_hint" | "shown_full" | "skipped" | "direct_answer" | "silence_no_match" | "silence_low_confidence" | "silence_budget" | "silence_user_disabled" | "feedback_useful" | "feedback_not_useful" | "feedback_not_applicable" | "confirmed" | "corrected";
/** dstu_research::insight::types::InsightEvidence */
export type InsightEvidence = {
  id: string;
  insight_id: string;
  revision_id: string | null;
  kind: EvidenceKind;
  session_id: string | null;
  message_id: string | null;
  variant_id: string | null;
  block_id: string | null;
  text_start: number | null;
  text_end: number | null;
  speaker: string | null;
  resource_id: string | null;
  quote_snapshot: string;
  created_at: string;
};
/** dstu_research::insight::types::InsightEvidenceInput */
export type InsightEvidenceInput = {
  kind: EvidenceKind__De;
  session_id?: string | null;
  message_id?: string | null;
  variant_id?: string | null;
  block_id?: string | null;
  text_start?: number | null;
  text_end?: number | null;
  speaker?: string | null;
  resource_id?: string | null;
  quote_snapshot: string;
};
/** dstu_research::insight::types::InsightOwnership */
export type InsightOwnership = "self_reported" | "guided" | "ai_draft";
/** dstu_research::insight::types::InsightOwnership */
export type InsightOwnership__De = ("self_reported" | "guided" | "ai_draft") | {
  self_reported: null;
} | {
  guided: null;
} | {
  ai_draft: null;
};
/** dstu_research::insight::types::InsightRelation */
export type InsightRelation = {
  id: string;
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  scope: string | null;
  evidence: string | null;
  status: string;
  created_by: string;
  created_at: string;
};
/** dstu_research::insight::types::InsightRevision */
export type InsightRevision = {
  id: string;
  insight_id: string;
  resource_id: string | null;
  situation: string;
  stuck_point: string;
  turning_point: string;
  rule: string;
  validity_conditions: string;
  hypothetical_queries: string[];
  edit_note: string | null;
  created_at: string;
};
/** dstu_research::insight::types::InsightStatus */
export type InsightStatus = "active" | "cold" | "archived";
/** dstu_learning::mastery::types::MasteryOverviewSummary */
export type MasteryOverviewSummary = {
  conceptCount: number;
  weakCount: number;
  avgScore: number;
  weakest: MasteryState[];
  todayPriorityReview: MasteryPriorityReviewItem[];
};
/** dstu_learning::mastery::types::MasteryPriorityReviewItem */
export type MasteryPriorityReviewItem = {
  conceptKey: string;
  score: number;
  total: number;
  wrongCount: number;
  priority: number;
  reason: string;
  dueCardCount?: number | null;
};
/** dstu_learning::mastery::types::MasteryState */
export type MasteryState = {
  conceptKey: string;
  score: number;
  streak: number;
  total: number;
  wrongCount: number;
  lastSignalAt: string | null;
};
/** dstu_tutor::essay_grading::ModelInfo */
export type ModelInfo = {
  id: string;
  name: string;
  model: string;
  is_default: boolean;
};
/** dstu_qbank::review_plan_service::ProcessReviewResult */
export type ProcessReviewResult = {
  plan: ReviewPlan;
  passed: boolean;
  new_interval: number;
  next_review_date: string;
  history: ReviewHistory;
};
/** dstu_research::insight::types::RelationType */
export type RelationType = "same_method" | "same_trap" | "counterexample" | "abstract_of" | "supersede" | "contradict" | "example_of";
/** dstu_vfs::vfs::repos::review_plan_repo::ReviewHistory */
export type ReviewHistory = {
  id: string;
  plan_id: string;
  question_id: string;
  quality: number;
  passed: boolean;
  ease_factor_before: number;
  ease_factor_after: number;
  interval_before: number;
  interval_after: number;
  repetitions_before: number;
  repetitions_after: number;
  reviewed_at: string;
  user_answer: string | null;
  time_spent_seconds: number | null;
};
/** dstu_vfs::vfs::repos::review_plan_repo::ReviewPlan */
export type ReviewPlan = {
  id: string;
  question_id: string;
  exam_id: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_date: string;
  last_review_date: string | null;
  status: ReviewPlanStatus;
  total_reviews: number;
  total_correct: number;
  consecutive_failures: number;
  is_difficult: boolean;
  created_at: string;
  updated_at: string;
};
/** dstu_vfs::vfs::repos::review_plan_repo::ReviewPlanStatus */
export type ReviewPlanStatus = "new" | "learning" | "reviewing" | "graduated" | "suspended";
/** dstu_vfs::vfs::repos::review_plan_repo::ReviewPlanStatus */
export type ReviewPlanStatus__De = ("new" | "learning" | "reviewing" | "graduated" | "suspended") | {
  new: null;
} | {
  learning: null;
} | {
  reviewing: null;
} | {
  graduated: null;
} | {
  suspended: null;
};
/** dstu_vfs::vfs::repos::review_plan_repo::ReviewStats */
export type ReviewStats = {
  exam_id: string | null;
  total_plans: number;
  new_count: number;
  learning_count: number;
  reviewing_count: number;
  graduated_count: number;
  suspended_count: number;
  due_today: number;
  overdue_count: number;
  difficult_count: number;
  total_reviews: number;
  total_correct: number;
  avg_correct_rate: number;
  avg_ease_factor: number;
  updated_at: string;
};
/** dstu_tutor::essay_grading::custom_modes::SaveBuiltinOverrideInput */
export type SaveBuiltinOverrideInput = {
  builtin_id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimension__De[];
  total_max_score: number;
};
/** dstu_tutor::essay_grading::types::ScoreDimension */
export type ScoreDimension = {
  name: string;
  max_score: number;
  description: string | null;
};
/** dstu_tutor::essay_grading::types::ScoreDimension */
export type ScoreDimension__De = {
  name: string;
  max_score: number;
  description?: string | null;
};
/** dstu_learning::study_loop::study_time::StudyTimeDay */
export type StudyTimeDay = {
  date: string;
  seconds: number;
};
/** dstu_tutor::essay_grading::custom_modes::UpdateModeInput */
export type UpdateModeInput = {
  id: string;
  name?: string | null;
  description?: string | null;
  system_prompt?: string | null;
  score_dimensions?: ScoreDimension__De[] | null;
  total_max_score?: number | null;
};
/** dstu_research::insight::types::VerificationState */
export type VerificationState = "unverified" | "verified" | "contradicted";
/** dstu_vfs::vfs::types::VfsEssaySession */
export type VfsEssaySession = {
  id: string;
  title: string;
  essay_type: string;
  grade_level: string;
  custom_prompt: string | null;
  total_rounds: number;
  latest_score?: number | null;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};
/** dstu_vfs::vfs::types::VfsUpdateEssaySessionParams */
export type VfsUpdateEssaySessionParams = {
  id: string;
  title?: string | null;
  is_favorite?: boolean | null;
  essay_type?: string | null;
  grade_level?: string | null;
  custom_prompt?: string | null;
};

export interface Commands {
  /** src/essay_grading/mod.rs:157 `essay_grading_create_custom_mode` */
  essay_grading_create_custom_mode: {
    args: {
      input: CreateModeInput;
    };
    result: GradingMode;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:37 `essay_grading_create_session` */
  essay_grading_create_session: {
    args: {
      title: string;
      essayType: string;
      gradeLevel: string;
      customPrompt?: string | null;
    };
    result: VfsEssaySession;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:175 `essay_grading_delete_custom_mode` */
  essay_grading_delete_custom_mode: {
    args: {
      modeId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:79 `essay_grading_delete_session` */
  essay_grading_delete_session: {
    args: {
      sessionId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:127 `essay_grading_get_latest_round_number` */
  essay_grading_get_latest_round_number: {
    args: {
      sessionId: string;
    };
    result: number;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:144 `essay_grading_get_mode` */
  essay_grading_get_mode: {
    args: {
      modeId: string;
    };
    result: GradingMode | null;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:219 `essay_grading_get_models` */
  essay_grading_get_models: {
    args: Record<string, never>;
    result: ModelInfo[];
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:136 `essay_grading_get_modes` */
  essay_grading_get_modes: {
    args: Record<string, never>;
    result: GradingMode[];
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:117 `essay_grading_get_round` */
  essay_grading_get_round: {
    args: {
      sessionId: string;
      roundNumber: number;
    };
    result: GradingRoundResponse | null;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:108 `essay_grading_get_rounds` */
  essay_grading_get_rounds: {
    args: {
      sessionId: string;
    };
    result: GradingRoundResponse[];
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:56 `essay_grading_get_session` */
  essay_grading_get_session: {
    args: {
      sessionId: string;
    };
    result: VfsEssaySession | null;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:210 `essay_grading_has_builtin_override` */
  essay_grading_has_builtin_override: {
    args: {
      builtinId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:184 `essay_grading_list_custom_modes` */
  essay_grading_list_custom_modes: {
    args: Record<string, never>;
    result: GradingMode[];
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:88 `essay_grading_list_sessions` */
  essay_grading_list_sessions: {
    args: {
      offset?: number | null;
      limit?: number | null;
      query?: string | null;
    };
    result: VfsEssaySession[];
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:201 `essay_grading_reset_builtin_mode` */
  essay_grading_reset_builtin_mode: {
    args: {
      builtinId: string;
    };
    result: GradingMode;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:192 `essay_grading_save_builtin_override` */
  essay_grading_save_builtin_override: {
    args: {
      input: SaveBuiltinOverrideInput;
    };
    result: GradingMode;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:27 `essay_grading_stream` */
  essay_grading_stream: {
    args: {
      request: GradingRequest;
    };
    result: GradingResponse | null;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:99 `essay_grading_toggle_favorite` */
  essay_grading_toggle_favorite: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:166 `essay_grading_update_custom_mode` */
  essay_grading_update_custom_mode: {
    args: {
      input: UpdateModeInput;
    };
    result: GradingMode;
    error: Shared.AppError;
  };
  /** src/essay_grading/mod.rs:68 `essay_grading_update_session` */
  essay_grading_update_session: {
    args: {
      session: VfsUpdateEssaySessionParams;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:470 `fsrs_bury_card` */
  fsrs_bury_card: {
    args: {
      cardStateId: string;
    };
    result: FsrsBuryResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:107 `fsrs_enqueue_cards` */
  fsrs_enqueue_cards: {
    args: {
      ankiCardIds: string[];
    };
    result: FsrsEnqueueResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:544 `fsrs_get_card_memory_history` */
  fsrs_get_card_memory_history: {
    args: {
      cardStateId: string;
    };
    result: FsrsCardMemoryHistory;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:129 `fsrs_get_due` */
  fsrs_get_due: {
    args: {
      limit?: number | null;
      readOnly?: boolean | null;
    };
    result: FsrsDueCard[];
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:533 `fsrs_get_memory_overview` */
  fsrs_get_memory_overview: {
    args: {
      recentLimit?: number | null;
    };
    result: FsrsMemoryOverview;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:523 `fsrs_get_review_statistics` */
  fsrs_get_review_statistics: {
    args: {
      days?: number | null;
    };
    result: FsrsReviewStatistics;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:555 `fsrs_get_scheduler_config` */
  fsrs_get_scheduler_config: {
    args: Record<string, never>;
    result: FsrsSchedulerConfig;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:515 `fsrs_get_stats` */
  fsrs_get_stats: {
    args: Record<string, never>;
    result: FsrsStats;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:572 `fsrs_optimize_parameters` */
  fsrs_optimize_parameters: {
    args: Record<string, never>;
    result: FsrsOptimizeResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:237 `fsrs_preview_intervals` */
  fsrs_preview_intervals: {
    args: {
      cardStateId: string;
    };
    result: FsrsPreviewResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:250 `fsrs_rate` */
  fsrs_rate: {
    args: {
      cardStateId: string;
      rating: number;
      durationMs?: number | null;
      clientOpId?: string | null;
      enforceExpectedLastReview?: boolean | null;
      expectedLastReviewMs?: number | null;
    };
    result: FsrsRateResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:595 `fsrs_reset_card_progress` */
  fsrs_reset_card_progress: {
    args: {
      cardStateId: string;
    };
    result: FsrsResetResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:455 `fsrs_suspend_card` */
  fsrs_suspend_card: {
    args: {
      cardStateId: string;
    };
    result: FsrsSuspendResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:485 `fsrs_unbury_card` */
  fsrs_unbury_card: {
    args: {
      cardStateId: string;
    };
    result: FsrsBuryResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:415 `fsrs_undo_last_review` */
  fsrs_undo_last_review: {
    args: {
      expectedLogId: string;
      cardStateId: string;
    };
    result: FsrsUndoResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:500 `fsrs_unsuspend_card` */
  fsrs_unsuspend_card: {
    args: {
      cardStateId: string;
    };
    result: FsrsSuspendResult;
    error: Shared.AppError;
  };
  /** src/cmd/fsrs_review.rs:562 `fsrs_update_scheduler_config` */
  fsrs_update_scheduler_config: {
    args: {
      update: FsrsSchedulerConfigUpdate;
    };
    result: FsrsSchedulerConfig;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:125 `insight_add_relation` */
  insight_add_relation: {
    args: {
      fromId: string;
      toId: string;
      relationType: string;
      scope?: string | null;
      evidence?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:31 `insight_confirm` */
  insight_confirm: {
    args: {
      insightId: string;
      edits?: InsightCorrectInput | null;
    };
    result: InsightCard;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:41 `insight_correct` */
  insight_correct: {
    args: {
      insightId: string;
      input: InsightCorrectInput;
    };
    result: InsightCard;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:22 `insight_create_draft` */
  insight_create_draft: {
    args: {
      input: InsightDraftInput;
    };
    result: InsightCard;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:51 `insight_delete` */
  insight_delete: {
    args: {
      insightId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:57 `insight_get` */
  insight_get: {
    args: {
      insightId: string;
    };
    result: InsightCard | null;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:66 `insight_list` */
  insight_list: {
    args: {
      status?: string | null;
      limit?: number | null;
      offset?: number | null;
    };
    result: InsightCard[];
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:104 `insight_list_events` */
  insight_list_events: {
    args: {
      insightId: string;
      limit?: number | null;
    };
    result: InsightEvent[];
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:88 `insight_list_evidence` */
  insight_list_evidence: {
    args: {
      insightId: string;
    };
    result: InsightEvidence[];
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:96 `insight_list_relations` */
  insight_list_relations: {
    args: {
      insightId: string;
    };
    result: InsightRelation[];
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:80 `insight_list_revisions` */
  insight_list_revisions: {
    args: {
      insightId: string;
    };
    result: InsightRevision[];
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:114 `insight_record_feedback` */
  insight_record_feedback: {
    args: {
      insightId: string;
      feedback: string;
      sessionId?: string | null;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/insight/handlers.rs:144 `insight_run_jobs` */
  insight_run_jobs: {
    args: {
      batchSize?: number | null;
    };
    result: number;
    error: Shared.AppError;
  };
  /** crates/dstu-learning/src/mastery/mod.rs:23 `mastery_get_overview` */
  mastery_get_overview: {
    args: {
      limit?: number | null;
    };
    result: MasteryOverviewSummary;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:908 `review_plan_batch_create` */
  review_plan_batch_create: {
    args: {
      questionIds: string[];
      examId: string;
    };
    result: BatchCreateResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:762 `review_plan_create` */
  review_plan_create: {
    args: {
      questionId: string;
      examId: string;
    };
    result: ReviewPlan;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:921 `review_plan_create_for_exam` */
  review_plan_create_for_exam: {
    args: {
      examId: string;
    };
    result: BatchCreateResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:885 `review_plan_delete` */
  review_plan_delete: {
    args: {
      planId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:855 `review_plan_get` */
  review_plan_get: {
    args: {
      planId: string;
    };
    result: ReviewPlan | null;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:843 `review_plan_get_by_question` */
  review_plan_get_by_question: {
    args: {
      questionId: string;
    };
    result: ReviewPlan | null;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:960 `review_plan_get_calendar_data` */
  review_plan_get_calendar_data: {
    args: {
      startDate?: string | null;
      endDate?: string | null;
      examId?: string | null;
    };
    result: CalendarHeatmapData[];
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:794 `review_plan_get_due` */
  review_plan_get_due: {
    args: {
      examId?: string | null;
      untilDate?: string | null;
    };
    result: DueReviewsResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:807 `review_plan_get_due_with_filter` */
  review_plan_get_due_with_filter: {
    args: {
      filter: DueReviewsFilter;
    };
    result: DueReviewsResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:895 `review_plan_get_history` */
  review_plan_get_history: {
    args: {
      planId: string;
      limit?: number | null;
    };
    result: ReviewHistory[];
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:947 `review_plan_get_or_create` */
  review_plan_get_or_create: {
    args: {
      questionId: string;
      examId: string;
    };
    result: ReviewPlan;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:819 `review_plan_get_stats` */
  review_plan_get_stats: {
    args: {
      examId?: string | null;
    };
    result: ReviewStats;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:933 `review_plan_list_by_exam` */
  review_plan_list_by_exam: {
    args: {
      examId: string;
      limit?: number | null;
      offset?: number | null;
    };
    result: DueReviewsResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:775 `review_plan_process` */
  review_plan_process: {
    args: {
      planId: string;
      quality: number;
      userAnswer?: string | null;
      timeSpentSeconds?: number | null;
    };
    result: ProcessReviewResult;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:831 `review_plan_refresh_stats` */
  review_plan_refresh_stats: {
    args: {
      examId?: string | null;
    };
    result: ReviewStats;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:875 `review_plan_resume` */
  review_plan_resume: {
    args: {
      planId: string;
    };
    result: ReviewPlan;
    error: string;
  };
  /** crates/dstu-qbank/src/review_plan_service.rs:865 `review_plan_suspend` */
  review_plan_suspend: {
    args: {
      planId: string;
    };
    result: ReviewPlan;
    error: string;
  };
  /** crates/dstu-learning/src/study_loop/study_time.rs:116 `study_time_add` */
  study_time_add: {
    args: {
      seconds: number;
      date?: string | null;
    };
    result: StudyTimeDay;
    error: Shared.AppError;
  };
  /** crates/dstu-learning/src/study_loop/study_time.rs:147 `study_time_range` */
  study_time_range: {
    args: {
      from: string;
      to: string;
    };
    result: StudyTimeDay[];
    error: Shared.AppError;
  };
}

export interface Events {
  "fsrs://changed": ({
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | unknown);
}

export type CommandName = keyof Commands;
export type EssayGradingCreateCustomModeCommandArgs = Commands['essay_grading_create_custom_mode']['args'];
export type EssayGradingCreateCustomModeCommandResult = Commands['essay_grading_create_custom_mode']['result'];
export type EssayGradingCreateSessionCommandArgs = Commands['essay_grading_create_session']['args'];
export type EssayGradingCreateSessionCommandResult = Commands['essay_grading_create_session']['result'];
export type EssayGradingDeleteCustomModeCommandArgs = Commands['essay_grading_delete_custom_mode']['args'];
export type EssayGradingDeleteCustomModeCommandResult = Commands['essay_grading_delete_custom_mode']['result'];
export type EssayGradingDeleteSessionCommandArgs = Commands['essay_grading_delete_session']['args'];
export type EssayGradingDeleteSessionCommandResult = Commands['essay_grading_delete_session']['result'];
export type EssayGradingGetLatestRoundNumberCommandArgs = Commands['essay_grading_get_latest_round_number']['args'];
export type EssayGradingGetLatestRoundNumberCommandResult = Commands['essay_grading_get_latest_round_number']['result'];
export type EssayGradingGetModeCommandArgs = Commands['essay_grading_get_mode']['args'];
export type EssayGradingGetModeCommandResult = Commands['essay_grading_get_mode']['result'];
export type EssayGradingGetModelsCommandArgs = Commands['essay_grading_get_models']['args'];
export type EssayGradingGetModelsCommandResult = Commands['essay_grading_get_models']['result'];
export type EssayGradingGetModesCommandArgs = Commands['essay_grading_get_modes']['args'];
export type EssayGradingGetModesCommandResult = Commands['essay_grading_get_modes']['result'];
export type EssayGradingGetRoundCommandArgs = Commands['essay_grading_get_round']['args'];
export type EssayGradingGetRoundCommandResult = Commands['essay_grading_get_round']['result'];
export type EssayGradingGetRoundsCommandArgs = Commands['essay_grading_get_rounds']['args'];
export type EssayGradingGetRoundsCommandResult = Commands['essay_grading_get_rounds']['result'];
export type EssayGradingGetSessionCommandArgs = Commands['essay_grading_get_session']['args'];
export type EssayGradingGetSessionCommandResult = Commands['essay_grading_get_session']['result'];
export type EssayGradingHasBuiltinOverrideCommandArgs = Commands['essay_grading_has_builtin_override']['args'];
export type EssayGradingHasBuiltinOverrideCommandResult = Commands['essay_grading_has_builtin_override']['result'];
export type EssayGradingListCustomModesCommandArgs = Commands['essay_grading_list_custom_modes']['args'];
export type EssayGradingListCustomModesCommandResult = Commands['essay_grading_list_custom_modes']['result'];
export type EssayGradingListSessionsCommandArgs = Commands['essay_grading_list_sessions']['args'];
export type EssayGradingListSessionsCommandResult = Commands['essay_grading_list_sessions']['result'];
export type EssayGradingResetBuiltinModeCommandArgs = Commands['essay_grading_reset_builtin_mode']['args'];
export type EssayGradingResetBuiltinModeCommandResult = Commands['essay_grading_reset_builtin_mode']['result'];
export type EssayGradingSaveBuiltinOverrideCommandArgs = Commands['essay_grading_save_builtin_override']['args'];
export type EssayGradingSaveBuiltinOverrideCommandResult = Commands['essay_grading_save_builtin_override']['result'];
export type EssayGradingStreamCommandArgs = Commands['essay_grading_stream']['args'];
export type EssayGradingStreamCommandResult = Commands['essay_grading_stream']['result'];
export type EssayGradingToggleFavoriteCommandArgs = Commands['essay_grading_toggle_favorite']['args'];
export type EssayGradingToggleFavoriteCommandResult = Commands['essay_grading_toggle_favorite']['result'];
export type EssayGradingUpdateCustomModeCommandArgs = Commands['essay_grading_update_custom_mode']['args'];
export type EssayGradingUpdateCustomModeCommandResult = Commands['essay_grading_update_custom_mode']['result'];
export type EssayGradingUpdateSessionCommandArgs = Commands['essay_grading_update_session']['args'];
export type EssayGradingUpdateSessionCommandResult = Commands['essay_grading_update_session']['result'];
export type FsrsBuryCardCommandArgs = Commands['fsrs_bury_card']['args'];
export type FsrsBuryCardCommandResult = Commands['fsrs_bury_card']['result'];
export type FsrsEnqueueCardsCommandArgs = Commands['fsrs_enqueue_cards']['args'];
export type FsrsEnqueueCardsCommandResult = Commands['fsrs_enqueue_cards']['result'];
export type FsrsGetCardMemoryHistoryCommandArgs = Commands['fsrs_get_card_memory_history']['args'];
export type FsrsGetCardMemoryHistoryCommandResult = Commands['fsrs_get_card_memory_history']['result'];
export type FsrsGetDueCommandArgs = Commands['fsrs_get_due']['args'];
export type FsrsGetDueCommandResult = Commands['fsrs_get_due']['result'];
export type FsrsGetMemoryOverviewCommandArgs = Commands['fsrs_get_memory_overview']['args'];
export type FsrsGetMemoryOverviewCommandResult = Commands['fsrs_get_memory_overview']['result'];
export type FsrsGetReviewStatisticsCommandArgs = Commands['fsrs_get_review_statistics']['args'];
export type FsrsGetReviewStatisticsCommandResult = Commands['fsrs_get_review_statistics']['result'];
export type FsrsGetSchedulerConfigCommandArgs = Commands['fsrs_get_scheduler_config']['args'];
export type FsrsGetSchedulerConfigCommandResult = Commands['fsrs_get_scheduler_config']['result'];
export type FsrsGetStatsCommandArgs = Commands['fsrs_get_stats']['args'];
export type FsrsGetStatsCommandResult = Commands['fsrs_get_stats']['result'];
export type FsrsOptimizeParametersCommandArgs = Commands['fsrs_optimize_parameters']['args'];
export type FsrsOptimizeParametersCommandResult = Commands['fsrs_optimize_parameters']['result'];
export type FsrsPreviewIntervalsCommandArgs = Commands['fsrs_preview_intervals']['args'];
export type FsrsPreviewIntervalsCommandResult = Commands['fsrs_preview_intervals']['result'];
export type FsrsRateCommandArgs = Commands['fsrs_rate']['args'];
export type FsrsRateCommandResult = Commands['fsrs_rate']['result'];
export type FsrsResetCardProgressCommandArgs = Commands['fsrs_reset_card_progress']['args'];
export type FsrsResetCardProgressCommandResult = Commands['fsrs_reset_card_progress']['result'];
export type FsrsSuspendCardCommandArgs = Commands['fsrs_suspend_card']['args'];
export type FsrsSuspendCardCommandResult = Commands['fsrs_suspend_card']['result'];
export type FsrsUnburyCardCommandArgs = Commands['fsrs_unbury_card']['args'];
export type FsrsUnburyCardCommandResult = Commands['fsrs_unbury_card']['result'];
export type FsrsUndoLastReviewCommandArgs = Commands['fsrs_undo_last_review']['args'];
export type FsrsUndoLastReviewCommandResult = Commands['fsrs_undo_last_review']['result'];
export type FsrsUnsuspendCardCommandArgs = Commands['fsrs_unsuspend_card']['args'];
export type FsrsUnsuspendCardCommandResult = Commands['fsrs_unsuspend_card']['result'];
export type FsrsUpdateSchedulerConfigCommandArgs = Commands['fsrs_update_scheduler_config']['args'];
export type FsrsUpdateSchedulerConfigCommandResult = Commands['fsrs_update_scheduler_config']['result'];
export type InsightAddRelationCommandArgs = Commands['insight_add_relation']['args'];
export type InsightAddRelationCommandResult = Commands['insight_add_relation']['result'];
export type InsightConfirmCommandArgs = Commands['insight_confirm']['args'];
export type InsightConfirmCommandResult = Commands['insight_confirm']['result'];
export type InsightCorrectCommandArgs = Commands['insight_correct']['args'];
export type InsightCorrectCommandResult = Commands['insight_correct']['result'];
export type InsightCreateDraftCommandArgs = Commands['insight_create_draft']['args'];
export type InsightCreateDraftCommandResult = Commands['insight_create_draft']['result'];
export type InsightDeleteCommandArgs = Commands['insight_delete']['args'];
export type InsightDeleteCommandResult = Commands['insight_delete']['result'];
export type InsightGetCommandArgs = Commands['insight_get']['args'];
export type InsightGetCommandResult = Commands['insight_get']['result'];
export type InsightListCommandArgs = Commands['insight_list']['args'];
export type InsightListCommandResult = Commands['insight_list']['result'];
export type InsightListEventsCommandArgs = Commands['insight_list_events']['args'];
export type InsightListEventsCommandResult = Commands['insight_list_events']['result'];
export type InsightListEvidenceCommandArgs = Commands['insight_list_evidence']['args'];
export type InsightListEvidenceCommandResult = Commands['insight_list_evidence']['result'];
export type InsightListRelationsCommandArgs = Commands['insight_list_relations']['args'];
export type InsightListRelationsCommandResult = Commands['insight_list_relations']['result'];
export type InsightListRevisionsCommandArgs = Commands['insight_list_revisions']['args'];
export type InsightListRevisionsCommandResult = Commands['insight_list_revisions']['result'];
export type InsightRecordFeedbackCommandArgs = Commands['insight_record_feedback']['args'];
export type InsightRecordFeedbackCommandResult = Commands['insight_record_feedback']['result'];
export type InsightRunJobsCommandArgs = Commands['insight_run_jobs']['args'];
export type InsightRunJobsCommandResult = Commands['insight_run_jobs']['result'];
export type MasteryGetOverviewCommandArgs = Commands['mastery_get_overview']['args'];
export type MasteryGetOverviewCommandResult = Commands['mastery_get_overview']['result'];
export type ReviewPlanBatchCreateCommandArgs = Commands['review_plan_batch_create']['args'];
export type ReviewPlanBatchCreateCommandResult = Commands['review_plan_batch_create']['result'];
export type ReviewPlanCreateCommandArgs = Commands['review_plan_create']['args'];
export type ReviewPlanCreateCommandResult = Commands['review_plan_create']['result'];
export type ReviewPlanCreateForExamCommandArgs = Commands['review_plan_create_for_exam']['args'];
export type ReviewPlanCreateForExamCommandResult = Commands['review_plan_create_for_exam']['result'];
export type ReviewPlanDeleteCommandArgs = Commands['review_plan_delete']['args'];
export type ReviewPlanDeleteCommandResult = Commands['review_plan_delete']['result'];
export type ReviewPlanGetCommandArgs = Commands['review_plan_get']['args'];
export type ReviewPlanGetCommandResult = Commands['review_plan_get']['result'];
export type ReviewPlanGetByQuestionCommandArgs = Commands['review_plan_get_by_question']['args'];
export type ReviewPlanGetByQuestionCommandResult = Commands['review_plan_get_by_question']['result'];
export type ReviewPlanGetCalendarDataCommandArgs = Commands['review_plan_get_calendar_data']['args'];
export type ReviewPlanGetCalendarDataCommandResult = Commands['review_plan_get_calendar_data']['result'];
export type ReviewPlanGetDueCommandArgs = Commands['review_plan_get_due']['args'];
export type ReviewPlanGetDueCommandResult = Commands['review_plan_get_due']['result'];
export type ReviewPlanGetDueWithFilterCommandArgs = Commands['review_plan_get_due_with_filter']['args'];
export type ReviewPlanGetDueWithFilterCommandResult = Commands['review_plan_get_due_with_filter']['result'];
export type ReviewPlanGetHistoryCommandArgs = Commands['review_plan_get_history']['args'];
export type ReviewPlanGetHistoryCommandResult = Commands['review_plan_get_history']['result'];
export type ReviewPlanGetOrCreateCommandArgs = Commands['review_plan_get_or_create']['args'];
export type ReviewPlanGetOrCreateCommandResult = Commands['review_plan_get_or_create']['result'];
export type ReviewPlanGetStatsCommandArgs = Commands['review_plan_get_stats']['args'];
export type ReviewPlanGetStatsCommandResult = Commands['review_plan_get_stats']['result'];
export type ReviewPlanListByExamCommandArgs = Commands['review_plan_list_by_exam']['args'];
export type ReviewPlanListByExamCommandResult = Commands['review_plan_list_by_exam']['result'];
export type ReviewPlanProcessCommandArgs = Commands['review_plan_process']['args'];
export type ReviewPlanProcessCommandResult = Commands['review_plan_process']['result'];
export type ReviewPlanRefreshStatsCommandArgs = Commands['review_plan_refresh_stats']['args'];
export type ReviewPlanRefreshStatsCommandResult = Commands['review_plan_refresh_stats']['result'];
export type ReviewPlanResumeCommandArgs = Commands['review_plan_resume']['args'];
export type ReviewPlanResumeCommandResult = Commands['review_plan_resume']['result'];
export type ReviewPlanSuspendCommandArgs = Commands['review_plan_suspend']['args'];
export type ReviewPlanSuspendCommandResult = Commands['review_plan_suspend']['result'];
export type StudyTimeAddCommandArgs = Commands['study_time_add']['args'];
export type StudyTimeAddCommandResult = Commands['study_time_add']['result'];
export type StudyTimeRangeCommandArgs = Commands['study_time_range']['args'];
export type StudyTimeRangeCommandResult = Commands['study_time_range']['result'];
