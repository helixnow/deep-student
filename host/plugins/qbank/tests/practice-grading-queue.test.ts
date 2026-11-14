import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMigratedStorage } from './support/storage.ts';
import { AppError } from '../../../platform/errors/api.ts';
import * as questions from '../repository/questions.ts';
// boundary-allow cross-plugin-impl: L11 真实题目仓储（D1 唯一写入方）
import { QuestionRepo } from '../../vfs-repos/repository/questions.ts';
import { vfsCreateParams } from '../src/question-repository-adapter.ts';
import * as repo from '../repository/practice.ts';
import * as practice from '../src/practice-service.ts';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import { llmPracticeGrader } from '../src/llm-grader.ts';
import {
  PracticeGradingFailure, runGradingQueue, type PracticeGrader, type PracticeGradingHost,
  type PracticeGradingRequest, type PracticeGradingResponse,
} from '../src/practice-grading-queue.ts';
import type {
  CreateQuestionParams, GradingDiagnostics, PracticeAttempt, Question,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-grading-queue-');
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  const masteryStates: unknown[] = [];
  const questionRepo = new QuestionRepo();
  const host: PracticeGradingHost = {
    db,
    questions: questionRepo,
    deviceId: 'qbank-test-device',
    mastery: () => ({
      recordQbankAnswerWithConn: () => ({ conceptKey: 'k1' }),
      recordQbankVerdictCorrectionWithConn: () => ({ conceptKey: 'k1' }),
      syncLearnerProfile: state => { masteryStates.push(state); },
    }),
    log: { warn: () => undefined, error: () => undefined, debug: () => undefined },
    emitPracticeUpdated: () => undefined,
  };
  return {
    db,
    host,
    questions: questionRepo,
    masteryStates,
    async dispose() {
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function params(content: string): CreateQuestionParams {
  return {
    exam_id: 'exam_1', content, answer: null, options: null,
    question_type: 'essay', difficulty: null, tags: ['essay'], source_type: 'manual',
  };
}

async function pendingAttempt(f: Awaited<ReturnType<typeof fixture>>, id: string,
  content: string): Promise<{ attempt: PracticeAttempt; question: Question }> {
  const question = f.questions.createQuestion(f.db, vfsCreateParams(params(content)));
  const draft = practice.createDraft(f.host, {
    id, scope_id: 'exam_1', title: id, mode: 'sequential', question_ids: [question.id],
  });
  const saved = practice.saveDraft(f.host, {
    id, revision: draft.revision, answers: { [question.id]: '我的论述' },
    marked_ids: [], current_index: 0, elapsed_seconds: 3,
  });
  return { attempt: practice.submitDraft(f.host, id, saved.revision).attempt, question };
}

function diagnostics(): GradingDiagnostics {
  return {
    status: 'truncated', model: 'test', model_config_id: 'cfg', max_output_tokens: 128,
    finish_reason: 'length', usage: { completion_tokens: 128 }, response_chars: 7,
    reasoning_chars: 0, http_status: 200, error_message: null,
  };
}

function success(request: PracticeGradingRequest): PracticeGradingResponse {
  expect(request.context.content).toContain('论述');
  expect(request.answer).toBe('我的论述');
  return { verdict: 'correct', score: 100, feedback: '回答正确', diagnostics: null };
}

describe('qbank_practice.rs::run_grading_queue', () => {
  it('run_grading_queue_applies_verdict_and_marks_job_done_after_commit', async () => {
    const f = await fixture();
    try {
      const { attempt, question } = await pendingAttempt(f, 'practice_1', '第一道论述题');
      const events: string[] = [];
      f.host.emitPracticeUpdated = id => { events.push(id); };
      const seen: PracticeGradingRequest[] = [];
      const grader: PracticeGrader = {
        grade: async request => {
          seen.push(request);
          return success(request);
        },
      };

      await runGradingQueue(f.host, grader);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ jobId: `${attempt.id}:${question.id}`, attemptId: attempt.id });
      expect(repo.nextQueuedJob(f.db, 'qbank-test-device')).toBeNull();
      expect(f.db.pluck<string>('SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1',
        [attempt.id])).toBe('done');
      const loaded = repo.loadAttempt(f.db, attempt.id)!;
      expect(loaded.status).toBe('completed');
      expect(loaded.results[0]).toMatchObject({
        status: 'correct', is_correct: true, score: 100, feedback: '回答正确',
        error: null, source_available: true,
      });
      expect(f.db.pluck<number>('SELECT is_correct FROM answer_submissions WHERE id = ?1',
        [loaded.results[0]!.submission_id!])).toBe(1);
      expect(f.masteryStates).toHaveLength(1);
      expect(events).toEqual([attempt.id]);
    } finally { await f.dispose(); }
  });

  it('run_grading_queue_records_failure_draft_and_keeps_submission_ungraded', async () => {
    const f = await fixture();
    try {
      const { attempt } = await pendingAttempt(f, 'practice_1', '第二道论述题');
      const grader: PracticeGrader = {
        grade: async () => {
          throw new PracticeGradingFailure(AppError.llm('truncated'), '半截反馈', diagnostics());
        },
      };

      await runGradingQueue(f.host, grader);

      const loaded = repo.loadAttempt(f.db, attempt.id)!;
      expect(loaded.status).toBe('needs_review');
      expect(loaded.results[0]).toMatchObject({
        status: 'failed', is_correct: null, score: null, feedback: null, error: 'truncated',
        grading_diagnostics: expect.objectContaining({ status: 'truncated', finish_reason: 'length' }),
      });
      expect(loaded.results[0]!.grading_drafts).toEqual([expect.objectContaining({
        feedback: '半截反馈', error: 'truncated',
        diagnostics: expect.objectContaining({ finish_reason: 'length' }),
      })]);
      expect(f.db.pluck<string>('SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1',
        [attempt.id])).toBe('failed');
      expect(f.db.pluck<number | null>('SELECT is_correct FROM answer_submissions WHERE id = ?1',
        [loaded.results[0]!.submission_id!])).toBeNull();
      expect(f.masteryStates).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('run_grading_queue_resets_running_jobs_and_processes_in_rust_order', async () => {
    const f = await fixture();
    try {
      const first = await pendingAttempt(f, 'practice_1', '第一道论述题');
      const second = await pendingAttempt(f, 'practice_2', '第二道论述题');
      f.db.run("UPDATE qbank_practice_jobs SET status = 'running', updated_at = '2026-01-01T00:00:01+00:00' WHERE attempt_id = ?1",
        [second.attempt.id]);
      f.db.run("UPDATE qbank_practice_jobs SET updated_at = '2026-01-01T00:00:00+00:00' WHERE attempt_id = ?1",
        [first.attempt.id]);
      const order: string[] = [];
      const grader: PracticeGrader = {
        grade: async request => {
          order.push(request.attemptId);
          return success(request);
        },
      };

      await runGradingQueue(f.host, grader);

      expect(order).toEqual([first.attempt.id, second.attempt.id]);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_practice_jobs WHERE status = 'done'")).toBe(2);
    } finally { await f.dispose(); }
  });

  it('run_grading_queue_does_not_commit_a_verdict_delivered_before_cancel', async () => {
    const f = await fixture();
    try {
      const { attempt } = await pendingAttempt(f, 'practice_1', '取消前的完整判定');
      const config = {
        id: 'cfg-test', model: 'test-reasoner', apiKey: 'key', isMultimodal: false,
        maxOutputTokens: 1024, maxTokensLimit: null, isReasoning: false,
      } as unknown as ApiConfig;
      const llm = {
        consumePendingCancel: async () => false,
        subscribeCancelStream: async () => new AbortController().signal,
        clearCancelStream: async () => undefined,
        getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
        getModel2Config: async () => config,
        decryptApiKey: async (key: string) => key,
      } as unknown as LLMManager;
      const streaming = {
        async singleShotCompletion(_config: ApiConfig, _body: unknown, _key: string | null,
          _session: string | null, _context: string, _opts: unknown,
          onDelta?: (delta: string) => boolean) {
          // 模型先给出完整 verdict，随后连接被取消；Rust stream.rs:151-155 要求传播取消失败。
          onDelta?.('反馈 <verdict>correct</verdict> <score value="100" />');
          throw AppError.llm('AI评判(test-reasoner) 请求已取消');
        },
      } as unknown as LlmStreamingService;
      const grader = llmPracticeGrader({
        llm: () => llm, streaming: () => streaming, images: () => undefined,
      });

      await runGradingQueue(f.host, grader);

      const loaded = repo.loadAttempt(f.db, attempt.id)!;
      expect(loaded.results[0]).toMatchObject({
        status: 'failed', is_correct: null, score: null, feedback: null,
      });
      expect(f.db.pluck<string>('SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1',
        [attempt.id])).toBe('failed');
      expect(f.db.pluck<number | null>('SELECT is_correct FROM answer_submissions WHERE id = ?1',
        [loaded.results[0]!.submission_id!])).toBeNull();
      expect(f.masteryStates).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('run_grading_queue_does_not_overwrite_a_verdict_that_won_during_grading', async () => {
    const f = await fixture();
    try {
      const { attempt, question } = await pendingAttempt(f, 'practice_1', '用户抢先自评');
      const manual = repo.loadAttempt(f.db, attempt.id)!;
      manual.results[0]!.status = 'correct';
      manual.results[0]!.is_correct = true;
      manual.results[0]!.score = 100;
      manual.status = 'completed';
      expect(repo.persistAttempt(f.db, manual, NOW)).toBe(1);
      const grader: PracticeGrader = {
        grade: async request => {
          expect(request.question.id).toBe(question.id);
          return { verdict: 'incorrect', score: 0, feedback: '模型判定错误', diagnostics: null };
        },
      };

      await runGradingQueue(f.host, grader);

      const loaded = repo.loadAttempt(f.db, attempt.id)!;
      expect(loaded.status).toBe('completed');
      expect(loaded.results[0]).toMatchObject({
        status: 'correct', is_correct: true, score: 100, feedback: null, error: null,
      });
      expect(f.db.pluck<string>('SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1',
        [attempt.id])).toBe('done');
    } finally { await f.dispose(); }
  });
});
