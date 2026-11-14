/**
 * `import_question_bank` / `import_question_bank_stream` / `cancel_question_bank_import` 生产入口契约测试
 * （host.invoke；真实 SQLite + vfs-repos 插件 + L18 ExamSheetSessionCore；LLM 与文档解析按 L02/L18 发布签名提供）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L18 真实的整卷会话服务组装 draft 响应
import { ExamSheetSessionCore } from '../../media/src/exam-sheet-service.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { ApiConfig, LlmQuestionAuthoring } from '../../llm/api.ts';
import qbank from '../index.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { QuestionDocument, QuestionImportDraftResponse } from '../api.ts';
import { authoringConfigFingerprint } from '../src/question-import-service.ts';

const CONFIG = {
  id: 'cfg_main', name: '主模型', model: 'main', apiKey: 'enc', baseUrl: 'http://x', enabled: true,
  isEmbedding: false, isReranker: false, isImageGeneration: false, isMultimodal: true,
  maxOutputTokens: 4096, maxTokensLimit: null, contextWindow: null, temperature: 0, modelAdapter: '',
  apiProtocol: null, extraBody: null, topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
} as unknown as ApiConfig;

const EXTRACTED = {
  schema_version: 2, mode: 'extract', materials: [], groups: [], unmatched_answers: [], issues: [],
  coverage: [{ source_id: 's1', page: null, status: 'processed' }],
  questions: [{ local_id: 'q1', group_id: null, original_label: '1', section_path: [], content: '题一',
    question_type: 'short_answer', options: null, answer: null, answer_origin: 'missing', explanation: null,
    structured_data: null, difficulty: 'medium', tags: [], source_refs: [{ source_id: 's1', page: null }],
    answer_source_refs: [], figures: [] }],
};

type Completion = Awaited<ReturnType<LlmQuestionAuthoring['runQuestionJson']>>;

interface Options {
  /** 主模型调用：返回内容或抛错；可在 gate 上阻塞。 */
  reply?: () => Promise<string>;
}

