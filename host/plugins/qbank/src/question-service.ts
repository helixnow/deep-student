/** QuestionBankService behavior, mirroring dstu-qbank/src/question_bank_service.rs. */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  AnswerSubmission, BatchResult, CreateQuestionParams, Question, QuestionFilters, QuestionHistory,
  QuestionListResult, SubmitAnswerResult, UpdateQuestionParams, QuestionSearchFilters, QuestionSearchListResult,
  dstu_vfs__vfs__repos__question_repo__QuestionBankStats as QuestionBankStats,
} from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import type { QbankPorts } from './ports.ts';
import { checkAnswerCorrectness } from './answer-correctness.ts';
import { toStatus } from './question-enums.ts';
import { localDate, utcNow, type MistakeListFilters, type MistakeListResult } from '../repository/questions.ts';
import { advanceDueReviewPlan, ensureReviewPlan, type ReviewPlanHost } from './review-plan-effects.ts';
import { vfsCreateParams, vfsFilters, vfsSearchFilters, vfsUpdateParams } from './question-repository-adapter.ts';

/** `.message` 为 AppError 的 Display（models.rs:1038-1042 只写 message），结构化错误在 `appError`。 */
export class QbankServiceError extends Error {
  readonly appError: unknown;
  constructor(appError: unknown) {
    const message = (appError as { message?: unknown } | null)?.message;
    super(typeof appError === 'string' ? appError : typeof message === 'string' ? message : JSON.stringify(appError));
    this.name = 'QbankServiceError';
    this.appError = appError;
  }
}
function notFound(message: string): never {
  throw new QbankServiceError(AppError.not_found(message));
}
function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}
function database(error: unknown): never {
  throw new QbankServiceError(AppError.database(errorMessage(error)));
}
function errorMessage(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    return typeof appError.message === 'string' ? appError.message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function warnStats(host: QuestionServiceHost, examId: string, error: unknown): void {
  host.log?.warn(`[qbank] refresh stats failed for ${examId}: ${errorMessage(error)}`);
}

export interface MasteryRecorder {
  recordQbankAnswerWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): unknown;
  recordQbankVerdictCorrectionWithConn(conn: SqlExecutor, submissionId: string, questionId: string, tags: string[], correct: boolean): unknown;
  syncLearnerProfile(state: unknown): void;
}

export interface QuestionServiceHost extends QbankPorts, ReviewPlanHost {
  readonly db: DatabaseHandle;
  /** L11 的 conn-bound 仓储：题目/历史/作答/统计的唯一写入方。 */
  readonly questions: QuestionRepository;
  mastery(): MasteryRecorder | undefined;
}

/** Rust 的掌握度服务始终可用；TS 侧缺失时必须让客观题提交失败而不是静默跳过。 */
export function requireMastery(host: { mastery(): MasteryRecorder | undefined }): MasteryRecorder {
  const mastery = host.mastery();
  if (mastery === undefined) {
    throw new QbankServiceError(AppError.configuration('掌握度服务不可用：review 插件未提供 mastery'));
  }
  return mastery;
}

export interface DailyProgressSnapshot {
  date: string; exam_id: string; answered_question_ids: string[]; completed_count: number; correct_count: number;
}

function withDatabase<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    return database(error);
  }
}

export function listQuestions(host: QuestionServiceHost, examId: string, filters: QuestionFilters,
  page: number, pageSize: number): QuestionListResult {
  return withDatabase(() => host.questions.listQuestions(host.db, examId, vfsFilters(filters), page, pageSize));
}
export function listMistakes(host: QuestionServiceHost, filters: MistakeListFilters,
  page: number, pageSize: number): MistakeListResult {
  return withDatabase(() => host.questions.listMistakes(host.db, filters, page, pageSize));
}
export function searchQuestions(host: QuestionServiceHost, keyword: string, examId: string | null,
  filters: QuestionSearchFilters, page: number, pageSize: number): QuestionSearchListResult {
  return withDatabase(() => host.questions.searchQuestions(host.db, keyword, examId, vfsSearchFilters(filters), page, pageSize));
}
export function rebuildFtsIndex(host: QuestionServiceHost): number {
  return withDatabase(() => host.questions.rebuildFtsIndex(host.db));
}
export function getQuestion(host: QuestionServiceHost, questionId: string): Question | null {
  return withDatabase(() => host.questions.getQuestion(host.db, questionId));
}
export function getQuestionByCardId(host: QuestionServiceHost, examId: string, cardId: string): Question | null {
  return withDatabase(() => host.questions.getQuestionByCardId(host.db, examId, cardId));
}

