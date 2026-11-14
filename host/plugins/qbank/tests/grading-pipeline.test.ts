/**
 * `qbank_grading/pipeline.rs` 的落库/失败草稿/通用解析回填测试。
 *
 * 数据库用真实迁移后的 vfs 库；mastery 用真实 review 插件组合（仅在测试中组合，
 * 生产由 Cordis 服务提供）。LLM 传输是 L02 的职责，这里用与 Rust 相同的 SSE 帧
 * 驱动 `GradingStreamState` 的测试替身。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import review from '../../review/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import qbank from '../index.ts';
import type { CreateQuestionParams, Question } from '../api.ts';
import * as repo from '../repository/questions.ts';
import { vfsCreateParams } from '../src/question-repository-adapter.ts';
import {
  AppErrorThrow, persistDraftFeedback, persistFailedGrading, persistGradingResult,
  runQbankGrading, type GradingCompletion, type GradingHost,
} from '../src/grading-service.ts';
import { GradingStreamState } from '../src/grading-stream.ts';
import {
  resetProgress, submitAnswer, type MasteryRecorder, type QuestionServiceHost,
} from '../src/question-service.ts';

const NOW = '2020-01-01T00:00:00Z';

function fakeLlm(config: Partial<ApiConfig> = {}): LLMManager {
  const resolved = {
    id: 'cfg_test', model: 'test-reasoner', apiKey: 'enc-key', isMultimodal: false,
    isEmbedding: false, isReranker: false, enabled: true, maxOutputTokens: 128000,
    maxTokensLimit: null, ...config,
  } as ApiConfig;
  return {
    getApiConfigs: async () => [resolved],
    getModelAssignments: async () => ({ qbank_ai_grading_model_config_id: null }),
    getModel2Config: async () => resolved,
    decryptApiKey: async (apiKey: string) => apiKey,
    consumePendingCancel: async () => false,
  } as unknown as LLMManager;
}

async function fixture(options: { llm?: LLMManager } = {}) {
  const { storage, base } = await createMigratedStorage('qbank-grading-pipeline-');
  const host = await createTestHost({
    plugins: [review, vfsRepos, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
    },
  });
  const db = storage.database('vfs');
  const mastery = host.ctx.mastery as unknown as MasteryRecorder;
  const questions = (host.ctx.vfsRepo as VfsReposService).questions;
  const questionHost: QuestionServiceHost = { db, questions, mastery: () => mastery };
  const gradingHost: GradingHost = {
    db,
    questions,
    mastery: () => mastery,
    llm: options.llm ?? fakeLlm(),
    blobsDir: path.join(base, 'vfs_blobs'),
    images: host.ctx.vfsRepo,
    log: { warn: () => undefined, error: () => undefined, debug: () => undefined },
  };
  return {
    base, host, storage, db, gradingHost, questionHost, questions,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function questionParams(examId: string): CreateQuestionParams {
  return {
    exam_id: examId,
    card_id: null,
    question_label: '1',
    content: '简述牛顿第二定律',
    options: null,
    answer: 'F = ma',
    explanation: null,
    structured_data: null,
    question_type: null,
    difficulty: null,
    tags: ['牛顿定律'],
    source_type: null,
    source_ref: null,
    images: null,
    parent_id: null,
  };
}

function seedQuestion(f: Fixture): Question {
  const examId = `exam_${Math.random().toString(36).slice(2, 10)}`;
  f.db.run(`INSERT INTO exam_sheets (
      id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
    ) VALUES (?1, 'pipeline persist test', 'completed', ?2, '{}', '{}', ?3, ?3)`,
  [examId, `temp_${examId}`, NOW]);
  return f.questions.createQuestion(f.db, vfsCreateParams(questionParams(examId)));
}

function seedQuestionWithSubmission(f: Fixture, firstVerdict: boolean | null):
{ question: Question; submissionId: string } {
  const created = seedQuestion(f);
  const submissionId = firstVerdict === null
    ? f.questions.insertSubmission(f.db, created.id, '学生答案', null, 'auto', null)
    : submitAnswer(f.gradingHost, created.id, '学生答案', firstVerdict, null).submission_id!;
  const question = f.questions.getQuestion(f.db, created.id);
  if (question === null) throw new Error('question reload failed');
  return { question, submissionId };
}

function questionCounters(db: DatabaseHandle, questionId: string): {
  correct_count: number; is_correct: number | null; status: string; attempt_count: number;
} {
  return db.one(`SELECT correct_count, is_correct, status, attempt_count
    FROM questions WHERE id = ?1`, [questionId]);
}

function submissionState(db: DatabaseHandle, submissionId: string): {
  is_correct: number | null; grading_method: string;
} {
  return db.one(`SELECT is_correct, grading_method FROM answer_submissions WHERE id = ?1`,
    [submissionId]);
}

function liveMasteryEvents(db: DatabaseHandle, submissionId: string, outcome: string): number {
  return db.pluck<number>(`SELECT COUNT(*) FROM mastery_events
    WHERE id LIKE ?1 AND outcome = ?2 AND deleted_at IS NULL`,
  [`me_qbank_${submissionId}%`, outcome]) ?? 0;
}

function draftHistory(db: DatabaseHandle, questionId: string): {
  feedback: string; diagnostics: { status: string; usage: Record<string, unknown> | null;
    max_output_tokens: number };
} {
  const raw = db.pluck<string>(`SELECT new_value FROM question_history
    WHERE question_id = ?1 AND field_name = 'ai_grading_draft'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`, [questionId]);
  if (raw === undefined) throw new Error('draft history missing');
  return JSON.parse(raw) as {
    feedback: string; diagnostics: { status: string; usage: Record<string, unknown> | null;
      max_output_tokens: number };
  };
}

describe('qbank_grading/pipeline.rs', () => {
  it('explicit config resolution failures keep their LLM error type and message', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, null);
      const cases: Array<[Partial<ApiConfig>, string, string]> = [
        [{ id: 'cfg_off', enabled: false }, 'cfg_off', '模型配置已禁用: cfg_off'],
        [{}, 'cfg_missing', '未找到模型配置: cfg_missing'],
        [{ id: 'cfg_emb', isEmbedding: true }, 'cfg_emb', '嵌入模型不支持 AI 评判: cfg_emb'],
      ];
      for (const [config, modelConfigId, message] of cases) {
        const emitted: string[] = [];
        const failure = await runQbankGrading({ ...f.gradingHost, llm: fakeLlm(config) }, {
          question_id: question.id,
          submission_id: submissionId,
          stream_session_id: `stream_cfg_${modelConfigId}`,
          mode: 'grade',
          model_config_id: modelConfigId,
        }, { run: async () => ({ error: null }) } as unknown as GradingCompletion, {
          emitData: () => undefined,
          emitComplete: () => undefined,
          emitError: (_session, text) => { emitted.push(text); },
          emitFailure: () => undefined,
          emitCancelled: () => undefined,
        }).then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(AppErrorThrow);
        expect((failure as AppErrorThrow).appError).toMatchObject({ error_type: 'LLM', message });
        expect(emitted).toEqual([message]);
      }
    } finally {
      await f.dispose();
    }
  });

  it('grading_request_respects_configured_budget_and_preserves_terminal_failures', async () => {
    const f = await fixture();
    try {
      const cases: Array<[string, string, number | null]> = [
        ['stop', 'completed', null],
        ['length', 'truncated', null],
        ['content_filter', 'provider_error', null],
        ['stop', 'completed', 64000],
      ];
      for (const [finish, expected, providerLimit] of cases) {
        const llm = fakeLlm({ maxTokensLimit: providerLimit });
        const gradingHost: GradingHost = { ...f.gradingHost, llm };
        const { question, submissionId } = seedQuestionWithSubmission(f, null);
        const completion: GradingCompletion = {
          async run(input) {
            const adapter = new OpenAIAdapter();
            const body = [
              'data: {"choices":[{"delta":{"content":"Draft <verdict>correct</verdict>"},'
                + '"finish_reason":null}]}',
              `data: {"choices":[{"delta":{},"finish_reason":"${finish}"}]}`,
              'data: {"choices":[],"usage":{"completion_tokens":9000}}',
              'data: [DONE]',
            ];
            for (const block of body) {
              input.stream.processBlock(adapter, block, input.onChunk);
            }
            input.stream.finishAdapter(adapter, input.onChunk);
            return { error: input.stream.complete(false, null) };
          },
        };
        const request = {
          question_id: question.id,
          submission_id: submissionId,
          stream_session_id: `stream_${finish}_${providerLimit ?? 'default'}_`
            + Math.random().toString(36).slice(2, 8),
          mode: 'grade' as const,
          model_config_id: null,
        };
        if (expected === 'completed') {
          const response = await runQbankGrading(gradingHost, request, completion, {
            emitData: () => undefined,
            emitComplete: () => undefined,
            emitError: () => undefined,
            emitFailure: () => undefined,
            emitCancelled: () => undefined,
          });
          const diagnostics = response?.diagnostics;
          expect(diagnostics?.status).toBe('completed');
          expect(response?.feedback).toContain('<verdict>correct</verdict>');
          expect(diagnostics?.usage).toMatchObject({ completion_tokens: 9000 });
          expect(diagnostics?.max_output_tokens).toBe(providerLimit ?? 128000);
        } else {
          await expect(runQbankGrading(gradingHost, request, completion, {
            emitData: () => undefined,
            emitComplete: () => undefined,
            emitError: () => undefined,
            emitFailure: () => undefined,
            emitCancelled: () => undefined,
          })).rejects.toBeInstanceOf(AppErrorThrow);
          const draft = draftHistory(f.db, question.id);
          expect(draft.diagnostics.status).toBe(expected);
          expect(draft.diagnostics.usage).toMatchObject({ completion_tokens: 9000 });
          expect(draft.diagnostics.max_output_tokens).toBe(providerLimit ?? 128000);
        }
      }
    } finally {
      await f.dispose();
    }
  });

  it('failed_grading_persists_draft_and_diagnostics_without_applying_verdict', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, null);
      const state = new GradingStreamState({ max_output_tokens: 128000 });
      state.diagnostics.status = 'truncated';
      state.diagnostics.finish_reason = 'length';
      const draft = 'partial feedback <verdict>correct</verdict>';
      persistFailedGrading(f.questions, f.db, question, draft, state.diagnostics);

      expect(submissionState(f.db, submissionId).is_correct).toBeNull();
      const updated = repo.getQuestion(f.db, question.id)!;
      expect(updated.ai_feedback).toBe(question.ai_feedback);
      expect(updated.ai_score).toBeNull();
      expect(updated.correct_count).toBe(question.correct_count);
      expect(updated.explanation).toBe(question.explanation);
      const saved = draftHistory(f.db, question.id);
      expect(saved.feedback).toBe(draft);
      expect(saved.diagnostics.status).toBe('truncated');
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM mastery_events')).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('persist_grade_first_verdict_null_to_true_counts_once', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, null);
      const outcome = persistGradingResult(f.db, f.gradingHost, question, 'grade', submissionId,
        '解析…<verdict>correct</verdict><score value="90"/>', 'correct', 90, false)
        .outcome;
      expect(outcome).not.toBeNull();
      expect(questionCounters(f.db, question.id)).toEqual({
        correct_count: 1, is_correct: 1, status: 'in_progress', attempt_count: 0,
      });
      expect(submissionState(f.db, submissionId)).toEqual({
        is_correct: 1, grading_method: 'ai',
      });
      expect(liveMasteryEvents(f.db, submissionId, 'correct')).toBe(1);
      expect(outcome?.needs_review_plan).toBe(false);

      const reloaded = repo.getQuestion(f.db, question.id)!;
      persistGradingResult(f.db, f.gradingHost, reloaded, 'grade', submissionId,
        '重评…<verdict>correct</verdict><score value="92"/>', 'correct', 92, false);
      expect(questionCounters(f.db, question.id).correct_count).toBe(1);
      expect(liveMasteryEvents(f.db, submissionId, 'correct')).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it('persist_grade_false_to_true_increments_correct_count', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, false);
      expect(question.correct_count).toBe(0);
      expect(question.is_correct).toBe(false);
      const baselineAttempts = question.attempt_count;

      const outcome = persistGradingResult(f.db, f.gradingHost, question, 'grade', submissionId,
        '其实答对了…<verdict>correct</verdict><score value="85"/>', 'correct', 85, false)
        .outcome;
      expect(questionCounters(f.db, question.id)).toEqual({
        correct_count: 1, is_correct: 1, status: 'in_progress', attempt_count: baselineAttempts,
      });
      expect(submissionState(f.db, submissionId)).toEqual({
        is_correct: 1, grading_method: 'ai',
      });
      expect(liveMasteryEvents(f.db, submissionId, 'correct')).toBe(1);
      expect(liveMasteryEvents(f.db, submissionId, 'wrong')).toBe(0);
      expect(outcome?.needs_review_plan).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('persist_grade_true_to_false_decrements_correct_count', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, true);
      expect(question.correct_count).toBe(1);
      expect(question.is_correct).toBe(true);
      const baselineAttempts = question.attempt_count;

      const outcome = persistGradingResult(f.db, f.gradingHost, question, 'grade', submissionId,
        '其实答错了…<verdict>incorrect</verdict><score value="20"/>', 'incorrect', 20, false)
        .outcome;
      expect(questionCounters(f.db, question.id)).toEqual({
        correct_count: 0, is_correct: 0, status: 'review', attempt_count: baselineAttempts,
      });
      expect(submissionState(f.db, submissionId)).toEqual({
        is_correct: 0, grading_method: 'ai',
      });
      expect(liveMasteryEvents(f.db, submissionId, 'wrong')).toBe(1);
      expect(liveMasteryEvents(f.db, submissionId, 'correct')).toBe(0);
      expect(outcome?.needs_review_plan).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('n13_draft_feedback_preserves_score_counters_and_mastery', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, true);
      expect(question.correct_count).toBe(1);
      f.db.run(`UPDATE questions SET ai_score = 88, ai_feedback = 'complete feedback',
        ai_graded_at = '2020-01-01' WHERE id = ?1`, [question.id]);

      const draft = '输出格式示例：verdict: correct, score: 100\n下面开始分析……（流在此中断）';
      persistDraftFeedback(f.questions, f.db, question, draft, null);

      expect(questionCounters(f.db, question.id)).toEqual({
        correct_count: 1, is_correct: 1, status: 'in_progress', attempt_count: 1,
      });
      const ai = f.db.one<{ ai_score: number | null; ai_feedback: string | null;
        ai_graded_at: string | null }>(
        'SELECT ai_score, ai_feedback, ai_graded_at FROM questions WHERE id = ?1', [question.id]);
      expect(ai.ai_score).toBe(88);
      expect(ai.ai_feedback).toBe('complete feedback');
      expect(ai.ai_graded_at).toBe('2020-01-01');
      expect(draftHistory(f.db, question.id).feedback).toBe(draft);
      expect(submissionState(f.db, submissionId)).toEqual({
        is_correct: 1, grading_method: 'manual',
      });
      expect(liveMasteryEvents(f.db, submissionId, 'correct')).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it('n13_draft_feedback_missing_question_errors', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      const ghost = { ...question, id: 'question_ghost' };
      expect(() => persistDraftFeedback(f.questions, f.db, ghost, 'draft', null))
        .toThrowError(/题目不存在：question_ghost/);
    } finally {
      await f.dispose();
    }
  });

  it('persist_standalone_analyze_fills_empty_explanation', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      const before = questionCounters(f.db, question.id);
      const persisted = persistGradingResult(f.db, f.gradingHost, question, 'analyze', null,
        '**解题思路**：F = ma', null, null, true);
      expect(persisted.outcome).toBeNull();
      expect(persisted.explanationWritten).toBe(true);
      const fields = f.db.one<{ explanation: string | null; ai_feedback: string | null }>(
        'SELECT explanation, ai_feedback FROM questions WHERE id = ?1', [question.id]);
      expect(fields.explanation).toBe('**解题思路**：F = ma');
      expect(fields.ai_feedback).toBe('**解题思路**：F = ma');
      expect(f.db.pluck<number>(`SELECT COUNT(*) FROM question_history
        WHERE question_id = ?1 AND field_name = 'explanation' AND operator = 'ai'`,
      [question.id])).toBe(1);
      expect(questionCounters(f.db, question.id)).toEqual(before);
    } finally {
      await f.dispose();
    }
  });

  it('first_explanation_survives_progress_reset_without_answering', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      f.db.run('DELETE FROM answer_submissions WHERE question_id = ?1', [question.id]);
      const persisted = persistGradingResult(f.db, f.gradingHost, question, 'analyze', null,
        '**解题思路**：F = ma', null, null, true);
      expect(persisted.explanationWritten).toBe(true);
      expect(f.db.pluck<number>(
        'SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1', [question.id])).toBe(0);
      resetProgress(f.gradingHost, question.exam_id);
      const reloaded = repo.getQuestion(f.db, question.id)!;
      expect(reloaded.explanation).toBe('**解题思路**：F = ma');
      expect(reloaded.attempt_count).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('standalone analyze fills the explanation with one conditional UPDATE like pipeline.rs fill_explanation_if_empty', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      const changeLog = () => f.db.pluck<number>(
        "SELECT COUNT(*) FROM __change_log WHERE table_name = 'questions' AND record_id = ?1", [question.id])!;
      const before = changeLog();
      persistGradingResult(f.db, f.gradingHost, question, 'analyze', null, '**解题思路**：F = ma', null, null, true);
      // ai cache 1 + (explanation, sync mark, content hash) × (statement + updated_at trigger) = 7
      expect(changeLog() - before).toBe(7);
      expect(f.db.all<{ field_name: string; new_value: string; operator: string }>(
        'SELECT field_name, new_value, operator FROM question_history WHERE question_id = ?1', [question.id],
      )).toEqual([{ field_name: 'explanation', new_value: '**解题思路**：F = ma', operator: 'ai' }]);
    } finally {
      await f.dispose();
    }
  });

  it('persist_standalone_analyze_never_overwrites_existing_explanation', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      f.db.run("UPDATE questions SET explanation = '老师手写的解析' WHERE id = ?1", [question.id]);
      const persisted = persistGradingResult(f.db, f.gradingHost, question, 'analyze', null,
        'AI 新解析', null, null, true);
      expect(persisted.explanationWritten).toBe(false);
      const fields = f.db.one<{ explanation: string | null; ai_feedback: string | null }>(
        'SELECT explanation, ai_feedback FROM questions WHERE id = ?1', [question.id]);
      expect(fields.explanation).toBe('老师手写的解析');
      expect(fields.ai_feedback).toBe('AI 新解析');
      expect(f.db.pluck<number>(`SELECT COUNT(*) FROM question_history
        WHERE question_id = ?1 AND field_name = 'explanation' AND operator = 'ai'`,
      [question.id])).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('persist_standalone_analyze_treats_blank_explanation_as_empty', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      f.db.run("UPDATE questions SET explanation = '  \n ' WHERE id = ?1", [question.id]);
      const persisted = persistGradingResult(f.db, f.gradingHost, question, 'analyze', null,
        'AI 解析', null, null, true);
      expect(persisted.explanationWritten).toBe(true);
      expect(f.db.pluck<string>('SELECT explanation FROM questions WHERE id = ?1', [question.id]))
        .toBe('AI 解析');
    } finally {
      await f.dispose();
    }
  });

  it('persist_analyze_without_fill_flag_leaves_explanation_alone', async () => {
    const f = await fixture();
    try {
      const { question, submissionId } = seedQuestionWithSubmission(f, false);
      const persisted = persistGradingResult(f.db, f.gradingHost, question, 'analyze',
        submissionId, '针对这次作答的分析', null, null, false);
      expect(persisted.explanationWritten).toBe(false);
      const fields = f.db.one<{ explanation: string | null; ai_feedback: string | null }>(
        'SELECT explanation, ai_feedback FROM questions WHERE id = ?1', [question.id]);
      expect(fields.explanation).toBeNull();
      expect(fields.ai_feedback).toBe('针对这次作答的分析');
    } finally {
      await f.dispose();
    }
  });

  it('persist_grade_without_submission_is_rejected', async () => {
    const f = await fixture();
    try {
      const { question } = seedQuestionWithSubmission(f, null);
      expect(() => persistGradingResult(f.db, f.gradingHost, question, 'grade', null,
        '<verdict>correct</verdict>', 'correct', 100, false))
        .toThrowError(/AI 评判需要作答记录：请先提交答案/);
    } finally {
      await f.dispose();
    }
  });
});
