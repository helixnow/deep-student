/**
 * dstu-vision Stage 2–5 through the provided `questionImportVision` service (production entry):
 * `vlm_grounding_service.rs` (Rust tests ported: resize/hard limit, count budget, remap, crop default
 * bbox), `cross_page_merger.rs`, `figure_extractor.rs`, `llm_structurer.rs` (Rust test: reusable batch
 * results). Only L02/L01 model services, the VFS repos and the network are substituted; images use
 * the real F7 `nativeImage`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type {
  MergedQuestion, PageSlice, QuestionImportVisionService, QuestionWithFigures, VlmExtractedQuestion,
  VlmPageAnalysis, VlmQuestion,
} from '../api.ts';
import { LATEX_OUTPUT_BRIEF, llmReplayPlugin, type ReplayResponse, type ReplayScript } from '../../llm-providers/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { DOCX_VLM_MAX_DIMENSION, DOCX_VLM_MAX_IMAGE_BYTES } from '../src/vlm-grounding.ts';
import { BATCH_FAILED_SENTINEL } from '../src/llm-structurer.ts';
import { encodePngRgba } from './helpers/png.ts';

type Cfg = Record<string, unknown> & { id: string; name: string; model: string };
type Completion = { content: string; finishReason?: string | null };

let root: string;
let host: TestHost;
let service: QuestionImportVisionService;
let configs: Cfg[];
let singleShots: Array<{ config: Cfg; body: Record<string, any>; apiKey: string; context: string; opts: Record<string, any> }>;
let respond: (config: Cfg) => Promise<Completion>;
let parseCalls: Array<{ prompt: string; id: string | null }>;
let parseRespond: (prompt: string) => Promise<string>;
let blobs: Map<string, string>;
let stored: Array<{ bytes: Uint8Array; mime: unknown; ext: unknown }>;
let files: unknown[][];
let httpCalls: Array<{ url: string; init: RequestInit & { requestTimeoutMs?: number | null } }>;

function cfg(id: string, model: string, extra: Record<string, unknown> = {}): Cfg {
  return {
    id, name: `n-${id}`, model, baseUrl: 'https://api.example.com/v1', apiKey: `k-${id}`, enabled: true,
    isMultimodal: true, maxOutputTokens: 4096, maxTokensLimit: null, vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null, isReasoning: false,
    isEmbedding: false, isReranker: false, isImageGeneration: false, modelAdapter: 'general', temperature: 0.7,
    supportsTools: false, geminiApiVersion: 'v1beta', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false, minP: null, topK: null,
    enableThinking: null, supportsReasoning: false, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
    presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, contextWindow: null, extraBody: null, resolvedAdapterId: null, ...extra,
  };
}

function png(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([(i * 7) % 251, (i * 13) % 241, (i * 3) % 239, 255], i * 4);
  return encodePngRgba(width, height, rgba);
}

const dataUrl = (bytes: Uint8Array, mime = 'image/png'): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

function putBlob(hash: string, bytes: Uint8Array): void {
  const file = path.join(root, hash);
  fs.writeFileSync(file, bytes);
  blobs.set(hash, file);
}

async function appErrorOf(run: () => Promise<unknown> | unknown): Promise<{ error_type: string; message: string }> {
  try { await run(); }
  catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    return (error as CommandError).value as { error_type: string; message: string };
  }
  throw new Error('expected CommandError');
}

function q(label: string, extra: Partial<VlmQuestion> = {}): VlmQuestion {
  return {
    label, bbox: [0, 0, 1, 1], raw_text: `text-${label}`, is_group: false, sub_questions: [], figures: [],
    continues_from_previous: false, continues_to_next: false, ...extra,
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'l18h3-vision-'));
  configs = [cfg('c1', 'glm-4.6v')];
  singleShots = [];
  respond = async () => ({ content: '[]' });
  parseCalls = [];
  parseRespond = async () => '[]';
  blobs = new Map();
  stored = [];
  files = [];
  httpCalls = [];
  host = await createTestHost({
    plugins: [media, [llmReplayPlugin, { scripts: DOCX_SCRIPTS }]],
    provide: { storage: unusedStorage(),
      llmHttp: {
        fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          httpCalls.push({ url: String(input), init: init ?? {} });
          return host.ctx.llmReplay.fetch(input, init);
        },
      },
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: root },
      vfsDatabase: { getConnSafe: () => ({}), blobsDir: () => '/blobs' },
      vfsRepo: {
        blobs: {
          getBlobPath: (_conn: unknown, dir: string, hash: string) => { expect(dir).toBe('/blobs'); return blobs.get(hash) ?? null; },
          storeBlob: (_conn: unknown, _dir: string, bytes: Uint8Array, mime: unknown, ext: unknown) => {
            stored.push({ bytes, mime, ext });
            return { hash: `fig${stored.length}` };
          },
        },
        files: {
          createFile: (...args: unknown[]) => { files.push(args.slice(1)); return { id: `file_${files.length}` }; },
        },
      },
      nativeImage,
      llm: {
        getApiConfigs: async () => configs,
        decryptApiKey: async (key: string) => `dec:${key}`,
      },
      llmOcrModels: { getAvailableOcrModels: async () => [], isOcrThinkingEnabled: () => false },
      llmStreaming: {
        singleShotCompletion: async (config: Cfg, body: Record<string, any>, apiKey: string, _session: null,
          context: string, opts: Record<string, any>) => {
          singleShots.push({ config, body, apiKey, context, opts });
          const r = await respond(config);
          return { content: r.content, reasoningBytes: 0, finishReason: r.finishReason ?? 'stop', usage: null,
            mode: 'stream', attempts: 1, interrupted: null, aborted: false };
        },
      },
      llmQuestionParsing: {
        parse: async (prompt: string, id: string | null) => { parseCalls.push({ prompt, id }); return parseRespond(prompt); },
      },
      llmAdapters: { createAdapter: () => { throw new Error('unused'); }, prepareRemoteImages: async (b: unknown) => b },
    },
  });
  service = host.ctx.questionImportVision as QuestionImportVisionService;
});

/**
 * Back-off sleeps (2s structurer retry, 3^n s DOCX retry) are recorded and run immediately;
 * all other timers (WASM runner, 120s idle timeout) keep their real delays.
 */
