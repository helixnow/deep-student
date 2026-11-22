import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { CreateQuestionParams, Question, SubmitAnswerResult } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

interface ReviewPlanCall {
  kind: 'getOrCreate' | 'getByQuestion' | 'advance' | 'lapse';
  questionId?: string;
  examId?: string;
  planId?: string;
}

async function fixture(options: { mastery?: boolean } = { mastery: true }) {
  const { storage, base } = await createMigratedStorage('qbank-learning-loop-');
  const calls: ReviewPlanCall[] = [];
  let plan: { id: string; next_review_date: string; status?: string } | null = null;
  const reviewPlan = {
    getOrCreatePlan(questionId: string, examId: string) {
      calls.push({ kind: 'getOrCreate', questionId, examId });
      return plan ?? { id: 'plan_1', status: 'new', next_review_date: today() };
    },
    getPlanByQuestion(questionId: string) {
      calls.push({ kind: 'getByQuestion', questionId });
      return plan;
    },
    advanceFromPractice(planId: string) {
      calls.push({ kind: 'advance', planId });
      return { plan_id: planId };
    },
    lapseFromPractice(planId: string) {
      calls.push({ kind: 'lapse', planId });
      return { plan_id: planId };
    },
  };
  const mastery = {
    recordQbankAnswerWithConn: () => ({}),
    recordQbankVerdictCorrectionWithConn: () => ({}),
    syncLearnerProfile: () => undefined,
  };
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      reviewPlan,
      ...(options.mastery === false ? {} : { mastery }),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage, calls,
    setPlan(value: { id: string; next_review_date: string; status?: string } | null) { plan = value; },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function params(content = '1+1=?'): CreateQuestionParams {
  return {
    exam_id: 'exam_1', content, answer: 'A',
    options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }],
    question_type: 'single_choice', difficulty: 'easy', tags: ['算术'], source_type: 'manual',
  };
}

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

describe('question_bank_service.rs / qbank_practice.rs learning loop', () => {
  it('wrong_answer_creates_review_plan_and_correct_answer_advances_due_plan', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const wrong = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', is_correct_override: null, client_request_id: null },
      }) as SubmitAnswerResult;
      expect(wrong.is_correct).toBe(false);
      expect(f.calls).toContainEqual({ kind: 'getOrCreate', questionId: question.id, examId: 'exam_1' });

      f.setPlan({ id: 'plan_due', next_review_date: today() });
      f.calls.length = 0;
      const correct = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'A', is_correct_override: null, client_request_id: null },
      }) as SubmitAnswerResult;
      expect(correct.is_correct).toBe(true);
      expect(f.calls).toContainEqual({ kind: 'getByQuestion', questionId: question.id });
      expect(f.calls).toContainEqual({ kind: 'advance', planId: 'plan_due' });
      expect(f.calls.some(call => call.kind === 'getOrCreate')).toBe(false);
    } finally { await f.dispose(); }
  });

  it('correct_answer_does_not_advance_a_plan_that_is_not_due', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      f.setPlan({ id: 'plan_future', next_review_date: '2999-01-01' });
      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'A', is_correct_override: null, client_request_id: null },
      });
      expect(f.calls).toContainEqual({ kind: 'getByQuestion', questionId: question.id });
      expect(f.calls.some(call => call.kind === 'advance')).toBe(false);
    } finally { await f.dispose(); }
  });

  it('regrade_to_wrong_creates_review_plan', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const pending = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'A', is_correct_override: null, client_request_id: null },
      }) as SubmitAnswerResult;
      f.calls.length = 0;
      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'A', is_correct_override: false,
          regrade_submission_id: pending.submission_id },
      });
      expect(f.calls).toContainEqual({ kind: 'getOrCreate', questionId: question.id, examId: 'exam_1' });
    } finally { await f.dispose(); }
  });

  it('objective_submit_without_mastery_service_rolls_back_the_answer', async () => {
    const f = await fixture({ mastery: false });
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      await expect(f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'A', is_correct_override: null, client_request_id: null },
      })).rejects.toMatchObject({
        error_type: 'Configuration',
        message: '掌握度服务不可用：review 插件未提供 mastery',
      });
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM answer_submissions')).toBe(0);
      expect(f.db.get<{ attempt_count: number }>(
        'SELECT attempt_count FROM questions WHERE id = ?1', [question.id])!.attempt_count).toBe(0);
    } finally { await f.dispose(); }
  });

  it('wrong_answer_on_graduated_or_future_plan_triggers_lapse', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      f.setPlan({ id: 'plan_grad', next_review_date: '2999-01-01', status: 'graduated' });
      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', is_correct_override: null, client_request_id: null },
      });
      expect(f.calls).toContainEqual({ kind: 'getOrCreate', questionId: question.id, examId: 'exam_1' });
      expect(f.calls).toContainEqual({ kind: 'lapse', planId: 'plan_grad' });
    } finally { await f.dispose(); }
  });

  it('subjective_regrade_and_manual_practice_correct_advance_due_plan', async () => {
    const f = await fixture();
    try {
      const subjective = await f.host.invoke('qbank_create_question', {
        params: {
          exam_id: 'exam_1', content: '证明勾股定理', answer: 'a^2+b^2=c^2',
          question_type: 'short_answer', difficulty: 'medium', tags: ['几何'], source_type: 'manual',
        },
      }) as Question;
      f.setPlan({ id: 'plan_subj', next_review_date: today(), status: 'reviewing' });
      const pending = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: subjective.id, user_answer: '面积法证明', is_correct_override: null, client_request_id: null },
      }) as SubmitAnswerResult;
      expect(pending.is_correct).toBeNull();
      f.calls.length = 0;

      // Regrade pending subjective submission to correct -> advances due FSRS plan
      await f.host.invoke('qbank_submit_answer', {
        request: {
          question_id: subjective.id, user_answer: '面积法证明', is_correct_override: true,
          regrade_submission_id: pending.submission_id,
        },
      });
      expect(f.calls).toContainEqual({ kind: 'advance', planId: 'plan_subj' });

      // Manual grading in batch practice also advances due FSRS plan
      const draft = await f.host.invoke('qbank_create_practice', {
        request: {
          id: 'p_subj_1', scope_id: 'exam_1', title: '主观题练习',
          mode: 'sequential', question_ids: [subjective.id],
        },
      }) as { id: string; revision: number };
      const saved = await f.host.invoke('qbank_save_practice', {
        request: {
          id: draft.id, revision: draft.revision,
          answers: { [subjective.id]: '再次证明' }, marked_ids: [],
          current_index: 0, elapsed_seconds: 10,
        },
      }) as { id: string; revision: number };
      await f.host.invoke('qbank_submit_practice', { id: saved.id, revision: saved.revision });
      f.calls.length = 0;
      await f.host.invoke('qbank_grade_practice_manually', {
        id: saved.id, questionId: subjective.id, correct: true,
      });
      expect(f.calls).toContainEqual({ kind: 'advance', planId: 'plan_subj' });
    } finally { await f.dispose(); }
  });
});
