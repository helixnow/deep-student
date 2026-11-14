/**
 * 练习主观题批改队列（qbank_practice.rs:735-958 `run_grading_queue`）。
 *
 * 启动时把重启残留的 running 重置为 queued，然后按 Rust 的 (updated_at, id) 顺序取任务：
 * 读冻结的题目/答案快照 → 取图 → 调 L02 llmStreaming 批改 → 在事务里应用判定、刷新状态、落 job 状态。
 * 事件与掌握度同步都在事务提交之后。
 */
import { AppError } from '../../../platform/errors/api.ts';
import { rfc3339Now } from '../../../platform/storage/time.ts';
import type {
  GradingDiagnostics, PracticeAttempt, PracticeResult, Question, Verdict,
} from '../api.ts';
import { GradingContext } from './grading-context.ts';
import { parseImageAnswerEnvelope, type ImageAnswerPayload } from './image-answer.ts';
import {
  applyPracticeVerdict, recordGradingFailure, refreshStatus,
  type PracticeServiceHost,
} from './practice-service.ts';
import { QbankServiceError } from './question-service.ts';
import * as repo from '../repository/practice.ts';

export interface PracticeGradingRequest {
  readonly jobId: string;
  readonly attemptId: string;
  readonly question: Question;
  readonly answer: string;
  readonly context: GradingContext;
  readonly imageAnswer: ImageAnswerPayload | null;
}

export interface PracticeGradingResponse {
  readonly verdict: Verdict;
  readonly score: number | null;
  readonly feedback: string;
  readonly diagnostics: GradingDiagnostics | null;
}

/** 批改队列的端口；生产实现由 `llm-grader.ts` 驱动 L02 `llmStreaming`。 */
export interface PracticeGrader {
  grade(request: PracticeGradingRequest): Promise<PracticeGradingResponse>;
}

export class PracticeGradingFailure extends Error {
  readonly appError: AppError;
  readonly feedback: string;
  readonly diagnostics: GradingDiagnostics | null;

  constructor(appError: AppError, feedback: string,
    diagnostics: GradingDiagnostics | null) {
    super(appError.message);
    this.appError = appError;
    this.feedback = feedback;
    this.diagnostics = diagnostics;
    this.name = 'PracticeGradingFailure';
  }
}

export interface ReviewPlanPort {
  getOrCreatePlan(questionId: string, examId: string): unknown;
  getPlanByQuestion(questionId: string): { id: string; next_review_date: string } | null;
  advanceFromPractice(planId: string): unknown;
}

export interface PracticeGradingHost extends PracticeServiceHost {
  readonly reviewPlan?: ReviewPlanPort;
  emitPracticeUpdated(attemptId: string): void;
}

interface AppliedOutcome {
  masteryState: unknown | null;
  needsReviewPlan: boolean;
}

interface QueueStep {
  attemptId: string;
  outcome: AppliedOutcome | null;
}