function recordSleeps(): number[] {
  const sleeps: number[] = [];
  const real = globalThis.setTimeout;
  vi.stubGlobal('setTimeout', ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 2_000 || ms === 3_000 || ms === 9_000) { sleeps.push(ms); return real(fn, 0, ...args); }
    return real(fn, ms, ...args);
  }) as typeof setTimeout);
  return sleeps;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- serde

it('VlmPageAnalysis serde: defaults, strict types, f64 ryu output', () => {
  const decoded = service.decodeVlmPageAnalysis('{"questions":[{"label":"1","bbox":[0,0.5,1,1e0],"extra":1}]}');
  expect(decoded).toEqual({ questions: [q('1', { raw_text: '', bbox: [0, 0.5, 1, 1] })] });
  expect(service.encodeVlmPageAnalysis(decoded!)).toBe('{"questions":[{"label":"1","bbox":[0.0,0.5,1.0,1.0],'
    + '"raw_text":"","is_group":false,"sub_questions":[],"figures":[],"continues_from_previous":false,'
    + '"continues_to_next":false}]}');
  expect(service.decodeVlmPageAnalysis(service.encodeVlmPageAnalysis(decoded!))).toEqual(decoded);
  expect(service.decodeVlmPageAnalysis('{}')).toBeNull(); // missing field `questions`
  expect(service.decodeVlmPageAnalysis('{"questions":[{"label":null}]}')).toBeNull();
  expect(service.decodeVlmPageAnalysis('{"questions":[{"bbox":[0,0,1]}]}')).toBeNull();
  expect(service.decodeVlmPageAnalysis('{"questions":[{"label":"1","label":"2"}]}')).toBeNull(); // duplicate field
  expect(service.decodeVlmPageAnalysis('{"questions":[]} x')).toBeNull();
});

// ---------------------------------------------------------------- analyze_page_by_blob

