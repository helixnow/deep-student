import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { formatF64 } from '../../../platform/serde-compat/index.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: 真实 review 插件仅在测试中组合以提供 mastery 服务
import review from '../../review/index.ts';
import qbank from '../index.ts';
import type { QbankGradingRequest } from '../api.ts';
import {
  QBANK_EXTENSION_TOOL_NAMES, QBANK_PENDING_TOOL_NAMES, QBANK_RUST_TOOL_NAMES, QBANK_TOOL_NAMES,
  QBankExecutor, qbankConcurrency, qbankSensitivity, type QbankToolDeps,
} from '../src/tools/qbank-tool-executor.ts';
import { createMigratedStorage } from './support/storage.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-tools-');
  const registered: AgentToolExecutor[] = [];
  const host = await createTestHost({
    plugins: [review, vfsRepos, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-tools-device' } }),
      agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => {
        registered.push(...executors);
        return { dispose: () => undefined };
      } },
    },
  });
  cleanups.push(() => { storage.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  cleanups.push(() => host.dispose());
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{"source_image_hashes":["h1","h2"]}', '{}', ?1, ?1)`, [NOW]);
  const executor = registered.find(entry => entry.name() === 'QBankExecutor') as ToolExecutor | undefined;
  if (executor === undefined) throw new Error('QBankExecutor was not registered');
  return { host, db, executor };
}

interface Recorded { ends: unknown[]; errors: string[]; saved: ToolResultInfo[] }

async function call(executor: ToolExecutor, name: string, args: unknown, windowed = true) {
  const recorded: Recorded = { ends: [], errors: [], saved: [] };
  const ctx = {
    session_id: 'sess', message_id: 'msg', block_id: 'blk', tool_call_id: 'call_q', cancellation_token: null,
    tryWindow: () => (windowed ? { window: 'main', webview: 'main' } : null),
    runId: () => 'call_q',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (result: unknown) => { recorded.ends.push(result); },
    emitToolCallError: (error: string) => { recorded.errors.push(error); },
    saveToolBlock: (result: ToolResultInfo) => { recorded.saved.push(result); },
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: 'call_q', name, arguments: args }, ctx);
  return { result, recorded, output: result.output as Record<string, any> };
}

function errorOf(result: ToolResultInfo): Record<string, any> {
  expect(result.success).toBe(false);
  expect(result.output).toBeNull();
  return JSON.parse(result.error!) as Record<string, any>;
}

/** Tools with an explicit sensitivity; the rest take the executor default. */
const SENSITIVITY: Record<'high' | 'medium' | 'low', string[]> = {
  high: ['qbank_delete_questions', 'qbank_delete_group', 'qbank_delete_material'],
  medium: ['qbank_create_question', 'qbank_toggle_favorite', 'qbank_toggle_bookmark', 'qbank_submit_answer',
    'qbank_update_question', 'qbank_batch_update_questions', 'qbank_generate_paper', 'qbank_batch_import',
    'qbank_review_authoring_draft', 'qbank_commit_authoring_draft', 'qbank_update_group', 'qbank_update_material',
    'qbank_import_document', 'qbank_reset_progress', 'qbank_export', 'qbank_ai_grade', 'qbank_generate_questions'],
  low: ['qbank_start_timed_practice', 'qbank_generate_mock_exam', 'qbank_submit_mock_exam', 'qbank_generate_variant'], // boundary-allow test-double: 领域词 MockExam（模拟考试），非测试替身
};
const READ_ONLY = ['qbank_list', 'qbank_list_questions', 'qbank_get_question', 'qbank_get_submissions',
  'qbank_get_question_history', 'qbank_list_source_images', 'qbank_search_questions', 'qbank_list_papers',
  'qbank_get_paper', 'qbank_list_practices', 'qbank_get_stats', 'qbank_get_learning_trend',
  'qbank_get_activity_heatmap', 'qbank_get_knowledge_stats', 'qbank_get_check_in_calendar'];

