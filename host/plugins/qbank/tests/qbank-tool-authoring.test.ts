import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import files from '../../../platform/files/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolExecutor, ToolResultInfo } from '../../chat/api.ts';
import type { ApiConfig } from '../../llm/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 真实 review 插件仅在测试中组合以提供 mastery 服务
import review from '../../review/index.ts';
import qbank from '../index.ts';
import { QBankExecutor, type QbankToolDeps } from '../src/tools/qbank-tool-executor.ts';
import { normalizeAuthoringDocument } from '../src/tools/qbank-tools-authoring.ts';
import { createMigratedStorage } from './support/storage.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const AUTHORING_CONFIG = {
  id: 'cfg_chat', name: '对话模型', model: 'gpt-x', providerType: 'openai', isMultimodal: true,
  maxOutputTokens: 4096, maxTokensLimit: null, contextWindow: 128000,
} as unknown as ApiConfig;
const ROUTE = { model_config_id: 'cfg_chat', name: '对话模型', model: 'gpt-x', provider_type: 'openai',
  is_multimodal: true, max_output_tokens: 4096, max_tokens_limit: null, context_window: 128000 };

async function fixture(extraProvide: Record<string, unknown> = {}) {
  const { storage, base } = await createMigratedStorage('qbank-authoring-');
  const registered: AgentToolExecutor[] = [];
  const docxSpecs: unknown[] = [];
  const host = await createTestHost({
    plugins: [files, review, vfsRepos, qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-authoring-device' } }),
      agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => {
        registered.push(...executors);
        return { dispose: () => undefined };
      } },
      nativeOfficeWriter: { generateDocx: async (spec: unknown) => {
        docxSpecs.push(spec);
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      } },
      ...extraProvide,
    },
  });
  cleanups.push(() => { storage.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  cleanups.push(() => host.dispose());
  const db = storage.database('vfs');
  const preview = { pages: [{ page_index: 0, cards: [{ card_id: 'card_p', question_label: '1', ocr_text: '1+1=?',
    tags: ['math'], question_type: 'short_answer', answer: '2', status: 'new', attempt_count: 0, correct_count: 0 }] }] };
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam_1', '题目集一', 'completed', 't1', '{}', ?2, ?1, ?1)`, [NOW, JSON.stringify(preview)]);
  const executor = registered.find(entry => entry.name() === 'QBankExecutor') as ToolExecutor | undefined;
  if (executor === undefined) throw new Error('QBankExecutor was not registered');
  return { host, db, executor, base, docxSpecs };
}

async function call(executor: ToolExecutor, name: string, args: unknown,
  options: { windowed?: boolean; config?: ApiConfig | null } = {}) {
  const errors: string[] = [];
  const ctx = {
    session_id: 'sess', message_id: 'msg', block_id: 'blk', tool_call_id: 'call_q', cancellation_token: null,
    question_authoring_config: options.config === undefined ? AUTHORING_CONFIG : options.config,
    tryWindow: () => (options.windowed ?? true ? { window: 'main', webview: 'main' } : null),
    runId: () => 'call_q',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: (error: string) => { errors.push(error); },
    saveToolBlock: () => undefined,
  } as unknown as ExecutionContext;
  const result = await executor.execute({ id: 'call_q', name, arguments: args }, ctx);
  return { result, errors, output: result.output as Record<string, any> };
}

function errorOf(result: ToolResultInfo): Record<string, any> {
  expect(result.success).toBe(false);
  return JSON.parse(result.error!) as Record<string, any>;
}

function examCount(db: { get(sql: string): unknown }): number {
  return (db.get('SELECT COUNT(*) AS n FROM exam_sheets') as { n: number }).n;
}

describe('normalizeAuthoringDocument (qbank_executor.rs:916)', () => {
  it('fills identity fields and drops legacy keys with serde_json preserve_order swap_remove', () => {
    const root = normalizeAuthoringDocument({ questions: [{ questionLabel: '甲', content: '题干', answer: 'A',
      options: [{ key: 'A', content: 'x' }, { key: 'B', content: 'y' }], extra: 1 }], session_id: 's' });
    const question = (root.questions as Record<string, unknown>[])[0]!;
    expect(Object.keys(question)).toEqual(['question_type', 'content', 'answer', 'options', 'extra', 'local_id',
      'original_label', 'tags', 'section_path', 'answer_origin']);
    expect(question).toMatchObject({ local_id: 'q1', original_label: '甲', question_type: 'single_choice',
      answer_origin: 'generated' });
    expect(Object.keys(root)).toEqual(['questions', 'session_id', 'schema_version', 'mode', 'materials', 'groups',
      'unmatched_answers', 'coverage', 'issues']);
  });

  it('rejects summary-style coverage before any write', () => {
    expect(() => normalizeAuthoringDocument({ questions: [{ content: 'x' }], coverage: [{ total: 3 }] }))
      .toThrow(/INVALID_COVERAGE/);
    expect(() => normalizeAuthoringDocument({ mode: 'edit', questions: [{ content: 'x' }] })).toThrow(/不支持的 mode: edit/);
    expect(() => normalizeAuthoringDocument({ name: 'x' })).toThrow(/缺少题目文档/);
    expect(() => normalizeAuthoringDocument({ document: '{bad' })).toThrow(/document 是字符串但不是有效 JSON/);
    let detail: unknown = null;
    try {
      normalizeAuthoringDocument({ questions: [{ content: 'x', answer: 'A', options: [{ key: 'A', content: 'a' }] }] });
    } catch (error) {
      detail = (JSON.parse((error as Error).message) as { code: string; messageParams: { detail: string } });
    }
    expect(detail).toMatchObject({ code: 'INVALID_DOCUMENT',
      messageParams: { detail: '题目文档校验失败: 选择题至少需要两个选项' } });
  });
});

describe('qbank_batch_import', () => {
  it('creates a bank, commits the legacy flat form and replays idempotently into the same bank', async () => {
    const { executor, db } = await fixture();
    const args = { name: ' 新题集 ', questions: [{ content: '2+2=?', answer: '4', question_type: 'short_answer' }] };
    const first = await call(executor, 'qbank_batch_import', args);
    expect(first.result.success).toBe(true);
    const sessionId = first.output.session_id as string;
    expect(sessionId).not.toBe('exam_1');
    expect(first.output).toMatchObject({ committed: true, success: true, status: 'committed', name: '新题集',
      imported_count: 1, total_questions: 1, draft_version: 2, idempotent_replay: false, model_route: ROUTE,
      messageKey: 'chat.tools.qbank.questions_imported', messageParams: { count: 1 } });
    expect(first.output.new_card_ids).toEqual(first.output.question_ids);
    const exam = db.get('SELECT exam_name, metadata_json FROM exam_sheets WHERE id = ?1', [sessionId]) as Record<string, string>;
    expect(exam.exam_name).toBe('新题集');
    expect(JSON.parse(exam.metadata_json!)).toMatchObject({ created_by: 'chat_qbank_authoring' });

    const replay = await call(executor, 'qbank_batch_import', args);
    expect(replay.output).toMatchObject({ session_id: sessionId, imported_count: 0, new_card_ids: [],
      idempotent_replay: true, draft_version: first.output.draft_version });
    expect(examCount(db)).toBe(2);
  });

  // 幂等键落库（qbank_import_jobs.idempotency_key），并按 (key, chat_session_id) 查找旧题集：旧版写下的键
  // 升级或同步后仍要能命中。Rust 原文来自 rust-sampler `--bin value_to_string` 的同一文档。
  it('derives the default idempotency key from the Rust Value::to_string text of the normalized document', async () => {
    const { executor, db } = await fixture();
    const { valueToString } = JSON.parse(fs.readFileSync(new URL(
      '../../../platform/serde-compat/tests/__fixtures__/serde-json-value-to-string.json', import.meta.url), 'utf8')) as {
      valueToString: [string, string][];
    };
    const [input, rust] = valueToString.find(([text]) => text.includes('新题集'))!;
    const rustKey = `chat-sess-${createHash('sha256').update(rust, 'utf8').digest('hex')}`;
    const keyOf = (sessionId: unknown) => (db.get('SELECT idempotency_key FROM qbank_import_jobs WHERE exam_id = ?1',
      [String(sessionId)]) as { idempotency_key: string }).idempotency_key;

    const imported = await call(executor, 'qbank_batch_import', JSON.parse(input));
    expect(imported.result.success).toBe(true);
    expect(keyOf(imported.output.session_id)).toBe(rustKey);

    // 已知残差：参数经 JSON.parse 读入（llm tool_calls），`1.0` 的词形已丢失，Rust 键里是 `1.0`。
    const lossy = await call(executor, 'qbank_batch_import', JSON.parse(input.replace('"weight":0.5', '"weight":1.0')));
    expect(keyOf(lossy.output.session_id)).not.toBe(
      `chat-sess-${createHash('sha256').update(rust.replace('"weight":0.5', '"weight":1.0'), 'utf8').digest('hex')}`);
  });

  it('stages a review draft instead of committing when coverage is uncertain', async () => {
    const { executor } = await fixture();
    const { output } = await call(executor, 'qbank_batch_import', { session_id: 'exam_1',
      document: { mode: 'extract', questions: [{ content: '题干' }],
        coverage: [{ source_id: 'src', page: 1, status: 'uncertain' }] } });
    expect(output).toMatchObject({ success: true, committed: false, status: 'needs_review', session_id: 'exam_1',
      question_count: 1, needs_review: true, next_tool: 'qbank_get_authoring_draft', draft_version: 1 });
  });

  it('fails without writing when a variant parent is not in the target bank', async () => {
    const { executor, db } = await fixture();
    const before = examCount(db);
    const { result } = await call(executor, 'qbank_batch_import', { parent_card_id: 'ghost',
      questions: [{ content: '变式', answer: 'x' }] });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND', messageParams: { detail: '变式父题不存在于目标题目集: ghost' } });
    expect(examCount(db)).toBe(before + 1);
    const invalid = await call(executor, 'qbank_batch_import', { questions: [{ content: 'x' }], coverage: [{ pages: 3 }] });
    expect(errorOf(invalid.result).code).toBe('INVALID_COVERAGE');
    expect(examCount(db)).toBe(before + 1);
    const missing = await call(executor, 'qbank_batch_import', { session_id: 'nope', questions: [{ content: 'x', answer: 'y' }] });
    expect(errorOf(missing.result)).toMatchObject({ code: 'NOT_FOUND', messageParams: { detail: '题目集不存在: nope' } });
  });
});

describe('qbank_generate_variant', () => {
  it('falls back to preview_json and prefers the formal question once it exists', async () => {
    const { executor } = await fixture();
    const preview = await call(executor, 'qbank_generate_variant', { session_id: 'exam_1', card_id: 'card_p',
      variant_type: 'weird' });
    expect(preview.result.error).toBeUndefined();
    expect(preview.output).toMatchObject({ source: 'preview_json', degraded: true, variant_type: 'weird',
      original_question: { card_id: 'card_p', label: '1', content: '1+1=?', answer: '2', explanation: null,
        difficulty: null, tags: ['math'] } });
    expect(preview.output.prompt).toContain('**相似难度**');
    expect(preview.output.original_question).not.toHaveProperty('images');

    const imported = await call(executor, 'qbank_batch_import', { session_id: 'exam_1',
      questions: [{ content: '3*3=?', answer: '9', question_type: 'short_answer', tags: ['乘法'] }] });
    const cardId = (imported.output.question_ids as string[])[0];
    const formal = await call(executor, 'qbank_generate_variant', { session_id: 'exam_1', card_id: cardId,
      variant_type: 'harder' });
    expect(formal.output).toMatchObject({ action: 'generate_variant', variant_type: 'harder', source: 'questions_table',
      original_question: { content: '3*3=?', answer: '9', question_type: 'short_answer', tags: ['乘法'], images: [] } });
    expect(formal.output.instruction).toBe(`${formal.output.prompt}\n\n**原题**：\n3*3=?\n\n**原题答案**：9\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析`);
    expect(formal.output.prompt).toContain('**更难**');

    const missing = await call(executor, 'qbank_generate_variant', { session_id: 'exam_1', card_id: 'nope' });
    expect(missing.result.error).toContain('Question not found');
    const noCard = await call(executor, 'qbank_generate_variant', { session_id: 'exam_1' });
    expect(noCard.result.error).toContain("Missing 'card_id' parameter");
  });
});

describe('qbank_generate_questions', () => {
  it('hands authoring back to the current chat model unless background is requested', async () => {
    const { executor } = await fixture();
    const { output } = await call(executor, 'qbank_generate_questions', { exam_id: ' exam_1 ' });
    expect(output).toMatchObject({ action: 'author_with_current_model', committed: false, exam_id: 'exam_1',
      model: '对话模型', model_config_id: 'cfg_chat', model_route: ROUTE,
      contract: { schema_version: 2, mode: 'generate', materials: [], groups: [], questions: [], coverage: [], issues: [] } });
    const untrusted = await call(executor, 'qbank_generate_questions', { exam_id: 'exam_1' }, { config: null });
    expect(errorOf(untrusted.result).code).toBe('MODEL_CONTEXT_UNAVAILABLE');
    const noLlm = await call(executor, 'qbank_generate_questions', { exam_id: 'exam_1', background: true });
    expect(noLlm.result.error).toContain('LLM Manager not available');
  });

  it('queues a background task with the trusted config and serde-shaped request', async () => {
    const { host, db } = await fixture();
    const spawned: unknown[][] = [];
    const repos = host.ctx.get('vfsRepo') as VfsReposService;
    const generation = { db, repos, ports: {}, spawn: (task: () => Promise<void>) => { spawned.push([task]); return null; } };
    const executor = new QBankExecutor({
      repos: () => repos, db: () => db, generation: () => generation,
      emit: () => undefined, log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as QbankToolDeps);
    const headless = await call(executor, 'qbank_generate_questions', { exam_id: 'exam_1', background: true },
      { windowed: false });
    expect(headless.result.error).toContain('后台出题需要窗口上下文');
    expect((db.get('SELECT COUNT(*) AS n FROM qbank_generation_tasks') as { n: number }).n).toBe(0);

    const { output } = await call(executor, 'qbank_generate_questions', { exam_id: 'exam_1', background: true,
      max_questions: 99, specs: [{ question_type: 'essay' }], knowledge_points: ['k', 3], difficulty: 'hard' });
    expect(output, String(headless.result.error)).not.toBeNull();
    expect(output).toMatchObject({ action: 'generate_questions_background', examId: 'exam_1', status: 'queued',
      committed: false, model_route: ROUTE });
    expect(spawned).toHaveLength(1);
    const row = db.get('SELECT request_json, stream_event FROM qbank_generation_tasks WHERE id = ?1',
      [output.taskId]) as { request_json: string; stream_event: string };
    const request = JSON.parse(row.request_json) as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(['exam_id', 'stream_session_id', 'model_config_id', 'max_questions', 'specs',
      'difficulty', 'topic_hint', 'based_on_existing', 'language', 'reference_file_ids', 'reference_files_base64',
      'knowledge_points']);
    expect(request).toMatchObject({ model_config_id: 'cfg_chat', max_questions: 50,
      specs: [{ question_type: 'essay', count: 1, difficulty: null }], knowledge_points: ['k'], difficulty: 'hard' });
    expect(row.stream_event).toBe(`qbank_generation_stream_${request.stream_session_id as string}`);
    expect(request.stream_session_id).toMatch(/^chat_/);
  });
});

async function seedQuestions(executor: ToolExecutor): Promise<string[]> {
  const { output } = await call(executor, 'qbank_batch_import', { session_id: 'exam_1', questions: [
    { content: '题一', answer: '1', explanation: '解一', question_type: 'short_answer' },
    { content: '题二', answer: 'A', question_type: 'single_choice',
      options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }] },
    { content: '题三', answer: '3', question_type: 'short_answer' },
  ] });
  return output.question_ids as string[];
}