/** commands.rs:8728 qbank_remove_question_image */
export function removeQuestionImage(host: QuestionServiceHost, questionId: string, imageId: string): void {
  withDatabase(() => {
    const question = host.questions.getQuestion(host.db, questionId);
    if (question === null) notFound('题目不存在');
    const images = question.images.filter(image => image.id !== imageId);
    host.questions.updateQuestion(host.db, questionId, { images });
  });
}

export function createQuestion(host: QuestionServiceHost, params: CreateQuestionParams): Question {
  return withDatabase(() => {
    const question = host.questions.createQuestion(host.db, vfsCreateParams(params));
    try {
      host.questions.refreshStats(host.db, params.exam_id);
    } catch (error) {
      warnStats(host, params.exam_id, error);
    }
    return question;
  });
}

export function batchCreateQuestions(host: QuestionServiceHost, paramsList: CreateQuestionParams[]): Question[] {
  return withDatabase(() => {
    if (paramsList.length === 0) return [];
    const questions = host.questions.batchCreateQuestions(host.db, paramsList.map(vfsCreateParams));
    for (const examId of new Set(paramsList.map(params => params.exam_id))) {
      try {
        host.questions.refreshStats(host.db, examId);
      } catch (error) {
        warnStats(host, examId, error);
      }
    }
    return questions;
  });
}

/** `serde_json::Value` 的结构相等：对象键顺序不影响结果。 */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (leftArray || rightArray) {
    return leftArray && rightArray && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]));
  }
  return false;
}

function recordChanges(host: QuestionServiceHost, db: SqlExecutor, old: Question, updated: Question): void {
  if (old.content !== updated.content) {
    host.questions.recordHistory(db, updated.id, 'content', old.content, updated.content, 'user', null);
  }
  if (old.answer !== updated.answer) {
    host.questions.recordHistory(db, updated.id, 'answer', old.answer, updated.answer, 'user', null);
  }
  if (old.explanation !== updated.explanation) {
    host.questions.recordHistory(db, updated.id, 'explanation', old.explanation, updated.explanation, 'user', null);
  }
  if (!structurallyEqual(old.structured_data ?? null, updated.structured_data ?? null)) {
    host.questions.recordHistory(db, updated.id, 'structured_data',
      old.structured_data == null ? null : JSON.stringify(old.structured_data),
      updated.structured_data == null ? null : JSON.stringify(updated.structured_data), 'user', null);
  }
  if (!structurallyEqual(old.images, updated.images)) {
    host.questions.recordHistory(db, updated.id, 'images', JSON.stringify(old.images), JSON.stringify(updated.images), 'user', null);
  }
}

export function updateQuestion(host: QuestionServiceHost, questionId: string, params: UpdateQuestionParams,
  recordHistory: boolean): Question {
  return withDatabase(() => {
    const old = recordHistory ? host.questions.getQuestion(host.db, questionId) : null;
    const updated = host.questions.updateQuestion(host.db, questionId, vfsUpdateParams(params));
    if (recordHistory && old !== null) recordChanges(host, host.db, old, updated);
    if (params.status != null) {
      try {
        host.questions.refreshStats(host.db, updated.exam_id);
      } catch (error) {
        warnStats(host, updated.exam_id, error);
      }
    }
    return updated;
  });
}

