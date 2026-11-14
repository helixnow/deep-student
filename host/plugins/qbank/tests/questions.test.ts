import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: 真实 review 插件仅在测试中组合以提供 mastery 服务
import review from '../../review/index.ts';
import type { Question, QuestionListResult, SubmitAnswerResult } from '../api.ts';
import { questionTypeFrom, toDifficulty, toStatus } from '../src/question-enums.ts';
import { listMistakes } from '../repository/questions.ts';
import { QbankServiceError } from '../src/question-service.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { thrownMessage } from '../../../kernel/commands.ts';

const NOW = '2026-01-01T00:00:00+00:00';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-questions-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      // 本文件的状态机用例不校验掌握度内容；真实 mastery 由 fixtureWithMastery 覆盖。
      mastery: {
        recordQbankAnswerWithConn: () => ({}),
        recordQbankVerdictCorrectionWithConn: () => ({}),
        syncLearnerProfile: () => undefined,
      },
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_2', '题目集二', 'completed', 't2', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

async function fixtureWithMastery() {
  const { storage, base } = await createMigratedStorage('qbank-questions-mastery-');
  const host = await createTestHost({
    plugins: [review, vfsRepos, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', '{}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage,
    mastery: host.ctx.mastery as {
      getState(concept: string): { score: number } | null;
      recordQbankVerdictCorrection(submissionId: string, questionId: string, tags: string[],
        correct: boolean): { score: number; total: number; wrongCount: number; conceptKey: string };
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function questionParams(examId = 'exam_1', content = '1+1=?'): Record<string, unknown> {
  return {
    exam_id: examId, card_id: null, question_label: null, content, answer: 'A',
    options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }],
    explanation: '基础加法', question_type: 'single_choice', difficulty: 'easy',
    tags: ['算术'], source_type: 'manual', source_ref: null, images: null, parent_id: null,
  };
}

describe('question_repo.rs / question_bank_service.rs', () => {
  it('test_question_type_from_str_lenient', () => {
    expect(questionTypeFrom('SingleChoice')).toBe('single_choice');
    expect(questionTypeFrom('single-choice')).toBe('single_choice');
    expect(questionTypeFrom(' multiple_choice ')).toBe('multiple_choice');
    expect(questionTypeFrom('TRUE_FALSE')).toBe('true_false');
    expect(questionTypeFrom('unknown')).toBe('other');
    expect(toDifficulty('very_hard')).toBe('very_hard');
    expect(toDifficulty('nope')).toBe('medium');
    expect(toStatus('review')).toBe('review');
  });

  it('service_error_message_is_the_app_error_display_like_rust_format_e', () => {
    // models.rs:1038-1042 `impl Display for AppError` 只写 message；`{e}` / `e.to_string()` 不带 error_type。
    const error = new QbankServiceError(AppError.validation('题目内容不能为空'));
    expect(error.message).toBe('题目内容不能为空');
    expect(thrownMessage(error)).toBe('题目内容不能为空');
    expect(error.appError).toEqual({ error_type: 'Validation', message: '题目内容不能为空', details: null });
    expect(new QbankServiceError('plain').message).toBe('plain');
  });

  it('create/get/list/search/favorite/stats command contracts', async () => {
    const f = await fixture();
    try {
      const created = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      expect(created.id).toMatch(/^q_/);
      expect(created.question_type).toBe('single_choice');
      expect(created.status).toBe('new');
      expect(created.attempt_count).toBe(0);
      expect(created.tags).toEqual(['算术']);
      expect(created.images).toEqual([]);
      expect(created.structured_data).toBeNull();

      const fetched = await f.host.invoke('qbank_get_question', { questionId: created.id });
      expect(fetched).toEqual(created);
      expect(await f.host.invoke('qbank_get_question', { questionId: 'missing' })).toBeNull();
      expect(await f.host.invoke('qbank_get_question_by_card_id', { examId: 'exam_1', cardId: created.id }))
        .toEqual(created);

      const second = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams('exam_1', '2+2=?'), answer: 'B', question_type: 'multiple_choice',
          explanation: '代数运算', tags: ['代数'] },
      }) as Question;
      const list = await f.host.invoke('qbank_list_questions', {
        request: { exam_id: 'exam_1', filters: { status: ['new'], question_type: [{ multiple_choice: null }] }, page: 1, page_size: 1 },
      }) as QuestionListResult;
      expect(list.total).toBe(1);
      expect(list.questions[0]?.id).toBe(second.id);
      expect(list.has_more).toBe(false);
      expect(list.page_size).toBe(1);
      const all = await f.host.invoke('qbank_list_questions', {
        request: { exam_id: 'exam_1', filters: { tags: ['算术'], search: '1+1' }, page: 0, page_size: 0 },
      }) as QuestionListResult;
      expect(all.questions.map(question => question.id)).toEqual([created.id]);
      expect(all.page).toBe(1);
      expect(all.page_size).toBe(1);

      const search = await f.host.invoke('qbank_search_questions', {
        request: { keyword: '基础加法', exam_id: 'exam_1', filters: null, page: 1, page_size: 10 },
      }) as { total: number; results: { question: Question; highlight_content: string | null }[] };
      expect(search.total).toBe(1);
      expect(search.results[0]?.question.id).toBe(created.id);
      const blank = await f.host.invoke('qbank_search_questions', {
        request: { keyword: '   ', page: 0, page_size: 0 },
      }) as { results: unknown[]; total: number };
      expect(blank).toMatchObject({ results: [], total: 0 });

      const favorite = await f.host.invoke('qbank_toggle_favorite', { questionId: created.id }) as Question;
      expect(favorite.is_favorite).toBe(true);
      expect((await f.host.invoke('qbank_toggle_favorite', { questionId: created.id }) as Question).is_favorite).toBe(false);
      await expect(f.host.invoke('qbank_toggle_favorite', { questionId: 'missing' }))
        .rejects.toEqual({ error_type: 'NotFound', message: 'Question not found: missing', details: null });

      expect(await f.host.invoke('qbank_count_by_type', { examId: 'exam_1' }))
        .toEqual({ single_choice: 1, multiple_choice: 1 });
      const stats = await f.host.invoke('qbank_refresh_stats', { examId: 'exam_1' }) as {
        total_count: number; new_count: number; correct_rate: number;
      };
      expect(stats).toMatchObject({ total_count: 2, new_count: 2, correct_rate: 0 });
      expect(await f.host.invoke('qbank_get_stats', { examId: 'exam_1' })).toEqual(stats);
      expect(await f.host.invoke('qbank_get_stats', { examId: 'exam_2' })).toBeNull();
      expect(await f.host.invoke('qbank_rebuild_fts_index')).toBeGreaterThanOrEqual(2);
    } finally { await f.dispose(); }
  });

  it('update_params_clear_stale_structured_data_only_on_type_switch', async () => {
    const f = await fixture();
    try {
      const matching = await f.host.invoke('qbank_create_question', {
        params: {
          ...questionParams(), question_type: 'matching',
          structured_data: { left: [{ key: 'L1', content: '甲' }], right: [{ key: 'R1', content: '乙' }],
            pairs: [{ left: 'L1', right: 'R1' }] },
        },
      }) as Question;
      expect(matching.structured_data).not.toBeNull();
      const renamed = await f.host.invoke('qbank_update_question', {
        request: { question_id: matching.id, params: { content: '改名' }, record_history: true },
      }) as Question;
      expect(renamed.structured_data).toEqual(matching.structured_data);
      const switched = await f.host.invoke('qbank_update_question', {
        request: { question_id: matching.id, params: { question_type: 'short_answer' }, record_history: true },
      }) as Question;
      expect(switched.structured_data).toBeNull();
      const history = await f.host.invoke('qbank_get_history', { questionId: matching.id, limit: null }) as {
        field_name: string; old_value: string | null; new_value: string | null;
      }[];
      expect(history.some(entry => entry.field_name === 'content' && entry.new_value === '改名')).toBe(true);
      expect(history.some(entry => entry.field_name === 'structured_data' && entry.new_value === null)).toBe(true);

      const stale = f.host.invoke('qbank_update_question', {
        request: { question_id: matching.id, params: { content: 'x', expected_updated_at: '1999-01-01T00:00:00+00:00' } },
      });
      await expect(stale).rejects.toMatchObject({ error_type: 'Database' });
      expect((await f.host.invoke('qbank_get_question', { questionId: matching.id }) as Question).content).toBe('改名');
    } finally { await f.dispose(); }
  });

  it('structured_data_history_uses_structural_equality_not_json_text', async () => {
    const f = await fixture();
    try {
      const matching = await f.host.invoke('qbank_create_question', {
        params: {
          ...questionParams(), question_type: 'matching',
          structured_data: { left: [{ key: 'L1', content: '甲' }], right: [{ key: 'R1', content: '乙' }] },
        },
      }) as Question;
      await f.host.invoke('qbank_update_question', {
        request: {
          question_id: matching.id,
          params: { structured_data: { right: [{ content: '乙', key: 'R1' }], left: [{ content: '甲', key: 'L1' }] } },
          record_history: true,
        },
      });
      const history = await f.host.invoke('qbank_get_history', { questionId: matching.id, limit: null }) as {
        field_name: string;
      }[];
      expect(history.some(entry => entry.field_name === 'structured_data')).toBe(false);
    } finally { await f.dispose(); }
  });

  it('structured_data_array_and_object_types_are_never_equal', async () => {
    const f = await fixture();
    try {
      const emptyObject = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), structured_data: {} },
      }) as Question;
      await f.host.invoke('qbank_update_question', {
        request: { question_id: emptyObject.id, params: { structured_data: [] }, record_history: true },
      });
      const emptyObjectHistory = await f.host.invoke('qbank_get_history', {
        questionId: emptyObject.id, limit: null,
      }) as { field_name: string }[];
      expect(emptyObjectHistory.filter(entry => entry.field_name === 'structured_data')).toHaveLength(1);

      const numericArray = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), structured_data: [1] },
      }) as Question;
      await f.host.invoke('qbank_update_question', {
        request: { question_id: numericArray.id, params: { structured_data: { 0: 1 } }, record_history: true },
      });
      const numericArrayHistory = await f.host.invoke('qbank_get_history', {
        questionId: numericArray.id, limit: null,
      }) as { field_name: string }[];
      expect(numericArrayHistory.filter(entry => entry.field_name === 'structured_data')).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it('delete hides questions and batch operations report partial failures', async () => {
    const f = await fixture();
    try {
      const one = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      const two = await f.host.invoke('qbank_create_question', { params: questionParams('exam_1', '3+3=?') }) as Question;
      await f.host.invoke('qbank_delete_question', { questionId: one.id });
      expect(await f.host.invoke('qbank_get_question', { questionId: one.id })).toBeNull();
      const deleted = await f.host.invoke('qbank_batch_delete_questions', { questionIds: ['missing', two.id] }) as {
        success_count: number; failed_count: number; errors: string[];
      };
      expect(deleted).toEqual({ success_count: 1, failed_count: 1, errors: ['missing: not found'] });
      expect((await f.host.invoke('qbank_list_questions', {
        request: { exam_id: 'exam_1' },
      }) as QuestionListResult).total).toBe(0);
    } finally { await f.dispose(); }
  });

  it('submit_and_regrade_return_daily_progress_snapshot', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      const wrong = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', is_correct_override: null, client_request_id: 'req-1' },
      }) as SubmitAnswerResult;
      expect(wrong).toMatchObject({
        is_correct: false, correct_answer: 'A', needs_manual_grading: false, message: '回答错误',
      });
      expect(wrong.updated_question).toMatchObject({ status: 'review', attempt_count: 1, correct_count: 0, is_correct: false });
      expect(wrong.updated_stats).toMatchObject({ total_attempts: 1, total_correct: 0, correct_rate: 0 });
      expect(wrong.daily_progress).toMatchObject({
        exam_id: 'exam_1', completed_count: 1, correct_count: 0, answered_question_ids: [question.id],
      });
      expect(wrong.submission_id).toMatch(/^as_/);

      const replay = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', client_request_id: 'req-1' },
      }) as SubmitAnswerResult;
      expect(replay.submission_id).toBe(wrong.submission_id);
      expect(replay.updated_question.attempt_count).toBe(1);
      expect((await f.host.invoke('qbank_get_submissions', { questionId: question.id, limit: null }) as unknown[]))
        .toHaveLength(1);

      const regraded = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', is_correct_override: true, regrade_submission_id: wrong.submission_id },
      }) as SubmitAnswerResult;
      expect(regraded).toMatchObject({ is_correct: true, needs_manual_grading: false, submission_id: wrong.submission_id });
      expect(regraded.updated_question).toMatchObject({ attempt_count: 1, correct_count: 1, status: 'in_progress', is_correct: true });
      expect(regraded.daily_progress).toMatchObject({ completed_count: 1, correct_count: 1 });
      const submissions = await f.host.invoke('qbank_get_submissions', { questionId: question.id, limit: 10 }) as {
        id: string; is_correct: boolean | null; grading_method: string;
      }[];
      expect(submissions).toEqual([{ ...submissions[0], id: wrong.submission_id, is_correct: true, grading_method: 'manual' }]);

      const stale = f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', is_correct_override: false, regrade_submission_id: 'as_missing' },
      });
      await expect(stale).rejects.toEqual({ error_type: 'Validation', message: '要改判的作答已不是最近一次提交，请刷新后重试', details: null });
    } finally { await f.dispose(); }
  });

  it('regrade_submission_flips_latest_without_double_counting', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      const first = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my answer', is_correct_override: false, client_request_id: 'rg-1' },
      }) as SubmitAnswerResult;
      expect(first.updated_question).toMatchObject({ attempt_count: 1, correct_count: 0, is_correct: false });
      const countSubmissions = () => f.db.pluck<number>(
        'SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1', [question.id]);
      expect(countSubmissions()).toBe(1);

      const flipped = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my answer', is_correct_override: true,
          regrade_submission_id: first.submission_id },
      }) as SubmitAnswerResult;
      expect(flipped.is_correct).toBe(true);
      expect(flipped.submission_id).toBe(first.submission_id);
      expect(flipped.updated_question).toMatchObject({ attempt_count: 1, correct_count: 1, is_correct: true });
      expect(countSubmissions()).toBe(1);

      const idem = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my answer', is_correct_override: true,
          regrade_submission_id: first.submission_id },
      }) as SubmitAnswerResult;
      expect(idem.updated_question.correct_count).toBe(1);
      expect(countSubmissions()).toBe(1);

      const back = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my answer', is_correct_override: false,
          regrade_submission_id: first.submission_id },
      }) as SubmitAnswerResult;
      expect(back.is_correct).toBe(false);
      expect(back.updated_question).toMatchObject({ correct_count: 0, status: 'review' });
      expect(countSubmissions()).toBe(1);
    } finally { await f.dispose(); }
  });

  it('regrade_submission_rejects_stale_submission', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      const first = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'old', is_correct_override: false, client_request_id: 'st-1' },
      }) as SubmitAnswerResult;
      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'new', is_correct_override: false, client_request_id: 'st-2' },
      });
      const stale = f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'old', is_correct_override: true,
          regrade_submission_id: first.submission_id },
      });
      await expect(stale).rejects.toMatchObject({
        error_type: 'Validation', message: expect.stringContaining('最近一次提交') as string,
      });
    } finally { await f.dispose(); }
  });

  it('specific answer types grade trivially and manual answers stay pending', async () => {
    const f = await fixture();
    try {
      const essay = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), question_type: 'essay', answer: null, options: null },
      }) as Question;
      const submitted = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: essay.id, user_answer: '我的论述' },
      }) as SubmitAnswerResult;
      expect(submitted).toMatchObject({ is_correct: null, needs_manual_grading: true, message: '需要手动批改' });
      expect(submitted.updated_question).toMatchObject({ status: 'in_progress', attempt_count: 1 });
      expect(submitted.updated_stats).toMatchObject({ total_attempts: 1, total_correct: 0, correct_rate: 0 });
    } finally { await f.dispose(); }
  });

  it('submit_answer_anti_farm_same_question_gains_less', async () => {
    const f = await fixtureWithMastery();
    try {
      const create = async (tag: string, content: string): Promise<Question> => f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), content, answer: '2', options: null, question_type: 'fill_blank',
          tags: [tag] },
      }) as Promise<Question>;
      const independent: Question[] = [];
      for (let index = 0; index < 5; index += 1) independent.push(await create('qb_ind', `I${index}`));
      const farm = await create('qb_farm', 'F');
      for (const [index, question] of independent.entries()) {
        await f.host.invoke('qbank_submit_answer', {
          request: { question_id: question.id, user_answer: '2', is_correct_override: true,
            client_request_id: `qi${index}` },
        });
      }
      for (let index = 0; index < 5; index += 1) {
        await f.host.invoke('qbank_submit_answer', {
          request: { question_id: farm.id, user_answer: '2', is_correct_override: true,
            client_request_id: `qf${index}` },
        });
      }
      const gainIndependent = f.mastery.getState('qb_ind')!.score - 0.5;
      const gainFarm = f.mastery.getState('qb_farm')!.score - 0.5;
      expect(gainFarm).toBeLessThan(gainIndependent * 0.55);
      const minWeight = f.db.pluck<number>(
        'SELECT MIN(weight) FROM mastery_events WHERE concept_key = ?1', ['qb_farm']);
      expect(minWeight).toBeLessThan(0.3);
    } finally { await f.dispose(); }
  });

  it('apply_submission_verdict_counts_and_rowsync', async () => {
    const f = await fixtureWithMastery();
    try {
      const question = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), answer: null, options: null, question_type: 'essay', tags: ['判分同步'] },
      }) as Question;
      const pending = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my essay', is_correct_override: null,
          client_request_id: 'av-1' },
      }) as SubmitAnswerResult;
      expect(pending.is_correct).toBeNull();
      const submissionId = pending.submission_id;
      const row = () => f.db.get<{ updated_at: string | null; local_version: number }>(
        'SELECT updated_at, COALESCE(local_version, 0) AS local_version FROM answer_submissions WHERE id = ?1',
        [submissionId])!;
      const apply = async (correct: boolean): Promise<SubmitAnswerResult> => f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'my essay', is_correct_override: correct,
          regrade_submission_id: submissionId },
      }) as Promise<SubmitAnswerResult>;
      const chain = (): { live: { id: string; outcome: string }[]; tombstones: number } => {
        const base = `me_qbank_${submissionId}`;
        const prefix = `${base}_r`;
        const rows = f.db.all<{ id: string; outcome: string; deleted_at: string | null }>(
          `SELECT id, outcome, deleted_at FROM mastery_events
           WHERE id = ?1 OR substr(id, 1, length(?2)) = ?2 ORDER BY id`, [base, prefix]);
        return {
          live: rows.filter(item => item.deleted_at === null).map(item => ({ id: item.id, outcome: item.outcome })),
          tombstones: rows.filter(item => item.deleted_at !== null).length,
        };
      };

      const initial = row();
      const first = await apply(true);
      expect(first.updated_question).toMatchObject({ correct_count: 1, is_correct: true });
      expect(row().local_version).toBe(1);
      expect(row().updated_at).not.toBeNull();
      expect(chain()).toEqual({ live: [{ id: `me_qbank_${submissionId}`, outcome: 'correct' }], tombstones: 0 });

      const afterFirst = row();
      const same = await apply(true);
      expect(same.updated_question.correct_count).toBe(1);
      expect(row()).toEqual(afterFirst);
      expect(chain().live).toHaveLength(1);

      const back = await apply(false);
      expect(back.updated_question).toMatchObject({ correct_count: 0, status: 'review' });
      expect(row().local_version).toBe(2);
      expect(chain()).toEqual({ live: [{ id: `me_qbank_${submissionId}_r1`, outcome: 'wrong' }], tombstones: 1 });

      await apply(true);
      expect(row().local_version).toBe(3);
      expect(chain()).toEqual({ live: [{ id: `me_qbank_${submissionId}_r2`, outcome: 'correct' }], tombstones: 2 });

      await apply(false);
      const beforeIdempotent = row();
      const idempotent = await apply(false);
      expect(idempotent.updated_question.correct_count).toBe(0);
      expect(row()).toEqual(beforeIdempotent);
      expect(chain().live).toEqual([{ id: `me_qbank_${submissionId}_r3`, outcome: 'wrong' }]);
      expect(initial.local_version).toBe(0);
    } finally { await f.dispose(); }
  });

  it('compensation_entry_interops_with_product_written_verdict_chain', async () => {
    const f = await fixtureWithMastery();
    try {
      const question = await f.host.invoke('qbank_create_question', {
        params: { ...questionParams(), content: 'q-corr-interop: explain why the sky is blue',
          answer: 'Rayleigh scattering favors shorter wavelengths.', options: null,
          question_type: 'short_answer', tags: ['physics'] },
      }) as Question;
      const pending = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'sky is blue because ocean',
          is_correct_override: null, client_request_id: null },
      }) as SubmitAnswerResult;
      expect(pending.is_correct).toBeNull();
      const sid = pending.submission_id;
      const baseId = `me_qbank_${sid}`;
      const chainCount = () => f.db.pluck<number>(
        `SELECT COUNT(*) FROM mastery_events WHERE id = ?1
          OR substr(id, 1, length(?2)) = ?2`, [baseId, `${baseId}_r`]);
      const event = (id: string) => f.db.get<{ outcome: string; weight: number; deleted_at: string | null }>(
        'SELECT outcome, weight, deleted_at FROM mastery_events WHERE id = ?1', [id]);

      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'sky is blue because ocean',
          is_correct_override: false, regrade_submission_id: sid },
      });
      expect(event(baseId)).toMatchObject({ outcome: 'wrong', deleted_at: null });
      expect(chainCount()).toBe(1);

      const corrected = f.mastery.recordQbankVerdictCorrection(sid, question.id, ['physics'], true);
      expect(corrected.conceptKey).toBe('physics');
      expect(Math.abs(corrected.score - 0.65)).toBeLessThan(1e-9);
      expect(corrected.wrongCount).toBe(0);
      expect(event(baseId)!.deleted_at).not.toBeNull();
      const revision = event(`${baseId}_r1`)!;
      expect(revision.outcome).toBe('correct');
      expect(revision.deleted_at).toBeNull();
      expect(Math.abs(revision.weight - 1)).toBeLessThan(1e-9);

      await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'sky is blue because ocean',
          is_correct_override: true, regrade_submission_id: sid },
      });
      expect(chainCount()).toBe(2);
      expect(event(`${baseId}_r1`)!.deleted_at).toBeNull();
    } finally { await f.dispose(); }
  });

  it('reset_progress and reset_questions_progress clear submissions and counters', async () => {
    const f = await fixture();
    try {
      const one = await f.host.invoke('qbank_create_question', { params: questionParams() }) as Question;
      const two = await f.host.invoke('qbank_create_question', { params: questionParams('exam_1', '4+4=?') }) as Question;
      await f.host.invoke('qbank_submit_answer', { request: { question_id: one.id, user_answer: 'A' } });
      await f.host.invoke('qbank_submit_answer', { request: { question_id: two.id, user_answer: 'A' } });
      const reset = await f.host.invoke('qbank_reset_questions_progress', { questionIds: [one.id, 'missing'] }) as {
        success_count: number; failed_count: number; errors: string[];
      };
      expect(reset.success_count).toBe(1);
      expect(reset.failed_count).toBe(1);
      expect(reset.errors).toEqual(['missing: not found']);
      expect((await f.host.invoke('qbank_get_question', { questionId: one.id }) as Question)).toMatchObject({
        status: 'new', attempt_count: 0, correct_count: 0, is_correct: null, user_answer: null,
      });
      expect(await f.host.invoke('qbank_get_submissions', { questionId: one.id, limit: 10 })).toEqual([]);
      expect((await f.host.invoke('qbank_get_question', { questionId: two.id }) as Question).attempt_count).toBe(1);
      const stats = await f.host.invoke('qbank_reset_progress', { examId: 'exam_1' }) as {
        total_count: number; total_attempts: number; new_count: number;
      };
      expect(stats).toMatchObject({ total_count: 2, total_attempts: 0, new_count: 2 });
      expect(await f.host.invoke('qbank_get_submissions', { questionId: two.id, limit: 10 })).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('list_mistakes aggregates review questions across exams', async () => {
    const f = await fixture();
    try {
      const one = await f.host.invoke('qbank_create_question', { params: questionParams('exam_1') }) as Question;
      const two = await f.host.invoke('qbank_create_question', { params: questionParams('exam_2', '错题二') }) as Question;
      await f.host.invoke('qbank_submit_answer', { request: { question_id: one.id, user_answer: 'B' } });
      await f.host.invoke('qbank_submit_answer', { request: { question_id: two.id, user_answer: 'B' } });
      // The L14 contract rejects MistakeQuestion's flattened exam_name (Question declares
      // additionalProperties:false), so the repository shape is asserted directly here.
      const result = listMistakes(f.db, { sort: 'errors' }, 1, 10);
      expect(result.total).toBe(2);
      expect(result.items.map(item => item.id).sort()).toEqual([one.id, two.id].sort());
      expect(result.items.every(item => item.exam_name !== null)).toBe(true);
      expect(result.exams.map(exam => exam.count)).toEqual([1, 1]);
      expect(listMistakes(f.db, { exam_id: 'exam_2', search: '错题' }, 1, 10).total).toBe(1);
    } finally { await f.dispose(); }
  });
});

export type { DatabaseHandle };
