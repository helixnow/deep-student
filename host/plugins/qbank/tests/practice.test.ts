import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import * as practiceService from '../src/practice-service.ts';
import { loadAttempt, persistAttempt } from '../repository/practice.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实 QuestionRepo 注入 qbank 的写入端口
import { QuestionRepo } from '../../vfs-repos/repository/questions.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type {
  CreatePracticeRequest, CreateQuestionParams, GeneratedPaper, PracticeAttempt, PracticeDraft,
  PracticeSummary, Question, SavePracticeRequest, SubmitAnswerResult,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const questionRepo = new QuestionRepo();

/** 让自动批改队列停在等待补全的状态，避免状态机用例与批改时序竞争。 */
function pendingGradingLlm() {
  return {
    gradePracticeSnapshot: () => new Promise<never>(() => undefined),
    getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
    getModel2Config: async () => ({
      id: 'cfg-test', model: 'test-model', apiKey: 'test-key',
      isMultimodal: false, maxOutputTokens: 1024, maxTokensLimit: null,
      baseUrl: 'https://api.openai.com/v1', name: 'test', vendorId: null, providerType: null,
      providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
      isReasoning: false, isEmbedding: false, isReranker: false, isImageGeneration: false,
      enabled: true, modelAdapter: '', supportsTools: false, geminiApiVersion: '',
      isBuiltin: false, isReadOnly: false, reasoningEffort: null, reasoningMode: null,
      thinkingEnabled: false, thinkingBudget: null, includeThoughts: false, minP: null,
      topK: null, enableThinking: null, supportsReasoning: false, headers: null,
      topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
      repetitionPenalty: null, reasoningSplit: false, temperature: 0.7,
    }),
    decryptApiKey: async (key: string) => key,
    consumePendingCancel: async () => false,
    subscribeCancelStream: async () => new AbortController().signal,
    clearCancelStream: async () => undefined,
  };
}

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-practice-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      // 本文件只测提交/重试状态机；批改队列由 practice-grading-queue.test.ts 覆盖。
      llm: pendingGradingLlm(),
      llmStreaming: { singleShotCompletion: () => new Promise<never>(() => undefined) },
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
  return {
    host, db, storage,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function params(content = '1+1=?', overrides: Partial<CreateQuestionParams> = {}): CreateQuestionParams {
  return {
    exam_id: 'exam_1', content, answer: 'A',
    options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }],
    question_type: 'single_choice', difficulty: 'easy', tags: ['算术'], source_type: 'manual',
    ...overrides,
  };
}

async function createPractice(host: Awaited<ReturnType<typeof fixture>>['host'], questionIds: string[],
  overrides: Partial<CreatePracticeRequest> = {}): Promise<PracticeDraft> {
  return host.invoke('qbank_create_practice', {
    request: {
      id: 'practice_1', scope_id: 'exam_1', title: '练习一', mode: 'sequential',
      question_ids: questionIds, ...overrides,
    },
  }) as Promise<PracticeDraft>;
}

