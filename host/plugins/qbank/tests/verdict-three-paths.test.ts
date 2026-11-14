import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { fakeMasteryService } from './support/mastery.ts';
import type {
  CreateQuestionParams, DailyPracticeResult, DailyProgressSnapshot, Question, SubmitAnswerResult,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const QUESTION_TAGS = ['physics'];

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-verdict-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...fakeMasteryService(),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', 'verdict three paths', 'completed', 'verdict', '{}', '{"pages":[]}', ?1, ?1)`,
  [NOW]);

  function params(label: string, overrides: Partial<CreateQuestionParams> = {}): CreateQuestionParams {
    return {
      exam_id: 'exam_1', card_id: label, question_label: label,
      content: `${label}: explain`, answer: null, options: null, explanation: null,
      question_type: 'short_answer', difficulty: null, tags: QUESTION_TAGS, source_type: 'manual',
      ...overrides,
    };
  }

  async function create(label: string, overrides: Partial<CreateQuestionParams> = {}): Promise<Question> {
    return host.invoke('qbank_create_question', { params: params(label, overrides) }) as Promise<Question>;
  }

  async function subjective(label: string): Promise<Question> {
    return create(label, { answer: 'Rayleigh scattering favors shorter wavelengths.' });
  }

  async function choice(label: string): Promise<Question> {
    return create(label, { question_type: 'single_choice', answer: 'A' });
  }

  async function submit(questionId: string, userAnswer: string, override: boolean | null = null,
    regradeSubmissionId: string | null = null): Promise<SubmitAnswerResult> {
    return host.invoke('qbank_submit_answer', {
      request: {
        question_id: questionId, user_answer: userAnswer, is_correct_override: override,
        client_request_id: null, regrade_submission_id: regradeSubmissionId,
      },
    }) as Promise<SubmitAnswerResult>;
  }

  async function reload(questionId: string): Promise<Question> {
    return host.invoke('qbank_get_question', { questionId }) as Promise<Question>;
  }

  async function daily(examId: string, count: number): Promise<DailyPracticeResult> {
    return host.invoke('qbank_get_daily_practice', {
      request: { exam_id: examId, count },
    }) as Promise<DailyPracticeResult>;
  }

  function submissionCount(questionId: string): number {
    return db.pluck<number>('SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1',
      [questionId])!;
  }

  function rowsync(submissionId: string): { updated_at: string | null; local_version: number } {
    return db.get<{ updated_at: string | null; local_version: number }>(
      `SELECT updated_at, COALESCE(local_version, 0) AS local_version
       FROM answer_submissions WHERE id = ?1`, [submissionId])!;
  }

  return {
    host, db, create, subjective, choice, submit, reload, daily, submissionCount, rowsync,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('tests/qbank_verdict_three_paths.rs', () => {
  it('manual_regrade_walks_full_transition_table_without_new_attempts', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-table');
      const first = await f.submit(question.id, 'blue light scatters more');
      expect(first.is_correct).toBeNull();
      expect(first.needs_manual_grading).toBe(true);
      const submissionId = first.submission_id;
      let reloaded = await f.reload(question.id);
      expect([reloaded.attempt_count, reloaded.correct_count]).toEqual([1, 0]);

      const wrong = await f.submit(question.id, 'blue light scatters more', false, submissionId);
      expect(wrong.is_correct).toBe(false);
      expect(wrong.needs_manual_grading).toBe(false);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(0);
      expect(reloaded.status).toBe('review');
      expect(reloaded.is_correct).toBe(false);

      await f.submit(question.id, 'blue light scatters more', true, submissionId);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(1);
      expect(reloaded.status).toBe('in_progress');
      expect(reloaded.is_correct).toBe(true);

      await f.submit(question.id, 'blue light scatters more', true, submissionId);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(1);
      expect(reloaded.status).toBe('in_progress');

      await f.submit(question.id, 'blue light scatters more', false, submissionId);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(0);
      expect(reloaded.status).toBe('review');
      expect(reloaded.attempt_count).toBe(1);
      expect(f.submissionCount(question.id)).toBe(1);
      const submissions = f.db.all<{ id: string; is_correct: number | null; grading_method: string }>(
        `SELECT id, is_correct, grading_method FROM answer_submissions
         WHERE question_id = ?1 ORDER BY submitted_at DESC`, [question.id]);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.id).toBe(submissionId);
      expect(submissions[0]!.is_correct).toBe(0);
      expect(submissions[0]!.grading_method).toBe('manual');
    } finally { await f.dispose(); }
  });

  it('pending_override_resubmit_merges_into_regrade_without_double_count', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-merge');
      const pending = await f.submit(question.id, 'same answer text');
      expect(pending.is_correct).toBeNull();
      const merged = await f.submit(question.id, 'same answer text', true);
      expect(merged.is_correct).toBe(true);
      expect(merged.submission_id).toBe(pending.submission_id);
      const reloaded = await f.reload(question.id);
      expect(reloaded.attempt_count).toBe(1);
      expect(reloaded.correct_count).toBe(1);
      expect(f.submissionCount(question.id)).toBe(1);
      expect(f.db.pluck<string>(
        'SELECT grading_method FROM answer_submissions WHERE id = ?1', [merged.submission_id]))
        .toBe('manual');
    } finally { await f.dispose(); }
  });

  it('decided_override_resubmit_remains_a_real_second_attempt', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-boundary');
      await f.submit(question.id, 'boundary answer');
      await f.submit(question.id, 'boundary answer', true);
      const second = await f.submit(question.id, 'boundary answer', true);
      expect(second.is_correct).toBe(true);
      const reloaded = await f.reload(question.id);
      expect(reloaded.attempt_count).toBe(2);
      expect(reloaded.correct_count).toBe(2);
      expect(reloaded.status).toBe('mastered');
      expect(f.submissionCount(question.id)).toBe(2);
    } finally { await f.dispose(); }
  });

  it('pub_regrade_entrypoint_advances_submission_rowsync_columns', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-rowsync');
      const pending = await f.submit(question.id, 'rowsync answer');
      const submissionId = pending.submission_id;
      await f.submit(question.id, 'rowsync answer', true, submissionId);
      const first = f.rowsync(submissionId);
      expect(first.updated_at).not.toBeNull();
      expect(first.local_version).toBeGreaterThanOrEqual(1);

      await f.submit(question.id, 'rowsync answer', false, submissionId);
      const second = f.rowsync(submissionId);
      expect(second.updated_at).not.toBeNull();
      expect(second.local_version).toBe(first.local_version + 1);

      await f.submit(question.id, 'rowsync answer', false, submissionId);
      const third = f.rowsync(submissionId);
      expect(third.local_version).toBe(second.local_version);
      expect(third.updated_at).toBe(second.updated_at);
    } finally { await f.dispose(); }
  });

  it('daily_progress_write_back_matches_get_daily_practice', async () => {
    const f = await fixture();
    try {
      const q1 = await f.subjective('q-daily-1');
      await f.subjective('q-daily-2');
      await f.subjective('q-daily-3');
      const wrong = await f.submit(q1.id, 'first take', false);
      const progress = wrong.daily_progress as DailyProgressSnapshot;
      expect(progress.exam_id).toBe('exam_1');
      expect(progress.completed_count).toBe(1);
      expect(progress.correct_count).toBe(0);
      expect(progress.answered_question_ids).toContain(q1.id);

      const regraded = await f.submit(q1.id, 'first take', true, wrong.submission_id);
      const corrected = regraded.daily_progress as DailyProgressSnapshot;
      expect(corrected.completed_count).toBe(1);
      expect(corrected.correct_count).toBe(1);
      const snapshot = await f.daily('exam_1', 3);
      expect(snapshot.completed_count).toBe(1);
      expect(snapshot.correct_count).toBe(1);
      expect(snapshot.is_completed).toBe(false);

      const back = await f.submit(q1.id, 'first take', false, wrong.submission_id);
      const reverted = back.daily_progress as DailyProgressSnapshot;
      expect(reverted.completed_count).toBe(1);
      expect(reverted.correct_count).toBe(0);
      expect((await f.daily('exam_1', 3)).correct_count).toBe(0);
    } finally { await f.dispose(); }
  });

  it('legacy_question_without_submission_rows_still_counts_into_daily', async () => {
    const f = await fixture();
    try {
      const legacy = await f.subjective('q-legacy');
      const fresh = await f.subjective('q-fresh');
      const now = new Date().toISOString().replace('Z', '+00:00');
      f.db.run(`UPDATE questions SET user_answer = 'legacy answer', is_correct = 1,
          attempt_count = 1, correct_count = 1, status = 'in_progress', last_attempt_at = ?1
        WHERE id = ?2`, [now, legacy.id]);
      expect(f.submissionCount(legacy.id)).toBe(0);

      const daily = await f.daily('exam_1', 2);
      expect(daily.completed_count).toBe(1);
      expect(daily.correct_count).toBe(1);

      const submitted = await f.submit(fresh.id, 'fresh take', true);
      const progress = submitted.daily_progress as DailyProgressSnapshot;
      expect(progress.completed_count).toBe(2);
      expect(progress.correct_count).toBe(2);
      expect(progress.answered_question_ids).toContain(legacy.id);
      expect(progress.answered_question_ids).toContain(fresh.id);
    } finally { await f.dispose(); }
  });

  it('grading_method_origin_matrix_matches_documented_table', async () => {
    const f = await fixture();
    try {
      const choice = await f.choice('q-origin-auto');
      const auto = await f.submit(choice.id, 'A');
      expect(auto.is_correct).toBe(true);
      expect(auto.needs_manual_grading).toBe(false);

      const subjective = await f.subjective('q-origin-ai');
      const pending = await f.submit(subjective.id, 'pending take');
      expect(pending.is_correct).toBeNull();

      const overridden = await f.subjective('q-origin-manual');
      const manual = await f.submit(overridden.id, 'override take', true);
      expect(manual.is_correct).toBe(true);

      const methodOf = (questionId: string): string => f.db.pluck<string>(
        `SELECT grading_method FROM answer_submissions WHERE question_id = ?1
         ORDER BY submitted_at DESC LIMIT 1`, [questionId])!;
      expect(methodOf(choice.id)).toBe('auto');
      expect(methodOf(subjective.id)).toBe('ai');
      expect(methodOf(overridden.id)).toBe('manual');
    } finally { await f.dispose(); }
  });

  it('auto_graded_choice_regrade_transfers_method_and_counts', async () => {
    const f = await fixture();
    try {
      const question = await f.choice('q-auto');
      const wrong = await f.submit(question.id, 'B');
      expect(wrong.is_correct).toBe(false);
      let reloaded = await f.reload(question.id);
      expect([reloaded.attempt_count, reloaded.correct_count]).toEqual([1, 0]);
      expect(reloaded.status).toBe('review');

      await f.submit(question.id, 'B', true, wrong.submission_id);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(1);
      expect(reloaded.status).toBe('in_progress');
      const submissions = f.db.all<{ grading_method: string }>(
        'SELECT grading_method FROM answer_submissions WHERE question_id = ?1', [question.id]);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.grading_method).toBe('manual');

      await f.submit(question.id, 'B', false, wrong.submission_id);
      reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(0);
      expect(reloaded.status).toBe('review');
      expect(reloaded.attempt_count).toBe(1);
      expect(f.submissionCount(question.id)).toBe(1);
    } finally { await f.dispose(); }
  });

  it('idempotent_regrade_of_auto_verdict_preserves_grading_method_and_rowsync', async () => {
    const f = await fixture();
    try {
      const question = await f.choice('q-auto-idem');
      const auto = await f.submit(question.id, 'A');
      expect(auto.is_correct).toBe(true);
      const baseline = f.rowsync(auto.submission_id);
      await f.submit(question.id, 'A', true, auto.submission_id);
      expect(f.db.pluck<string>(
        'SELECT grading_method FROM answer_submissions WHERE id = ?1', [auto.submission_id]))
        .toBe('auto');
      expect(f.rowsync(auto.submission_id)).toEqual(baseline);
      const reloaded = await f.reload(question.id);
      expect([reloaded.attempt_count, reloaded.correct_count]).toEqual([1, 1]);
      expect(reloaded.status).toBe('in_progress');
    } finally { await f.dispose(); }
  });

  it('ai_decided_verdict_manual_flip_converges_to_manual_method', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-ai-handoff');
      const pending = await f.submit(question.id, 'ai graded answer');
      await f.submit(question.id, 'ai graded answer', true, pending.submission_id);
      f.db.run("UPDATE answer_submissions SET grading_method = 'ai' WHERE id = ?1",
        [pending.submission_id]);
      const versionBefore = f.rowsync(pending.submission_id).local_version;
      const flipped = await f.submit(question.id, 'ai graded answer', false, pending.submission_id);
      expect(flipped.is_correct).toBe(false);
      const reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(0);
      expect(reloaded.status).toBe('review');
      expect(reloaded.attempt_count).toBe(1);
      expect(f.submissionCount(question.id)).toBe(1);
      expect(f.db.pluck<string>(
        'SELECT grading_method FROM answer_submissions WHERE id = ?1', [pending.submission_id]))
        .toBe('manual');
      const after = f.rowsync(pending.submission_id);
      expect(after.updated_at).not.toBeNull();
      expect(after.local_version).toBe(versionBefore + 1);
    } finally { await f.dispose(); }
  });

  it('true_to_false_regrade_clamps_correct_count_at_zero', async () => {
    const f = await fixture();
    try {
      const question = await f.subjective('q-clamp');
      const pending = await f.submit(question.id, 'clamp answer');
      await f.submit(question.id, 'clamp answer', true, pending.submission_id);
      expect((await f.reload(question.id)).correct_count).toBe(1);
      f.db.run('UPDATE questions SET correct_count = 0 WHERE id = ?1', [question.id]);
      const flipped = await f.submit(question.id, 'clamp answer', false, pending.submission_id);
      expect(flipped.is_correct).toBe(false);
      const reloaded = await f.reload(question.id);
      expect(reloaded.correct_count).toBe(0);
      expect(reloaded.status).toBe('review');
    } finally { await f.dispose(); }
  });

  it('submit_answer_result_without_daily_progress_field_still_deserializes', async () => {
    // TS 侧没有 serde：旧载荷（缺 daily_progress 键）直接对应可选字段。
    // 这里锁定契约形状：字段缺失时保持 undefined，其余字段不受影响。
    const f = await fixture();
    try {
      const question = await f.subjective('q-serde');
      const result = await f.submit(question.id, 'serde take', true);
      const payload = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      delete payload.daily_progress;
      const revived = payload as unknown as SubmitAnswerResult;
      expect(revived.daily_progress).toBeUndefined();
      expect(revived.submission_id).toBe(result.submission_id);
      expect(revived.is_correct).toBe(true);
    } finally { await f.dispose(); }
  });

  it('regrade_guard_rejects_stale_or_unknown_submission_without_side_effects', async () => {
    const f = await fixture();
    try {
      const question = await f.choice('q-guard');
      const first = await f.submit(question.id, 'A');
      f.db.run("UPDATE answer_submissions SET submitted_at = '2020-01-01T00:00:00Z' WHERE id = ?1",
        [first.submission_id]);
      const second = await f.submit(question.id, 'B');
      expect(second.submission_id).not.toBe(first.submission_id);
      const before = await f.reload(question.id);
      expect([before.attempt_count, before.correct_count]).toEqual([2, 1]);

      await expect(f.submit(question.id, 'A', false, first.submission_id))
        .rejects.toMatchObject({ message: expect.stringContaining('最近一次提交') as string });
      await expect(f.submit(question.id, 'B', true, 'sub-does-not-exist')).rejects.toThrow();

      const untouched = await f.choice('q-guard-empty');
      await expect(f.submit(untouched.id, 'whatever', true, 'whatever'))
        .rejects.toMatchObject({ message: expect.stringContaining('作答记录') as string });

      const after = await f.reload(question.id);
      expect([after.attempt_count, after.correct_count])
        .toEqual([before.attempt_count, before.correct_count]);
      const submissions = f.db.all<{ id: string; is_correct: number | null; grading_method: string }>(
        `SELECT id, is_correct, grading_method FROM answer_submissions
         WHERE question_id = ?1 ORDER BY submitted_at DESC`, [question.id]);
      expect(submissions).toHaveLength(2);
      expect(submissions.find(item => item.id === first.submission_id)).toMatchObject({
        is_correct: 1, grading_method: 'auto',
      });
      expect(submissions.find(item => item.id === second.submission_id)!.is_correct).toBe(0);
    } finally { await f.dispose(); }
  });
});