async function fixture(options: Options = {}) {
  const { storage, base } = await createMigratedStorage('qbank-import-invoke-');
  const calls: unknown[] = [];
  const questionAuthoring: LlmQuestionAuthoring = {
    async runQuestionJson(_config, systemPrompt, userContent) {
      calls.push({ systemPrompt, userContent });
      const content = options.reply === undefined ? JSON.stringify(EXTRACTED) : await options.reply();
      return { content, finishReason: 'stop', usage: null, jsonMode: true } as Completion;
    },
    buildDebugPersistConfig: () => null,
  };
  let sessions: ExamSheetSessionCore | null = null;
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' },
      }),
      llm: { getModel2Config: async () => CONFIG, getApiConfigs: async () => [CONFIG], decryptApiKey: async () => 'key' },
      llmQuestionAuthoring: questionAuthoring,
      docs: {
        extractTextFromBase64: async (_name: string, content: string) => Buffer.from(content, 'base64').toString('utf8'),
        extractDocxWithImages: async () => ({ text: '', images: [] }),
      },
      pageRasterizer: {
        rasterizePdfCancellable: async () => ({ pages: [], source_format: 'pdf' }),
        rasterizeImages: async () => ({ pages: [], source_format: 'image' }),
      },
      examSheetSession: {
        getExamSheetSessionDetail: (id: string) => sessions!.getExamSheetSessionDetail(id),
      },
    },
  });
  const db = storage.database('vfs');
  const repos = host.ctx.vfsRepo as VfsReposService;
  sessions = new ExamSheetSessionCore({
    db: () => db, exams: () => repos.exams, questions: () => repos.questions,
    nativeImage: () => { throw new Error('nativeImage unused'); },
    encodePng: async () => { throw new Error('encodePng unused'); },
    imagesDir: () => path.join(base, 'images'),
    log: { warn: () => undefined, info: () => undefined },
  });
  return {
    host, db, repos, calls,
    progress: () => host.eventsNamed('question_import_progress') as Record<string, unknown>[],
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('import_question_bank_stream (host.invoke)', () => {
  it('json 分支：旧版 questions 数组规范化为 v2 草稿，事件按序且带 trim 后的 import_id', async () => {
    const f = await fixture();
    try {
      const content = b64(JSON.stringify({ questions: [
        { content: '题一', questionType: 'short_answer' }, { content: '题二', questionLabel: '二' }] }));
      const response = await f.host.invoke<QuestionImportDraftResponse>('import_question_bank_stream',
        { request: { content, format: 'json', name: '我的题集', import_id: '  imp-1  ' } });
      expect(response.committed).toBe(false);
      expect(response.draft_job_id).toMatch(/^qjob/);
      const draft = response.draft_document as QuestionDocument;
      expect(draft.questions.map(q => [q.local_id, q.question_type, q.original_label]))
        .toEqual([['q1', 'short_answer', '1'], ['q2', 'other', '二']]);
      expect(response.model_route).toEqual({ sources: [], pages: [], source_format: 'json' });
      expect(response.summary.exam_name).toBe('我的题集');
      const events = f.progress();
      expect(events.map(e => e.type)).toEqual(['Preprocessing', 'SessionCreated', 'QuestionParsed', 'QuestionParsed', 'Completed']);
      expect(events.every(e => e.import_id === 'imp-1')).toBe(true);
      expect(Object.keys(events[0]!)).toEqual(['type', 'stage', 'message', 'percent', 'import_id']);
      expect(events[4]).toMatchObject({ total_questions: 2, partial: false, failed_count: 0 });
      expect(JSON.parse(f.repos.exams.getImportState(f.db, response.summary.id)!))
        .toEqual({ schema_version: 2, job_id: response.draft_job_id });
      expect(f.repos.questions.countQuestions(f.db, response.summary.id)).toBe(0);
      // 完成后登记已释放，迟到的取消返回 false
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp-1' })).resolves.toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('完整来源分支（txt）：一次主请求，草稿 ready，元数据为整份来源路由', async () => {
    const f = await fixture();
    try {
      const response = await f.host.invoke<QuestionImportDraftResponse>('import_question_bank_stream',
        { request: { content: b64('1. 题一'), format: 'txt', name: '文本卷' } });
      expect(f.calls).toHaveLength(1);
      expect((response.draft_document as QuestionDocument).questions.map(q => q.content)).toEqual(['题一']);
      expect(response.model_route).toMatchObject({ source_route: 'whole_original_source', complete_document: true,
        main_requests: 1, visual_fallback: null });
      const events = f.progress();
      expect(events.map(e => e.message).filter(Boolean)).toEqual(['正在准备完整来源...', '正在使用 主模型 理解完整材料...']);
      expect(events.some(e => Object.hasOwn(e, 'import_id'))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'Completed', partial: false });
    } finally {
      await f.dispose();
    }
  });

  it('解析进行中取消：报「题目集导入已取消」，不写 last_error、不发 Completed，登记被释放', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture({ reply: async () => { started(); await gate; return JSON.stringify(EXTRACTED); } });
    try {
      const pending = f.host.invoke('import_question_bank_stream',
        { request: { content: b64('1. 题'), format: 'txt', import_id: 'imp-c' } });
      await running;
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp-c' })).resolves.toBe(true);
      await expect(pending).rejects.toMatchObject({ error_type: 'Validation', message: '题目集导入已取消' });
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      const events = f.progress();
      expect(events.map(e => e.type)).toEqual(['Preprocessing', 'SessionCreated', 'Preprocessing']);
      const state = JSON.parse(f.repos.exams.getImportState(f.db, events[1]!.session_id as string)!);
      expect(state.last_error).toBeUndefined();
      expect(state.model_fingerprint).toBe(authoringConfigFingerprint(CONFIG));
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'imp-c' })).resolves.toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('同一 import_id 仍在运行时拒绝第二次导入', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ reply: async () => { await gate; return JSON.stringify(EXTRACTED); } });
    try {
      const first = f.host.invoke('import_question_bank_stream',
        { request: { content: b64('1. 题'), format: 'txt', import_id: 'busy' } });
      await expect(f.host.invoke('import_question_bank_stream',
        { request: { content: b64('{}'), format: 'json', import_id: 'busy' } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: '该题目集导入仍在进行中，请稍后再试' });
      release();
      await expect(first).resolves.toMatchObject({ committed: false });
    } finally {
      await f.dispose();
    }
  });

  it('主模型失败：记录 last_error 后原样抛出', async () => {
    const f = await fixture({ reply: async () => { throw new CommandError(AppError.llm('上游错误')); } });
    try {
      await expect(f.host.invoke('import_question_bank_stream',
        { request: { content: b64('1. 题'), format: 'txt' } }))
        .rejects.toMatchObject({ error_type: 'LLM', message: '上游错误' });
      const sessionId = f.progress()[1]!.session_id as string;
      const state = JSON.parse(f.repos.exams.getImportState(f.db, sessionId)!);
      expect(state.last_error).toEqual({ error_type: 'LLM', message: '上游错误', details: null });
      expect(Object.keys(state)).toEqual(['schema_version', 'source_bundle', 'model_config_id', 'model_fingerprint',
        'qbank_name', 'last_error']);
    } finally {
      await f.dispose();
    }
  });
});

describe('import_question_bank (host.invoke)', () => {
  it('非流式：结果相同但不发任何进度事件', async () => {
    const f = await fixture();
    try {
      const response = await f.host.invoke<QuestionImportDraftResponse>('import_question_bank', {
        request: { content: b64(JSON.stringify({ questions: [{ content: '题' }] })), format: 'json' } });
      expect(response.draft_job_id).not.toBeNull();
      expect(response.summary.exam_name).toBe('导入的题目集');
      expect(f.progress()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it('json 无 questions 数组 → Validation', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('import_question_bank', { request: { content: b64('{"x":1}'), format: 'json' } }))
        .rejects.toMatchObject({ error_type: 'Validation', message: 'JSON 需要 questions 数组' });
    } finally {
      await f.dispose();
    }
  });

  it('追加到不存在的题目集 → NotFound', async () => {
    const f = await fixture();
    try {
      await expect(f.host.invoke('import_question_bank', { request: {
        content: b64(JSON.stringify({ questions: [{ content: '题' }] })), format: 'json', session_id: 'nope' } }))
        .rejects.toMatchObject({ error_type: 'NotFound', message: '目标题目集不存在' });
    } finally {
      await f.dispose();
    }
  });
});
