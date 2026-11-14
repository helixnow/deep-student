/** model2_pipeline.rs:7559–7952 call_unified_model_2 (non-streaming, background failover) over real local HTTP. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from '../../../kernel/testing.ts';
import { CommandError } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for public adapter integration.
import providers from '../../llm-providers/index.ts';
import { LATEX_OUTPUT_BRIEF } from '../../llm-providers/api.ts';
import llm from '../index.ts';
import type { ApiConfig, LlmUsageRecorder, Model2HistoryMessage } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let baseUrl: string;
let handle: (body: Record<string, unknown>, response: ServerResponse) => void;
const requests: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
const usage: Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0][] = [];
const logs: { level: string; message: string }[] = [];
const values = new Map<string, string>();
const settings: SettingsStore = {
  get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
  delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
  getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); },
  deleteSecret: async key => values.delete(key),
};
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  const body = JSON.parse(text) as Record<string, unknown>;
  requests.push({ body, headers: request.headers });
  handle(body, response);
});
const answer = { id: 'r1', choices: [{ message: { role: 'assistant', content: '[{"content":"勾股定理","category":"定理"}]' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 } };
const MODELS: Record<string, string> = { text: 'gpt-4o', title: 'gpt-4o-mini', review: 'gpt-4.1', backup: 'gpt-4.1-mini' };
function config(id: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return makeConfig({ id, name: id, model: MODELS[id] ?? id, enabled: true, apiKey: `local-${id}`, baseUrl,
    apiProtocol: 'openai_chat_completions', ...overrides });
}
const SUBJECT_PROMPT = `你是一个教学专家。请仔细分析这道错题，提供详细的解题思路和知识点讲解。\n\n${LATEX_OUTPUT_BRIEF}`;
function systemContent(taskContext: string | null, fields: { ocr?: string; tags?: string; type?: string; question?: string } = {}) {
  const prompt = taskContext === null ? SUBJECT_PROMPT : `${SUBJECT_PROMPT}\n\n任务上下文: ${taskContext}`;
  return `${prompt}\n\n题目信息:\nOCR文本: ${fields.ocr ?? ''}\n标签: ${fields.tags ?? '[]'}\n题目类型: ${fields.type ?? ''}\n用户原问题: ${fields.question ?? ''}`;
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected rejection');
}
function call(context: Record<string, unknown>, history: Model2HistoryMessage[], taskContext: string | null,
  enableChainOfThought = false, imagePaths: string[] | null = null) {
  return host.ctx.llm.callUnifiedModel2(context as never, history, '通用', enableChainOfThought, imagePaths, taskContext, null);
}

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const record = (level: string) => (message: string) => { logs.push({ level, message }); };
  host = await createTestHost({ plugins: [providers, llm], provide: {
    settings, secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget,
    vfsDatabase: {}, vfsRepo: { essays: {} },
    log: { logger: () => ({ debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }) },
    llmUsage: { cacheDebugEnabled: () => false,
      recordLlmUsageCacheExtWithIdentity: (entry: typeof usage[number]) => { usage.push(entry); } },
  } });
});
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  requests.length = 0; usage.length = 0; logs.length = 0;
  await host.ctx.llm.saveApiConfigurations([config('text'), config('title'), config('review'), config('backup')]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'text', chat_title_model_config_id: 'title',
    review_analysis_model_config_id: 'review' });
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });
  handle = (_body, response) => response.end(JSON.stringify(answer));
});

describe('llm.callUnifiedModel2 (model2_pipeline.rs:7559)', () => {
  it('is published on llm@1 and sends the Rust non-stream body built from the subject prompt and context', async () => {
    const before = host.eventsNamed('llm-failover').length;
    const output = await call({ task: 'ignored', ocr_text: '题干', tags: ['几何', 3, true, null, { k: 'v' }, ['x']],
      mistake_type: '计算', user_question: '为什么' }, [{ role: 'user', content: '问' }], '提取知识点');
    expect(output).toEqual({ assistant_message: answer.choices[0]!.message.content, raw_response: JSON.stringify(answer),
      chain_of_thought_details: null, cancelled: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ model: 'gpt-4o', stream: false, temperature: 0.7, max_tokens: 8192,
      messages: [
        { role: 'system', content: systemContent('提取知识点', { ocr: '题干', type: '计算', question: '为什么',
          tags: '[String("几何"), Number(3), Bool(true), Null, Object {"k": String("v")}, Array [String("x")]]' }) },
        { role: 'user', content: '问' },
      ] });
    expect(requests[0]!.headers.accept).toBe('application/json');
    expect(requests[0]!.headers['accept-encoding']).toBe('identity');
    expect(requests[0]!.headers.authorization).toBe('Bearer local-text');
    expect(requests[0]!.headers.origin).toBe('http://127.0.0.1');
    // Rust records no usage on this exit and only logs the call.
    expect(usage).toEqual([]);
    expect(logs.filter(entry => entry.level === 'info' && entry.message.startsWith('调用统一模型二接口:')).map(entry => entry.message))
      .toEqual(['调用统一模型二接口: 科目=通用, 思维链=false, 图片数量=0, model=gpt-4o']);
    expect(logs.some(entry => entry.message.startsWith('[LLM_AUDIT:CHAT_V2_STREAM] model=gpt-4o'))).toBe(true);
    expect(host.eventsNamed('llm-failover').length).toBe(before);
  });

  it('knowledge_executor call shape: empty history, prompt as task context, non-string tags degrade to []', async () => {
    const prompt = '你是知识整理助手。\nuser: 内容';
    await host.ctx.llm.callUnifiedModel2({ task: prompt }, [], '通用', false, null, prompt, null);
    expect(requests[0]!.body.messages).toEqual([{ role: 'system', content: systemContent(prompt) }]);
    requests.length = 0;
    await call({ tags: 'not-an-array', ocr_text: 7 }, [], null);
    expect(requests[0]!.body.messages).toEqual([{ role: 'system', content: systemContent(null) }]);
  });

  it('chain_of_thought_details mirror the Rust non-stream shape', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { isReasoning: true, modelAdapter: 'deepseek' })]);
    const output = await call({}, [{ role: 'user', content: 'q' }], null, true);
    expect(output.chain_of_thought_details).toEqual({ full_response: answer.choices[0]!.message.content, enabled: true,
      is_reasoning_model: true, model_adapter: 'deepseek' });
  });

  it('routes planner → review, tag → tag_generation and anything else → model2', async () => {
    for (const [taskContext, model] of [['weekly_planner', 'gpt-4.1'], ['tag_generation', 'gpt-4o-mini'],
      ['make tags', 'gpt-4o-mini'], ['review', 'gpt-4o'], [null, 'gpt-4o']] as const) {
      requests.length = 0;
      await call({}, [], taskContext);
      expect([taskContext, requests.map(entry => entry.body.model)]).toEqual([taskContext, [model]]);
    }
  });

  it('a routing failure falls back to model2, but a model2 failure rejects even when routing succeeded', async () => {
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'text', chat_title_model_config_id: 'title' });
    await call({}, [], 'planner');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);

    requests.length = 0;
    await host.ctx.llm.saveModelAssignments({ model2_config_id: null, chat_title_model_config_id: 'title' });
    const error = await rejection(call({}, [], 'tag_generation'));
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).value).toEqual({ error_type: 'Configuration', message: '对话模型未配置', details: null });
    expect(requests).toEqual([]);
  });

  it('reasoning models fold the system prompt into a user message only when the history is empty', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { isReasoning: true })]);
    await call({}, [], null);
    expect(requests[0]!.body.messages).toEqual([{ role: 'user', content: systemContent(null) }]);
    requests.length = 0;
    await call({}, [{ role: 'user', content: 'q' }], null);
    expect(requests[0]!.body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('converts history like Rust: tool calls/results, merges, multimodal parts, dropped attachments', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { isMultimodal: true })]);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
    await call({}, [
      { role: 'user', content: 'a', doc_attachments: [{ name: 'd', text_content: 'ignored' }] },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '', tool_call: { id: 'c1', tool_name: 'search', args_json: { q: 1 } } },
      { role: 'assistant', content: 'second', tool_call: { id: 'c2', tool_name: 'fetch', args_json: {} } },
      { role: 'tool', content: 'r1', tool_result: { call_id: 'c1' } },
      { role: 'tool', content: 'orphan' },
      { role: 'user', content: 'see', image_base64: [png] },
      { role: 'user', content: 'mm', multimodal_content: [{ type: 'text', text: 't' }, { type: 'image_url', mediaType: 'image/webp', base64: 'AAAA' }] },
      { role: 'system', content: 'sys' },
    ], null);
    expect((requests[0]!.body.messages as unknown[]).slice(1)).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":1}' } },
        { id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        { type: 'text', text: 't' }, { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }] },
      { role: 'system', content: 'sys' },
    ]);
  });

  it('image history or image paths require a multimodal model before HTTP (routing.rs:599, Option Debug text)', async () => {
    const expected = { error_type: 'Configuration', message: '模型配置 text 不满足已编译请求的 Some(true) 能力要求', details: null };
    expect(await rejection(call({}, [{ role: 'user', content: 'q', image_base64: ['AAAA'] }], null))).toEqual(expected);
    expect(await rejection(call({}, [], null, false, ['a.png']))).toEqual(expected);
    expect(requests).toEqual([]);
  });

  it('HTTP failures are tagged for failover and never retried inside the attempt', async () => {
    handle = (_body, response) => { response.writeHead(503); response.end('busy'); };
    await expect(call({}, [], null)).rejects.toEqual({ error_type: 'LLM', message: '模型二API请求失败: 503 Service Unavailable - busy',
      details: { llm_failover: { phase: 'establish', http_status: 503 } } });
    expect(requests).toHaveLength(1);

    requests.length = 0;
    handle = (_body, response) => response.end(JSON.stringify({ choices: [{ message: { content: null } }] }));
    await expect(call({}, [], null)).rejects.toEqual({ error_type: 'LLM', message: '无法解析模型二API响应', details: null });
    handle = (_body, response) => response.end('not json');
    await expect(call({}, [], null)).rejects.toMatchObject({ error_type: 'LLM', message: expect.stringMatching(/^解析模型二响应失败: /) });
  });

  it('fails over as a background task without emitting llm-failover', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { apiKey: 'failover-text' }), config('backup')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: {}, defaultFallbacks: ['backup'] });
    handle = (body, response) => {
      if (body.model === 'gpt-4o') { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    const before = host.eventsNamed('llm-failover').length;
    expect((await call({}, [], null)).assistant_message).toBe(answer.choices[0]!.message.content);
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o', 'gpt-4.1-mini']);
    expect(host.eventsNamed('llm-failover').length).toBe(before);
    expect(logs.some(entry => entry.level === 'warn' && entry.message.includes('[Failover] model_fallback（task=default）'))).toBe(true);
  });
});