describe('qbank_generate_paper', () => {
  it('persists a preview paper truncated to question_count and hides excluded answers', async () => {
    const { executor, db } = await fixture();
    await seedQuestions(executor);
    const { output } = await call(executor, 'qbank_generate_paper', { session_id: 'exam_1',
      config: { title: '周测', question_count: 2, include_answers: false, shuffle: false } });
    expect(output).toMatchObject({ success: true, persisted: true, view: 'papers', grading_mode: 'on_submit',
      title: '周测', session_id: 'exam_1', total_score: 2, question_count: 2, questions_truncated: false,
      export_format: 'preview', export_path: null, file_created: false, requires_user_interaction: true,
      messageKey: 'chat.tools.qbank.paper_preview_created', messageParams: { fileCreated: false, format: 'preview' } });
    expect((output.questions as Record<string, unknown>[]).map(question => question.answer)).toEqual([null, null]);
    expect((output.questions as Record<string, unknown>[])[0]).toHaveProperty('fieldsTruncated');
    const stored = JSON.parse((db.get('SELECT document_json FROM qbank_papers WHERE id = ?1',
      [output.paper_id]) as { document_json: string }).document_json) as { questions: unknown[]; total_score: number };
    expect([stored.questions.length, stored.total_score]).toEqual([2, 2]);
  });

  it('exports through the frontend bridge and rejects file formats without a window', async () => {
    const { executor, host } = await fixture();
    await seedQuestions(executor);
    const headless = await call(executor, 'qbank_generate_paper', { session_id: 'exam_1', export_format: 'pdf' },
      { windowed: false });
    expect(errorOf(headless.result).code).toBe('QBANK_EXPORT_SURFACE_UNAVAILABLE');
    const invalid = await call(executor, 'qbank_generate_paper', { session_id: 'exam_1', export_format: 'pptx' });
    expect(errorOf(invalid.result)).toMatchObject({ code: 'INVALID_ARGS', messageParams: { detail: 'export_format 不受支持' } });

    host.ctx.backendEvents.listen('qbank-export-paper', payload => {
      const request = payload as { request_id: string; format: string };
      void host.invoke('qbank_complete_paper_export', { requestId: request.request_id,
        data: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64'), error: null });
    });
    const { output } = await call(executor, 'qbank_generate_paper', { session_id: 'exam_1', export_format: 'word' });
    expect(output).toMatchObject({ file_created: true, export_format: 'word', requires_user_interaction: false,
      messageKey: 'chat.tools.qbank.paper_markdown_created' });
    expect(output.export_path).toMatch(/exports[\\/]qbank[\\/]练习试卷-[0-9a-f-]+\.docx$/);
  });
});

describe('qbank_export', () => {
  it('writes markdown, json and docx exports into the app data export directory', async () => {
    const { executor, docxSpecs } = await fixture();
    await seedQuestions(executor);
    const markdown = await call(executor, 'qbank_export', { session_id: 'exam_1', format: 'markdown' });
    expect(markdown.output).toMatchObject({ success: true, format: 'markdown', questionCount: 3,
      questionsTruncated: false, source: 'questions_table', degraded: false, schemaVersion: 2 });
    expect(markdown.output.exportPath).toMatch(/exports[\\/]qbank[\\/]题目集一-[0-9a-f-]+\.md$/);
    const text = fs.readFileSync(markdown.output.exportPath as string, 'utf8');
    expect(text.startsWith('# 题目集一\n\n## 题目 1\n\n**题干**\n')).toBe(true);
    expect(text).toContain('- A. 甲\n- B. 乙\n');
    expect(markdown.output.fileSize).toBe(Buffer.byteLength(text));
    expect(markdown.output.stats).toBeDefined();
    expect((markdown.output.questions as Record<string, unknown>[])[0]).toMatchObject({ fieldsTruncated: [] });

    const json = await call(executor, 'qbank_export', { session_id: 'exam_1', include_stats: false });
    expect(json.output).not.toHaveProperty('stats');
    const document = JSON.parse(fs.readFileSync(json.output.exportPath as string, 'utf8')) as { questions: unknown[] };
    expect(document.questions).toHaveLength(3);

    const docx = await call(executor, 'qbank_export', { session_id: 'exam_1', format: 'docx', filter_status: 'new' });
    expect(docx.output).toMatchObject({ format: 'docx', fileSize: 4, questionCount: 3 });
    expect(docxSpecs[0]).toMatchObject({ title: '题目集一', blocks: expect.arrayContaining([
      { type: 'heading', level: 2, text: '题目 1' }, { type: 'paragraph', text: 'A. 甲' },
      { type: 'paragraph', text: '答案：A', bold: true }, { type: 'paragraph', text: '解析：解一', italic: true }]) });

    const invalid = await call(executor, 'qbank_export', { session_id: 'exam_1', format: 'csv' });
    expect(errorOf(invalid.result).code).toBe('INVALID_ARGS');
  });
});

describe('qbank_import_document', () => {
  const importProvide = (noteContent = '') => ({
    llm: {},
    vfsRefText: { version: 1, extractFileTextWithStrategy: async () => null },
    notes: { repository: {
      getNote: (id: string) => (id === 'note_1' ? { id, title: '错题本' } : null),
      getNoteContent: () => noteContent,
    } },
  });
  const documentJson = JSON.stringify({ schema_version: 2, mode: 'extract',
    questions: [{ local_id: 'q1', content: '1+2=?', answer: '3', question_type: 'short_answer',
      answer_origin: 'source' }] });

  it('stages a preview draft from JSON content and commits it on mode=commit', async () => {
    const { executor } = await fixture(importProvide());
    const preview = await call(executor, 'qbank_import_document', { content: documentJson, format: 'JSON',
      name: ' 导入一 ' }, { config: null });
    expect(preview.result.error).toBeUndefined();
    expect(preview.output).toMatchObject({ success: true, committed: false, status: 'draft', name: '导入一',
      draft_version: 1, question_count: 1, material_count: 0, group_count: 0, needs_review: false, partial: false,
      model_route: { source_format: 'json', sources: [], pages: [] }, hint: '仅生成草稿，未写入正式题目。' });
    expect(preview.output.draft_document).toMatchObject({ schema_version: 2, questions: [{ local_id: 'q1' }] });
    expect(preview.output).not.toHaveProperty('source');

    const commit = await call(executor, 'qbank_import_document', { content: documentJson, format: 'json',
      mode: 'commit', session_id: preview.output.session_id });
    expect(commit.output).toMatchObject({ committed: true, success: true, status: 'committed',
      session_id: preview.output.session_id, imported_count: 1, draft_version: 2,
      model_route: { source_format: 'json' },
      messageKey: 'chat.tools.qbank.questions_imported' });
  });

  it('validates the import source and mode like qbank_import_source.rs', async () => {
    const { executor } = await fixture(importProvide());
    const both = await call(executor, 'qbank_import_document', { resource_id: 'file_a', content: 'x' });
    expect(both.result.error).toContain('content 与 resource_id 互斥');
    const none = await call(executor, 'qbank_import_document', {});
    expect(none.result.error).toContain('缺少导入来源');
    const alias = await call(executor, 'qbank_import_document', { resource_id: 'file_a', file_id: 'file_b' });
    expect(alias.result.error).toContain('resource_id（file_a）与 file_id（file_b）不一致');
    const badId = await call(executor, 'qbank_import_document', { resource_id: 'a/b' });
    expect(badId.result.error).toContain('资源 ID 格式无效: a/b');
    const mode = await call(executor, 'qbank_import_document', { content: documentJson, format: 'json', mode: 'auto' });
    expect(errorOf(mode.result)).toMatchObject({ code: 'INVALID_ARGS', messageParams: { detail: '不支持的导入模式: auto' } });
    const untrusted = await call(executor, 'qbank_import_document', { content: '1+1=?' }, { config: null });
    expect(errorOf(untrusted.result).code).toBe('MODEL_CONTEXT_UNAVAILABLE');
    const ranges = await call(executor, 'qbank_import_document', { content: documentJson, format: 'json',
      source_ranges: [{ start_page: 1 }] });
    expect(ranges.result.error).toContain('source_ranges 无效');
  });

  it('resolves notes and reports files that are still being parsed', async () => {
    const { executor, db, host } = await fixture(importProvide('   '));
    const empty = await call(executor, 'qbank_import_document', { resource_id: 'note_1' });
    expect(empty.result.error).toContain('笔记「错题本」内容为空，无法导入题目');
    const missing = await call(executor, 'qbank_import_document', { resource_id: 'note_404' });
    expect(missing.result.error).toContain('笔记不存在: note_404');

    const repos = host.ctx.get('vfsRepo') as VfsReposService;
    const slides = repos.files.createFile(db, 'sha-slides', '讲义.pptx', 10, 'document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    db.run("UPDATE files SET processing_status = 'ocr_processing' WHERE id = ?1", [slides.id]);
    const processing = await call(executor, 'qbank_import_document', { resource_id: slides.id });
    expect(processing.result.success).toBe(true);
    expect(processing.output).toMatchObject({ success: false, status: 'processing', file_id: slides.id,
      file_name: '讲义.pptx', stage: 'ocr_processing' });

    db.run("UPDATE files SET processing_status = 'completed' WHERE id = ?1", [slides.id]);
    const unsupported = await call(executor, 'qbank_import_document', { file_id: slides.id });
    expect(unsupported.result.error).toContain('不是题库导入支持的格式');
  });
});
