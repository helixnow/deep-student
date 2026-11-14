/** WP-108 / D1-L18-M01: handout.rs:45–62,84–92 drops the entire text request future. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { getEventListeners, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for public adapter and Codex transport integration.
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
const requests: Record<string, unknown>[] = [];
const usage: Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0][] = [];
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
  requests.push(body);
  handle(body, response);
});
const consumer = definePlugin({
  meta: { id: 'test.handout-raw-consumer' }, inject: [llmRawPromptService.name],
  apply(ctx) { raw = ctx.llmRawPrompt; },
});
const cancelled = { error_type: 'Validation', message: 'cancelled', details: null };
const answer = { choices: [{ message: { content: '讲义正文' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
function config(id: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, model: 'gpt-4o', enabled: true, apiKey: `local-${id}`, baseUrl,
    apiProtocol: 'openai_chat_completions', ...overrides });
}
function call(signal?: AbortSignal, forceJson = false) {
  return raw.callModel2RawPromptOpts('讲义提示词', forceJson, { other: 'media_handout' }, 'media_handout', signal);
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `${base}/v1`;
  values.set('internal.oauth.openai_codex.session', JSON.stringify({ schemaVersion: 1, accessToken: 'token',
    refreshToken: 'refresh', idToken: null, expiresAtUnixMs: Date.now() + 3600000, accountId: 'account',
    email: null, planType: null, isFedramp: false, lastRefreshAt: null }));
  const endpoints = { clientId: 'test', authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`, deviceUserCodeUrl: `${base}/usercode`, deviceTokenUrl: `${base}/device-token`,
    deviceVerificationUrl: `${base}/device`, deviceRedirectUrl: `${base}/callback`,
    responsesUrl: `${base}/responses`, usageUrl: `${base}/usage` };
  host = await createTestHost({ plugins: [[providers, { codexEndpoints: endpoints }], llm, consumer], provide: {
    settings, secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget,
    vfsDatabase: {}, vfsRepo: { essays: {} },
    log: { logger: () => ({ debug() {}, info() {}, error() {}, warn(message: string) { onWarn?.(message); } }) },
    llmUsage: { cacheDebugEnabled: () => false,
      recordLlmUsageCacheExtWithIdentity: (record: typeof usage[number]) => { usage.push(record); } },
  } });
}, 120_000);
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  requests.length = 0; usage.length = 0; onWarn = undefined;
  await host.ctx.llm.saveApiConfigurations([config('text')]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'text' });
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });
  handle = (_body, response) => response.end(JSON.stringify(answer));
});

describe('llmRawPrompt text AbortSignal (WP-108)', () => {
  it('pre-cancellation wins before model selection and sends no HTTP or usage', async () => {
    await host.ctx.llm.saveApiConfigurations([]);
    const controller = new AbortController(); controller.abort();
    await expect(call(controller.signal)).rejects.toEqual(cancelled);
    expect(requests).toEqual([]); expect(usage).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('keeps model2 selection, forceJson, caller, success output and the four-argument entry', async () => {
    await host.ctx.llm.saveApiConfigurations([config('unused', { model: 'unused' }), config('text')]);
    const signal = new AbortController().signal;
    const output = await call(signal, true);
    expect(output).toEqual({ assistant_message: '讲义正文', raw_response: JSON.stringify(answer),
      chain_of_thought_details: null, cancelled: false });
    expect(await raw.callModel2RawPromptOpts('plain', false, { other: 'media_handout' }, 'media_handout'))
      .toEqual(output);
    expect(requests[0]).toMatchObject({ model: 'gpt-4o', stream: false, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'text', text: '讲义提示词' }] }] });
    expect(requests[1]).not.toHaveProperty('response_format');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ callerType: { other: 'media_handout' }, model: 'gpt-4o', success: true,
      promptTokens: 10, completionTokens: 5, tokenSource: 'api', errorMessage: null });
    expect(getEventListeners(signal, 'abort')).toEqual([]);
  });

  it.each(['headers', 'body', 'error-body', 'codex'] as const)('aborts real HTTP during %s without late results or usage', async mode => {
    if (mode === 'codex') await host.ctx.llm.saveApiConfigurations([config('text', { model: 'gpt-5',
      authMode: 'openai_codex_oauth', providerType: 'openai_codex', baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai_responses', supportsOpenaiResponses: true })]);
    let start!: (response: ServerResponse) => void, close!: () => void;
    const started = new Promise<ServerResponse>(resolve => { start = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    handle = (_body, response) => {
      response.once('close', close);
      if (mode === 'body' || mode === 'error-body') {
        response.writeHead(mode === 'body' ? 200 : 400, { 'content-type': 'application/json' }); response.write('{');
      }
      if (mode === 'codex') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"response.created"}\n\n');
      }
      start(response);
    };
    const controller = new AbortController();
    const result = call(controller.signal);
    const rejection = expect(result).rejects.toEqual(cancelled);
    const response = await started;
    controller.abort(); await rejection;
    // A bounded observation of peer close, not cancellation by racing a still-running request.
    const timeout = new AbortController();
    try {
      await Promise.race([closed, delay(100, undefined, { signal: timeout.signal }).then(() => {
        throw new Error('HTTP peer did not close within 100ms');
      })]);
    } finally { timeout.abort(); }
    expect(response.destroyed).toBe(true);
    response.end(JSON.stringify(answer));
    await delay(350); // exceeds first retry delay: no abandoned attempt may send again or record late usage.
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(host.eventsNamed('llm-failover')).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it.each([503, 429])('cancels the %s retry backoff rather than continuing to another HTTP request', async status => {
    const controller = new AbortController();
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      rateLimitBackoffMs: 1500 });
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    handle = (_body, response) => { response.writeHead(status); response.end('unavailable'); complete(); };
    if (status === 503) onWarn = message => { if (message.includes('[RAW_PROMPT] 瞬态失败')) controller.abort(); };
    const pending = call(controller.signal);
    const rejection = expect(pending).rejects.toEqual(cancelled);
    await completed;
    if (status === 429) { await delay(50); controller.abort(); }
    const start = performance.now(); await rejection;
    expect(performance.now() - start).toBeLessThan(100);
    await delay(status === 503 ? 350 : 1550);
    expect(requests).toHaveLength(1); expect(usage).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('retains task-specific fallback selection and notifications with a live signal', async () => {
    await host.ctx.llm.saveApiConfigurations([config('text', { apiKey: 'fallback-primary' }), config('fallback', { model: 'gpt-4o-mini' })]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: { media_handout: ['fallback'] }, defaultFallbacks: [] });
    handle = (body, response) => {
      if (body.model === 'gpt-4o') { response.writeHead(503); response.end('unavailable'); }
      else response.end(JSON.stringify(answer));
    };
    expect((await call(new AbortController().signal)).assistant_message).toBe('讲义正文');
    expect(requests.map(body => body.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(host.eventsNamed('llm-failover')).toEqual([expect.objectContaining({ task: 'media_handout',
      kind: 'model_fallback', from_config_id: 'text', to_config_id: 'fallback' })]);
    expect(usage).toEqual([expect.objectContaining({ model: 'gpt-4o-mini', success: true })]);
  });

  it('repeated success and business errors keep AppError semantics and do not accumulate signal listeners', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 12; i++) {
      handle = (_body, response) => response.end(JSON.stringify(answer));
      expect((await call(controller.signal)).assistant_message).toBe('讲义正文');
      handle = (_body, response) => { response.writeHead(400); response.end('bad request'); };
      await expect(call(controller.signal)).rejects.toEqual({ error_type: 'LLM',
        message: 'RAW_PROMPT API请求失败: 400 Bad Request - bad request',
        details: { llm_failover: { phase: 'establish', http_status: 400 } } });
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    }
    expect(requests).toHaveLength(24); expect(usage).toHaveLength(12);
    controller.abort(); await delay(0);
    expect(usage.every(record => record.success)).toBe(true);
  });
});