describe('QBankExecutor definition', () => {
  it('names match the frontend qbank skill schemas', () => {
    const skill = fs.readFileSync('src/features/chat/skills/builtin-tools/qbank-tools.ts', 'utf8');
    const schemaNames = [...skill.slice(skill.indexOf('embeddedTools')).matchAll(/name: 'builtin-(qbank_[a-z_]+)'/g)]
      .map(m => m[1]);
    // The skill never exposes qbank_submit_mock_exam: scores come from the qbank UI handoff, not the model.
    expect(QBANK_RUST_TOOL_NAMES.filter(name => !schemaNames.includes(name))).toEqual(['qbank_submit_mock_exam']); // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    expect(schemaNames.filter(name => !(QBANK_RUST_TOOL_NAMES as readonly string[]).includes(name!)).sort())
      .toEqual([...QBANK_EXTENSION_TOOL_NAMES].sort());
    expect([...QBANK_TOOL_NAMES, ...QBANK_PENDING_TOOL_NAMES].sort())
      .toEqual([...QBANK_RUST_TOOL_NAMES, ...QBANK_EXTENSION_TOOL_NAMES].sort());
    expect([...QBANK_PENDING_TOOL_NAMES]).toEqual([]);
  });

  it('classifies sensitivity and concurrency per tool', () => {
    for (const [level, names] of Object.entries(SENSITIVITY)) {
      for (const name of names) expect([name, qbankSensitivity(`builtin-${name}`)]).toEqual([name, level]);
    }
    for (const name of QBANK_RUST_TOOL_NAMES) {
      expect([name, qbankConcurrency(name)]).toEqual([name, READ_ONLY.includes(name) ? 'read_only' : 'serial']);
    }
    expect(qbankSensitivity('qbank_list_mistakes')).toBe('low');
    expect(qbankConcurrency('qbank_list_mistakes')).toBe('read_only');
    expect(qbankSensitivity('qbank_update_paper')).toBe('medium');
    expect(qbankConcurrency('qbank_update_paper')).toBe('serial');
    expect(qbankSensitivity('qbank_delete_practice')).toBe('high');
    expect(qbankConcurrency('qbank_delete_practice')).toBe('serial');
  });
});

describe('QBankExecutor user-data management extensions', () => {
  it('lists mistake-book entries with mistake counts and bank stats', async () => {
    const { executor } = await fixture();
    const created = await call(executor, 'qbank_create_question', {
      session_id: 'exam_1', content: '2+2=?', question_type: 'single_choice', card_id: 'm1',
      options: [{ key: 'A', content: '4' }, { key: 'B', content: '5' }], answer: 'A',
    });
    expect(created.result.success).toBe(true);
    const wrong = await call(executor, 'qbank_submit_answer', {
      session_id: 'exam_1', card_id: 'm1', user_answer: 'B',
    });
    expect(wrong.output).toMatchObject({ is_correct: false });

    const listed = await call(executor, 'qbank_list_mistakes', { group_id: 'exam_1', limit: 10 });
    expect(listed.result.success).toBe(true);
    expect(listed.output).toMatchObject({ total: 1, limit: 10, offset: 0, has_more: false, sort: 'errors' });
    expect(listed.output.items[0]).toMatchObject({
      card_id: 'm1', group_id: 'exam_1', exam_name: '题目集一',
      attempt_count: 1, correct_count: 0, mistake_count: 1,
    });
    expect(listed.output.exam_stats).toEqual([
      { group_id: 'exam_1', exam_name: '题目集一', mistake_count: 1 },
    ]);
  });

  it('deletes a practice draft by id and reports the record kind', async () => {
    const { executor } = await fixture();
    const deleted = await call(executor, 'qbank_delete_practice', {
      practice_id: 'practice_missing', submitted: false,
    });
    expect(deleted.result.success).toBe(true);
    expect(deleted.output).toMatchObject({
      success: true, practice_id: 'practice_missing', submitted: false,
    });
  });

  it('renames a saved paper and can move it into the deleted state', async () => {
    const { executor } = await fixture();
    const created = await call(executor, 'qbank_create_question', {
      session_id: 'exam_1', content: '3+3=?', question_type: 'single_choice', card_id: 'p1',
      options: [{ key: 'A', content: '6' }, { key: 'B', content: '7' }], answer: 'A',
    });
    expect(created.result.success).toBe(true);
    const generated = await call(executor, 'qbank_generate_paper', {
      session_id: 'exam_1', title: '旧试卷', question_count: 1,
    });
    expect(generated.result.success).toBe(true);
    const paperId = generated.output.paper_id as string;

    const renamed = await call(executor, 'qbank_update_paper', { paper_id: paperId, title: '新试卷' });
    expect(renamed.result.success).toBe(true);
    expect(renamed.output).toMatchObject({ success: true, paper_id: paperId, title: '新试卷', deleted: false });
    expect(renamed.recorded.ends).toHaveLength(1);

    const fetched = await call(executor, 'qbank_get_paper', { paper_id: paperId });
    expect(fetched.result.success).toBe(true);
    expect(fetched.output.title).toBe('新试卷');

    const removed = await call(executor, 'qbank_update_paper', {
      paper_id: paperId, title: '新试卷', deleted: true,
    });
    expect(removed.result.success).toBe(true);
    expect(removed.output.deleted).toBe(true);
    const afterDelete = await call(executor, 'qbank_get_paper', { paper_id: paperId });
    expect(afterDelete.result.success).toBe(false);
  });
});