it('analyze_page_by_blob loads the page blob, sends a single-shot VLM request and parses the fenced array', async () => {
  const page = png(4, 4);
  putBlob('h1', page);
  respond = async () => ({ content: '```json\n[{"label":"3","raw_text":"x","figures":[{"bbox":[0.1,0.2,0.3,0.4]}]}]\n```' });
  const result = await service.analyzePageByBlob({ page_index: 0, blob_hash: 'h1', text_hint: '提示', width: 4, height: 4 });
  expect(result.questions).toEqual([q('3', { raw_text: 'x', bbox: [0, 0, 0, 0],
    figures: [{ bbox: [0.1, 0.2, 0.3, 0.4], fig_label: '' }] })]);
  const call = singleShots[0]!;
  expect(call.apiKey).toBe('dec:k-c1');
  expect(call.context).toBe('VLM 请求构建失败');
  expect(call.opts.label).toBe('VLM-Grounding(glm-4.6v)');
  expect(call.opts.maxRetries).toBe(2);
  expect(call.body.temperature).toBe(0.1);
  expect(call.body.max_tokens).toBe(4096);
  expect(call.body.stream).toBeUndefined();
  expect(call.body.thinking).toEqual({ type: 'disabled' });
  const content = call.body.messages[0].content;
  expect(content[0]).toEqual({ type: 'image_url', image_url: { url: dataUrl(page), detail: 'high' } });
  expect(content[1].text).toContain('**机器提取的文本参考**（可能有误，仅供辅助识别模糊内容，以图片为准）：\n---\n提示\n---\n');
  expect(content[1].text).toContain(`1. 公式格式：${LATEX_OUTPUT_BRIEF}`);
});

it('analyze_page_by_blob: missing blob is NotFound', async () => {
  const error = await appErrorOf(() => service.analyzePageByBlob({ page_index: 0, blob_hash: 'nope', text_hint: null, width: 1, height: 1 }));
  expect(error).toMatchObject({ error_type: 'NotFound', message: '页面图片 blob 不存在: nope' });
});

it('analyze_single_page fails over to the next candidate and accepts the {"questions": [...]} form', async () => {
  configs = [cfg('c1', 'glm-4.6v'), cfg('c2', 'qwen3-vl-plus')];
  respond = async config => {
    if (config.id === 'c1') throw { error_type: 'LLM', message: 'boom', details: null };
    return { content: 'prefix {"questions":[{"label":"9"}]} suffix' };
  };
  const result = await service.analyzeSinglePage('data:image/png;base64,AA==', null);
  expect(result.questions.map(x => x.label)).toEqual(['9']);
  expect(singleShots.map(s => s.config.id)).toEqual(['c1', 'c2']);
  expect(singleShots[1]!.body.thinking).toBeUndefined();
  expect(singleShots[0]!.body.messages[0].content[1].text).not.toContain('机器提取的文本参考');
});

it('analyze_single_page: unparsable responses surface the last error; no candidates is Configuration', async () => {
  respond = async () => ({ content: 'no json here' });
  expect(await appErrorOf(() => service.analyzeSinglePage('data:,', null)))
    .toMatchObject({ error_type: 'LLM', message: 'VLM 响应无法解析为题目分析结果' });
  configs = [cfg('c1', 'glm-4.1v-thinking'), cfg('c2', 'gpt-4o', { isMultimodal: false })];
  expect(await appErrorOf(() => service.analyzeSinglePage('data:,', null))).toMatchObject({
    error_type: 'Configuration', message: '未找到可用的 VLM 模型（需要 GLM-4.6V / Qwen-VL 等多模态模型），请在设置中配置' });
});

// ---------------------------------------------------------------- describe_image

it('describe_image: one retry, trimmed content, LaTeX brief appended', async () => {
  respond = async () => ({ content: '  一张坐标图  \n' });
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  expect(await service.describeImage(jpeg)).toBe('一张坐标图');
  const call = singleShots[0]!;
  expect(call.opts.label).toBe('VLM-Describe(glm-4.6v)');
  expect(call.opts.maxRetries).toBe(1);
  expect(call.context).toBe('VLM 图片描述请求构建失败');
  expect(call.body.messages[0].content[0].image_url.url).toBe(dataUrl(jpeg, 'image/jpeg'));
  expect(call.body.messages[0].content[1].text.endsWith(`5. 只输出描述，不要其他多余内容\n\n${LATEX_OUTPUT_BRIEF}`)).toBe(true);
});

// ---------------------------------------------------------------- extract_docx_questions_stream

function sse(chunks: string[], tail = 'data: [DONE]\n\n'): ReplayResponse {
  const events = chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: [...events, tail] };
}

const plain = (status: number, body: string): ReplayResponse => ({ status, headers: {}, chunks: [body] });

/** Responses are served in arrival order; a request past the end gets a 409 (`unscripted-round`). */
const replies = (...responses: ReplayResponse[]): ReplayScript => ({ description: 'DOCX VLM stream', responses });

const QUESTIONS = '[{"content":"A","question_type":"single_choice","image_indices":[0,5]},{"content":"B","image_indices":[1.5]},{"content":"C"}]';

