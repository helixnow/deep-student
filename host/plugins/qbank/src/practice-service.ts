/** Practice drafts, submitted attempts and generated papers, mirroring qbank_practice.rs. */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rfc3339FromMillis, rfc3339Now } from '../../../platform/storage/time.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type {
  CreatePracticeRequest, GeneratedPaper, PaperConfig, PaperConfig__De, PracticeAttempt, PracticeDraft,
  PracticeGradingDraft, PracticeResult, PracticeSummary, Question, SavePracticeRequest,
} from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { checkAnswerCorrectness } from './answer-correctness.ts';
import { chronoRfc3339Error } from './chrono-rfc3339.ts';
import { difficultyFrom } from './question-enums.ts';
import {
  QbankServiceError, requireMastery, type MasteryRecorder,
} from './question-service.ts';
import type { QbankPorts } from './ports.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import { vfsFilters } from './question-repository-adapter.ts';
import { advanceDueReviewPlan, ensureReviewPlan, type ReviewPlanHost } from './review-plan-effects.ts';
import * as repo from '../repository/practice.ts';

const PRACTICE_MODES = ['sequential', 'random', 'review_first', 'review_only', 'by_tag', 'timed',
  'mock_exam', 'daily', 'paper', 'mistake_redo', 'group'];
const MAX_ANSWER_BYTES = 512 * 1024;
const MAX_DURATION_SECONDS = 480 * 60;

export interface PracticeServiceHost extends QbankPorts, ReviewPlanHost {
  readonly db: DatabaseHandle;
  readonly questions: QuestionRepository;
  /** device_id from F4 paths, mirroring data_space::device_id::get_device_id. */
  readonly deviceId: string;
  mastery(): MasteryRecorder | undefined;
}

export interface PracticeSyncOutcome {
  wrongQuestions: Array<{ questionId: string; examId: string }>;
  correctQuestionIds: string[];
  masteryStates: unknown[];
}

export interface SubmittedPractice {
  attempt: PracticeAttempt;
  outcome: PracticeSyncOutcome | null;
}

function notFound(message: string): never {
  throw new QbankServiceError(AppError.not_found(message));
}
function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}
function database(error: unknown): never {
  throw new QbankServiceError(AppError.database(errorText(error)));
}
function errorText(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    return typeof appError.message === 'string' ? appError.message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
function withDatabase<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof QbankServiceError) throw error;
    return database(error);
  }
}
function now(): string {
  return rfc3339Now();
}
function trim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}
export function refreshStatus(attempt: PracticeAttempt): void {
  attempt.status = attempt.results.some(result => result.status === 'pending') ? 'grading'
    : attempt.results.some(result => result.status === 'failed') ? 'needs_review' : 'completed';
}
function materialSnapshotJson(materials: Question['materials']): string {
  return JSON.stringify(materials);
}
function practiceQuestionSnapshot(question: Question): string {
  return JSON.stringify({
    id: question.id,
    exam_id: question.exam_id,
    question_label: question.question_label,
    content: question.content,
    question_type: question.question_type,
    options: question.options,
    answer: question.answer,
    explanation: question.explanation,
    structured_data: question.structured_data,
    images: question.images,
    source_ref: question.source_ref,
    updated_at: question.updated_at,
  });
}

function loadDraftOrThrow(db: SqlExecutor, id: string): PracticeDraft {
  const draft = repo.loadDraft(db, id);
  if (draft === null) notFound('Practice draft not found');
  return draft;
}
function loadAttemptOrThrow(db: SqlExecutor, id: string): PracticeAttempt {
  const attempt = repo.loadAttempt(db, id);
  if (attempt === null) notFound('Practice attempt not found');
  return attempt;
}

