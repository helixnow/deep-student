/** WP-022: rag_extension.rs:31–137, 1009–1309 through an installed Host provider. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { definePlugin } from '../../../kernel/api.ts';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { embeddingService, embeddingErrorKind, embeddingErrorRetryAfterSecs, type TextEmbeddingService, type ApiConfig } from '../api.ts';
import type { LlmUsageService } from '../../../platform/storage/api.ts';
import { makeConfig } from './support.ts';
import { keyCooldowns, keyFingerprint } from '../src/routing.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let embedding: TextEmbeddingService;
let baseUrl: string;
let handle: (response: ServerResponse) => void;
const values = new Map<string, string>();
const requests: { url: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
const usage: Parameters<LlmUsageService['recordLlmUsageExt']>[0][] = [];
const logs: { level: string; message: string }[] = [];
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message: string) => logs.push({ level, message })]));
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ url: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
  handle(response);
});
const consumer = definePlugin({ meta: { id: 'test.embedding-consumer' }, inject: [embeddingService.name],
  apply(ctx) { embedding = ctx['embedding@1']; } });
function config(overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id: 'text', name: 'text', model: 'text-embedding-3-small', enabled: true,
    isEmbedding: true, isMultimodal: false, isReranker: false, apiKey: 'key', baseUrl,
    modelAdapter: 'openai', ...overrides });
}
async function configure(overrides: Partial<ApiConfig> = {}) { await host.ctx.llm.saveApiConfigurations([config(overrides)]); }
function reply(raw = '{"data":[{"embedding":[0.1,-0.2]}],"usage":{"prompt_tokens":7}}', status = 200, retry?: string) {
  handle = response => { response.writeHead(status, { 'content-type': 'application/json', ...(retry === undefined ? {} : { 'retry-after': retry }) }); response.end(raw); };
}
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ plugins: [plugin, consumer], provide: {
    settings: { get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
      getSecret: async (key: string) => values.get(key) ?? null,
      saveSecret: async (key: string, value: string) => { values.set(key, value); } },
    secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    log: { logger: () => logger },
    llmUsage: { recordLlmUsageExt: (record: typeof usage[number]) => usage.push(record) },
  } });
}, 120_000);
beforeEach(async () => {
  keyCooldowns()._entries.clear(); requests.length = 0; usage.length = 0; logs.length = 0;
  values.delete('embedding.default_text_model_config_id'); values.delete('model_assignments');
  values.delete('llm_failover_policy');
  await configure(); reply();
});
afterAll(async () => { vi.restoreAllMocks(); await host?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

it('publishes embedding@1; preserves headers, exact request, response order (ignores index), f32 and usage', async () => {
  await configure({ baseUrl: `${baseUrl}///`, headers: { 'x-unused': 'not-forwarded' } });
  reply('{"data":[{"index":1,"embedding":[0.1,-0.2]},{"index":0,"embedding":[3]}],"usage":{"prompt_tokens":7}}');
  expect(await embedding.callEmbeddingApi(['甲', '乙'], 'text')).toEqual([[0.10000000149011612, -0.20000000298023224], [3]]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: '/v1/embeddings', body: { model: 'text-embedding-3-small', input: ['甲', '乙'], encoding_format: 'float' },
    headers: { authorization: 'Bearer key', 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', origin: 'http://127.0.0.1', referer: 'http://127.0.0.1/' } });
  expect(requests[0]!.headers['x-unused']).toBeUndefined();
  expect(requests[0]!.headers['user-agent']).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  expect(usage).toEqual([{ callerType: 'embedding', model: 'text-embedding-3-small', promptTokens: 7, completionTokens: 0,
    reasoningTokens: null, cachedTokens: null, sessionId: null, durationMs: null, success: true, errorMessage: null,
    adapter: 'openai_embeddings', tokenSource: 'api' }]);
  expect(logs).toContainEqual({ level: 'info', message: '嵌入API调用成功，返回 2 个向量' });
});

it('empty batch precedes config reads; exact id and capability errors precede HTTP', async () => {
  expect(await embedding.callEmbeddingApi([], 'missing')).toEqual([]);
  await expect(embedding.callEmbeddingApi(['a'], 'missing')).rejects.toEqual({ error_type: 'Configuration', message: '找不到嵌入模型配置', details: null });
  for (const overrides of [{ enabled: false }, { isEmbedding: false }, { isMultimodal: true }, { isReranker: true }]) {
    await configure(overrides);
    await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toEqual({ error_type: 'Configuration', message: '指定模型不支持文本嵌入协议或已禁用', details: null });
  }
  expect(requests).toHaveLength(0); expect(usage).toHaveLength(0);
});

it.each(['anthropic', 'claude'])('rejects %s after decryption/cooldown and before sending', async modelAdapter => {
  await configure({ modelAdapter });
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toEqual({ error_type: 'Configuration', message: 'Claude模型不支持嵌入API', details: null });
  expect(requests).toHaveLength(0);
});
it.each(['general', 'custom'])('uses the default OpenAI request for %s', async modelAdapter => {
  await configure({ modelAdapter, apiKey: '', authMode: 'none' });
  expect(await embedding.callEmbeddingApi(['a'], 'text')).toHaveLength(1);
  expect(requests[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a'], encoding_format: 'float' });
  expect(requests[0]!.headers.authorization).toBe('Bearer');
});

it.each([
  [401, 'auth', 'API 密钥无效或已过期，请检查设置'], [403, 'auth', 'API 访问被拒绝，请检查账户权限'],
  [429, 'rate_limited', '请求过于频繁，请稍后重试'], [400, 'invalid_request', '嵌入请求失败，请重试'],
  [404, 'invalid_request', '嵌入请求失败，请重试'], [422, 'invalid_request', '嵌入请求失败，请重试'],
  [408, 'server', '嵌入请求失败，请重试'], [500, 'server', '嵌入服务暂时不可用，请稍后重试'],
  [599, 'server', '嵌入服务暂时不可用，请稍后重试'], [418, 'unknown', '嵌入请求失败，请重试'],
] as const)('classifies HTTP %s, preserves Retry-After and logs full body without exposing it', async (status, kind, message) => {
  reply('upstream private diagnostic', status, ' 12 ');
  const error = await embedding.callEmbeddingApi(['a'], 'text').catch(error => error);
  expect(error).toEqual({ error_type: 'LLM', message, details: { llm_failover: { phase: 'establish', http_status: status },
    embedding_error: { kind, http_status: status, retry_after_secs: 12 } } });
  expect(embeddingErrorKind(error)).toBe(kind); expect(embeddingErrorRetryAfterSecs(error)).toBe(12);
  expect(logs).toContainEqual({ level: 'error', message: `[Embedding] API error ${status}: upstream private diagnostic` });
  expect(requests).toHaveLength(1); expect(usage).toHaveLength(0);
  if ([401, 403, 429].includes(status)) {
    await expect(embedding.callEmbeddingApi(['b'], 'text')).rejects.toMatchObject({ message: '嵌入 API 密钥处于限速/鉴权冷却期，请稍后重试',
      details: { embedding_error: { kind: 'rate_limited', http_status: 429, retry_after_secs: null } } });
    expect(requests).toHaveLength(1);
    expect(logs).toContainEqual({ level: 'warn', message: `[Embedding] HTTP ${status} for model text-embedding-3-small; key cooled down for 12s (retry_after=Some(12))` });
  } else expect(keyCooldowns()._entries.size).toBe(0);
});

it.each([
  ['0', 0, 1], ['+2', 2, 2], ['\t2\t', 2, 2], ['18446744073709551615', 18446744073709551615n, 3600],
  ['18446744073709551616', null, 60], ['Wed, 21 Oct 2015 07:28:00 GMT', null, 60], ['1.5', null, 60], ['-1', null, 60],
] as const)('parses Retry-After %s as u64 and clamps only the cooldown', async (header, expected, duration) => {
  reply('limited', 429, header);
  const before = performance.now();
  const error = await embedding.callEmbeddingApi(['a'], 'text').catch(error => error);
  const after = performance.now();
  expect(embeddingErrorRetryAfterSecs(error)).toBe(expected);
  if (typeof expected === 'bigint') expect(error.details.embedding_error.retry_after_secs).toBe(18446744073709551615n);
  const expiry = [...keyCooldowns()._entries.values()][0]!;
  expect(expiry).toBeGreaterThanOrEqual(before + duration * 1000);
  expect(expiry).toBeLessThanOrEqual(after + duration * 1000);
});

it.each([
  ['null', '嵌入API响应格式无效：缺少data字段'], ['{"data":{}}', '嵌入API响应格式无效：缺少data字段'],
  ['{"data":[null]}', '嵌入API响应格式无效：缺少embedding字段'],
  ['{"data":[{"embedding":null}]}', '嵌入API响应格式无效：缺少embedding字段'],
  ['{"data":[{"embedding":["1"]}]}', '嵌入向量包含无效数值'],
  ['{"data":[{"embedding":[1e400]}]}', '嵌入向量包含无效数值'],
  ['{"data":[]}', '嵌入向量数量与输入文本数量不匹配'],
] as const)('rejects bad response %s without usage or transport retry tagging', async (body, message) => {
  reply(body);
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toEqual({ error_type: 'LLM', message, details: null });
  expect(requests).toHaveLength(1); expect(usage).toHaveLength(0);
});

it.each([
  ['{"total_tokens":9}', 9, 'api'], ['{"prompt_tokens":0,"total_tokens":9}', 0, 'api'],
  ['{"prompt_tokens":null,"total_tokens":9}', 0, 'heuristic'], ['{"prompt_tokens":1.0}', 0, 'heuristic'],
  ['{"prompt_tokens":18446744073709551615}', 4294967295, 'api'], ['{}', 0, 'heuristic'],
] as const)('preserves Option/or_else and u64-as-u32 usage for %s', async (tokens, promptTokens, tokenSource) => {
  reply(`{"data":[{"embedding":[]}],"usage":${tokens}}`);
  expect(await embedding.callEmbeddingApi(['a'], 'text')).toEqual([[]]);
  expect(usage).toHaveLength(1); expect(usage[0]).toMatchObject({ promptTokens, tokenSource });
});

it('keeps serde last-wins, f64-to-f32 overflow and signed zero', async () => {
  reply('{"data":null,"data":[{"embedding":[3.5e38,-0.0,1e-50]}]}');
  const result = await embedding.callEmbeddingApi(['a'], 'text');
  expect(result).toEqual([[Infinity, -0, 0]]);
});

it('uses shared L01 chunking and mean-pooling, including zero-chunk dimension fallback', async () => {
  await configure({ model: 'embed-local' });
  handle = response => response.end(JSON.stringify({ data: [
    { embedding: [1, 0] }, { embedding: [0, 1] }, { embedding: [3, 4] },
  ] }));
  expect(await embedding.callEmbeddingApi(['中'.repeat(400), 'short', ' '.repeat(3000)], 'text'))
    .toEqual([[0.7071067690849304, 0.7071067690849304], [3, 4], [0, 0]]);
  expect(requests[0]!.body).toEqual({ model: 'embed-local', input: ['中'.repeat(230), '中'.repeat(34) + ' ' + '中'.repeat(170), 'short'], encoding_format: 'float' });
  expect(usage).toHaveLength(1);
  reply('{"data":[]}');
  expect(await embedding.callEmbeddingApi([' '.repeat(3000)], 'text')).toEqual([Array(1024).fill(0)]);
  expect(requests[1]!.body).toEqual({ model: 'embed-local', input: [], encoding_format: 'float' });
});

it('generate_embedding uses the persisted default and the full transport', async () => {
  values.set('embedding.default_text_model_config_id', 'text');
  expect(await embedding.generateEmbedding('hello')).toEqual([0.10000000149011612, -0.20000000298023224]);
  expect(requests[0]!.body).toMatchObject({ input: ['hello'] });
});

it('dangling_embedding_default_falls_back_to_assignments_and_writes_back', async () => {
  await configure({ id: 'emb-test', name: 'EmbTest', model: 'test-embed-v1' });
  values.set('embedding.default_text_model_config_id', 'sf_1789015238478_dangling');
  await host.ctx.llm.saveModelAssignments({ embedding_model_config_id: 'emb-test' });
  const selected = await host.ctx.llmEmbeddingModels.getEmbeddingModelConfig();
  expect(selected.id).toBe('emb-test'); expect(selected.isEmbedding).toBe(true);
  expect(values.get('embedding.default_text_model_config_id')).toBe('emb-test');
  expect(await embedding.generateEmbedding('a')).toHaveLength(2);
  expect(logs).toContainEqual({ level: 'info', message: '[RAG] Falling back to model_assignments.embedding_model_config_id=emb-test' });
});

it('dangling_embedding_default_with_dangling_assignment_autodetects', async () => {
  await configure({ id: 'emb-test', name: 'EmbTest', model: 'test-embed-v1' });
  values.set('embedding.default_text_model_config_id', 'sf_1789015238478_dangling');
  await host.ctx.llm.saveModelAssignments({ embedding_model_config_id: 'vm_also_missing' });
  expect((await host.ctx.llmEmbeddingModels.getEmbeddingModelConfig()).id).toBe('emb-test');
  expect(values.get('embedding.default_text_model_config_id')).toBe('emb-test');
  expect(logs).toContainEqual({ level: 'warn', message: '[RAG] model_assignments.embedding_model_config_id=vm_also_missing also missing from configs; skipping write-back' });
  expect(logs).toContainEqual({ level: 'info', message: '[RAG] Auto-selected embedding model: id=emb-test, name=EmbTest (1 usable)' });
});

it('dangling_embedding_default_without_any_embedding_config_errors', async () => {
  await configure({ id: 'chat-only', model: 'test-chat-v1', isEmbedding: false });
  values.set('embedding.default_text_model_config_id', 'sf_1789015238478_dangling');
  await expect(embedding.generateEmbedding('a')).rejects.toMatchObject({ message: expect.stringContaining('未配置默认嵌入维度') });
  expect(requests).toHaveLength(0);
});

it('valid_embedding_default_is_used_as_is', async () => {
  await configure({ id: 'emb-test', name: 'EmbTest', model: 'test-embed-v1' });
  values.set('embedding.default_text_model_config_id', 'emb-test');
  expect((await host.ctx.llmEmbeddingModels.getEmbeddingModelConfig()).id).toBe('emb-test');
  expect(values.get('embedding.default_text_model_config_id')).toBe('emb-test');
});

it('default read failure precedes config reads and is an unwrapped configuration error', async () => {
  const get = vi.spyOn(host.ctx.settings, 'get').mockImplementation(key => {
    if (key === 'embedding.default_text_model_config_id') throw new Error('database unavailable');
    throw new Error(`must not read ${key}`);
  });
  try {
    await expect(embedding.generateEmbedding('a')).rejects.toEqual({ error_type: 'Configuration', message: '读取嵌入模型配置失败: database unavailable', details: null });
    expect(get).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(0);
  } finally { get.mockRestore(); }
});

it('warns once for an unusable id; failed writeback stays silent and does not prevent embedding', async () => {
  values.set('embedding.default_text_model_config_id', 'never-available');
  await host.ctx.llm.saveModelAssignments({ embedding_model_config_id: 'text' });
  const save = vi.spyOn(host.ctx.settings, 'save').mockImplementation((key, value) => {
    if (key === 'embedding.default_text_model_config_id') throw new Error('read-only');
    values.set(key, value);
  });
  try {
    await embedding.generateEmbedding('a'); await embedding.generateEmbedding('b');
    expect(logs.filter(log => log.level === 'warn' && log.message.includes('Unusable embedding default'))).toHaveLength(1);
    expect(logs).toContainEqual({ level: 'debug', message: "[RAG] Unusable embedding default 'never-available' (already warned)" });
    expect(logs.some(log => log.message.includes('read-only'))).toBe(false);
    expect(requests).toHaveLength(2);
  } finally { save.mockRestore(); }
});

it('network establishment fails once with network metadata and no cooldown or usage', async () => {
  handle = response => response.destroy();
  const error = await embedding.callEmbeddingApi(['a'], 'text').catch(error => error);
  expect(error).toMatchObject({ error_type: 'Network', message: expect.stringContaining('嵌入API请求失败:'),
    details: { llm_failover: { phase: 'establish', http_status: null }, embedding_error: { kind: 'network', http_status: null, retry_after_secs: null } } });
  expect(requests).toHaveLength(1); expect(usage).toHaveLength(0); expect(keyCooldowns()._entries.size).toBe(0);
});

it('malformed JSON preserves reqwest decode context and serde position', async () => {
  reply('{');
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toEqual({ error_type: 'LLM',
    message: '解析嵌入API响应失败: error decoding response body: EOF while parsing an object at line 1 column 1', details: null });
  expect(usage).toHaveLength(0); expect(requests).toHaveLength(1);
});

it('HTTP body read failure is logged as empty and still applies Retry-After cooldown', async () => {
  handle = response => {
    response.writeHead(429, { 'content-length': '100', 'retry-after': '3' }); response.write('partial');
    setImmediate(() => response.destroy());
  };
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ details: { embedding_error: { kind: 'rate_limited', retry_after_secs: 3 } } });
  expect(logs).toContainEqual({ level: 'error', message: '[Embedding] API error 429: ' });
  expect(usage).toHaveLength(0);
});

it('HTTP error logging honors MIME charset and unknown-label UTF-8 fallback', async () => {
  handle = response => { response.writeHead(400, { 'content-type': 'text/plain; charset="gbk"' }); response.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); };
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ message: '嵌入请求失败，请重试' });
  expect(logs).toContainEqual({ level: 'error', message: '[Embedding] API error 400: 中文' });
  handle = response => { response.writeHead(400, { 'content-type': 'text/plain; charset=unknown-label' }); response.end('原文'); };
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ message: '嵌入请求失败，请重试' });
  expect(logs).toContainEqual({ level: 'error', message: '[Embedding] API error 400: 原文' });
  expect(usage).toHaveLength(0);
});

it('a truncated successful body fails as parsing, without establish tag, retry or usage', async () => {
  handle = response => {
    response.writeHead(200, { 'content-length': '100' }); response.write('{');
    setImmediate(() => response.destroy());
  };
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ error_type: 'LLM',
    message: expect.stringContaining('解析嵌入API响应失败: request or response body error:'), details: null });
  expect(requests).toHaveLength(1); expect(usage).toHaveLength(0);
});

it('invalid UTF-8 is rejected rather than replacing bytes in otherwise valid JSON', async () => {
  handle = response => response.end(Buffer.concat([Buffer.from('{"data":[{"embedding":[1]}],"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ error_type: 'LLM',
    message: expect.stringContaining('解析嵌入API响应失败:'), details: null });
  expect(usage).toHaveLength(0);
});

it('inherits the shared HTTP redirect policy instead of treating redirects as embeddings', async () => {
  handle = response => {
    if (requests.length === 1) { response.writeHead(307, { location: '/redirected' }); response.end(); }
    else response.end('{"data":[{"embedding":[1]}]}');
  };
  expect(await embedding.callEmbeddingApi(['a'], 'text')).toEqual([[1]]);
  expect(requests.map(request => request.url)).toEqual(['/v1/embeddings', '/redirected']);
  expect(requests[1]!.body).toEqual(requests[0]!.body);
  expect(requests[1]!.headers.authorization).toBe('Bearer key'); expect(usage).toHaveLength(1);
});

it('configured policy controls cooldown; read failure uses the original 60-second default', async () => {
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), keyCooldownSecs: 9 });
  reply('bad key', 401);
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ message: 'API 密钥无效或已过期，请检查设置' });
  expect(logs).toContainEqual({ level: 'warn', message: '[Embedding] HTTP 401 for model text-embedding-3-small; key cooled down for 9s (retry_after=None)' });
  keyCooldowns()._entries.clear();
  const get = vi.spyOn(host.ctx.settings, 'get').mockImplementation(key => {
    if (key === 'llm_failover_policy') throw new Error('unavailable');
    return values.get(key) ?? null;
  });
  try {
    await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ message: 'API 密钥无效或已过期，请检查设置' });
    expect(logs).toContainEqual({ level: 'warn', message: '[Embedding] HTTP 401 for model text-embedding-3-small; key cooled down for 60s (retry_after=None)' });
  } finally { get.mockRestore(); }
});

it('shares cooldown across same vendor/key but not another key; expiry re-enables real HTTP', async () => {
  const runtime = (await host.ctx.llm.getApiConfigs()).find(c => c.id === 'text')!;
  const fingerprint = keyFingerprint(runtime.vendorId ?? runtime.baseUrl, 'key');
  keyCooldowns().setFor(fingerprint, 60_000);
  await expect(embedding.callEmbeddingApi(['a'], 'text')).rejects.toMatchObject({ details: { embedding_error: { kind: 'rate_limited' } } });
  expect(requests).toHaveLength(0);
  keyCooldowns().setUntil(fingerprint, performance.now() - 1);
  expect(await embedding.callEmbeddingApi(['a'], 'text')).toHaveLength(1);
});
