/**
 * `resume_question_import` 生产入口契约测试（commands.rs:1285-1350、question_import_service.rs:741-1376、2053-2934）。
 * host.invoke；真实 SQLite + vfs-repos 插件 + L18 ExamSheetSessionCore；L02/L18 视觉与 LLM 边界按已发布签名注入确定结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L18 真实的整卷会话服务组装 draft 响应
import { ExamSheetSessionCore } from '../../media/src/exam-sheet-service.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { ApiConfig, LlmQuestionAuthoring, LlmQuestionParsing } from '../../llm/api.ts';
import type {
  MergedQuestion, QuestionImportVisionService, QuestionWithFigures, StructuredQuestion, VlmExtractedQuestion,
  VlmPageAnalysis,
} from '../../media/api.ts';
import qbank from '../index.ts';
import type { QuestionDocument, QuestionImportDraftResponse } from '../api.ts';
import { authoringConfigFingerprint, bundleValue } from '../src/question-import-service.ts';
import type { SourceBundle } from '../src/source-bundle.ts';

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

type Vision = Partial<QuestionImportVisionService>;

interface Options {
  parsing?: LlmQuestionParsing['parseStreaming'];
  vision?: Vision;
}

async function fixture(options: Options = {}) {
  const { storage, base } = await createMigratedStorage('qbank-import-resume-');
  const vision: QuestionImportVisionService = {
    version: 1,
    analyzePageByBlob: async () => ({ questions: [] }),
    analyzeSinglePage: async () => ({ questions: [] }),
    describeImage: async () => '',
    extractDocxQuestionsStream: async () => 0,
    mergePages: () => [],
    extractFigures: async merged => merged.map(item => ({ merged: item, images: [] })),
    structureQuestions: async () => [0, [], []],
    loadPageImageBytes: () => new Uint8Array([1, 2, 3]),
    decodeVlmPageAnalysis: text => JSON.parse(text) as VlmPageAnalysis,
    encodeVlmPageAnalysis: analysis => JSON.stringify(analysis),
    ...options.vision,
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
      llmQuestionAuthoring: {
        runQuestionJson: async () => ({ content: JSON.stringify(EXTRACTED), finishReason: 'stop', usage: null, jsonMode: true }),
        buildDebugPersistConfig: () => null,
      } satisfies LlmQuestionAuthoring,
      llmQuestionParsing: {
        parse: async () => '',
        parseStreaming: options.parsing ?? (async () => []),
      } satisfies LlmQuestionParsing,
      questionImportVision: vision,
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
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  sessions = new ExamSheetSessionCore({
    db: () => db, exams: () => repos.exams, questions: () => repos.questions,
    nativeImage: () => { throw new Error('nativeImage unused'); },
    encodePng: async () => { throw new Error('encodePng unused'); },
    imagesDir: () => path.join(base, 'images'),
    log: { warn: () => undefined, info: () => undefined },
  });
  const createExam = (id: string, state: JsonValue | null) => {
    db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
      VALUES (?1, '旧导入', 'importing', ?1, '{}', '{"pages":[]}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`, [id]);
    if (state !== null) repos.exams.updateImportState(db, id, state);
  };
  return {
    host, db, repos, blobsDir, createExam,
    progress: () => host.eventsNamed('question_import_progress') as Record<string, unknown>[],
    resume: (sessionId: string, importId: string | null = null) =>
      host.invoke<QuestionImportDraftResponse>('resume_question_import', { sessionId, importId }),
    questions: (sessionId: string) => repos.questions.listQuestions(db, sessionId, {}, 1, 100).questions,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function withFixture(options: Options, body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(options);
  try {
    await body(f);
  } finally {
    await f.dispose();
  }
}

const TEXT_BUNDLE: SourceBundle = {
  sources: [{ source_id: 's1', name: '卷', format: 'txt', page_count: null, text: '1. 题', blob_hash: 'b',
    content_hash: 'a'.repeat(64) }],
  pages: [], text: '1. 题', format: 'txt',
};

function legacy(overrides: Record<string, JsonValue>): JsonValue {
  return { qbank_name: '旧卷', model_config_id: 'cfg_t', source_format: 'pdf', page_blob_hashes: [], ...overrides };
}

const types = (f: Fixture) => f.progress().map(event => event.type);

describe('resume_question_import · v2', () => {
  it('草稿指针：返回已有草稿与题目集名称，不发进度事件', () => withFixture({}, async f => {
    const first = await f.host.invoke<QuestionImportDraftResponse>('import_question_bank', {
      request: { content: Buffer.from(JSON.stringify({ questions: [{ content: '题' }] })).toString('base64'),
        format: 'json', name: '续导' } });
    const resumed = await f.resume(first.summary.id);
    expect(resumed.draft_job_id).toBe(first.draft_job_id);
    expect(resumed.committed).toBe(false);
    expect(f.progress()).toEqual([]);
  }));

  it('来源包：模型指纹变化 → Configuration，登记被移除', () => withFixture({}, async f => {
    f.createExam('exam_fp', { schema_version: 2, source_bundle: bundleValue(TEXT_BUNDLE),
      model_config_id: 'cfg_main', model_fingerprint: 'stale', qbank_name: '旧' });
    await expect(f.resume('exam_fp', 'r1')).rejects.toMatchObject({ error_type: 'Configuration',
      message: '恢复任务的模型配置已变化，请从原文件创建新解析任务' });
    await expect(f.host.invoke('cancel_question_bank_import', { importId: 'r1' })).resolves.toBe(false);
  }));

  it('来源包：指纹一致时重新抽取并保存新草稿指针', () => withFixture({}, async f => {
    f.createExam('exam_ok', { schema_version: 2, source_bundle: bundleValue(TEXT_BUNDLE),
      model_config_id: 'cfg_main', model_fingerprint: authoringConfigFingerprint(CONFIG), qbank_name: '旧' });
    const resumed = await f.resume('exam_ok');
    expect((resumed.draft_document as QuestionDocument).questions.map(q => q.content)).toEqual(['题一']);
    expect(JSON.parse(f.repos.exams.getImportState(f.db, 'exam_ok')!))
      .toEqual({ schema_version: 2, job_id: resumed.draft_job_id });
  }));

  it('schema_version 为 2.0（F64）不走 v2，按旧 checkpoint 解析失败', () => withFixture({}, async f => {
    f.createExam('exam_f', null);
    f.db.run(`UPDATE exam_sheets SET import_state_json = '{"schema_version":2.0,"job_id":"x"}' WHERE id = 'exam_f'`);
    await expect(f.resume('exam_f')).rejects.toMatchObject({ error_type: 'Validation',
      message: expect.stringMatching(/^解析导入状态失败: /) });
  }));

  it('schema_version 为 2e0（F64）不走 v2，按旧 checkpoint 解析失败', () => withFixture({}, async f => {
    f.createExam('exam_fe', null);
    f.db.run(`UPDATE exam_sheets SET import_state_json = '{"schema_version":2e0,"job_id":"x"}' WHERE id = 'exam_fe'`);
    await expect(f.resume('exam_fe')).rejects.toMatchObject({ error_type: 'Validation',
      message: expect.stringMatching(/^解析导入状态失败: /) });
  }));

  it('没有导入状态 → NotFound', () => withFixture({}, async f => {
    f.createExam('exam_none', null);
    await expect(f.resume('exam_none')).rejects.toMatchObject({ error_type: 'NotFound', message: '未找到可恢复的导入状态' });
  }));

  it('同一恢复 import_id 仍在运行 → 拒绝', () => withFixture({}, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.createExam('exam_busy', legacy({ import_mode: 'text', text_content: '1. 题' }));
    const parsing = f.host.ctx.get('llmQuestionParsing') as LlmQuestionParsing;
    parsing.parseStreaming = async () => { await gate; return []; };
    const first = f.resume('exam_busy', 'dup');
    await expect(f.resume('exam_busy', 'dup')).rejects.toMatchObject({ message: '该恢复任务仍在运行' });
    release();
    await expect(first).rejects.toMatchObject({ error_type: 'Validation' });
  }));
});

describe('resume_question_import · 旧版纯文本', () => {
  it('从断点块续导、写入正式题目并收尾，事件附 import_id', async () => {
    const calls: string[] = [];
    await withFixture({ parsing: async (prompt, modelConfigId, onQuestion) => {
      calls.push(`${modelConfigId}:${prompt.includes('第二块') ? 2 : 1}`);
      const items: JsonValue[] = [
        { content: '选择题\nA. 一 B. 二 C. 三', question_type: '单选', options: [
          { key: 'A', content: '一' }, { key: 'B', content: '二' }, { key: 'C', content: '三' }] },
        { content: '   ' },
      ];
      for (const item of items) onQuestion(item);
      return items;
    } }, async f => {
      const text = `${'第一块'.repeat(4000)}\n\n${'第二块'.repeat(4000)}`;
      f.createExam('exam_txt', legacy({ source_format: 'txt', import_mode: 'text', text_content: text,
        chunks_total: 2, chunks_completed: 1 }));
      const response = await f.resume('exam_txt', 'imp-r');
      expect(calls).toEqual(['cfg_t:2']);
      expect(response.committed).toBe(true);
      const list = f.questions('exam_txt');
      expect(list.map(q => [q.content, q.question_type, q.question_label])).toEqual([['选择题', 'single_choice', 'Q1']]);
      expect(f.repos.exams.getImportState(f.db, 'exam_txt')).toBeNull();
      expect(f.repos.exams.getExamSheet(f.db, 'exam_txt')!.status).toBe('completed');
      expect(types(f)).toEqual(['SessionCreated', 'ChunkStart', 'QuestionParsed', 'ChunkCompleted', 'Completed']);
      expect(f.progress().every(event => event.import_id === 'imp-r')).toBe(true);
      expect(f.progress()[4]).toMatchObject({ total_questions: 1, partial: false, failed_count: 0 });
    });
  });

  it('一题未提取且解析失败 → Validation 带首个失败原因，并收尾', () => withFixture({
    parsing: async () => { throw new Error('  对话模型未配置 '); },
  }, async f => {
    f.createExam('exam_fail', legacy({ source_format: 'txt', import_mode: 'text', text_content: '1. 题' }));
    await expect(f.resume('exam_fail')).rejects.toMatchObject({ error_type: 'Validation',
      message: '未能提取到题目：对话模型未配置' });
    expect(f.repos.exams.getExamSheet(f.db, 'exam_fail')!.status).toBe('completed');
    expect(f.repos.exams.getImportState(f.db, 'exam_fail')).toBeNull();
  }));
});

describe('resume_question_import · DOCX VLM 直提', () => {
  it('DocxVlmDirectDone：重建预览并直接收尾', () => withFixture({}, async f => {
    f.createExam('exam_done', legacy({ current_stage: 'docx_vlm_direct_done', docx_vlm_direct_saved: 4 }));
    const response = await f.resume('exam_done');
    expect(response).toMatchObject({ committed: true });
    expect(types(f)).toEqual(['SessionCreated', 'Completed']);
    expect(f.progress()[1]).toMatchObject({ total_questions: 4, partial: false });
    expect(f.repos.exams.getImportState(f.db, 'exam_done')).toBeNull();
  }));

  it('重建预览的默认 bbox 按 ExamCardBBox（models.rs:300，f32）输出 0.0', () => withFixture({}, async f => {
    f.createExam('exam_bbox', legacy({ current_stage: 'docx_vlm_direct_done', docx_vlm_direct_saved: 1 }));
    f.repos.questions.createQuestion(f.db, { exam_id: 'exam_bbox', content: '已存题' });
    await f.resume('exam_bbox');
    expect(f.db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_bbox'"))
      .toContain('"bbox":{"x":0.0,"y":0.0,"width":0.0,"height":0.0}');
  }));

  it('DocxVlmDirect：跳过已保存题、内容去重、图片关联，按位置续存', async () => {
    const seen: string[][] = [];
    const extracted = (content: string, indices: number[]): VlmExtractedQuestion => ({
      content, question_type: 'short_answer', options: [], answer: '', explanation: '', image_indices: indices,
      difficulty: 'easy', tags: [],
    });
    await withFixture({ vision: {
      extractDocxQuestionsStream: async (urls, text, onQuestion) => {
        seen.push([...urls.map(url => url.slice(0, 23)), text]);
        const items = [extracted('已存题', []), extracted('已存题 ', []), extracted('新题', [0, 5]), extracted('  ', [])];
        for (const item of items) if (!onQuestion(item)) break;
        return items.length;
      },
    } }, async f => {
      f.createExam('exam_vlm', legacy({ current_stage: 'docx_vlm_direct' }));
      f.repos.questions.createQuestion(f.db, { exam_id: 'exam_vlm', content: '已存题' });
      const blob = f.repos.blobs.storeBlob(f.db, f.blobsDir, new Uint8Array([9, 9, 9]), 'image/jpeg', 'jpg');
      f.repos.exams.updateImportState(f.db, 'exam_vlm', legacy({ current_stage: 'docx_vlm_direct',
        docx_vlm_direct_blob_hashes: [blob.hash, 'missing'], docx_vlm_direct_mimes: ['image/jpeg'],
        docx_vlm_direct_exts: ['jpg'], docx_vlm_direct_text: '正文', docx_vlm_direct_saved: 1 }));
      const response = await f.resume('exam_vlm');
      expect(seen).toEqual([['data:image/jpeg;base64,', '', '正文']]);
      expect(response).toMatchObject({ committed: true });
      const list = f.questions('exam_vlm');
      expect(list.map(q => q.content)).toEqual(['已存题', '新题']);
      const added = list[1]!;
      expect(added.question_label).toBe('Q2');
      expect(added.images.map(image => [image.name, image.mime, image.hash, image.role]))
        .toEqual([['docx_image_0.jpg', 'image/jpeg', blob.hash, 'question']]);
      expect(added.images[0]!.id).toMatch(/^file_/);
      expect(types(f)).toEqual(['SessionCreated', 'Preprocessing', 'QuestionParsed', 'Completed']);
      expect(f.progress()[1]).toMatchObject({ message: '恢复 VLM 提取: 2 张图片, 已保存 1 题...' });
      expect(f.progress()[3]).toMatchObject({ total_questions: 2, partial: false });
    });
  });

  it('VLM 失败且无新题 → Failed 事件后原样抛出', () => withFixture({ vision: {
    extractDocxQuestionsStream: async () => { throw new Error('未找到可用的 VLM 模型'); },
  } }, async f => {
    f.createExam('exam_vf', legacy({ current_stage: 'docx_vlm_direct' }));
    await expect(f.resume('exam_vf')).rejects.toMatchObject({ message: '未找到可用的 VLM 模型' });
    expect(f.progress().at(-1)).toMatchObject({ type: 'Failed', error: 'VLM 提取失败: 未找到可用的 VLM 模型' });
  }));
});

describe('resume_question_import · DOCX 原生', () => {
  it('逐图描述后结构化：标记内图片关联并清理为 [图N]，遗漏标记的图片兜底关联', async () => {
    const prompts: string[] = [];
    await withFixture({
      vision: { describeImage: async bytes => (bytes[0] === 1 ? '三角形\n边长>>3' : '') },
      parsing: async (prompt, _id, onQuestion) => {
        prompts.push(prompt);
        const item: JsonValue = { content: '第1题 如图<<IMG:0:[图片内容: 三角形 边长> >3]>> 求面积', question_type: 'calculation' };
        onQuestion(item);
        return [item];
      },
    }, async f => {
      f.createExam('exam_dn', legacy({ source_format: 'docx', current_stage: 'docx_extracted',
        text_content: '第1题 如图<<IMG:0>> 求面积\n第2题<<IMG:1>>',
        docx_image_entries: [
          { marker_index: 0, blob_hash: 'h0', mime: 'image/png', ext: 'png' },
          { marker_index: 1, blob_hash: 'h1', mime: 'image/png', ext: 'png' },
        ] }));
      const response = await f.resume('exam_dn');
      expect(response).toMatchObject({ committed: true });
      expect(prompts[0]).toContain('<<IMG:0:[图片内容: 三角形 边长> >3]>>');
      expect(prompts[0]).toContain('<<IMG:1:[图片内容: 三角形 边长> >3]>>');
      const [question] = f.questions('exam_dn');
      expect(question!.content).toBe('第1题 如图[图0] 求面积');
      expect(question!.images.map(image => [image.hash, image.name])).toEqual([['h0', 'docx_image_0.png'], ['h1', 'docx_image_1.png']]);
      expect(types(f)).toEqual(['SessionCreated', 'OcrImageCompleted', 'OcrImageCompleted', 'OcrPhaseCompleted',
        'ChunkStart', 'QuestionParsed', 'ChunkCompleted', 'Completed']);
    });
  });
});

describe('resume_question_import · Visual-First', () => {
  const page = (label: string): VlmPageAnalysis => ({ questions: [{ label, bbox: [0, 0, 1, 1], raw_text: `题${label}`,
    is_group: false, sub_questions: [], figures: [], continues_from_previous: false, continues_to_next: false }] });

  it('从断点页续做 VLM（最多 3 页并发、按页序写 checkpoint），合并、配图、结构化后原子持久化', async () => {
    let inFlight = 0;
    let peak = 0;
    const analyzed: number[] = [];
    await withFixture({ vision: {
      analyzePageByBlob: async slice => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, (6 - slice.page_index) * 5));
        inFlight -= 1;
        analyzed.push(slice.page_index);
        if (slice.page_index === 3) throw new Error('页面超时');
        return page(String(slice.page_index + 1));
      },
      mergePages: analyses => analyses.flatMap((analysis, index) => (analysis === null ? [] : analysis.questions
        .map(question => ({ question, page_indices: [index], figures_with_page: [] } as MergedQuestion)))),
      structureQuestions: async (items: readonly QuestionWithFigures[], modelConfigId, done, prior) => {
        expect([modelConfigId, done, prior]).toEqual(['cfg_t', 0, []]);
        return [1, ['[...]'], items.map((item, index): StructuredQuestion => ({
          json: { content: index === 1 ? ' ' : item.merged.question.raw_text, question_type: 'short_answer' },
          source: item,
        }))];
      },
    } }, async f => {
      f.createExam('exam_vis', legacy({ current_stage: 'vlm_analyzing', page_blob_hashes: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
        page_dimensions: [[10, 20]], vlm_pages_completed: 1, vlm_page_results: [JSON.stringify(page('1'))] }));
      const response = await f.resume('exam_vis');
      expect(response).toMatchObject({ committed: true, summary: { exam_name: '旧导入' } });
      expect(peak).toBeLessThanOrEqual(3);
      expect(analyzed).not.toContain(0);
      // 题1 来自 checkpoint，题4 页失败；结构化后第 2 条为空内容被跳过
      expect(f.questions('exam_vis').map(q => [q.content, q.question_label])).toEqual(
        [['题1', 'Q1'], ['题3', 'Q3'], ['题5', 'Q4'], ['题6', 'Q5']]);
      const ocr = f.progress().filter(event => event.type === 'OcrImageCompleted').map(event => event.image_index);
      expect(ocr).toEqual([1, 2, 3, 4, 5]);
      const all = types(f);
      expect(all.slice(all.lastIndexOf('OcrImageCompleted') + 1)).toEqual(['OcrPhaseCompleted', 'Preprocessing',
        'ExtractingFigures', 'ExtractingFigures', 'StructuringQuestion', 'QuestionParsed', 'QuestionParsed',
        'QuestionParsed', 'QuestionParsed', 'Completed']);
      expect(f.progress().at(-1)).toMatchObject({ type: 'Completed', total_questions: 4 });
      expect(f.repos.exams.getImportState(f.db, 'exam_vis')).toBeNull();
      const sheet = f.repos.exams.getExamSheet(f.db, 'exam_vis')!;
      expect(sheet.status).toBe('completed');
      const preview = sheet.previewJson as { pages: { page_index: number; cards: unknown[]; width: number }[] };
      expect(preview.pages.map(p => [p.page_index, p.cards.length, p.width])).toEqual(
        [[0, 4, 10], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0]]);
      const rawPreview = f.db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_vis'")!;
      expect(rawPreview.split('"bbox":{"x":0.0,"y":0.0,"width":0.0,"height":0.0}')).toHaveLength(5);
    });
  });

  // vfs-repos `utcNow()`（repository/timestamps.ts:21）取 `nowEpochNanos()`：墙钟毫秒不前进时亚毫秒位被钳位，
  // created_at 并列，`listQuestions` 的 `ORDER BY created_at, id` 按随机 id 排序（上面并发用例偶发失败的根因）。
  // Rust `Utc::now()` 纳秒分辨率，同批题目按写入顺序列出。改用 `orderedNowEpochNanos()` 后翻为 `it`。
  it('墙钟毫秒不前进时，同批写入的题目 created_at 严格递增、按写入顺序列出', async () => {
    await withFixture({ vision: {
      analyzePageByBlob: async slice => page(String(slice.page_index + 1)),
      mergePages: analyses => analyses.flatMap((analysis, index) => (analysis === null ? [] : analysis.questions
        .map(question => ({ question, page_indices: [index], figures_with_page: [] } as MergedQuestion)))),
      structureQuestions: async (items: readonly QuestionWithFigures[]) => [1, ['[...]'], items.map(
        (item): StructuredQuestion => ({ json: { content: item.merged.question.raw_text, question_type: 'short_answer' },
          source: item }))],
    } }, async f => {
      f.createExam('exam_tie', legacy({ page_blob_hashes: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] }));
      const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10);
      try {
        await f.resume('exam_tie');
      } finally {
        frozen.mockRestore();
      }
      const createdAt = f.db.all<{ created_at: string }>(
        "SELECT created_at FROM questions WHERE exam_id = 'exam_tie' ORDER BY rowid").map(row => row.created_at);
      expect(createdAt).toHaveLength(6);
      expect(createdAt.every((stamp, index) => index === 0 || stamp > createdAt[index - 1]!)).toBe(true);
      expect(f.questions('exam_tie').map(q => q.content)).toEqual(['题1', '题2', '题3', '题4', '题5', '题6']);
    });
  });

  it('一题未识别 → Failed 事件、状态 completed，错误带首个失败页原因', () => withFixture({ vision: {
    analyzePageByBlob: async () => { throw new Error('未找到可用的 VLM 模型'); },
  } }, async f => {
    f.createExam('exam_none_vis', legacy({ page_blob_hashes: ['p0'] }));
    await expect(f.resume('exam_none_vis')).rejects.toMatchObject({ error_type: 'Validation',
      message: '未能识别出题目：未找到可用的 VLM 模型' });
    expect(f.progress().at(-1)).toMatchObject({ type: 'Failed', error: '未能识别出题目：未找到可用的 VLM 模型' });
    expect(f.repos.exams.getExamSheet(f.db, 'exam_none_vis')!.status).toBe('completed');
    const state = JSON.parse(f.repos.exams.getImportState(f.db, 'exam_none_vis')!);
    expect([state.current_stage, state.vlm_pages_completed, state.vlm_page_results]).toEqual(['vlm_completed', 1, ['']]);
  }));

  it('取消恢复：报「题目解析恢复已取消」，后续页不再写 checkpoint', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    await withFixture({ vision: {
      analyzePageByBlob: async () => { started(); await gate; return page('1'); },
    } }, async f => {
      f.createExam('exam_c', legacy({ page_blob_hashes: ['p0'] }));
      const pending = f.resume('exam_c', 'rc');
      await running;
      await expect(f.host.invoke('cancel_question_bank_import', { importId: 'rc' })).resolves.toBe(true);
      await expect(pending).rejects.toMatchObject({ message: '题目解析恢复已取消' });
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      const state = JSON.parse(f.repos.exams.getImportState(f.db, 'exam_c')!);
      expect(state.vlm_pages_completed).toBe(0);
      expect(f.questions('exam_c')).toEqual([]);
    });
  });
});