export function createDraft(host: PracticeServiceHost, request: CreatePracticeRequest): PracticeDraft {
  return withDatabase(() => host.db.transaction(tx => {
    if (request.id.length === 0 || utf8ByteLength(request.id) > 120 || request.scope_id.length === 0) {
      validation('Invalid practice identity');
    }
    if (!PRACTICE_MODES.includes(request.mode)) validation('Invalid practice mode');
    const existing = repo.loadDraft(tx, request.id);
    if (existing !== null) {
      if (existing.scope_id !== request.scope_id) validation('Practice scope mismatch');
      return existing;
    }
    if (repo.loadAttempt(tx, request.id) !== null) validation('Practice already submitted');

    let selected: Question[];
    if (request.attempt_id != null) {
      const source = loadAttemptOrThrow(tx, request.attempt_id);
      if (source.scope_id !== request.scope_id) validation('Practice scope mismatch');
      selected = source.questions;
    } else if (request.paper_id != null) {
      const paper = repo.loadPaper(tx, request.paper_id);
      if (paper === null) notFound('Paper not found');
      if (paper.exam_id !== request.scope_id) validation('Paper scope mismatch');
      selected = paper.questions;
    } else {
      const ids = request.question_ids ?? [];
      if (ids.length === 0 || ids.length > 10000) validation('Practice requires 1–10000 questions');
      const seen = new Set<string>();
      selected = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const question = host.questions.getQuestion(tx, id);
        if (question === null) notFound(`Question not found: ${id}`);
        if (request.scope_id !== '__mistake_redo__' && question.exam_id !== request.scope_id) {
          validation('Question scope mismatch');
        }
        selected.push(question);
      }
    }
    if (selected.length === 0) validation('No questions available');

    const createdAt = now();
    const duration = request.duration_seconds != null && request.duration_seconds > 0 ? request.duration_seconds : null;
    let deadline: string | null = null;
    if (duration !== null) {
      if (duration > MAX_DURATION_SECONDS) validation('Duration exceeds 480 minutes');
      const parsedStart = request.started_at == null ? null : parseRfc3339(request.started_at);
      const startedAt = request.started_at == null ? Math.floor(Date.now() / 1000)
        : parsedStart === null ? null : Math.floor(parsedStart.millis / 1000);
      if (startedAt === null) validation('Invalid practice start time');
      deadline = rfc3339FromMillis((startedAt + duration) * 1000);
    }
    const currentIndex = request.start_question_id == null ? 0
      : Math.max(0, selected.findIndex(question => question.id === request.start_question_id));
    const draft: PracticeDraft = {
      id: request.id,
      scope_id: request.scope_id,
      paper_id: request.paper_id ?? null,
      title: [...request.title].slice(0, 200).join(''),
      mode: request.mode,
      questions: selected,
      answers: {},
      marked_ids: [],
      current_index: currentIndex,
      elapsed_seconds: 0,
      duration_seconds: duration,
      deadline,
      revision: 1,
      created_at: createdAt,
      updated_at: createdAt,
    };
    repo.insertDraft(tx, draft);
    return draft;
  }));
}

export function saveDraft(host: PracticeServiceHost, request: SavePracticeRequest): PracticeDraft {
  return withDatabase(() => host.db.transaction(tx => {
    const draft = loadDraftOrThrow(tx, request.id);
    if (draft.revision !== request.revision) {
      validation('Practice changed in another window; reload before saving');
    }
    const ids = new Set(draft.questions.map(question => question.id));
    const answers = Object.entries(request.answers ?? {});
    if (answers.some(([id]) => !ids.has(id)) || (request.marked_ids ?? []).some(id => !ids.has(id))) {
      validation('Answer does not belong to this practice');
    }
    if (answers.some(([, answer]) => utf8ByteLength(answer) > MAX_ANSWER_BYTES)) {
      validation('Answer exceeds size limit');
    }
    if (request.current_index >= draft.questions.length) validation('Invalid question index');
    draft.answers = Object.fromEntries(answers.filter(([, answer]) => trim(answer) !== ''));
    draft.marked_ids = [...request.marked_ids];
    draft.current_index = request.current_index;
    draft.elapsed_seconds = request.elapsed_seconds;
    draft.revision += 1;
    draft.updated_at = now();
    if (repo.updateDraft(tx, draft, request.revision) === 0) {
      validation('Practice changed in another window; reload before saving');
    }
    return draft;
  }));
}

export function getPractice(host: PracticeServiceHost, id: string, submitted: boolean): PracticeDraft | PracticeAttempt {
  return withDatabase(() => submitted ? loadAttemptOrThrow(host.db, id) : loadDraftOrThrow(host.db, id));
}

export function listPractices(host: PracticeServiceHost, scopeId: string, submitted: boolean,
  offset: number | null): PracticeSummary[] {
  return withDatabase(() => repo.listPracticeSummaries(host.db, scopeId, submitted, offset ?? 0));
}