describe('QBankExecutor through the qbank plugin', () => {
  it('creates, reads, answers, favorites, updates and deletes with OCC and qbank://changed', async () => {
    const { host, executor } = await fixture();
    expect(executor.canHandle('builtin-qbank_list')).toBe(true);
    expect(executor.canHandle('qbank_export')).toBe(true);
    expect(executor.canHandle('qbank_bogus')).toBe(false);

    const created = await call(executor, 'builtin-qbank_create_question', {
      session_id: 'exam_1', content: '1+1=?', question_type: 'single_choice', card_id: 'c1',
      options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }], answer: 'A', tags: ['算术', '算术'],
    });
    expect(created.result.success).toBe(true);
    const question = created.output.question;
    expect(question).toMatchObject({ exam_id: 'exam_1', card_id: 'c1', content: '1+1=?', tags: ['算术'],
      source_type: 'manual', fieldsTruncated: [] });
    expect(created.output.undo).toEqual({ tool: 'builtin-qbank_delete_questions', requiresApproval: true,
      question_ids: [question.id], expected_updated_at_by_id: { [question.id]: question.updated_at } });
    expect(host.eventsNamed('qbank://changed')).toEqual([
      { source: 'agent', action: 'create_question', entityIds: [question.id], runId: 'call_q' }]);

    const listed = await call(executor, 'qbank_list', {});
    expect(listed.output).toMatchObject({ total: 1, limit: 20, offset: 0, has_more: false });
    expect(listed.output.question_banks[0]).toMatchObject({ session_id: 'exam_1', name: '题目集一',
      stats: { total: 1, new: 1 } });

    const got = await call(executor, 'qbank_get_question', { session_id: 'exam_1', card_id: 'c1' });
    expect(got.output).toMatchObject({ question_id: question.id, card_id: 'c1', occ_supported: true,
      source: 'questions_table', recent_submissions: [] });

    host.events.length = 0;
    const answered = await call(executor, 'qbank_submit_answer', { session_id: 'exam_1', card_id: 'c1', user_answer: 'A' });
    expect(answered.output).toMatchObject({ is_correct: true, correct_answer: 'A', needs_manual_grading: false,
      source: 'questions_table', messageKey: 'chat.tools.qbank.answer_correct' });
    expect(typeof answered.output.submission_id).toBe('string');
    expect(host.eventsNamed('qbank://changed')).toEqual([
      { source: 'agent', action: 'submit_answer', entityIds: ['c1'], runId: 'call_q' }]);

    const submissions = await call(executor, 'qbank_get_submissions', { question_id: question.id });
    expect(submissions.output).toMatchObject({ question_id: question.id, count: 1, limit: 10, has_more: false });
    const stats = await call(executor, 'qbank_get_stats', { session_id: 'exam_1' });
    expect(stats.output).toMatchObject({ total: 1, total_attempts: 1, total_correct: 1, source: 'questions_table' });
    const page = await call(executor, 'qbank_list_questions', { session_id: 'exam_1', page_size: 999 });
    expect(page.output).toMatchObject({ total: 1, page: 1, page_size: 20, source: 'questions_table' });
    expect(page.output.questions[0]).toMatchObject({ card_id: 'c1', attempt_count: 1, has_images: false });
    const next = await call(executor, 'qbank_get_next_question', { session_id: 'exam_1', current_card_id: 'c1' });
    expect(next.output).toMatchObject({ found: false, messageKey: 'chat.tools.qbank.no_more_questions' });

    const current = (await call(executor, 'qbank_get_question', { session_id: 'exam_1', card_id: 'c1' })).output;
    const stale = await call(executor, 'qbank_toggle_favorite', { question_id: question.id, expected_updated_at: question.updated_at });
    const conflict = errorOf(stale.result);
    expect(conflict).toMatchObject({ code: 'QBANK_CONFLICT', retryable: false });
    expect(conflict.current).toMatchObject({ id: question.id, updated_at: current.updated_at });
    const favorite = await call(executor, 'qbank_toggle_favorite', { question_id: question.id, expected_updated_at: current.updated_at });
    expect(favorite.output).toMatchObject({ success: true, previous: { is_favorite: false }, question: { is_favorite: true } });

    const updated = await call(executor, 'qbank_update_question', {
      session_id: 'exam_1', card_id: 'c1', expected_updated_at: favorite.output.question.updated_at,
      explanation: '因为 1+1=2', difficulty: 'easy',
    });
    expect(updated.output).toMatchObject({ success: true, changed_fields: ['explanation', 'difficulty'],
      question: { explanation: '因为 1+1=2', difficulty: 'easy' }, previous: { explanation: null } });
    const history = await call(executor, 'qbank_get_question_history', { session_id: 'exam_1', card_id: 'c1' });
    expect(history.output.history.map((entry: { field_name: string }) => entry.field_name)).toContain('explanation');

    const batch = await call(executor, 'qbank_batch_update_questions', {
      question_ids: [question.id, 'q_missing'], updates: { status: 'review' },
      expected_updated_at_by_id: { [question.id]: updated.output.updated_at, q_missing: NOW },
    });
    expect(batch.output).toMatchObject({ success: false, changed_fields: ['status'], updated_count: 1, atomic: false });
    expect(batch.output.results[1]).toMatchObject({ question_id: 'q_missing', outcome: 'failed' });

    const latest = (await call(executor, 'qbank_get_question', { session_id: 'exam_1', card_id: 'c1' })).output;
    host.events.length = 0;
    const deleted = await call(executor, 'qbank_delete_questions', { question_ids: [question.id], expected_updated_at: latest.updated_at });
    expect(deleted.output).toMatchObject({ success: true, deleted_count: 1, soft_deleted: true,
      deleted: [{ question_id: question.id, card_id: 'c1', session_id: 'exam_1', previous_updated_at: latest.updated_at }] });
    expect(host.eventsNamed('qbank://changed')).toEqual([
      { source: 'agent', action: 'delete_questions', entityIds: [question.id], runId: 'call_q' }]);
  });

  it('returns structured Rust errors and never emits on failure', async () => {
    const { host, executor } = await fixture();
    host.events.length = 0;
    const cases: [string, unknown, string, string][] = [
      ['qbank_create_question', { session_id: 'exam_1', content: 'x', question_type: 'single_choice' },
        'INVALID_ARGS', '选择题必须提供非空 options'],
      ['qbank_create_question', { session_id: 'exam_1', content: 'x', question_type: 'matching' },
        'INVALID_ARGS', 'matching/ordering/numeric 题型必须提供 structured_data'],
      ['qbank_create_question', { session_id: 'exam_1', content: 'x', question_type: 'true_false', answer: 'yes' },
        'INVALID_ARGS', 'true_false 题的答案必须是 "true" 或 "false"，收到: yes'],
      ['qbank_create_question', { session_id: 'exam_1', content: 'x', question_type: 'bogus' },
        'INVALID_ARGS', 'question_type 是不支持的题型'],
      ['qbank_toggle_favorite', { question_id: 'q' }, 'QBANK_OCC_REQUIRED', '更新题目前必须提供 expected_updated_at'],
      ['qbank_delete_questions', { question_ids: ['a', 'b'] }, 'QBANK_OCC_REQUIRED', '批量删除必须提供 expected_updated_at_by_id'],
      ['qbank_batch_update_questions', { question_ids: ['a'], expected_updated_at_by_id: { a: NOW }, updates: { content: 'x' } },
        'INVALID_ARGS', 'updates 包含不支持的字段: content'],
      ['qbank_get_submissions', { session_id: 'exam_1', card_id: 'nope' }, 'QBANK_QUESTION_NOT_FOUND', '找不到指定题目'],
      ['qbank_get_activity_heatmap', { year: 1969 }, 'INVALID_ARGS', 'year 必须是 1970..=9999 的整数'],
      ['qbank_get_learning_trend', { start_date: '2026-02-01', end_date: '2026-01-01' },
        'INVALID_ARGS', '日期范围必须正序且不超过 367 天'],
      ['qbank_submit_mock_exam', { session: {} }, 'QBANK_UI_RESULTS_REQUIRED', '模拟考交卷只接受 qbank_ui 产生的作答结果'], // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
      ['qbank_commit_authoring_draft', { job_id: 'j' }, 'QBANK_OCC_REQUIRED', '必须提供草稿 expected_version'],
    ];
    for (const [name, args, code, message] of cases) {
      const { result, recorded } = await call(executor, name, args);
      const error = errorOf(result);
      expect({ name, code: error.code, message: error.messageFallback['zh-CN'] }).toEqual({ name, code, message });
      expect(recorded.errors).toEqual([result.error]);
    }
    const plain = errorOf((await call(executor, 'qbank_get_question', { card_id: 'c1' })).result);
    expect(plain).toMatchObject({ code: 'QBANK_OPERATION_FAILED', detail: "Missing 'session_id' parameter",
      messageKey: 'chat.tools.qbank.error' });
    const paper = errorOf((await call(executor, 'qbank_get_paper', { paper_id: 'p_missing' })).result);
    expect(paper.detail).toBe('Paper not found');
    expect(host.eventsNamed('qbank://changed')).toEqual([]);
  });

  it('writes Rust f64 output fields with the serde_json spelling (json! of f64 prints 1.0)', async () => {
    const { executor } = await fixture();
    const created = await call(executor, 'qbank_create_question', {
      session_id: 'exam_1', content: '1+1=?', question_type: 'single_choice', card_id: 'c1',
      options: [{ key: 'A', content: '2' }, { key: 'B', content: '3' }], answer: 'A', tags: ['算术'],
    });
    const questionId = created.output.question.id as string;
    await call(executor, 'qbank_submit_answer', { session_id: 'exam_1', card_id: 'c1', user_answer: 'A' });
    const text = async (name: string, args: unknown) => {
      const { result } = await call(executor, name, args);
      if (!result.success) throw new Error(`${name}: ${result.error}`);
      return JSON.stringify(result.output);
    };
    const today = new Date().toISOString().slice(0, 10);

    // qbank_executor.rs:1685 / :3356 `"correct_rate": stats.correct_rate`（question_repo.rs:583 f64）
    expect(await text('qbank_list', {})).toContain('"correct_rate":1.0}');
    expect(await text('qbank_get_stats', { session_id: 'exam_1' })).toContain('"correct_rate":1.0,');
    // question_bank_service.rs:3208 LearningTrendPoint / :3236 KnowledgePoint
    expect(await text('qbank_get_learning_trend', { session_id: 'exam_1', start_date: today, end_date: today }))
      .toContain(`{"date":"${today}","attempt_count":1,"correct_count":1,"correct_rate":100.0}`);
    expect(await text('qbank_get_knowledge_stats', { session_id: 'exam_1' }))
      .toContain('"mastery_rate":50.0,"correct_rate":100.0}');
    // question_repo.rs:439 `relevance_score: f64`
    const searched = await text('qbank_search_questions', { keyword: '1+1', session_id: 'exam_1' });
    const relevance = /"relevance_score":([^,}]+)\}/.exec(searched)?.[1];
    expect(relevance).toBeDefined();
    expect(relevance).toBe(formatF64(Number(relevance)));
    // question_bank_service.rs:3395 MockExamScoreCard / :3417 TypeStatItem
    const scoreCard = await text('qbank_submit_mock_exam', { submission_source: 'qbank_ui', session: { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
      id: 'mock_1', exam_id: 'exam_1', question_ids: [questionId], started_at: `${today}T00:00:00+00:00`,
      ended_at: `${today}T00:10:00+00:00`, answers: { [questionId]: 'A' }, results: { [questionId]: true },
      is_submitted: true, score: null, correct_rate: null,
      config: { duration_minutes: 10, type_distribution: {}, difficulty_distribution: {}, shuffle: false,
        include_mistakes: false },
    } });
    expect(scoreCard).toContain('"correct_rate":100.0,');
    expect(scoreCard).toContain('"type_stats":{"SingleChoice":{"total":1,"correct":1,"rate":100.0}}');
  });

  it('question payloads spell SourceRef.bbox as f64 like question_to_bounded_value (serde_json::to_value)', async () => {
    const { db, executor } = await fixture();
    const created = await call(executor, 'qbank_create_question', {
      session_id: 'exam_1', content: '题', question_type: 'short_answer', card_id: 'c1' });
    db.run('UPDATE questions SET provenance_json = ?1 WHERE id = ?2', [
      '{"source_refs":[{"source_id":"src_1","page":1,"bbox":[0,0.5,1,1]}],"answer_source_refs":[{"source_id":"src_2","bbox":[2,3,4,5]}]}',
      created.output.question.id]);
    const got = await call(executor, 'qbank_get_question', { session_id: 'exam_1', card_id: 'c1' });
    const favorite = await call(executor, 'qbank_toggle_favorite', {
      question_id: created.output.question.id, expected_updated_at: got.output.updated_at });
    for (const text of [JSON.stringify(got.output), JSON.stringify(favorite.output.question)]) {
      expect(text).toContain('"source_refs":[{"source_id":"src_1","page":1,"bbox":[0.0,0.5,1.0,1.0]}]');
      expect(text).toContain('"answer_source_refs":[{"source_id":"src_2","page":null,"bbox":[2.0,3.0,4.0,5.0]}]');
    }
  });

  it('serves practice handoffs, statistics pages, structure and source images', async () => {
    const { db, executor } = await fixture();
    for (const card of ['p1', 'p2']) {
      await call(executor, 'qbank_create_question', { session_id: 'exam_1', content: `题 ${card}`, card_id: card,
        question_type: 'short_answer' });
    }
    const timed = await call(executor, 'qbank_start_timed_practice', { session_id: 'exam_1', question_count: 5 });
    expect(timed.output).toMatchObject({ success: true, session_state: 'handoff_ready', agentCanAnswer: false,
      session: { exam_id: 'exam_1', question_count: 2 },
      handoff: { version: 1, kind: 'qbank_practice_session', exam_id: 'exam_1', mode: 'timed' },
      workbenchAction: { tool: 'builtin-workbench_app_command', executed: false,
        arguments: { typeId: 'exam', instanceKey: 'exam_1', action: 'hydratePracticeSession' } } });
    expect(timed.output.handoff.handoff_id).toBe(timed.output.session.id);
    const mock = await call(executor, 'qbank_generate_mock_exam', { session_id: 'exam_1', config: { total_count: 2 } }); // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    expect(mock.output.session.question_ids).toHaveLength(2);
    const invalidCount = errorOf((await call(executor, 'qbank_generate_mock_exam', { // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
      session_id: 'exam_1', type_distribution: { essay: 0 } })).result);
    expect(invalidCount.messageFallback['zh-CN']).toBe('type_distribution.essay 必须是正整数');
    const calendar = await call(executor, 'qbank_get_check_in_calendar', { year: 2026, month: 2 });
    expect(calendar.output).toMatchObject({ session_id: null, year: 2026, month: 2, days: [], total: 0, page: 1,
      page_size: 20, has_more: false, truncated: false });
    const knowledge = await call(executor, 'qbank_get_knowledge_stats', { session_id: 'exam_1' });
    expect(knowledge.output).toMatchObject({ page: 1, page_size: 20 });
    const papers = await call(executor, 'qbank_list_papers', { session_id: 'exam_1' });
    expect(papers.output).toEqual({ items: [], total: 0, page: 1, page_size: 20, has_more: false });
    db.run(`INSERT INTO qbank_materials (id, exam_id, content, images_json, source_refs_json, created_at, updated_at)
      VALUES ('mat_1', 'exam_1', '材料', '[]', '[{"source_id":"src_1","page":2,"bbox":[0,0.25,1,1]}]', ?1, ?1)`, [NOW]);
    const structure = await call(executor, 'qbank_list_structure', { session_id: 'exam_1' });
    expect(structure.result.success).toBe(true);
    // qbank_executor.rs:5247 `json!(view)`：bbox 是 [f64; 4]，工具输出写 `1.0`。
    expect(JSON.stringify(structure.output.materials[0].source_refs))
      .toBe('[{"source_id":"src_1","page":2,"bbox":[0.0,0.25,1.0,1.0]}]');
    const images = await call(executor, 'qbank_list_source_images', { session_id: 'exam_1', page_size: 1, page: 2 });
    expect(images.output).toMatchObject({ images: [{ page_index: 1, blob_hash: 'h2' }], total: 2, has_more: false,
      data_included: false });
    const drafts = await call(executor, 'qbank_list_authoring_drafts', { session_id: 'exam_1' });
    expect(drafts.output).toEqual({ drafts: [] });
    const task = errorOf((await call(executor, 'qbank_get_generation_task', { task_id: 't_missing' })).result);
    expect(task.detail).toBe('任务不存在: t_missing');
  });

  it('falls back to legacy preview_json cards with OCC writes when the question is not migrated', async () => {
    const { host, db, executor } = await fixture();
    const preview = { temp_id: 't_legacy', exam_name: '旧题集', pages: [{ page_index: 0, cards: [
      { card_id: 'old_1', question_label: '1', ocr_text: '旧题干', tags: ['旧'], question_type: 'single_choice',
        answer: 'B', status: 'new', attempt_count: 0, correct_count: 0, legacy_extra: 1 },
    ] }] };
    db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
      VALUES ('exam_legacy', '旧题集', 'completed', 't_legacy', '{}', ?1, ?2, ?2)`, [JSON.stringify(preview), NOW]);
    const got = await call(executor, 'qbank_get_question', { session_id: 'exam_legacy', card_id: 'old_1' });
    expect(got.output).toMatchObject({ card_id: 'old_1', content: '旧题干', answer: 'B', occ_supported: false,
      updated_at: NOW, source: 'preview_json' });
    host.events.length = 0;
    const answered = await call(executor, 'qbank_submit_answer', { session_id: 'exam_legacy', card_id: 'old_1', user_answer: ' b ' });
    expect(answered.output).toMatchObject({ is_correct: true, correct_answer: 'B', source: 'preview_json', degraded: true });
    const stored = JSON.parse(db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_legacy'")!);
    expect(stored.pages[0].cards[0]).toMatchObject({ user_answer: ' b ', attempt_count: 1, correct_count: 1,
      status: 'in_progress', is_correct: true });
    expect(stored.pages[0].cards[0].legacy_extra).toBeUndefined();
    expect(host.eventsNamed('qbank://changed')).toEqual([
      { source: 'agent', action: 'submit_answer', entityIds: ['old_1'], runId: 'call_q' }]);
    const listed = await call(executor, 'qbank_list_questions', { session_id: 'exam_legacy' });
    expect(listed.output).toMatchObject({ total: 0, source: 'questions_table' });
  });

  it('legacy preview writes keep serde_json Value numbers and print ExamCardBBox as f32 (models.rs:300)', async () => {
    const { db, executor } = await fixture();
    const raw = '{"temp_id":"t_f32","exam_name":"旧题集","pages":[{"page_index":0,"cards":[{"card_id":"old_f32",'
      + '"page_index":0,"question_label":"1","bbox":{"x":0.123456789,"y":0.05,"width":0.9,"height":0.25},'
      + '"resolved_bbox":{"x":50.0,"y":70,"width":900.0,"height":350.0},"ocr_text":"旧题干","tags":[],'
      + '"extra_metadata":{"score":1.0,"weight":2.5e-3},"question_type":"single_choice","answer":"B"}]}],'
      + '"raw_model_response":{"confidence":0.95,"tokens":12}}';
    db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
      VALUES ('exam_f32', '旧题集', 'completed', 't_f32', '{}', ?1, ?2, ?2)`, [raw, NOW]);
    const stored = () => db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_f32'")!;
    const bboxes = '"bbox":{"x":0.12345679,"y":0.05,"width":0.9,"height":0.25},'
      + '"resolved_bbox":{"x":50.0,"y":70.0,"width":900.0,"height":350.0}';

    const answered = await call(executor, 'qbank_submit_answer', { session_id: 'exam_f32', card_id: 'old_f32', user_answer: 'B' });
    expect([answered.result.success, answered.result.error ?? null]).toEqual([true, null]);
    expect(stored()).toContain(bboxes);
    expect(stored()).toContain('"extra_metadata":{"score":1.0,"weight":2.5e-3}');
    expect(stored()).toContain('"raw_model_response":{"confidence":0.95,"tokens":12}');

    const reset = await call(executor, 'qbank_reset_progress', { session_id: 'exam_f32' });
    expect([reset.result.success, reset.result.error ?? null]).toEqual([true, null]);
    expect(stored()).toContain(bboxes);
    expect(stored()).toContain('"raw_model_response":{"confidence":0.95,"tokens":12}');
  });

  it('skips change notifications without a window', async () => {
    const { host, executor } = await fixture();
    const created = await call(executor, 'qbank_create_question', { session_id: 'exam_1', content: 'headless' }, false);
    expect(created.result.success).toBe(true);
    expect(host.eventsNamed('qbank://changed')).toEqual([]);
  });
});