export function batchUpdateQuestions(host: QuestionServiceHost, questionIds: string[],
  params: UpdateQuestionParams): BatchResult {
  return withDatabase(() => {
    if (questionIds.length === 0) return { success_count: 0, failed_count: 0, errors: [] };
    return host.db.transaction(tx => {
      let successCount = 0;
      const errors: string[] = [];
      const examIds = new Set<string>();
      for (const id of questionIds) {
        try {
          const question = tx.savepoint(sp => host.questions.updateQuestion(sp, id, vfsUpdateParams(params)));
          successCount += 1;
          examIds.add(question.exam_id);
        } catch (error) {
          // Rust: errors.push(format!("{}: {}", id, AppError::database(e.to_string())))
          errors.push(`${id}: ${AppError.database(errorMessage(error)).message}`);
        }
      }
      for (const examId of examIds) {
        try {
          host.questions.refreshStats(tx, examId);
        } catch (error) {
          warnStats(host, examId, error);
        }
      }
      return { success_count: successCount, failed_count: errors.length, errors };
    });
  });
}

export function deleteQuestion(host: QuestionServiceHost, questionId: string): void {
  return withDatabase(() => {
    const question = host.questions.getQuestion(host.db, questionId);
    host.questions.deleteQuestion(host.db, questionId);
    if (question !== null) {
      try {
        host.questions.refreshStats(host.db, question.exam_id);
      } catch (error) {
        warnStats(host, question.exam_id, error);
      }
    }
  });
}

export function batchDeleteQuestions(host: QuestionServiceHost, questionIds: string[]): BatchResult {
  return withDatabase(() => {
    if (questionIds.length === 0) return { success_count: 0, failed_count: 0, errors: [] };
    return host.db.transaction(tx => {
      let successCount = 0;
      const errors: string[] = [];
      const examIds = new Set<string>();
      for (const id of questionIds) {
        try {
          const question = host.questions.getQuestion(tx, id);
          if (question === null) {
            errors.push(`${id}: not found`);
            continue;
          }
          host.questions.deleteQuestion(tx, id);
          successCount += 1;
          examIds.add(question.exam_id);
        } catch (error) {
          errors.push(`${id}: ${errorMessage(error)}`);
        }
      }
      for (const examId of examIds) {
        try {
          host.questions.refreshStats(tx, examId);
        } catch (error) {
          warnStats(host, examId, error);
        }
      }
      return { success_count: successCount, failed_count: errors.length, errors };
    });
  });
}

/**
 * question_bank_service.rs:440 `batch_delete_questions_if_versions`: one transaction, every
 * question soft-deleted only at its expected revision; any conflict rolls the whole batch back.
 */
export function batchDeleteQuestionsIfVersions(host: QuestionServiceHost,
  expectedVersions: readonly (readonly [string, string])[]): Question[] {
  if (expectedVersions.length === 0) validation('question_ids must not be empty');
  if (new Set(expectedVersions.map(([questionId]) => questionId)).size !== expectedVersions.length) {
    validation('question_ids contains duplicates');
  }
  const examIds = new Set<string>();
  const previous = withDatabase(() => host.db.transaction(tx => {
    const deleted: Question[] = [];
    for (const [questionId, expectedUpdatedAt] of expectedVersions) {
      const question = host.questions.getQuestion(tx, questionId);
      if (question === null) notFound(`Question not found: ${questionId}`);
      examIds.add(question.exam_id);
      host.questions.deleteQuestionIfVersion(tx, questionId, expectedUpdatedAt);
      deleted.push(question);
    }
    return deleted;
  }));
  for (const examId of examIds) {
    try {
      host.questions.refreshStats(host.db, examId);
    } catch (error) {
      host.log?.warn(`[QuestionBankService] Failed to refresh stats after OCC delete for ${examId}: ${errorMessage(error)}`);
    }
  }
  return previous;
}

export function toggleFavorite(host: QuestionServiceHost, questionId: string): Question {
  return withDatabase(() => {
    const question = host.questions.getQuestion(host.db, questionId);
    if (question === null) notFound(`Question not found: ${questionId}`);
    return host.questions.updateQuestion(host.db, questionId, { is_favorite: !question.is_favorite });
  });
}