/** qbank_practice.rs:401-566. Objective answers are graded here; subjective answers queue jobs. */
export function submitDraft(host: PracticeServiceHost, id: string, revision: number | null): SubmittedPractice {
  return withDatabase(() => {
    const outcome = host.db.transaction(tx => {
      const existing = repo.loadAttempt(tx, id);
      if (existing !== null) return { attempt: existing, outcome: null };
      const draft = loadDraftOrThrow(tx, id);
      if (revision !== null && draft.revision !== revision) {
        validation('Practice changed before submission; reload before submitting');
      }
      const submittedAt = now();
      const results: PracticeResult[] = [];
      const masteryStates: unknown[] = [];
      const wrongQuestions: Array<{ questionId: string; examId: string }> = [];
      const correctQuestionIds: string[] = [];
      for (const question of draft.questions) {
        const live = host.questions.getQuestion(tx, question.id);
        const rawAnswer = draft.answers[question.id];
        const answer = rawAnswer !== undefined && trim(rawAnswer) !== '' ? rawAnswer : null;
        const [correct, manual] = answer === null
          ? [false, false] as const
          : checkAnswerCorrectness(answer, question.answer, question.question_type, question.structured_data);
        const isCorrect = answer === null || manual ? null : correct;
        const status = answer === null ? 'unanswered' : manual ? 'pending' : correct ? 'correct' : 'incorrect';
        let submissionId: string | null = null;
        if (answer !== null && live !== null) {
          submissionId = host.questions.insertSubmission(tx, question.id, answer, isCorrect,
            manual ? 'ai' : 'auto', `practice:${draft.id}:${question.id}`,
            practiceQuestionSnapshot(question), materialSnapshotJson(question.materials));
          host.questions.submitAnswer(tx, question.id, answer, isCorrect, manual);
          host.questions.refreshStats(tx, live.exam_id);
          if (isCorrect !== null) {
            const state = requireMastery(host).recordQbankAnswerWithConn(
              tx, submissionId, question.id, question.tags, isCorrect);
            masteryStates.push(state);
            if (!isCorrect) wrongQuestions.push({ questionId: question.id, examId: live.exam_id });
            else correctQuestionIds.push(question.id);
          }
        }
        results.push({
          question_id: question.id, status, is_correct: isCorrect,
          score: isCorrect === null ? null : isCorrect ? 100 : 0,
          feedback: null, error: null, submission_id: submissionId,
          source_available: live !== null, grading_diagnostics: null, grading_drafts: [],
        });
      }
      const elapsedSeconds = draft.duration_seconds !== null && draft.deadline !== null
        ? (() => {
          const parsedDeadline = parseRfc3339(draft.deadline);
          if (parsedDeadline === null) database(chronoRfc3339Error(draft.deadline));
          const deadlineSeconds = Math.floor(parsedDeadline.millis / 1000);
          const remaining = Math.max(0, deadlineSeconds - Math.floor(Date.now() / 1000));
          return Math.max(0, draft.duration_seconds! - remaining);
        })()
        : draft.elapsed_seconds;
      const attempt: PracticeAttempt = {
        id: draft.id, scope_id: draft.scope_id, paper_id: draft.paper_id, title: draft.title,
        mode: draft.mode, questions: draft.questions, answers: draft.answers, marked_ids: draft.marked_ids,
        results, elapsed_seconds: elapsedSeconds, duration_seconds: draft.duration_seconds,
        status: '', origin_device_id: host.deviceId, created_at: draft.created_at, submitted_at: submittedAt,
      };
      refreshStatus(attempt);
      repo.insertAttempt(tx, attempt, host.deviceId);
      for (const result of attempt.results) {
        if (result.status === 'pending') repo.insertJob(tx, attempt.id, result.question_id, submittedAt);
      }
      repo.deleteDraft(tx, id);
      return {
        attempt,
        outcome: { wrongQuestions, correctQuestionIds, masteryStates } as PracticeSyncOutcome,
      };
    });
    if (outcome.outcome !== null) syncAfterSubmit(host, outcome.outcome);
    return outcome;
  });
}

function syncAfterSubmit(host: PracticeServiceHost, outcome: PracticeSyncOutcome): void {
  for (const wrong of outcome.wrongQuestions) {
    ensureReviewPlan(host, wrong.questionId, wrong.examId, {
      logSuccess: false, failureLabel: 'Failed to auto-create review plan for',
    });
  }
  for (const questionId of outcome.correctQuestionIds) advanceDueReviewPlan(host, questionId);
  const mastery = host.mastery();
  if (mastery === undefined) return;
  for (const state of outcome.masteryStates) {
    try {
      mastery.syncLearnerProfile(state);
    } catch (error) {
      host.log?.warn(`[qbank] practice mastery sync failed: ${errorText(error)}`);
    }
  }
}

export function deletePractice(host: PracticeServiceHost, id: string, submitted: boolean): void {
  withDatabase(() => {
    if (submitted) repo.deleteAttempt(host.db, id, now());
    else repo.deleteDraft(host.db, id);
  });
}