const DOCX_SCRIPTS: Record<string, ReplayScript> = {
  split: replies(sse([QUESTIONS.slice(0, 30), QUESTIONS.slice(30)])),
  whole: replies(sse([QUESTIONS])),
  retry: replies(plain(503, 'busy'), sse([QUESTIONS])),
  fatal: replies(plain(400, 'bad')),
  exhausted: replies(plain(429, 'a'), plain(502, 'b'), plain(503, 'c')),
  unparsable: replies(sse(['没有任何题目'])),
};

/** Points the VLM model at `scriptId`; returns the requests sent through `llmHttp`. */
function docx(scriptId: keyof typeof DOCX_SCRIPTS): typeof httpCalls {
  configs = [cfg('c1', 'glm-4.6v', { baseUrl: host.ctx.llmReplay.baseUrl(scriptId) })];
  httpCalls.length = 0;
  return httpCalls;
}

it('extract_docx_questions_stream streams questions, remaps image indices and annotates omitted images', async () => {
  const calls = docx('split');
  const got: VlmExtractedQuestion[] = [];
  const count = await service.extractDocxQuestionsStream(['not-a-data-url', dataUrl(png(2, 2))], '题干文本',
    question => { got.push(question); return true; });
  // 第二个对象 image_indices=[1.5] 不是 usize → from_value 失败被跳过。
  expect(count).toBe(2);
  expect(got.map(x => x.content)).toEqual(['A', 'C']);
  expect(got[0]!.image_indices).toEqual([1]); // 准备序 0 → 源 1；越界 5 丢弃
  expect(got[1]).toEqual({ content: 'C', question_type: '', options: [], answer: '', explanation: '', image_indices: [],
    difficulty: '', tags: [] });
  const request = calls[0]!;
  expect(request.url).toBe(`${host.ctx.llmReplay.baseUrl('split')}/chat/completions`);
  // vlm_grounding_service.rs:771-775 builds this client without a total timeout.
  expect(request.init.requestTimeoutMs).toBeNull();
  const body = JSON.parse(String(request.init.body));
  expect(body.stream).toBe(true);
  expect(body.thinking).toEqual({ type: 'disabled' });
  const parts = body.messages[0].content;
  expect(parts[0]).toEqual({ type: 'text', text: '【图片0】' });
  expect(parts[1].image_url.url).toBe(dataUrl(png(2, 2)));
  expect(parts[2].text).toBe('注意：原文共有 2 张嵌入图片，其中 1 张因安全或请求预算未附带；请勿臆测未显示图片的内容。');
  expect(parts[3].text).toContain('上面是从一份 DOCX 文档中提取的 1 张嵌入图片（编号为图片0到图片0）');
  expect(parts[3].text).toContain('---\n题干文本\n---');
});

it('test_prepare_docx_image_resizes_and_enforces_hard_output_limit (via the DOCX request)', async () => {
  const calls = docx('whole');
  await service.extractDocxQuestionsStream([dataUrl(png(2_000, 100))], '', () => true);
  const url: string = JSON.parse(String(calls[0]!.init.body)).messages[0].content[1].image_url.url;
  expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
  const bytes = Buffer.from(url.split(',')[1]!, 'base64');
  expect(bytes.length).toBeLessThanOrEqual(DOCX_VLM_MAX_IMAGE_BYTES);
  const { width, height } = await nativeImage.dimensions(bytes);
  expect(width).toBeLessThanOrEqual(DOCX_VLM_MAX_DIMENSION);
  expect(height).toBeLessThanOrEqual(DOCX_VLM_MAX_DIMENSION);
});

it('extract_docx_questions_stream: callback false stops after that question', async () => {
  docx('whole');
  let seen = 0;
  expect(await service.extractDocxQuestionsStream([dataUrl(png(1, 1))], '', () => { seen += 1; return false; })).toBe(1);
  expect(seen).toBe(1);
});

it('extract_docx_questions_stream: validation errors before any request', async () => {
  expect(await appErrorOf(() => service.extractDocxQuestionsStream([], '', () => true)))
    .toMatchObject({ error_type: 'Validation', message: '图片列表为空' });
  expect(await appErrorOf(() => service.extractDocxQuestionsStream(['data:text/plain;base64,SGVsbG8='], '', () => true)))
    .toMatchObject({ error_type: 'Validation', message: 'DOCX 中没有通过安全检查且可发送给 VLM 的图片' });
});