function now(): string {
  return rfc3339Now();
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error
    && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

function diagnosticsOf(failure: PracticeGradingFailure): GradingDiagnostics | null {
  return failure.diagnostics;
}

function withPersistenceError(diagnostics: GradingDiagnostics | null): GradingDiagnostics | null {
  if (diagnostics === null) return null;
  return { ...diagnostics, status: 'persistence_error', error_message: diagnostics.error_message };
}

export async function runGradingQueue(host: PracticeGradingHost,
  grader: PracticeGrader): Promise<void> {
  repo.resetRunningJobs(host.db);
  for (;;) {
    const job = repo.nextQueuedJob(host.db, host.deviceId);
    if (job === null) return;
    const attempt = repo.loadAttempt(host.db, job.attempt_id);
    if (attempt === null) {
      host.db.transaction(tx => repo.markJobDone(tx, job.id, now()));
      continue;
    }
    const question = attempt.questions.find(item => item.id === job.question_id);
    if (question === undefined) validation('Missing practice snapshot');
    const answer = attempt.answers[job.question_id];
    if (answer === undefined) validation('Missing practice answer');

    repo.markJobRunning(host.db, job.id, now());
    const contextResult = (() => {
      try {
        const context = GradingContext.fromQuestion(question);
        context.materials = question.materials ?? [];
        const result = attempt.results.find(item => item.question_id === job.question_id);
        if (result !== undefined && result.submission_id !== null) {
          const snapshot = host.questions.getSubmissionSnapshot(host.db, result.submission_id);
          context.applySnapshots(snapshot?.question_snapshot_json ?? null,
            snapshot?.material_snapshot_json ?? null);
        }
        return { context, failure: null };
      } catch (error) {
        return {
          context: null,
          failure: new PracticeGradingFailure(AppError.llm(errorText(error)), '', null),
        };
      }
    })();
    const imageAnswer = parseImageAnswerEnvelope(answer);

    const response = contextResult.failure !== null
      ? { ok: false as const, failure: contextResult.failure }
      : await grade(grader, {
        jobId: job.id, attemptId: job.attempt_id, question, answer,
        context: contextResult.context!, imageAnswer,
      });

    const step = host.db.transaction(tx => {
      const current = repo.loadAttempt(tx, job.attempt_id);
      if (current === null) {
        repo.markJobDone(tx, job.id, now());
        return null;
      }
      const target = current.results.find(item => item.question_id === job.question_id);
      if (target === undefined) validation('Missing practice result');
      if (target.status !== 'pending') {
        repo.markJobDone(tx, job.id, now());
        return null;
      }
      let outcome: AppliedOutcome | null = null;
      if (response.ok) {
        let applied: { outcome: AppliedOutcome | null; sourceAvailable: boolean };
        try {
          applied = applyPracticeVerdict(host, tx, job.question_id, target.submission_id,
            response.value.verdict === 'correct');
        } catch (error) {
          const failure = new PracticeGradingFailure(
            AppError.llm(errorText(error)), response.value.feedback,
            withPersistenceError(response.value.diagnostics));
          recordGradingFailure(target, {
            error: { message: failure.appError.message },
            feedback: failure.feedback,
            diagnostics: diagnosticsOf(failure),
          });
          logFailure(host, job.id, target);
          repo.markJobFailed(tx, job.id, failure.appError.message, now());
          refreshStatus(current);
          if (repo.persistAttempt(tx, current, now()) === 0) validation('Practice attempt not found');
          return { attemptId: current.id, outcome: null };
        }
        outcome = applied.outcome;
        target.source_available = applied.sourceAvailable;
        const correct = response.value.verdict === 'correct';
        target.status = response.value.verdict === 'correct' ? 'correct'
          : response.value.verdict === 'partial' ? 'partial' : 'incorrect';
        target.is_correct = correct;
        target.score = response.value.score;
        target.feedback = response.value.feedback;
        target.grading_diagnostics = response.value.diagnostics;
        target.error = null;
        repo.markJobDone(tx, job.id, now());
      } else {
        recordGradingFailure(target, {
          error: { message: response.failure.appError.message },
          feedback: response.failure.feedback,
          diagnostics: response.failure.diagnostics,
        });
        logFailure(host, job.id, target);
        repo.markJobFailed(tx, job.id, target.error ?? response.failure.appError.message, now());
      }
      refreshStatus(current);
      if (repo.persistAttempt(tx, current, now()) === 0) validation('Practice attempt not found');
      return { attemptId: current.id, outcome };
    });

    if (step === null) continue;
    applyPostCommit(host, step.outcome, job.question_id, question.exam_id);
    host.emitPracticeUpdated(step.attemptId);
  }
}

type GradeResult =
  | { ok: true; value: PracticeGradingResponse }
  | { ok: false; failure: PracticeGradingFailure };

async function grade(grader: PracticeGrader, request: PracticeGradingRequest): Promise<GradeResult> {
  try {
    return { ok: true, value: await grader.grade(request) };
  } catch (error) {
    if (error instanceof PracticeGradingFailure) return { ok: false, failure: error };
    return {
      ok: false,
      failure: new PracticeGradingFailure(AppError.llm(errorText(error)), '', null),
    };
  }
}

function logFailure(host: PracticeGradingHost, jobId: string, result: PracticeResult): void {
  host.log?.warn(`[PracticeGrading] job=${jobId} error=${result.error ?? ''} diagnostics=`
    + `${JSON.stringify(result.grading_diagnostics)}`);
}

function applyPostCommit(host: PracticeGradingHost, outcome: AppliedOutcome | null,
  questionId: string, examId: string): void {
  if (outcome === null) return;
  if (outcome.needsReviewPlan) {
    try {
      host.reviewPlan?.getOrCreatePlan(questionId, examId);
    } catch (error) {
      host.log?.warn(`[qbank] review plan creation failed: ${errorText(error)}`);
    }
  }
  if (outcome.masteryState !== null) {
    const mastery = host.mastery();
    if (mastery !== undefined) {
      try {
        mastery.syncLearnerProfile(outcome.masteryState);
      } catch (error) {
        host.log?.warn(`[qbank] practice mastery sync failed: ${errorText(error)}`);
      }
    }
  }
}

/** 串行执行器：Rust 用静态 GRADING_LOCK 保证同一时刻只有一个队列。 */
export class PracticeGradingQueue {
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly host: PracticeGradingHost;
  private readonly grader: PracticeGrader;

  constructor(host: PracticeGradingHost,
    grader: PracticeGrader) {
    this.host = host;
    this.grader = grader;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run().catch(error => {
        this.host.log?.error(`Practice grading queue: ${errorText(error)}`);
      });
    }, 0);
    this.timer.unref?.();
  }

  run(): Promise<void> {
    const task = this.tail.then(() => runGradingQueue(this.host, this.grader));
    this.tail = task.catch(() => undefined);
    return task;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