export function listPapers(host: PracticeServiceHost, examId: string): GeneratedPaper[] {
  return withDatabase(() => repo.listPapers(host.db, examId));
}

export function getPaper(host: PracticeServiceHost, id: string): GeneratedPaper {
  return withDatabase(() => {
    const paper = repo.loadPaper(host.db, id);
    if (paper === null) notFound('Paper not found');
    return paper;
  });
}

export function updatePaper(host: PracticeServiceHost, id: string, title: string | null, deleted: boolean): void {
  withDatabase(() => host.db.transaction(tx => {
    const paper = repo.loadPaper(tx, id);
    if (paper === null) notFound('Paper not found');
    if (title !== null) {
      const trimmed = trim(title);
      if (trimmed === '' || [...trimmed].length > 200) validation('Invalid paper title');
      paper.title = trimmed;
      paper.config.title = trimmed;
    }
    repo.updatePaper(tx, id, paper, deleted, now());
  }));
}

function normalizePaperConfig(config: PaperConfig__De): PaperConfig {
  return {
    title: config.title,
    type_selection: config.type_selection ?? {},
    difficulty_filter: config.difficulty_filter ?? null,
    tags_filter: config.tags_filter ?? null,
    shuffle: config.shuffle,
    include_answers: config.include_answers,
    include_explanations: config.include_explanations,
    export_format: normalizeExportFormat(config.export_format),
  };
}
function normalizeExportFormat(value: PaperConfig__De['export_format']): PaperConfig['export_format'] {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    for (const key of ['preview', 'pdf', 'word', 'markdown'] as const) {
      if (key in value) return key;
    }
  }
  return 'preview';
}

export function generatePaper(host: PracticeServiceHost, examId: string, rawConfig: PaperConfig__De): GeneratedPaper {
  return withDatabase(() => {
    const config = normalizePaperConfig(rawConfig);
    if (trim(config.title) === '' || [...config.title].length > 200) validation('试卷标题须为 1–200 字符');
    const totalRequested = Object.values(config.type_selection).reduce((sum, count) => sum + count, 0);
    if (totalRequested > 500) validation('每份试卷最多 500 题');

    const filters: import('../api.ts').QuestionFilters = {};
    if (config.difficulty_filter !== null) filters.difficulty = config.difficulty_filter.map(difficultyFrom);
    if (config.tags_filter !== null) filters.tags = config.tags_filter;
    let selected: Question[] = [];
    const typeEntries = Object.entries(config.type_selection);
    if (typeEntries.length > 0) {
      for (const [type, count] of typeEntries) {
        const typeFilters = { ...filters, question_type: [type] };
        const exclude = selected.map(question => question.id);
        const found = host.questions.randomQuestions(host.db, examId, vfsFilters(typeFilters as never), exclude, count);
        if (found.length !== count) {
          validation(`题型 ${type} 在当前难度和标签筛选下仅有 ${found.length} 题，需要 ${count} 题`);
        }
        selected.push(...found);
      }
    } else {
      selected = host.questions.randomQuestions(host.db, examId, vfsFilters(filters), [], 500);
    }
    if (selected.length === 0) validation('无法根据配置选出题目');
    if (config.shuffle) shuffle(selected);
    const paper: GeneratedPaper = {
      id: crypto.randomUUID(), title: config.title, exam_id: examId, questions: selected,
      total_score: selected.length, config, created_at: now(), export_path: null,
    };
    repo.savePaper(host.db, paper, host.deviceId);
    return paper;
  });
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
}

export interface ManualGradeOutcome {
  attempt: PracticeAttempt;
  masteryState: unknown | null;
  wrongExamId: string | null;
}