it('extract_docx_questions_stream retries retryable statuses after 3^n seconds; 4xx is fatal', async () => {
  const sleeps = recordSleeps();
  const calls = docx('retry');
  expect(await service.extractDocxQuestionsStream([dataUrl(png(1, 1))], '', () => true)).toBe(2);
  expect(calls).toHaveLength(2);
  expect(sleeps).toEqual([3_000]);

  docx('fatal');
  expect(await appErrorOf(() => service.extractDocxQuestionsStream([dataUrl(png(1, 1))], '', () => true)))
    .toMatchObject({ error_type: 'LLM', message: 'VLM DOCX 提取 API 返回错误 400 Bad Request: bad' });
});

it('extract_docx_questions_stream: three retryable failures surface the last status text', async () => {
  const sleeps = recordSleeps();
  docx('exhausted');
  expect(await appErrorOf(() => service.extractDocxQuestionsStream([dataUrl(png(1, 1))], '', () => true)))
    .toMatchObject({ error_type: 'LLM', message: 'VLM API 返回 503 Service Unavailable: c' });
  expect(sleeps).toEqual([3_000, 9_000]);
});

it('extract_docx_questions_stream: unparsable non-empty content falls back to full parse and fails', async () => {
  docx('unparsable');
  expect(await appErrorOf(() => service.extractDocxQuestionsStream([dataUrl(png(1, 1))], '', () => true)))
    .toMatchObject({ error_type: 'LLM', message: 'VLM 响应无法解析为题目列表' });
});

// ---------------------------------------------------------------- merge_pages

it('merge_pages: adjacent continuation merges, gaps and None pages do not', () => {
  const fig = { bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number], fig_label: '图1' };
  const pages: Array<VlmPageAnalysis | null> = [
    { questions: [q('1'), q('2', { continues_to_next: true })] },
    { questions: [q('', { raw_text: 'cont', continues_from_previous: true, figures: [fig] }),
      q('', { raw_text: '', continues_from_previous: true, continues_to_next: false })] },
    null,
    { questions: [q('4', { continues_from_previous: true })] },
  ];
  const merged = service.mergePages(pages);
  expect(merged.map(m => m.question.label)).toEqual(['1', '2', '4']);
  const second = merged[1]!;
  expect(second.question.raw_text).toBe('text-2\ncont');
  expect(second.page_indices).toEqual([0, 1]);
  expect(second.figures_with_page).toEqual([[1, fig]]);
  expect(second.question.figures).toEqual([fig]);
  expect(second.question.continues_to_next).toBe(false);
  expect(merged[2]!.page_indices).toEqual([3]);
  // 第一页续接标记但前面没有任何题目 → 独立题目。
  expect(service.mergePages([{ questions: [q('x', { continues_from_previous: true })] }])).toHaveLength(1);
});

// ---------------------------------------------------------------- extract_figures

it('test_crop_figure_default_bbox_yields_minimal_crop + test_crop_figure_inverted_and_out_of_range_bbox: extract_figures crops, filters tiny figures, stores PNG blobs + VFS files', async () => {
  putBlob('p0', png(200, 100));
  const pages: PageSlice[] = [{ page_index: 0, blob_hash: 'p0', text_hint: null, width: 200, height: 100 }];
  const merged: MergedQuestion[] = [{
    question: q('1'), page_indices: [0],
    figures_with_page: [
      [0, { bbox: [0, 0, 0.5, 0.5], fig_label: '图 1-a!' }],
      [0, { bbox: [0, 0, 0, 0], fig_label: 'tiny' }], // test_crop_figure_default_bbox_yields_minimal_crop → 1x1，过小跳过
      [0, { bbox: [0.9, 1.5, 0.1, -0.2], fig_label: 'inv' }], // 颠倒/越界坐标归一化
      [3, { bbox: [0, 0, 1, 1], fig_label: 'oob' }],
    ],
  }];
  const [result] = await service.extractFigures(merged, pages);
  expect(result!.images).toEqual([
    { id: 'file_1', name: 'fig_p0_图1a.png', mime: 'image/png', hash: 'fig1', role: 'question' },
    { id: 'file_2', name: 'fig_p0_inv.png', mime: 'image/png', hash: 'fig2', role: 'question' },
  ]);
  expect(await nativeImage.dimensions(stored[0]!.bytes)).toEqual({ width: 100, height: 50 });
  expect(await nativeImage.dimensions(stored[1]!.bytes)).toEqual({ width: 160, height: 100 });
  expect(stored.map(s => [s.mime, s.ext])).toEqual([['image/png', 'png'], ['image/png', 'png']]);
  expect(files[0]).toEqual(['fig1', 'fig_p0_图1a.png', stored[0]!.bytes.length, 'image', 'image/png', 'fig1', null]);
  // 页面 blob 缺失：只跳过，不报错。
  const missing = await service.extractFigures(merged, [{ ...pages[0]!, blob_hash: 'gone' }]);
  expect(missing[0]!.images).toEqual([]);
});

