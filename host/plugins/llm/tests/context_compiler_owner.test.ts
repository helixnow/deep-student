/** WP-002: actual L01/L02 plugins, stored configuration and a controlled HTTP boundary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-import: integration installs the real L01 provider plugin, not its internals.
import providers from '../../llm-providers/index.ts';
import plugin from '../index.ts';
import { image } from '../../../platform/native/image/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { tmpdir } from 'node:os';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';
import { makePng } from './png_fixture.ts';
import type { ApiConfig, ContextCompilerLlmOwner, LlmUsageRecorder } from '../api.ts';
import { llmContextCompilerService } from '../api.ts';
import { OCR_CIRCUIT_BREAKER } from '../src/ocr_circuit_breaker.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let owner: ContextCompilerLlmOwner;
let baseUrl: string, imagePath: string;
let handle: (body: Record<string, unknown>, response: ServerResponse) => void;
const requests: Record<string, unknown>[] = [];
const usage: Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0][] = [];
const logs: { level: string; message: string }[] = [];
let onWarn: ((message: string) => void) | undefined;
const values = new Map<string, string>();
const bytes = makePng(4, 3);
const payload = { mime: 'image/png', base64: Buffer.from(bytes).toString('base64') };
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  handle(body, response);
});
const settings: SettingsStore = {
  get: key => values.get(key) ?? null, save: (key, value) => { values.set(key, value); },
  delete: key => values.delete(key), listByPrefix: () => [], deleteByPrefix: () => 0,
  getSecret: async key => values.get(key) ?? null, saveSecret: async (key, value) => { values.set(key, value); },
  deleteSecret: async key => values.delete(key),
};
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message: string) => {
  logs.push({ level, message });
  if (level === 'warn') onWarn?.(message);
}]));
const consumer = definePlugin({
  meta: { id: 'test.context-compiler-consumer' },
  inject: [llmContextCompilerService.name],
  apply(ctx) { owner = ctx.llmContextCompiler; },
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `${base}/v1`;
  const endpoints = { clientId: 'test', authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`, deviceUserCodeUrl: `${base}/usercode`, deviceTokenUrl: `${base}/device-token`,
    deviceVerificationUrl: `${base}/device`, deviceRedirectUrl: `${base}/callback`,
    responsesUrl: `${base}/responses`, usageUrl: `${base}/usage` };
  values.set('internal.oauth.openai_codex.session', JSON.stringify({ schemaVersion: 1, accessToken: 'test-token',
    refreshToken: 'test-refresh', idToken: null, expiresAtUnixMs: Date.now() + 3600000, accountId: 'account',
    email: null, planType: null, isFedramp: false, lastRefreshAt: null }));
  host = await createTestHost({ plugins: [[providers, { codexEndpoints: endpoints }], plugin, consumer], provide: {
    settings, secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget,
    files: createNodeFiles({ roots: [{ name: 'temp', path: tmpdir() }] }),
    vfsDatabase: {}, vfsRepo: { essays: {} }, log: { logger: () => logger },
    llmUsage: { cacheDebugEnabled: () => false,
      recordLlmUsageCacheExtWithIdentity: (record: typeof usage[number]) => { usage.push(record); } },
  } });
  imagePath = join(host.ctx.app.dataDir, 'context-image.png');
  await writeFile(imagePath, bytes);
}, 120_000);
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
function config(id: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, model: id, enabled: true, isMultimodal: true,
    apiKey: 'local-key', baseUrl, apiProtocol: 'openai_chat_completions', ...overrides });
}
async function configure(configs = [config('vision')], engines: { id: string; engine: string }[] = []) {
  await host.ctx.llm.saveApiConfigurations(configs);
  values.set('ocr.available_models', JSON.stringify(engines.map(({ id, engine }, priority) =>
    ({ configId: id, model: id, name: id, engineType: engine, priority }))));
}
beforeEach(async () => {
  OCR_CIRCUIT_BREAKER.recordSuccess(); onWarn = undefined;
  requests.length = 0; usage.length = 0; logs.length = 0;
  await configure();
  handle = (_body, response) => response.end(JSON.stringify({ choices: [{ message: { content: '观察结果' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
function raw(signal = new AbortController().signal, id = 'vision', images = [payload]) {
  return owner.callRawPromptWithConfigIdAndImagesCancellable(id, '忠实描述', images, 'chat_v2', signal);
}
function ocr(signal = new AbortController().signal, path = imagePath) {
  return owner.callDedicatedOcrFreeTextWithFallback(path, signal);
}
function stream(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
async function dedicated() {
  await configure([config('vlm'), config('glm-4v'), config('deepseek-ocr')], [
    { id: 'vlm', engine: 'generic_vlm' }, { id: 'glm-4v', engine: 'glm4v_ocr' }, { id: 'deepseek-ocr', engine: 'deepseek_ocr' },
  ]);
}
function halfOpenCircuit() {
  for (let i = 0; i < 3; i++) OCR_CIRCUIT_BREAKER.recordFailure();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_001);
  try { expect(OCR_CIRCUIT_BREAKER.allowRequest()).toBe(true); }
  finally { clock.mockRestore(); }
  OCR_CIRCUIT_BREAKER.cancelProbe();
  expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('HalfOpen');
}

describe('llmContextCompiler@1', () => {
  it('is injectable and preserves raw multimodal payload, chat_v2 usage and audit logs', async () => {
    const result = await raw();
    expect(llmContextCompilerService).toEqual({ name: 'llmContextCompiler', version: '1.0.0' });
    expect(result).toMatchObject({ assistant_message: '观察结果', chain_of_thought_details: null, cancelled: false });
    expect(JSON.parse(result.raw_response!)).toMatchObject({ choices: [{ message: { content: '观察结果' } }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'vision', stream: false, messages: [{ role: 'user', content: [
      { type: 'text', text: '忠实描述' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${payload.base64}` } },
    ] }] });
    expect(requests[0]).not.toHaveProperty('response_format');
    expect(usage).toEqual([expect.objectContaining({ callerType: 'chat_v2', model: 'vision', success: true,
      promptTokens: 10, completionTokens: 5 })]);
    expect(logs).toContainEqual({ level: 'debug', message: expect.stringContaining('[LLM_AUDIT:RAW_PROMPT]') });
  });

  it('pre-cancellation wins over validation; other configuration errors retain their exact values', async () => {
    const pre = new AbortController(); pre.abort();
    await expect(raw(pre.signal, 'missing', [])).rejects.toEqual({ error_type: 'LLM', message: 'visual observation cancelled', details: null });
    await expect(raw(undefined, 'vision', [])).rejects.toMatchObject({ error_type: 'Configuration', message: '多模态 raw prompt 至少需要一张图片' });
    await expect(raw(undefined, 'missing')).rejects.toMatchObject({ error_type: 'Configuration', message: '找不到指定的多模态模型配置: missing' });
    expect(requests).toHaveLength(0);
  });

  it('preserves HTTP failure and frozen model selection without failover', async () => {
    await configure([config('vision'), config('fallback')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), defaultFallbacks: ['fallback'] });
    handle = (_body, response) => { response.writeHead(400); response.end('bad request'); };
    await expect(raw()).rejects.toMatchObject({ error_type: 'LLM', message: 'RAW_PROMPT API请求失败: 400 Bad Request - bad request' });
    expect(requests.map(body => body.model)).toEqual(['vision']);
    expect(usage).toEqual([]);
  });

  it.each([
    ['disabled', { enabled: false }, '指定的多模态模型已禁用: vision'],
    ['text', { isMultimodal: false }, '指定配置不是可用于视觉理解的多模态语言模型: vision'],
    ['embedding', { isEmbedding: true }, '指定配置不是可用于视觉理解的多模态语言模型: vision'],
    ['reranker', { isReranker: true }, '指定配置不是可用于视觉理解的多模态语言模型: vision'],
    ['image generation', { isImageGeneration: true }, '指定配置不是可用于视觉理解的多模态语言模型: vision'],
  ] as const)('rejects %s configurations before network I/O', async (_name, overrides, message) => {
    await configure([config('vision', overrides)]);
    await expect(raw()).rejects.toMatchObject({ error_type: 'Configuration', message });
    expect(requests).toHaveLength(0);
  });

  it('accepts the exact model-name lookup used by the original raw entry', async () => {
    await configure([config('vision', { model: 'vision-model' })]);
    expect((await raw(undefined, 'vision-model')).assistant_message).toBe('观察结果');
    expect(requests[0]).toHaveProperty('model', 'vision-model');
  });

  it('retains parse-failure usage and retry warning before succeeding on the same model', async () => {
    handle = (_body, response) => response.end(requests.length === 1 ? '' : '{"choices":[{"message":{"content":"重试成功"}}]}');
    expect((await raw()).assistant_message).toBe('重试成功');
    expect(requests.map(body => body.model)).toEqual(['vision', 'vision']);
    expect(usage[0]).toMatchObject({ callerType: 'chat_v2', success: false, promptTokens: 0, completionTokens: 0,
      errorMessage: expect.stringContaining('解析RAW_PROMPT响应失败') });
    expect(usage[1]).toMatchObject({ success: true });
    expect(logs).toContainEqual({ level: 'warn', message: expect.stringContaining('[RAW_PROMPT] 瞬态失败') });
  });

  it.each(['headers', 'body', 'codex'] as const)('visual_observation_cancellation_drops_the_provider_future (%s)', async mode => {
    if (mode === 'codex') await configure([config('vision', { model: 'gpt-5', authMode: 'openai_codex_oauth',
      providerType: 'openai_codex', baseUrl: 'https://api.openai.com/v1', apiProtocol: 'openai_responses', supportsOpenaiResponses: true })]);
    let start!: () => void, close!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    handle = (_body, response) => {
      response.once('close', close);
      if (mode === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
      if (mode === 'codex') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"response.created"}\n\n'); }
      start();
    };
    const controller = new AbortController();
    const result = raw(controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ error_type: 'LLM', message: 'visual observation cancelled' });
    await started;
    controller.abort();
    await rejection;
    // Rust drop_rx must complete within 100ms; observe the actual HTTP peer closing here.
    await expect(Promise.race([closed.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100))])).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(usage).toEqual([]);
    expect(logs.filter(log => log.message.includes('[RAW_PROMPT] 瞬态失败'))).toEqual([]);
  });

  it('cancellation stops the retry delay and does not send another attempt', async () => {
    const controller = new AbortController();
    handle = (_body, response) => { response.writeHead(503); response.end('unavailable'); };
    onWarn = message => { if (message.includes('[RAW_PROMPT] 瞬态失败')) controller.abort(); };
    await expect(raw(controller.signal)).rejects.toMatchObject({ message: 'visual observation cancelled' });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(requests).toHaveLength(1);
    expect(usage).toEqual([]);
  });

  it('dedicated OCR excludes both VLM types and sends the original file through the real FreeOCR pipeline', async () => {
    await dedicated();
    handle = (_body, response) => stream(response, '识别文字');
    expect(await ocr()).toBe('识别文字');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'deepseek-ocr', stream: true, messages: [{ content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${payload.base64}` } },
      { type: 'text', text: expect.stringContaining('Free OCR') },
    ] }] });
    expect(logs).toContainEqual({ level: 'info', message: expect.stringContaining('[OCR-Hedge] Spawned engine #0 (deepseek_ocr') });
    expect(logs).toContainEqual({ level: 'info', message: expect.stringContaining('[OCR-Hedge] Engine #0 succeeded') });
  });

  it('dedicated OCR keeps configuration and image failures and does not penalize the circuit', async () => {
    halfOpenCircuit();
    await configure([config('vlm')], [{ id: 'vlm', engine: 'generic_vlm' }]);
    await expect(ocr()).rejects.toMatchObject({ error_type: 'Configuration', message: '没有已启用的 OCR 引擎，请在设置中配置' });
    await dedicated();
    await expect(ocr(undefined, join(host.ctx.app.dataDir, 'missing.png'))).rejects.toMatchObject({
      error_type: 'FileSystem', message: expect.stringContaining('读取试卷图片失败:') });
    expect(requests).toHaveLength(0);
    expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('HalfOpen');
    handle = (_body, response) => stream(response, '恢复');
    expect(await ocr()).toBe('恢复');
    expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('Closed');
  });

  it('dedicated OCR preserves engine failures and warning logs', async () => {
    await dedicated();
    handle = (_body, response) => { response.writeHead(400); response.end('invalid image'); };
    // single_shot_stream.rs:267 formats a u16 status (not reqwest StatusCode Display).
    await expect(ocr()).rejects.toEqual({ error_type: 'LLM', details: null,
      message: 'Engine #0 (deepseek_ocr) failed: OCR-Hedge #0 (deepseek_ocr) 接口返回错误 400: invalid image' });
    expect(requests.map(body => body.model)).toEqual(['deepseek-ocr']);
    expect(logs).toContainEqual({ level: 'warn', message: expect.stringContaining('[OCR-Hedge] Engine #0 failed:') });
  });

  it('dedicated OCR cancellation closes the stream and releases the probe without a failure', async () => {
    await dedicated();
    halfOpenCircuit();
    let start!: () => void, close!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    handle = (_body, response) => {
      response.once('close', close);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); start();
    };
    const controller = new AbortController();
    const result = ocr(controller.signal);
    const rejection = expect(result).rejects.toEqual({ error_type: 'LLM', message: 'OCR cancelled', details: null });
    await started; controller.abort(); await rejection; await closed;
    expect(requests).toHaveLength(1);
    expect(OCR_CIRCUIT_BREAKER.currentState()).toBe('HalfOpen');
    expect(logs.filter(log => log.level === 'warn' && log.message.includes('[OCR-Hedge] Engine #0 failed'))).toEqual([]);
    handle = (_body, response) => stream(response, '下一次成功');
    expect(await ocr()).toBe('下一次成功');
  });
});