/** qbank_practice.rs:1060-1122 */
export function gradePracticeManually(host: PracticeServiceHost, id: string, questionId: string,
  correct: boolean): ManualGradeOutcome {
  return withDatabase(() => {
    const result = host.db.transaction(tx => {
      const attempt = loadAttemptOrThrow(tx, id);
      const target = attempt.results.find(item => item.question_id === questionId);
      if (target === undefined) notFound('Result not found');
      if (target.status === 'unanswered') validation('Cannot grade an unanswered question');
      let masteryState: unknown | null = null;
      let wrongExamId: string | null = null;
      if (target.submission_id !== null) {
        const live = host.questions.getQuestion(tx, questionId);
        const submission = host.questions.getSubmissionById(tx, target.submission_id);
        if (live === null || submission === null) {
          target.source_available = false;
        } else {
          const verdict = applyVerdictForPractice(host, tx, live, submission, correct, 'manual');
          masteryState = verdict.masteryState;
          if (verdict.needsReviewPlan) wrongExamId = live.exam_id;
        }
      }
      target.is_correct = correct;
      target.score = correct ? 100 : 0;
      target.status = correct ? 'correct' : 'incorrect';
      target.error = null;
      repo.finishJob(tx, id, questionId, now());
      refreshStatus(attempt);
      if (repo.persistAttempt(tx, attempt, now()) === 0) notFound('Practice attempt not found');
      return { attempt, masteryState, wrongExamId };
    });
    syncManual(host, result.masteryState);
    if (result.wrongExamId !== null) {
      ensureReviewPlan(host, questionId, result.wrongExamId, {
        logSuccess: false, failureLabel: 'Failed to auto-create review plan for',
      });
    }
    return result;
  });
}

export interface GradingFailureInput {
  error: { message: string };
  feedback: string;
  diagnostics: import('../api.ts').GradingDiagnostics | null;
}

/** qbank_practice.rs:1013-1025 */
export function recordGradingFailure(result: import('../api.ts').PracticeResult,
  failure: GradingFailureInput): void {
  result.status = 'failed';
  result.is_correct = null;
  result.score = null;
  result.error = failure.error.message;
  result.grading_diagnostics = failure.diagnostics;
  result.grading_drafts.push({
    feedback: failure.feedback, error: failure.error.message,
    diagnostics: failure.diagnostics, created_at: now(),
  });
}

/** qbank_practice.rs:960-1011: verdict writes roll back to a savepoint on failure. */
export function applyPracticeVerdict(host: PracticeServiceHost, tx: import('../../../platform/storage/api.ts').TransactionScope,
  questionId: string, submissionId: string | null, correct: boolean): {
    outcome: { masteryState: unknown | null; needsReviewPlan: boolean } | null;
    sourceAvailable: boolean;
  } {
  return tx.savepoint(sp => {
    const live = host.questions.getQuestion(sp, questionId);
    if (live === null || submissionId === null) return { outcome: null, sourceAvailable: false };
    const submission = host.questions.getSubmissionById(sp, submissionId);
    if (submission === null) return { outcome: null, sourceAvailable: false };
    return {
      outcome: applyVerdictForPractice(host, sp, live, submission, correct, 'ai'),
      sourceAvailable: true,
    };
  });
}

function applyVerdictForPractice(host: PracticeServiceHost, tx: SqlExecutor, question: Question,
  submission: import('../api.ts').AnswerSubmission, correct: boolean, method: string): {
    masteryState: unknown | null; needsReviewPlan: boolean;
  } {
  const outcome = host.questions.applySubmissionVerdict(tx, question.id, submission.id,
    correct, method, now());
  if (!outcome.changed) return { masteryState: null, needsReviewPlan: false };
  const mastery = requireMastery(host);
  const masteryState = submission.is_correct === null
    ? mastery.recordQbankAnswerWithConn(tx, submission.id, question.id, question.tags, correct)
    : mastery.recordQbankVerdictCorrectionWithConn(tx, submission.id, question.id, question.tags, correct);
  return { masteryState, needsReviewPlan: !correct };
}

function syncManual(host: PracticeServiceHost, state: unknown | null): void {
  if (state === null) return;
  const mastery = host.mastery();
  if (mastery === undefined) return;
  try {
    mastery.syncLearnerProfile(state);
  } catch (error) {
    host.log?.warn(`[qbank] practice mastery sync failed: ${errorText(error)}`);
  }
}

export function retryPracticeGrading(host: PracticeServiceHost, id: string, questionId: string): PracticeAttempt {
  return withDatabase(() => host.db.transaction(tx => {
    const attempt = loadAttemptOrThrow(tx, id);
    if (attempt.origin_device_id !== host.deviceId) validation('请在发起练习的设备上重试 AI 批改');
    const target = attempt.results.find(item => item.question_id === questionId);
    if (target === undefined) notFound('Result not found');
    if (target.status !== 'failed') validation('Only failed grading can be retried');
    target.status = 'pending';
    target.error = null;
    repo.queueJob(tx, id, questionId, now());
    refreshStatus(attempt);
    if (repo.persistAttempt(tx, attempt, now()) === 0) notFound('Practice attempt not found');
    return attempt;
  }));
}

export function resumeDeadlineDrafts(host: PracticeServiceHost): PracticeDraft[] {
  return withDatabase(() => repo.draftDeadlineDocuments(host.db));
}