// ---------------------------------------------------------------- structure_questions

function qwf(label: string): QuestionWithFigures {
  return { merged: { question: q(label), page_indices: [0], figures_with_page: [] }, images: [] };
}
const minimal = (label: string): JsonValue => ({ content: `text-${label}`, question_type: 'other', options: null,
  answer: null, explanation: null, difficulty: 'medium', tags: [], _source_label: label });

it('reusable_batch_result_distinguishes_failure_from_success (resume path)', async () => {
  const questions = [qwf('1')];
  for (const prior of [BATCH_FAILED_SENTINEL, '[]', '', '{not json']) {
    const [completed, , results] = await service.structureQuestions(questions, null, 1, [prior]);
    expect(completed).toBe(1);
    expect(results[0]!.json).toEqual(minimal('1'));
  }
  const [, , ok] = await service.structureQuestions(questions, null, 1, ['[{"_source_label":"1","content":"题目"}]']);
  expect(ok[0]!.json).toEqual({ _source_label: '1', content: '题目' });
  expect(parseCalls).toHaveLength(0);
});

it('structure_questions aligns by label, persists exact JSON, and records failed batches with the sentinel', async () => {
  const sleeps = recordSleeps();
  const questions = Array.from({ length: 9 }, (_, i) => qwf(String(i + 1)));
  parseRespond = async prompt => {
    if (prompt.startsWith('请将以下 8 道题目')) {
      return 'ok ```json\n[' + Array.from({ length: 8 }, (_, i) => `{"_source_label":" ${8 - i} ","score":1.0}`).join(',') + ']\n```';
    }
    throw { error_type: 'LLM', message: 'down', details: null };
  };
  const [completed, batches, results] = await service.structureQuestions(questions, 'cfg-x', 0, []);
  expect(sleeps).toEqual([2_000]);
  expect(completed).toBe(1);
  expect(batches).toHaveLength(2);
  expect(batches[0]).toBe('[' + Array.from({ length: 8 }, (_, i) => `{"_source_label":" ${8 - i} ","score":1.0}`).join(',') + ']');
  expect(batches[1]).toBe(BATCH_FAILED_SENTINEL);
  expect(results.map(r => (r.json as { _source_label: string })._source_label)).toEqual(
    [' 1 ', ' 2 ', ' 3 ', ' 4 ', ' 5 ', ' 6 ', ' 7 ', ' 8 ', '9']);
  expect(results[8]!.json).toEqual(minimal('9'));
  expect(parseCalls.map(c => c.id)).toEqual(['cfg-x', 'cfg-x', 'cfg-x']); // 第二批失败后重试一次
  const prompt = parseCalls[0]!.prompt;
  expect(prompt).toContain('--- 题目 1 (label="1") ---\ntext-1\n\n');
  expect(prompt).toContain('7. 输出数组长度必须等于输入题目数量 (8)');
  expect(prompt).toContain(`4. 公式格式：${LATEX_OUTPUT_BRIEF}`);

  // 恢复：第 1 批失败、第 2 批已成功 → 只重试第 1 批，completed 前缀越过两批。
  parseCalls = [];
  parseRespond = async () => '[{"_source_label":"x"}]';
  const [resumed, resumedBatches, resumedResults] = await service.structureQuestions(questions, null, 0,
    [BATCH_FAILED_SENTINEL, '[{"_source_label":"9","v":2}]']);
  expect(parseCalls).toHaveLength(1);
  expect(resumed).toBe(2);
  expect(resumedBatches).toEqual(['[{"_source_label":"x"}]', '[{"_source_label":"9","v":2}]']);
  expect(resumedResults[8]!.json).toEqual({ _source_label: '9', v: 2 });
  expect(resumedResults[0]!.json).toEqual(minimal('1')); // 1 项且 label 不匹配、数量不等 → minimal
});

it('structure_questions: positional fallback without labels and None vs JSON null', async () => {
  parseRespond = async () => '[null, {"content":"b"}]';
  const [completed, , results] = await service.structureQuestions([qwf('1'), qwf('2')], null, 0, []);
  expect(completed).toBe(1);
  expect(results.map(r => r.json)).toEqual([null, { content: 'b' }]);
  expect(await service.structureQuestions([], null, 3, ['x'])).toEqual([0, [], []]);
});