export function countByType(host: QuestionServiceHost, examId: string): Record<string, number> {
  return withDatabase(() => host.questions.countByType(host.db, examId));
}
export function getStats(host: QuestionServiceHost, examId: string): QuestionBankStats | null {
  return withDatabase(() => host.questions.getStats(host.db, examId));
}
export function refreshStats(host: QuestionServiceHost, examId: string): QuestionBankStats {
  return withDatabase(() => host.questions.refreshStats(host.db, examId));
}
export function getHistory(host: QuestionServiceHost, questionId: string, limit: number | null): QuestionHistory[] {
  return withDatabase(() => host.questions.getHistory(host.db, questionId, limit));
}
export function getSubmissions(host: QuestionServiceHost, questionId: string, limit: number): AnswerSubmission[] {
  return withDatabase(() => host.questions.getSubmissions(host.db, questionId, limit));
}

export function resetProgress(host: QuestionServiceHost, examId: string): QuestionBankStats {
  return withDatabase(() => host.db.transaction(tx =>
    host.questions.resetExamProgress(tx, examId, utcNow())));
}

export function resetQuestionsProgress(host: QuestionServiceHost, questionIds: string[]): BatchResult {
  return withDatabase(() => {
    if (questionIds.length === 0) return { success_count: 0, failed_count: 0, errors: [] };
    return host.db.transaction(tx => {
      const now = utcNow();
      let successCount = 0;
      const errors: string[] = [];
      const examIds = new Set<string>();
      for (const questionId of questionIds) {
        try {
          const examId = tx.savepoint(sp => host.questions.resetQuestionProgress(sp, questionId, now));
          successCount += 1;
          examIds.add(examId);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      }
      for (const examId of examIds) {
        try {
          host.questions.refreshStats(tx, examId);
        } catch (error) {
          const message = `${examId}: refresh stats failed: ${errorMessage(error)}`;
          errors.push(message);
          host.log?.warn(`[QuestionBank] ${message}`);
        }
      }
      return { success_count: successCount, failed_count: errors.length, errors };
    });
  });
}

function buildDailyProgress(host: QuestionServiceHost, examId: string): DailyProgressSnapshot | null {
  const date = localDate();
  try {
    const progress = host.questions.dailyProgressRows(host.db, examId, date);
    return { date, exam_id: examId, answered_question_ids: progress.ids,
      completed_count: progress.ids.length, correct_count: progress.correct };
  } catch (error) {
    host.log?.warn(
      `[QuestionBankService] daily progress snapshot failed for exam_id=${examId}: ${errorMessage(error)}`);
    return null;
  }
}

export interface VerdictOutcome {
  changed: boolean; updated_question: Question; updated_stats: QuestionBankStats;
  mastery_state: unknown | null; needs_review_plan: boolean;
}

/** question_bank_service.rs:820-957 */
export function applySubmissionVerdict(host: QuestionServiceHost, conn: SqlExecutor, question: Question,
  submission: AnswerSubmission, newIsCorrect: boolean, gradingMethod: string, now: string): VerdictOutcome {
  const questionId = question.id;
  // L11 owns the submission/question update + sync_status/content_hash side effects.
  // The caller already bound `submission` to this question in the same executor.
  const outcome = host.questions.applySubmissionVerdict(conn, questionId, submission.id,
    newIsCorrect, gradingMethod, now);
  if (!outcome.changed) {
    return { changed: false, updated_question: outcome.updated_question,
      updated_stats: host.questions.refreshStats(conn, question.exam_id),
      mastery_state: null, needs_review_plan: false };
  }

  // mastery 与仓储写入共用同一个 SqlExecutor；SM-2/profile 仍由调用方在提交后执行。
  const mastery = requireMastery(host);
  const masteryState = submission.is_correct === null
    ? mastery.recordQbankAnswerWithConn(conn, submission.id, questionId, question.tags, newIsCorrect)
    : mastery.recordQbankVerdictCorrectionWithConn(conn, submission.id, questionId, question.tags, newIsCorrect);
  return {
    changed: true, updated_question: outcome.updated_question,
    updated_stats: host.questions.refreshStats(conn, question.exam_id), mastery_state: masteryState,
    needs_review_plan: !newIsCorrect,
  };
}

function debugOption(value: boolean | null): string {
  return value === null ? 'None' : `Some(${value})`;
}

function syncProfile(host: QuestionServiceHost, questionId: string, state: unknown | null): void {
  if (state === null) return;
  const mastery = host.mastery();
  if (mastery === undefined) return;
  try {
    mastery.syncLearnerProfile(state);
  } catch (error) {
    host.log?.warn(
      `[QuestionBankService] mastery profile reflux failed for question_id=${questionId}: ${errorMessage(error)}`);
  }
}

export function submitAnswer(host: QuestionServiceHost, questionId: string, userAnswer: string,
  isCorrectOverride: boolean | null, clientRequestId: string | null): SubmitAnswerResult {
  return withDatabase(() => {
    if (isCorrectOverride !== null) {
      host.log?.warn(`[QuestionBankService] submit_answer called with is_correct_override for question_id=${questionId}`);
    }
    const outcome = host.db.transaction(tx => {
      const question = host.questions.getQuestion(tx, questionId);
      if (question === null) notFound(`Question not found: ${questionId}`);

      const requestId = clientRequestId?.trim() ? clientRequestId.trim() : null;
      if (requestId !== null) {
        const existing = host.questions.getSubmissionByClientRequest(tx, questionId, requestId);
        if (existing !== null) {
          const updatedQuestion = host.questions.getQuestion(tx, questionId);
          if (updatedQuestion === null) notFound(`Question not found: ${questionId}`);
          const updatedStats = host.questions.refreshStats(tx, question.exam_id);
          return { kind: 'idempotent' as const, question, existing, updatedQuestion, updatedStats };
        }
      }

      if (isCorrectOverride !== null) {
        const latest = host.questions.getSubmissions(tx, questionId, 1)[0];
        if (latest !== undefined && latest.is_correct === null && latest.user_answer === userAnswer) {
          const now = utcNow();
          const verdict = applySubmissionVerdict(host, tx, question, latest, isCorrectOverride, 'manual', now);
          return { kind: 'regraded' as const, question, submission: latest, verdict };
        }
      }

      const [rawIsCorrect, needsManualGrading] = isCorrectOverride !== null
        ? [isCorrectOverride, false] as const
        : checkAnswerCorrectness(userAnswer, question.answer, question.question_type, question.structured_data);
      const isCorrect = needsManualGrading ? null : rawIsCorrect;
      const updatedQuestion = host.questions.submitAnswer(tx, questionId, userAnswer, isCorrect, needsManualGrading);
      const gradingMethod = needsManualGrading ? 'ai' : isCorrectOverride !== null ? 'manual' : 'auto';
      const submissionId = host.questions.insertSubmission(tx, questionId, userAnswer, isCorrect, gradingMethod, clientRequestId);
      const updatedStats = host.questions.refreshStats(tx, question.exam_id);
      const masteryState = isCorrect === null ? null
        : requireMastery(host).recordQbankAnswerWithConn(
          tx, submissionId, questionId, question.tags, isCorrect);
      return { kind: 'submitted' as const, question, updatedQuestion, updatedStats, submissionId,
        isCorrect, rawIsCorrect, needsManualGrading, masteryState };
    });

    if (outcome.kind === 'idempotent') {
      const isCorrect = outcome.existing.is_correct;
      return {
        is_correct: isCorrect, correct_answer: outcome.question.answer,
        needs_manual_grading: isCorrect === null,
        message: isCorrect === null ? '需要手动批改' : isCorrect ? '回答正确！' : '回答错误',
        updated_question: outcome.updatedQuestion, updated_stats: outcome.updatedStats,
        submission_id: outcome.existing.id, daily_progress: buildDailyProgress(host, outcome.question.exam_id),
      };
    }
    if (outcome.kind === 'regraded') {
      if (outcome.verdict.needs_review_plan) {
        ensureReviewPlan(host, questionId, outcome.question.exam_id, {
          logSuccess: false, failureLabel: 'Failed to auto-create review plan after regrade for',
        });
      }
      syncProfile(host, questionId, outcome.verdict.mastery_state);
      if (outcome.verdict.changed) {
        host.log?.info?.(
          `[QuestionBankService] Regraded submission id=${outcome.submission.id} for question id=${questionId}, `
          + `${debugOption(outcome.submission.is_correct)} -> ${isCorrectOverride}`);
      }
      return {
        is_correct: isCorrectOverride, correct_answer: outcome.question.answer,
        needs_manual_grading: false, message: isCorrectOverride ? '回答正确！' : '回答错误',
        updated_question: outcome.verdict.updated_question, updated_stats: outcome.verdict.updated_stats,
        submission_id: outcome.submission.id, daily_progress: buildDailyProgress(host, outcome.question.exam_id),
      };
    }
    if (outcome.isCorrect === false) {
      ensureReviewPlan(host, questionId, outcome.question.exam_id, {
        logSuccess: true, failureLabel: 'Failed to auto-create review plan for',
      });
    } else if (outcome.isCorrect === true) {
      advanceDueReviewPlan(host, questionId);
    }
    syncProfile(host, questionId, outcome.masteryState);
    host.log?.info?.(
      `[QuestionBankService] Submitted answer for question id=${questionId}, `
      + `is_correct=${debugOption(outcome.isCorrect)}, submission_id=${outcome.submissionId}`);
    return {
      is_correct: outcome.isCorrect, correct_answer: outcome.question.answer,
      needs_manual_grading: outcome.needsManualGrading,
      message: outcome.needsManualGrading ? '需要手动批改' : outcome.rawIsCorrect ? '回答正确！' : '回答错误',
      updated_question: outcome.updatedQuestion, updated_stats: outcome.updatedStats,
      submission_id: outcome.submissionId, daily_progress: buildDailyProgress(host, outcome.question.exam_id),
    };
  });
}

export function regradeSubmission(host: QuestionServiceHost, questionId: string,
  submissionId: string, isCorrect: boolean): SubmitAnswerResult {
  return withDatabase(() => {
    const outcome = host.db.transaction(tx => {
      const question = host.questions.getQuestion(tx, questionId);
      if (question === null) notFound(`Question not found: ${questionId}`);
      const latest = host.questions.getSubmissions(tx, questionId, 1)[0];
      if (latest === undefined) validation('该题还没有作答记录，无法改判');
      if (latest.id !== submissionId) validation('要改判的作答已不是最近一次提交，请刷新后重试');
      return { question, submission: latest,
        verdict: applySubmissionVerdict(host, tx, question, latest, isCorrect, 'manual', utcNow()) };
    });
    if (outcome.verdict.needs_review_plan) {
      ensureReviewPlan(host, questionId, outcome.question.exam_id, {
        logSuccess: false, failureLabel: 'Failed to auto-create review plan after regrade for',
      });
    }
    syncProfile(host, questionId, outcome.verdict.mastery_state);
    if (outcome.verdict.changed) {
      host.log?.info?.(
        `[QuestionBankService] Regraded submission id=${outcome.submission.id} for question id=${questionId}, `
        + `${debugOption(outcome.submission.is_correct)} -> ${isCorrect}`);
    }
    return {
      is_correct: isCorrect, correct_answer: outcome.question.answer, needs_manual_grading: false,
      message: isCorrect ? '回答正确！' : '回答错误',
      updated_question: outcome.verdict.updated_question, updated_stats: outcome.verdict.updated_stats,
      submission_id: outcome.submission.id, daily_progress: buildDailyProgress(host, outcome.question.exam_id),
    };
  });
}

export function resetAllStatus(host: QuestionServiceHost, questionId: string, status: string): Question {
  return updateQuestion(host, questionId, { status: toStatus(status) }, false);
}