describe('qbank_practice.rs', () => {
  it('drafts_do_not_grade_or_create_learning_signals_and_submit_is_idempotent', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      expect(draft).toMatchObject({
        id: 'practice_1', scope_id: 'exam_1', title: '练习一', mode: 'sequential',
        revision: 1, answers: {}, marked_ids: [], current_index: 0, elapsed_seconds: 0,
        duration_seconds: null, deadline: null,
      });
      expect(draft.questions.map(item => item.id)).toEqual([question.id]);

      const saved = await f.host.invoke('qbank_save_practice', {
        request: { id: 'practice_1', revision: 1, answers: { [question.id]: 'A' },
          marked_ids: [question.id], current_index: 0, elapsed_seconds: 5 },
      }) as PracticeDraft;
      expect(saved).toMatchObject({ revision: 2, elapsed_seconds: 5, marked_ids: [question.id] });
      expect(saved.answers).toEqual({ [question.id]: 'A' });
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM answer_submissions')).toBe(0);
      expect((await f.host.invoke('qbank_get_question', { questionId: question.id }) as Question).attempt_count).toBe(0);

      const submitted = await f.host.invoke('qbank_submit_practice', { id: 'practice_1', revision: 2 }) as PracticeAttempt;
      expect(submitted.status).toBe('completed');
      expect(submitted.results).toEqual([expect.objectContaining({
        question_id: question.id, status: 'correct', is_correct: true, score: 100, source_available: true,
      })]);
      expect(submitted.origin_device_id).toBe('qbank-test-device');
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM answer_submissions')).toBe(1);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM qbank_practice_drafts WHERE id = ?1', ['practice_1'])).toBe(0);

      const replay = await f.host.invoke('qbank_submit_practice', { id: 'practice_1', revision: 2 }) as PracticeAttempt;
      expect(replay).toEqual(submitted);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM answer_submissions')).toBe(1);

      const summaries = await f.host.invoke('qbank_list_practices', {
        scopeId: 'exam_1', submitted: true, offset: null,
      }) as PracticeSummary[];
      expect(summaries).toEqual([expect.objectContaining({
        id: 'practice_1', question_count: 1, answered_count: 1, correct_count: 1,
        pending_count: 0, status: 'completed',
      })]);
      expect(await f.host.invoke('qbank_get_practice', { id: 'practice_1', submitted: true })).toEqual(submitted);
      await expect(f.host.invoke('qbank_get_practice', { id: 'practice_1', submitted: false }))
        .rejects.toMatchObject({ error_type: 'NotFound', message: 'Practice draft not found' });
      await f.host.invoke('qbank_delete_practice', { id: 'practice_1', submitted: true });
      await expect(f.host.invoke('qbank_get_practice', { id: 'practice_1', submitted: true }))
        .rejects.toMatchObject({ error_type: 'NotFound', message: 'Practice attempt not found' });
    } finally { await f.dispose(); }
  });

  it('stale_save_and_submit_cannot_overwrite_newer_answers', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      await createPractice(f.host, [question.id]);
      const saved = await f.host.invoke('qbank_save_practice', {
        request: { id: 'practice_1', revision: 1, answers: { [question.id]: 'A' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      }) as PracticeDraft;
      expect(saved.revision).toBe(2);

      await expect(f.host.invoke('qbank_save_practice', {
        request: { id: 'practice_1', revision: 1, answers: { [question.id]: 'B' },
          marked_ids: [], current_index: 0, elapsed_seconds: 2 },
      })).rejects.toMatchObject({
        error_type: 'Validation', message: 'Practice changed in another window; reload before saving',
      });
      await expect(f.host.invoke('qbank_submit_practice', { id: 'practice_1', revision: 1 }))
        .rejects.toMatchObject({
          error_type: 'Validation', message: 'Practice changed before submission; reload before submitting',
        });

      const latest = await f.host.invoke('qbank_save_practice', {
        request: { id: 'practice_1', revision: 2, answers: { [question.id]: 'B' },
          marked_ids: [], current_index: 0, elapsed_seconds: 3 },
      }) as PracticeDraft;
      expect(latest.revision).toBe(3);
      const submitted = await f.host.invoke('qbank_submit_practice', { id: 'practice_1', revision: 3 }) as PracticeAttempt;
      expect(submitted.results[0]).toMatchObject({ status: 'incorrect', is_correct: false });
      expect(submitted.answers).toEqual({ [question.id]: 'B' });
    } finally { await f.dispose(); }
  });

  it('deadline_submission_uses_latest_saved_revision_and_replays_manual_submit', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const first = await createPractice(f.host, [question.id]);
      const second = await f.host.invoke('qbank_save_practice', {
        request: { id: first.id, revision: 1, answers: { [question.id]: 'B' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      }) as PracticeDraft;
      const latest = await f.host.invoke('qbank_save_practice', {
        request: { id: first.id, revision: second.revision, answers: { [question.id]: 'A' },
          marked_ids: [], current_index: 0, elapsed_seconds: 2 },
      }) as PracticeDraft;
      const mastery = () => ({
        recordQbankAnswerWithConn: () => ({}),
        recordQbankVerdictCorrectionWithConn: () => ({}),
        syncLearnerProfile: () => undefined,
      });
      const automatic = practiceService.submitDraft({
        db: f.db, deviceId: 'qbank-test-device', questions: questionRepo, mastery,
      }, first.id, null).attempt;
      expect(automatic.answers[question.id]).toBe('A');
      expect(automatic.results[0]!.status).toBe('correct');
      const replay = await f.host.invoke('qbank_submit_practice', {
        id: first.id, revision: latest.revision,
      }) as PracticeAttempt;
      expect(replay.results[0]!.submission_id).toBe(automatic.results[0]!.submission_id);
    } finally { await f.dispose(); }
  });

  // qbank_practice.rs:509 `parse_from_rfc3339(deadline).map_err(db_error)`：坏 deadline 透传 chrono ParseError 原文（V05-04）。
  it('submit_with_corrupt_deadline_reports_chrono_parse_error_text', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      await createPractice(f.host, [question.id], { mode: 'timed', duration_seconds: 600 });
      for (const [deadline, message] of [
        ['2026-01-01T00:00:00', 'premature end of input'],
        ['2026/01/01T00:00:00Z', 'input contains invalid characters'],
        ['2026-02-30T00:00:00Z', 'input is out of range'],
        ['2026-01-01T00:00:00Z ', 'trailing input'],
      ] as const) {
        f.db.run(`UPDATE qbank_practice_drafts SET document_json = json_set(document_json, '$.deadline', ?1)
          WHERE id = 'practice_1'`, [deadline]);
        await expect(f.host.invoke('qbank_submit_practice', { id: 'practice_1', revision: 1 }))
          .rejects.toEqual({ error_type: 'Database', message, details: null });
      }
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM qbank_practice_drafts WHERE id = 'practice_1'")).toBe(1);
    } finally { await f.dispose(); }
  });

  it('retry_practice_grading_requires_failed_result_and_requeues_job', async () => {
    const f = await fixture();
    try {
      const essay = await f.host.invoke('qbank_create_question', {
        params: params('论述题', { question_type: 'essay', answer: null, options: null }),
      }) as Question;
      const draft = await createPractice(f.host, [essay.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: draft.revision, answers: { [essay.id]: '回答' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', {
        id: draft.id, revision: 2,
      }) as PracticeAttempt;
      await expect(f.host.invoke('qbank_retry_practice_grading', {
        id: attempt.id, questionId: essay.id,
      })).rejects.toMatchObject({
        error_type: 'Validation', message: 'Only failed grading can be retried',
      });
      const failed = structuredClone(attempt);
      failed.results[0]!.status = 'failed';
      failed.results[0]!.error = 'truncated';
      failed.status = 'needs_review';
      f.db.run('UPDATE qbank_practice_attempts SET document_json = ?1 WHERE id = ?2',
        [JSON.stringify(failed), attempt.id]);
      f.db.run("UPDATE qbank_practice_jobs SET status = 'failed' WHERE attempt_id = ?1 AND question_id = ?2",
        [attempt.id, essay.id]);
      const retried = await f.host.invoke('qbank_retry_practice_grading', {
        id: attempt.id, questionId: essay.id,
      }) as PracticeAttempt;
      expect(retried.results[0]).toMatchObject({ status: 'pending', error: null });
      expect(retried.status).toBe('grading');
      expect(f.db.pluck<string>(
        'SELECT status FROM qbank_practice_jobs WHERE attempt_id = ?1 AND question_id = ?2',
        [attempt.id, essay.id])).toBe('queued');
    } finally { await f.dispose(); }
  });

  it('failed_practice_grading_retains_drafts_on_reload_without_grades_or_learning_writes', async () => {
    const f = await fixture();
    try {
      const essay = await f.host.invoke('qbank_create_question', {
        params: params('论述题', { question_type: 'essay', answer: null, options: null }),
      }) as Question;
      const draft = await createPractice(f.host, [essay.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: draft.revision, answers: { [essay.id]: 'My answer' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', {
        id: draft.id, revision: 2,
      }) as PracticeAttempt;
      const submissionId = attempt.results[0]!.submission_id!;
      const diagnostics = {
        status: 'truncated' as const, model: 'test', model_config_id: 'test-id',
        max_output_tokens: 128000, finish_reason: 'length', usage: { completion_tokens: 128000 },
        response_chars: 7, reasoning_chars: 90000, http_status: 200, error_message: 'truncated',
      };
      for (const text of ['draft one', 'draft two']) {
        attempt.results[0]!.status = 'pending';
        practiceService.recordGradingFailure(attempt.results[0]!, {
          error: { message: 'truncated' }, feedback: text, diagnostics,
        });
      }
      practiceService.refreshStatus(attempt);
      expect(attempt.status).toBe('needs_review');
      expect(attempt.results[0]).toMatchObject({
        status: 'failed', is_correct: null, score: null, feedback: null,
      });
      expect(attempt.results[0]!.grading_drafts).toHaveLength(2);
      expect(attempt.results[0]!.grading_drafts[0]!.feedback).toBe('draft one');
      expect(attempt.results[0]!.grading_drafts[1]!.diagnostics?.finish_reason).toBe('length');
      expect(persistAttempt(f.db, attempt, NOW)).toBe(1);
      const loaded = loadAttempt(f.db, attempt.id)!;
      expect(loaded.status).toBe('needs_review');
      expect(loaded.results[0]).toMatchObject({
        status: 'failed', is_correct: null, score: null, feedback: null,
      });
      expect(loaded.results[0]!.grading_drafts).toHaveLength(2);
      expect(f.db.get<{ is_correct: number | null }>(
        'SELECT is_correct FROM answer_submissions WHERE id = ?1', [submissionId])!.is_correct)
        .toBeNull();
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM mastery_events')).toBe(0);
      expect(f.db.pluck<number>('SELECT correct_count FROM questions WHERE id = ?1', [essay.id]))
        .toBe(0);
    } finally { await f.dispose(); }
  });

  it('practice_verdict_persistence_error_rolls_back_partial_learning_writes', async () => {
    const f = await fixture();
    try {
      const essay = await f.host.invoke('qbank_create_question', {
        params: params('论述题', { question_type: 'essay', answer: null, options: null }),
      }) as Question;
      const draft = await createPractice(f.host, [essay.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: draft.revision, answers: { [essay.id]: 'My answer' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', {
        id: draft.id, revision: 2,
      }) as PracticeAttempt;
      const sid = attempt.results[0]!.submission_id!;
      f.db.transaction(tx => {
        tx.exec("CREATE TEMP TRIGGER fail_practice_grade BEFORE UPDATE ON questions "
          + "BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;");
        let failure: unknown = null;
        try {
          practiceService.applyPracticeVerdict(
            { db: f.db, deviceId: 'qbank-test-device', questions: questionRepo, mastery: () => ({
              recordQbankAnswerWithConn: () => ({}),
              recordQbankVerdictCorrectionWithConn: () => ({}),
              syncLearnerProfile: () => undefined,
            }) },
            tx, essay.id, sid, true);
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('disk write failed');
        practiceService.recordGradingFailure(attempt.results[0]!, {
          error: { message: (failure as Error).message },
          feedback: 'Finished feedback <verdict>correct</verdict>', diagnostics: null,
        });
        practiceService.refreshStatus(attempt);
        expect(persistAttempt(tx, attempt, NOW)).toBe(1);
      });
      expect(f.db.get<{ is_correct: number | null }>(
        'SELECT is_correct FROM answer_submissions WHERE id = ?1', [sid])!.is_correct).toBeNull();
      expect(loadAttempt(f.db, attempt.id)!.results[0]!.grading_drafts).toHaveLength(1);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM mastery_events')).toBe(0);
      expect(f.db.pluck<number>('SELECT correct_count FROM questions WHERE id = ?1', [essay.id]))
        .toBe(0);
    } finally { await f.dispose(); }
  });

  it('subjective_answers_are_pending_and_unanswered_are_not_wrong', async () => {
    const f = await fixture();
    try {
      const essay = await f.host.invoke('qbank_create_question', {
        params: params('论述题', { question_type: 'essay', answer: null, options: null }),
      }) as Question;
      const choice = await f.host.invoke('qbank_create_question', { params: params('选择题') }) as Question;
      const draft = await createPractice(f.host, [essay.id, choice.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: draft.revision, answers: { [essay.id]: '我的论述' },
          marked_ids: [], current_index: 0, elapsed_seconds: 4 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', { id: draft.id, revision: 2 }) as PracticeAttempt;
      expect(attempt.status).toBe('grading');
      expect(attempt.results).toEqual([
        expect.objectContaining({ question_id: essay.id, status: 'pending', is_correct: null, score: null,
          submission_id: expect.stringMatching(/^as_/) as unknown as string, source_available: true }),
        expect.objectContaining({ question_id: choice.id, status: 'unanswered', is_correct: null, score: null,
          submission_id: null, source_available: true }),
      ]);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM qbank_practice_jobs WHERE status = ?1', ['queued'])).toBe(1);

      await expect(f.host.invoke('qbank_grade_practice_manually', {
        id: attempt.id, questionId: choice.id, correct: true,
      })).rejects.toMatchObject({ error_type: 'Validation', message: 'Cannot grade an unanswered question' });

      const graded = await f.host.invoke('qbank_grade_practice_manually', {
        id: attempt.id, questionId: essay.id, correct: true,
      }) as PracticeAttempt;
      expect(graded.status).toBe('completed');
      expect(graded.results[0]).toMatchObject({ status: 'correct', is_correct: true, score: 100, error: null });
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM qbank_practice_jobs WHERE status = ?1', ['done'])).toBe(1);
      const question = await f.host.invoke('qbank_get_question', { questionId: essay.id }) as Question;
      expect(question).toMatchObject({ attempt_count: 1, correct_count: 1, is_correct: true, status: 'in_progress' });
    } finally { await f.dispose(); }
  });

  it('grading_uses_frozen_answer_even_after_source_changes_or_is_deleted', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: 1, answers: { [question.id]: 'A' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const second = await createPractice(f.host, [question.id], {
        id: 'practice_2', mode: 'paper',
      });
      await f.host.invoke('qbank_save_practice', {
        request: { id: second.id, revision: 1, answers: { [question.id]: 'A' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      await f.host.invoke('qbank_update_question', {
        request: { question_id: question.id, params: { answer: 'B' }, record_history: false },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', { id: draft.id, revision: 2 }) as PracticeAttempt;
      expect(attempt.results[0]).toMatchObject({ status: 'correct', is_correct: true });

      await f.host.invoke('qbank_delete_question', { questionId: question.id });
      const deleted = await f.host.invoke('qbank_submit_practice', { id: second.id, revision: 2 }) as PracticeAttempt;
      expect(deleted.results[0]).toMatchObject({
        status: 'correct', is_correct: true, submission_id: null, source_available: false,
      });
    } finally { await f.dispose(); }
  });

  it('snapshots_retain_question_and_answer_image_references', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', {
        params: params('带图题', {
          images: [
            { id: 'img_q', name: '题干.png', mime: 'image/png', hash: 'hash-q', role: 'question' },
            { id: 'img_a', name: '答案.png', mime: 'image/png', hash: 'hash-a', role: 'answer' },
          ],
        }),
      }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: 1, answers: { [question.id]: 'A' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', { id: draft.id, revision: 2 }) as PracticeAttempt;
      const snapshot = f.db.get<{ question_snapshot_json: string; material_snapshot_json: string }>(
        'SELECT question_snapshot_json, material_snapshot_json FROM answer_submissions WHERE id = ?1',
        [attempt.results[0]!.submission_id!]);
      expect(snapshot).not.toBeNull();
      expect(JSON.parse(snapshot!.question_snapshot_json)).toMatchObject({
        id: question.id, answer: 'A',
        images: [
          { id: 'img_q', hash: 'hash-q', role: 'question' },
          { id: 'img_a', hash: 'hash-a', role: 'answer' },
        ],
      });
      expect(JSON.parse(snapshot!.material_snapshot_json)).toEqual([]);

      // Rust qbank_practice.rs:1491-1506: rewrite a draft snapshot, then ask the
      // published retains_asset owner method (used by L11 purge/attachment cleanup).
      const retained = await createPractice(f.host, [question.id], { id: 'practice_retain' });
      const raw = JSON.parse(f.db.pluck<string>(
        'SELECT document_json FROM qbank_practice_drafts WHERE id = ?1', [retained.id])!) as {
        questions: { images: unknown }[]; answers: Record<string, string>;
      };
      raw.questions[0]!.images = [{ id: 'snapshot-image', hash: 'snapshot-hash', name: 'image', mime: 'image/png' }];
      raw.answers[question.id] = JSON.stringify({ type: 'image_answer', images: [{ id: 'answer-image', hash: 'answer-hash' }] });
      f.db.run('UPDATE qbank_practice_drafts SET document_json=?2 WHERE id=?1', [retained.id, JSON.stringify(raw)]);
      const cascade = f.host.ctx.qbank.examCascade;
      expect(cascade.retainsAssetWithConn(f.db, 'snapshot-image')).toBe(true);
      expect(cascade.retainsAssetWithConn(f.db, 'answer-hash')).toBe(true);
      expect(cascade.retainsAssetWithConn(f.db, 'unrelated')).toBe(false);
    } finally { await f.dispose(); }
  });

  it('historical_correction_does_not_replace_a_newer_answer_verdict', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      await f.host.invoke('qbank_save_practice', {
        request: { id: draft.id, revision: 1, answers: { [question.id]: 'B' },
          marked_ids: [], current_index: 0, elapsed_seconds: 1 },
      });
      const attempt = await f.host.invoke('qbank_submit_practice', { id: draft.id, revision: 2 }) as PracticeAttempt;
      expect(attempt.results[0]).toMatchObject({ status: 'incorrect', is_correct: false });
      const practiceSubmission = attempt.results[0]!.submission_id!;
      const newer = await f.host.invoke('qbank_submit_answer', {
        request: { question_id: question.id, user_answer: 'B', client_request_id: 'newer-answer' },
      }) as SubmitAnswerResult;
      expect(newer.updated_question).toMatchObject({ is_correct: false, status: 'review' });

      const corrected = await f.host.invoke('qbank_grade_practice_manually', {
        id: attempt.id, questionId: question.id, correct: true,
      }) as PracticeAttempt;
      expect(corrected.results[0]).toMatchObject({ status: 'correct', is_correct: true });
      const live = await f.host.invoke('qbank_get_question', { questionId: question.id }) as Question;
      expect(live).toMatchObject({ is_correct: false, status: 'review', user_answer: 'B', correct_count: 1 });
      expect(f.db.get<{ is_correct: number; grading_method: string }>(
        'SELECT is_correct, grading_method FROM answer_submissions WHERE id = ?1', [practiceSubmission]))
        .toEqual({ is_correct: 1, grading_method: 'manual' });
      expect(live.attempt_count).toBe(2);
    } finally { await f.dispose(); }
  });

  it('papers_keep_answers_when_export_hides_them_and_restore_with_the_exam', async () => {
    const f = await fixture();
    try {
      await f.host.invoke('qbank_create_question', { params: params() });
      const paper = await f.host.invoke('qbank_generate_paper', {
        request: {
          exam_id: 'exam_1',
          config: {
            title: '试卷一', type_selection: {}, shuffle: false,
            include_answers: false, include_explanations: false, export_format: 'preview',
          },
        },
      }) as GeneratedPaper;
      // include_answers 只影响导出视图，试卷文档本身保留答案。
      expect(paper.questions[0]!.answer).toBe('A');
      const loaded = await f.host.invoke('qbank_get_paper', { id: paper.id }) as GeneratedPaper;
      expect(loaded.questions).toHaveLength(1);

      // 真实插件服务：ExamRepo 的 qbank 级联解析器由 vfs-repos 插件构造时注入。
      const exams = (f.host.ctx.vfsRepo as VfsReposService).exams;
      exams.deleteExamSheet(f.db, 'exam_1');
      await expect(f.host.invoke('qbank_get_paper', { id: paper.id })).rejects.toThrow();
      exams.restoreExam(f.db, 'exam_1');
      const restored = await f.host.invoke('qbank_get_paper', { id: paper.id }) as GeneratedPaper;
      expect(restored.questions).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  // X6-unchecked-decode-qbank-practice-8: document_json follows qbank_practice.rs `decode`
  // (serde_json::from_str::<PracticeDraft>), not an unchecked cast.
  it('persisted_practice_draft_decodes_with_serde_field_rules', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      const stored = () => JSON.parse(f.db.pluck<string>(
        'SELECT document_json FROM qbank_practice_drafts WHERE id = ?1', [draft.id])!) as Record<string, unknown>;
      const write = (doc: unknown) => f.db.run(
        'UPDATE qbank_practice_drafts SET document_json=?2 WHERE id=?1', [draft.id, JSON.stringify(doc)]);
      const get = () => f.host.invoke('qbank_get_practice', { id: draft.id, submitted: false });
      const original = stored();

      // Unknown keys are ignored; a missing Option (`deadline`) and `#[serde(default)]` Vec
      // (`materials` on Question) decode to None / [].
      const loose = structuredClone(original);
      loose.extra_key = 1;
      delete loose.deadline;
      delete (loose.questions as Record<string, unknown>[])[0]!.materials;
      write(loose);
      const decoded = await get() as PracticeDraft;
      expect(decoded).not.toHaveProperty('extra_key');
      expect(decoded.deadline).toBeNull();
      expect(decoded.questions[0]!.materials).toEqual([]);
      // Unit enum variants also accept serde's map form.
      const mapped = structuredClone(original);
      (mapped.questions as Record<string, unknown>[])[0]!.question_type = { single_choice: null };
      write(mapped);
      expect((await get() as PracticeDraft).questions[0]!.question_type).toBe('single_choice');

      // Required field missing, wrong integer width and unknown enum variant are database errors.
      const missing = structuredClone(original);
      delete missing.revision;
      write(missing);
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('missing field `revision`') });
      write({ ...original, elapsed_seconds: -1 });
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('expected u32') });
      write({ ...original, current_index: 1.5 });
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('floating point') });
      const badEnum = structuredClone(original);
      (badEnum.questions as Record<string, unknown>[])[0]!.status = 'archived';
      write(badEnum);
      await expect(get()).rejects.toMatchObject({ error_type: 'Database', message: expect.stringContaining('unknown variant `archived`') });

      write(original);
      expect(await get()).toEqual(draft);
    } finally { await f.dispose(); }
  });

  // qbank_practice.rs:131 `serde_json::from_str::<T>`（arbitrary_precision）：typed 整数字段拒绝 `2.0` 这类
  // 小数 token（serde_json JsonUnexpected 文案）；Question.structured_data 的 Value 数字原文不变。
  it('persisted_practice_documents_decode_number_tokens_like_serde_json', async () => {
    const f = await fixture();
    try {
      const question = await f.host.invoke('qbank_create_question', { params: params() }) as Question;
      const draft = await createPractice(f.host, [question.id]);
      const raw = f.db.pluck<string>('SELECT document_json FROM qbank_practice_drafts WHERE id = ?1', [draft.id])!;
      const write = (text: string) => f.db.run(
        'UPDATE qbank_practice_drafts SET document_json=?2 WHERE id=?1', [draft.id, text]);
      write(raw.replace('"current_index":0', '"current_index":2.0'));
      await expect(f.host.invoke('qbank_get_practice', { id: draft.id, submitted: false })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('invalid type: floating point `2.0`, expected usize') });
      write(raw.replace('"elapsed_seconds":0', '"elapsed_seconds":1e0'));
      await expect(f.host.invoke('qbank_get_practice', { id: draft.id, submitted: false })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('invalid type: floating point `1.0`, expected u32') });

      const paper = await f.host.invoke('qbank_generate_paper', {
        request: { exam_id: 'exam_1', config: {
          title: '试卷', type_selection: {}, shuffle: false, include_answers: true, include_explanations: true,
          export_format: 'preview',
        } },
      }) as GeneratedPaper;
      const structured = '{"answer_value":2.50,"tolerance":1e-2,"big":12345678901234567890}';
      const document = f.db.pluck<string>('SELECT document_json FROM qbank_papers WHERE id = ?1', [paper.id])!;
      expect(document).toContain('"structured_data":null');
      f.db.run('UPDATE qbank_papers SET document_json = ?2 WHERE id = ?1',
        [paper.id, document.replace('"structured_data":null', `"structured_data":${structured}`)]);
      const outcome = await f.host.runtime.dispatchInvoke({
        id: 'paper-lossless', cmd: 'qbank_get_paper', args: { id: paper.id },
        source: { window: 'main', webview: 'main' },
      });
      if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome));
      expect(outcome.json).toContain(`"structured_data":${structured}`);
    } finally { await f.dispose(); }
  });
});