describe('qbank_ai_grade', () => {
  function gradingExecutor(response: 'ok' | 'cancelled') {
    const requests: QbankGradingRequest[] = [];
    const cancelled: string[] = [];
    const emitted: unknown[] = [];
    const deps = {
      repos: () => ({}),
      db: () => ({}),
      questionHost: () => { throw new Error('question service is not read when question_id is given'); },
      statisticsHost: () => { throw new Error('unused'); },
      managementHost: () => { throw new Error('unused'); },
      authoringHost: () => { throw new Error('unused'); },
      aiGrading: () => ({
        run: async (request: QbankGradingRequest) => {
          requests.push(request);
          return response === 'cancelled' ? null : { submission_id: null, verdict: null, score: null,
            feedback: '解析', explanation_written: false, diagnostics: null };
        },
        cancelStream: async (event: string) => { cancelled.push(event); },
      }),
      emit: (_event: string, payload: unknown) => { emitted.push(payload); },
      log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as QbankToolDeps;
    return { executor: new QBankExecutor(deps), requests, cancelled, emitted };
  }

  it('runs the grading pipeline with the Rust stream identity and hints when the explanation was kept', async () => {
    const { executor, requests, emitted } = gradingExecutor('ok');
    const { output } = await call(executor, 'qbank_ai_grade', { question_id: ' q1 ', mode: 'analyze', model_config_id: ' m ' });
    expect(requests).toEqual([{ question_id: 'q1', submission_id: null, stream_session_id: 'agent-sess-call_q',
      mode: 'analyze', model_config_id: 'm' }]);
    expect(output).toMatchObject({ feedback: '解析', explanation_written: false,
      explanation_hint: '题目已有解析，本次结果只存为 AI 解析（ai_feedback）；如需替换题目解析，用 qbank_update_question 写 explanation' });
    expect(emitted).toEqual([{ source: 'agent', action: 'ai_grade', entityIds: ['q1'], runId: 'call_q' }]);
  });

  it('validates mode and submission before grading and reports cancellation', async () => {
    const { executor, requests } = gradingExecutor('cancelled');
    const missing = errorOf((await call(executor, 'qbank_ai_grade', { question_id: 'q1' })).result);
    expect(missing).toMatchObject({ code: 'INVALID_ARGS', messageFallback: { 'zh-CN': 'grade 模式缺少 submission_id' } });
    const badMode = errorOf((await call(executor, 'qbank_ai_grade', { question_id: 'q1', mode: 'judge' })).result);
    expect(badMode.messageFallback['zh-CN']).toBe('不支持的 AI 评判模式: judge');
    expect(requests).toEqual([]);
    const cancelled = await call(executor, 'qbank_ai_grade', { question_id: 'q1', submission_id: 's1' });
    expect(cancelled.output).toEqual({ cancelled: true, messageKey: 'agentTools.qbank.aiGradeCancelled' });
  });

  it('fails without the LLM manager in the plugin host', async () => {
    const { executor } = await fixture();
    const failure = errorOf((await call(executor, 'qbank_ai_grade', { question_id: 'q1', mode: 'analyze' })).result);
    expect(failure.detail).toBe('LLM manager not available');
  });
});
