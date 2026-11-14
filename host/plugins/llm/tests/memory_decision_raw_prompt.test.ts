/** WP-088 / D36: model2_pipeline.rs:8842 call_memory_decision_raw_prompt over real local HTTP. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { getEventListeners, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { CommandError, definePlugin } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for public adapter integration.
import providers from '../../llm-providers/index.ts';
import llm from '../index.ts';
import { llmRawPromptService, type ApiConfig, type LlmRawPrompt, type LlmUsageRecorder } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let raw: LlmRawPrompt;
let baseUrl: string;
let handle: (body: Record<string, unknown>, response: ServerResponse) => void;
let onWarn: ((message: string) => void) | undefined;
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
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ body, headers: request.headers });
  handle(body, response);
});
const consumer = definePlugin({
  meta: { id: 'test.memory-decision-consumer' }, inject: [llmRawPromptService.name],
  apply(ctx) { raw = ctx.llmRawPrompt; },
});
const answer = { choices: [{ message: { content: '{"event":"ADD"}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
// gpt-* models: provider_quirks force_json_response_format makes force_json observable on the wire.
const MODELS: Record<string, string> = { text: 'gpt-4o', memory: 'gpt-4o-mini', backup: 'gpt-4.1' };
function config(id: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, model: MODELS[id]!, enabled: true, apiKey: `local-${id}`, baseUrl,
    apiProtocol: 'openai_chat_completions', ...overrides });
}
async function assign(memory: string | null, model2: string | null = 'text') {
  await host.ctx.llm.saveModelAssignments({ model2_config_id: model2, memory_decision_model_config_id: memory });
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected rejection');
}
function messages(level: string, needle: string) {
  return logs.filter(entry => entry.level === level && entry.message.includes(needle)).map(entry => entry.message);
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const record = (level: string) => (message: string) => { logs.push({ level, message }); };
  host = await createTestHost({ plugins: [providers, llm, consumer], provide: {
    settings, secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget,
    vfsDatabase: {}, vfsRepo: { essays: {} },
    log: { logger: () => ({ debug: record('debug'), info: record('info'), error: record('error'),
      warn(message: string) { logs.push({ level: 'warn', message }); onWarn?.(message); } }) },
    llmUsage: { cacheDebugEnabled: () => false,
      recordLlmUsageCacheExtWithIdentity: (entry: typeof usage[number]) => { usage.push(entry); } },
  } });
}, 120_000);
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  requests.length = 0; usage.length = 0; logs.length = 0; onWarn = undefined;
  await host.ctx.llm.saveApiConfigurations([config('text'), config('memory')]);
  await assign('memory');
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });
  handle = (_body, response) => response.end(JSON.stringify(answer));
});

describe('llmRawPrompt.callMemoryDecisionRawPrompt (model2_pipeline.rs:8842)', () => {
  it('sends the memory_decision model non-streaming with JSON mode, caller memory and the unchanged output', async () => {
    const output = await raw.callMemoryDecisionRawPrompt('决策提示词');
    expect(output).toEqual({ assistant_message: '{"event":"ADD"}', raw_response: JSON.stringify(answer),
      chain_of_thought_details: null, cancelled: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ model: 'gpt-4o-mini', stream: false, temperature: 0.7,
      messages: [{ role: 'user', content: [{ type: 'text', text: '决策提示词' }] }],
      max_tokens: expect.any(Number), max_total_tokens: expect.any(Number),
      response_format: { type: 'json_object' } });
    expect(requests[0]!.headers.authorization).toBe('Bearer local-memory');
    expect(usage).toEqual([expect.objectContaining({ callerType: 'memory', model: 'gpt-4o-mini', success: true,
      promptTokens: 12, completionTokens: 4, tokenSource: 'api', errorMessage: null,
      sessionId: null, variantId: null, runId: null, durationMs: null })]);
    expect(messages('debug', '[RAW_PROMPT] 发送简化请求到')).toEqual([`[RAW_PROMPT] 发送简化请求到: ${baseUrl} (经适配器)`
      + ' | 请求图片数: 0 | 实际附加: 0 | prompt字符数: 5']);
    expect(messages('debug', '[LLM_AUDIT:RAW_PROMPT] model=gpt-4o-mini')).toHaveLength(1);
    expect(messages('debug', '[LLM Usage] 记录使用量')).toEqual(['[LLM Usage] 记录使用量: model=gpt-4o-mini, prompt=12, '
      + 'completion=4, success=true, adapter=openai_chat_completions, token_source=api']);
  });

  it('falls back to model2 when memory_decision is unassigned, disabled or not a text model', async () => {
    for (const setup of [
      async () => assign(null),
      async () => { await host.ctx.llm.saveApiConfigurations([config('text'), config('memory', { enabled: false })]); },
      async () => { await host.ctx.llm.saveApiConfigurations([config('text'), config('memory', { isEmbedding: true })]); },
    ]) {
      requests.length = 0; usage.length = 0;
      await setup();
      expect((await raw.callMemoryDecisionRawPrompt('p')).assistant_message).toBe('{"event":"ADD"}');
      expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);
      expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
      expect(usage).toEqual([expect.objectContaining({ callerType: 'memory', model: 'gpt-4o' })]);
      await host.ctx.llm.saveApiConfigurations([config('text'), config('memory')]);
      await assign('memory');
    }
  });

  it('missing memory/model2 configuration rejects before HTTP with the Rust Configuration error', async () => {
    await assign(null, null);
    const error = await rejection(raw.callMemoryDecisionRawPrompt('p'));
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).value).toEqual({ error_type: 'Configuration',
      message: '没有已启用的有效记忆决策模型（禁止使用嵌入/重排序模型）', details: null });
    expect(requests).toEqual([]); expect(usage).toEqual([]);
  });

  it('HTTP failures keep the RAW_PROMPT AppError and transient retry log without usage', async () => {
    handle = (_body, response) => { response.writeHead(400); response.end('bad request'); };
    await expect(raw.callMemoryDecisionRawPrompt('p')).rejects.toEqual({ error_type: 'LLM',
      message: 'RAW_PROMPT API请求失败: 400 Bad Request - bad request',
      details: { llm_failover: { phase: 'establish', http_status: 400 } } });
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);

    requests.length = 0;
    handle = (_body, response) => {
      if (requests.length === 1) { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    expect((await raw.callMemoryDecisionRawPrompt('p')).assistant_message).toBe('{"event":"ADD"}');
    expect(requests).toHaveLength(2);
    expect(messages('warn', '[RAW_PROMPT] 瞬态失败')).toEqual([
      '[RAW_PROMPT] 瞬态失败（RAW_PROMPT API请求失败: 503 Service Unavailable - unavailable），300ms 后重试 2/5']);
    expect(usage).toEqual([expect.objectContaining({ model: 'gpt-4o-mini', success: true })]);
  });

  it('fails over with task memory_decision', async () => {
    // Distinct key: the transient failure cools this key down for the rest of the shared host.
    await host.ctx.llm.saveApiConfigurations([config('text'), config('memory', { apiKey: 'failover-memory' }),
      config('backup')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: { memory_decision: ['backup'] }, defaultFallbacks: [] });
    handle = (body, response) => {
      if (body.model === 'gpt-4o-mini') { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    const before = host.eventsNamed('llm-failover').length;
    expect((await raw.callMemoryDecisionRawPrompt('p')).assistant_message).toBe('{"event":"ADD"}');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini', 'gpt-4.1']);
    expect(host.eventsNamed('llm-failover').slice(before)).toEqual([expect.objectContaining({ task: 'memory_decision',
      kind: 'model_fallback', from_config_id: 'memory', to_config_id: 'backup' })]);
    expect(usage).toEqual([expect.objectContaining({ callerType: 'memory', model: 'gpt-4.1', success: true })]);
  });

  it('pre-aborted signal rejects with its reason before model selection, HTTP or usage', async () => {
    await assign(null, null);
    const controller = new AbortController(); controller.abort();
    const error = await rejection(raw.callMemoryDecisionRawPrompt('p', controller.signal));
    expect(error).toBe(controller.signal.reason);
    expect((error as DOMException).name).toBe('AbortError');
    expect(requests).toEqual([]); expect(usage).toEqual([]);
  });

  it('a caller timeout aborts the in-flight HTTP request with the TimeoutError reason and no late usage', async () => {
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    let pending!: ServerResponse;
    handle = (_body, response) => { pending = response; response.once('close', close); };
    const signal = AbortSignal.timeout(200);
    const error = await rejection(raw.callMemoryDecisionRawPrompt('p', signal));
    expect(error).toBe(signal.reason);
    expect((error as DOMException).name).toBe('TimeoutError');
    const timer = new AbortController();
    try {
      await Promise.race([closed, delay(100, undefined, { signal: timer.signal }).then(() => {
        throw new Error('HTTP peer did not close within 100ms');
      })]);
    } finally { timer.abort(); }
    expect(pending.destroyed).toBe(true);
    await delay(350); // exceeds the first retry delay: no abandoned attempt may resend or record usage.
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(getEventListeners(signal, 'abort')).toEqual([]);
  });

  it('aborting during the transient retry backoff sends no further request', async () => {
    const controller = new AbortController();
    handle = (_body, response) => { response.writeHead(503); response.end('unavailable'); };
    onWarn = message => { if (message.includes('[RAW_PROMPT] 瞬态失败')) controller.abort(); };
    const error = await rejection(raw.callMemoryDecisionRawPrompt('p', controller.signal));
    expect(error).toBe(controller.signal.reason);
    await delay(350);
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('a live signal does not change success and leaves no abort listeners', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 5; i++) {
      expect((await raw.callMemoryDecisionRawPrompt('p', controller.signal)).assistant_message).toBe('{"event":"ADD"}');
    }
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expect(usage).toHaveLength(5);
  });

  it('default model2 raw prompt keeps model2, its caller and utility task when memory_decision is assigned', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { apiKey: 'failover-text' }), config('memory')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: { utility: ['memory'] }, defaultFallbacks: [] });
    handle = (body, response) => {
      if (body.model === 'gpt-4o') { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    const before = host.eventsNamed('llm-failover').length;
    await raw.callModel2RawPrompt('p', null, 'analysis');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(host.eventsNamed('llm-failover').slice(before)).toEqual([expect.objectContaining({ task: 'utility' })]);
    expect(usage).toEqual([expect.objectContaining({ callerType: 'analysis', model: 'gpt-4o-mini' })]);
  });
});
