/** WP-209: model2_pipeline.rs:8682–8739; HPIAS caller owns timeout/drop/fallback. */
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
import { PROVIDER_TYPE, SESSION_HEADER } from '../src/opencode_go.ts';

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
  meta: { id: 'test.config-id-raw-consumer' }, inject: [llmRawPromptService.name],
  apply(ctx) { raw = ctx.llmRawPrompt; },
});
const answer = { choices: [{ message: { content: '  ## 综合结论\n证据正文  ' } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 } };
function config(id: string, model: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, model, enabled: true, apiKey: `local-${id}`, baseUrl,
    apiProtocol: 'openai_chat_completions', ...overrides });
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
  await host.ctx.llm.saveApiConfigurations([config('text', 'gpt-4o'), config('selected', 'gpt-4o-mini')]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'text' });
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });
  handle = (_body, response) => response.end(JSON.stringify(answer));
});

describe('llmRawPrompt.callWithConfigIdRawPrompt', () => {
  it('prefers config id over an earlier matching model, preserving payload/output/usage/audit without an agent session', async () => {
    await host.ctx.llm.saveApiConfigurations([config('collision', 'selected'), config('selected', 'gpt-4o-mini'),
      config('text', 'gpt-4o')]);
    const controller = new AbortController();
    const output = await raw.callWithConfigIdRawPrompt('selected', '研究提示词', controller.signal);
    expect(output).toEqual({ assistant_message: '  ## 综合结论\n证据正文  ', raw_response: JSON.stringify(answer),
      chain_of_thought_details: null, cancelled: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ model: 'gpt-4o-mini', stream: false, temperature: 0.7,
      messages: [{ role: 'user', content: [{ type: 'text', text: '研究提示词' }] }],
      max_tokens: expect.any(Number), max_total_tokens: expect.any(Number) });
    expect(requests[0]!.headers.authorization).toBe('Bearer local-selected');
    expect(requests[0]!.headers[SESSION_HEADER]).toBeUndefined();
    expect(usage).toEqual([expect.objectContaining({ callerType: 'chat_v2', model: 'gpt-4o-mini', success: true,
      promptTokens: 12, completionTokens: 4, tokenSource: 'api', errorMessage: null,
      sessionId: null, variantId: null, runId: null, durationMs: null })]);
    expect(messages('warn', '[compaction]')).toEqual([]);
    expect(messages('debug', '[LLM_AUDIT:RAW_PROMPT] model=gpt-4o-mini')).toHaveLength(1);
    expect(messages('debug', '[LLM Usage] 记录使用量')).toEqual(['[LLM Usage] 记录使用量: model=gpt-4o-mini, prompt=12, '
      + 'completion=4, success=true, adapter=openai_chat_completions, token_source=api']);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('matches model name, then falls back to Model2 with the original WARN', async () => {
    await raw.callWithConfigIdRawPrompt('gpt-4o-mini', 'p');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini']);
    expect(messages('warn', '[compaction]')).toEqual([]);
    await raw.callWithConfigIdRawPrompt('_hpias_synthesis_', 'p');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(requests.every(entry => !('response_format' in entry.body))).toBe(true);
    expect(messages('warn', '[compaction]')).toEqual([
      "[compaction] config_id/model '_hpias_synthesis_' 未找到，回退到 Model2 默认配置"]);
  });

  it('propagates missing default configuration instead of returning successful empty output', async () => {
    await host.ctx.llm.saveModelAssignments({ model2_config_id: null });
    const expected = await rejection(host.ctx.llm.getModel2Config());
    const error = await rejection(raw.callWithConfigIdRawPrompt('missing', 'p'));
    expect(expected).toBeInstanceOf(CommandError);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).value).toEqual((expected as CommandError).value);
    // mod.rs:6945, not a synthesized success or a renamed configuration diagnostic.
    expect((error as CommandError).value).toEqual({ error_type: 'Configuration', message: '对话模型未配置', details: null });
    expect(messages('warn', '[compaction]')).toEqual([
      "[compaction] config_id/model 'missing' 未找到，回退到 Model2 默认配置"]);
    expect(requests).toEqual([]); expect(usage).toEqual([]);
  });

  it('keeps HTTP errors and transient retries; empty provider content remains empty for the consumer to handle', async () => {
    handle = (_body, response) => { response.writeHead(400); response.end('bad request'); };
    await expect(raw.callWithConfigIdRawPrompt('selected', 'p')).rejects.toEqual({ error_type: 'LLM',
      message: 'RAW_PROMPT API请求失败: 400 Bad Request - bad request',
      details: { llm_failover: { phase: 'establish', http_status: 400 } } });
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    requests.length = 0;
    const empty = { choices: [{ message: { content: '' } }] };
    handle = (_body, response) => {
      if (requests.length === 1) { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(empty));
    };
    expect(await raw.callWithConfigIdRawPrompt('selected', 'p')).toEqual({ assistant_message: '',
      raw_response: JSON.stringify(empty), chain_of_thought_details: null, cancelled: false });
    expect(requests).toHaveLength(2);
    expect(messages('warn', '[RAW_PROMPT] 瞬态失败')).toEqual([
      '[RAW_PROMPT] 瞬态失败（RAW_PROMPT API请求失败: 503 Service Unavailable - unavailable），300ms 后重试 2/5']);
    expect(usage).toEqual([expect.objectContaining({ callerType: 'chat_v2', success: true, tokenSource: 'heuristic' })]);
  });

  it('uses the compaction task fallback chain and leaves session identity absent', async () => {
    await host.ctx.llm.saveApiConfigurations([config('selected', 'gpt-4o-mini', { apiKey: 'fallback-selected' }),
      config('text', 'gpt-4o'), config('backup', 'gpt-4.1')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: { compaction: ['backup'] }, defaultFallbacks: ['text'] });
    handle = (body, response) => {
      if (body.model === 'gpt-4o-mini') { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    const before = host.eventsNamed('llm-failover').length;
    await raw.callWithConfigIdRawPrompt('selected', 'p');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini', 'gpt-4.1']);
    expect(host.eventsNamed('llm-failover').slice(before)).toEqual([expect.objectContaining({ task: 'compaction',
      kind: 'model_fallback', from_config_id: 'selected', to_config_id: 'backup' })]);
    expect(usage).toEqual([expect.objectContaining({ callerType: 'chat_v2', model: 'gpt-4.1', sessionId: null })]);
    expect(requests.every(entry => entry.headers[SESSION_HEADER] === undefined)).toBe(true);
  });

  it('keeps the Rust non-agent Go task identity distinct from the real agent compaction session', async () => {
    // :4883–4894 permits manually configured Go outside agents; None does not grant an agent session.
    await host.ctx.llm.saveApiConfigurations([config('go', 'glm-5', { providerType: PROVIDER_TYPE })]);
    await raw.callWithConfigIdRawPrompt('go', 'p');
    await raw.callAgentCompactionRawPrompt('go', 'p', 'agent-session-42');
    expect(requests).toHaveLength(2);
    expect(requests.map(entry => entry.headers[SESSION_HEADER])).toEqual(['chat_v2', 'agent-session-42']);
    expect(requests.map(entry => entry.headers.authorization)).toEqual(['Bearer local-go', 'Bearer local-go']);
    expect(requests.every(entry => !('response_format' in entry.body))).toBe(true);
    expect(usage.every(entry => entry.sessionId === null && entry.callerType === 'chat_v2')).toBe(true);
  });

  it('pre-cancellation preserves the caller reason before any configuration warning or HTTP', async () => {
    const controller = new AbortController(); const reason = new Error('caller dropped synthesis'); controller.abort(reason);
    await expect(raw.callWithConfigIdRawPrompt('missing', 'p', controller.signal)).rejects.toBe(reason);
    expect(messages('warn', '[compaction]')).toEqual([]);
    expect(requests).toEqual([]); expect(usage).toEqual([]);
  });

  it.each(['headers', 'body', 'error-body'] as const)('cancellation closes actual HTTP during %s within 100ms', async phase => {
    let arrived!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; });
    let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve; });
    let pending!: ServerResponse;
    handle = (_body, response) => {
      pending = response; response.once('close', close);
      if (phase !== 'headers') { response.writeHead(phase === 'body' ? 200 : 503); response.write('{'); }
      arrived();
    };
    const controller = new AbortController(); const reason = new Error('drop future');
    const result = rejection(raw.callWithConfigIdRawPrompt('selected', 'p', controller.signal));
    await started; controller.abort(reason);
    expect(await result).toBe(reason);
    const timer = new AbortController();
    try {
      await Promise.race([closed, delay(100, undefined, { signal: timer.signal }).then(() => {
        throw new Error('HTTP peer did not close within 100ms');
      })]);
    } finally { timer.abort(); }
    expect(pending.destroyed).toBe(true);
    await delay(350);
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it.each([503, 429])('cancellation stops the %s retry delay with the original reason', async status => {
    const controller = new AbortController(); const reason = new Error('stop retry');
    if (status === 429) await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()),
      enabled: true, rateLimitBackoffMs: 1500, taskFallbacks: {}, defaultFallbacks: [] });
    let complete!: () => void; const completed = new Promise<void>(resolve => { complete = resolve; });
    handle = (_body, response) => { response.writeHead(status); response.end('unavailable'); complete(); };
    onWarn = message => {
      if (status === 503 && message.includes('[RAW_PROMPT] 瞬态失败')) controller.abort(reason);
    };
    const result = rejection(raw.callWithConfigIdRawPrompt('selected', 'p', controller.signal));
    await completed;
    if (status === 429) { await delay(50); controller.abort(reason); }
    const start = performance.now();
    expect(await result).toBe(reason);
    expect(performance.now() - start).toBeLessThan(100);
    await delay(status === 503 ? 350 : 1600);
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});
