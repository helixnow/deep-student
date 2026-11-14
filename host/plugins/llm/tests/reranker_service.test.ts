/** rag_extension.rs:302,499,744,1313 reranker owner (WP-023/024) over real local HTTP, plus the vfs-index consumer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for public adapter integration.
import providers from '../../llm-providers/index.ts';
// boundary-allow cross-plugin-impl: exercise the vfs-index rerank adapter against the real llmReranker service.
import { createRerankRuntime } from '../../vfs-index/src/runtime-adapter.ts';
import llm from '../index.ts';
import { llmRerankerService, type ApiConfig, type LlmReranker, type RetrievedChunk } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { LlmUsageExtCall } from '../../../platform/storage/llm-usage.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let baseUrl: string;
let handle: (body: Record<string, unknown>, response: ServerResponse) => void;
const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
const usage: LlmUsageExtCall[] = [];
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
  requests.push({ url: request.url ?? '', body: JSON.parse(text) as Record<string, unknown>, headers: request.headers });
  handle(JSON.parse(text) as Record<string, unknown>, response);
});
function config(id: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return makeConfig({ id, name: id, model: `${id}-model`, enabled: true, apiKey: `key-${id}`, baseUrl: `${baseUrl}/`,
    apiProtocol: 'openai_chat_completions', ...overrides });
}
function chunk(id: string, text: string, score = 0.5): RetrievedChunk {
  return { chunk: { id, document_id: `res-${id}`, chunk_index: 0, text, metadata: {} }, score };
}
async function rejection(promise: Promise<unknown>): Promise<{ error_type?: string; message?: string }> {
  try { await promise; } catch (error) { return error as { error_type?: string; message?: string }; }
  throw new Error('expected rejection');
}
const reranker = (): LlmReranker => host.ctx.get(llmRerankerService.name) as LlmReranker;

beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ plugins: [providers, llm], provide: {
    settings, secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget,
    vfsDatabase: {}, vfsRepo: { essays: {} },
    llmUsage: { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: () => {},
      recordLlmUsageExt: (entry: LlmUsageExtCall) => { usage.push(entry); } },
  } });
});
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  requests.length = 0; usage.length = 0;
  await host.ctx.llm.saveApiConfigurations([
    config('text-rr', { isReranker: true }),
    config('vl-rr', { isReranker: true, isMultimodal: true }),
    config('chat'),
  ]);
  await host.ctx.llm.saveModelAssignments({ reranker_model_config_id: 'text-rr', vl_reranker_model_config_id: 'vl-rr' });
  handle = (_body, response) => response.end(JSON.stringify({ results: [] }));
});

describe('llmReranker text rerank (rag_extension.rs:1313 call_reranker_api)', () => {
  it('is provided under the single llmReranker name and resolves the assigned text reranker', async () => {
    expect(llmRerankerService.name).toBe('llmReranker');
    expect((await reranker().getRerankerModelConfig()).id).toBe('text-rr');
    expect((await reranker().getVlRerankerModelConfig()).id).toBe('vl-rr');
  });

  it('posts the Rust /rerank body, keeps API order, overwrites scores as f32 and skips out-of-range indexes', async () => {
    handle = (_body, response) => response.end(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.9 }, { index: 7, relevance_score: 0.8 }, { index: 0, relevance_score: 0.1 }],
      meta: { billed_units: { search_units: 3 } },
    }));
    const out = await reranker().callRerankerApi('勾股定理', [chunk('a', 'alpha'), chunk('b', 'beta')], 'text-rr');
    expect(out.map(item => [item.chunk.id, item.score])).toEqual([['b', Math.fround(0.9)], ['a', Math.fround(0.1)]]);
    expect(out[0]!.chunk).toEqual(chunk('b', 'beta').chunk);
    const [request] = requests;
    expect(request!.url).toBe('/v1/rerank');
    expect(request!.body).toEqual({ model: 'text-rr-model', query: '勾股定理', documents: ['alpha', 'beta'], top_k: 2, return_documents: true });
    expect(Object.keys(request!.body)).toEqual(['model', 'query', 'documents', 'top_k', 'return_documents']);
    expect(request!.headers).toMatchObject({ authorization: 'Bearer key-text-rr', accept: 'application/json',
      'accept-encoding': 'identity', origin: 'http://127.0.0.1', referer: 'http://127.0.0.1/' });
    expect(usage).toEqual([expect.objectContaining({ callerType: 'reranker', model: 'text-rr-model', promptTokens: 3,
      completionTokens: 0, success: true, adapter: 'rerank', tokenSource: 'api' })]);
  });

  it('records heuristic usage when the response reports no u64 token count', async () => {
    handle = (_body, response) => response.end(JSON.stringify({ results: [], usage: { tokens: 1.5 } }));
    await reranker().callRerankerApi('q', [chunk('a', 'alpha')], 'text-rr');
    expect(usage).toEqual([expect.objectContaining({ promptTokens: 0, tokenSource: 'heuristic' })]);
  });

  it('rejects configs without the text reranker capability with the Rust configuration errors', async () => {
    expect(await rejection(reranker().callRerankerApi('q', [], 'missing'))).toMatchObject({ error_type: 'Configuration', message: '找不到重排序模型配置' });
    expect(await rejection(reranker().callRerankerApi('q', [], 'vl-rr')))
      .toMatchObject({ error_type: 'Configuration', message: '指定模型不支持文本重排序协议或已禁用' });
    expect(requests).toEqual([]);
    await host.ctx.llm.saveModelAssignments({ reranker_model_config_id: null, vl_reranker_model_config_id: 'chat' });
    expect(await rejection(reranker().getRerankerModelConfig())).toMatchObject({ error_type: 'Configuration', message: '未配置重排序模型' });
    expect(await rejection(reranker().getVlRerankerModelConfig()))
      .toMatchObject({ error_type: 'Configuration', message: '多模态重排序配置已禁用或能力协议不匹配' });
  });

  it('maps HTTP failures to the Rust user messages and malformed bodies to LLM errors', async () => {
    for (const [status, message] of [[401, 'API 密钥无效或已过期，请检查设置'], [429, '请求过于频繁，请稍后重试'],
      [503, '重排序服务暂时不可用，请稍后重试'], [400, '重排序请求失败，请重试']] as const) {
      handle = (_body, response) => { response.statusCode = status; response.end('{"secret":"detail"}'); };
      expect(await rejection(reranker().callRerankerApi('q', [chunk('a', 'alpha')], 'text-rr'))).toMatchObject({ error_type: 'LLM', message });
    }
    handle = (_body, response) => response.end(JSON.stringify({ data: [] }));
    expect(await rejection(reranker().callRerankerApi('q', [chunk('a', 'alpha')], 'text-rr')))
      .toMatchObject({ error_type: 'LLM', message: '重排序API响应格式无效：缺少results字段' });
    handle = (_body, response) => response.end(JSON.stringify({ results: [{ index: 0 }] }));
    expect(await rejection(reranker().callRerankerApi('q', [chunk('a', 'alpha')], 'text-rr')))
      .toMatchObject({ error_type: 'LLM', message: '重排序结果缺少relevance_score字段' });
    expect(usage).toEqual([]);
  });
});

describe('llmReranker multimodal rerank (rag_extension.rs:744 call_multimodal_reranker_api)', () => {
  it('sends VL input items, sorts by descending score and records no usage', async () => {
    handle = (_body, response) => response.end(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.7 }, { index: 2, relevance_score: 0.7 }],
    }));
    const out = await reranker().callMultimodalRerankerApi({ text: '图', image: { data: 'AAAA', media_type: 'image/png' } },
      [{ text: 'a' }, { image: { url: 'https://img.example/x.png' } }, { text: 'c', instruction: 'i' }]);
    expect(out).toEqual([{ index: 1, relevance_score: Math.fround(0.7) }, { index: 2, relevance_score: Math.fround(0.7) },
      { index: 0, relevance_score: Math.fround(0.2) }]);
    expect(requests[0]!.body).toEqual({ model: 'vl-rr-model', query: { text: '图', image: 'data:image/png;base64,AAAA' },
      documents: [{ text: 'a' }, { image: 'https://img.example/x.png' }, { text: 'c', instruction: 'i' }], top_k: 3, return_documents: false });
    expect(requests[0]!.headers.origin).toBe('http://127.0.0.1');
    expect(requests[0]!.headers.referer).toBeUndefined();
    expect(usage).toEqual([]);
  });

  it('returns no results without a request for an empty document list', async () => {
    expect(await reranker().callMultimodalRerankerApi({ text: 'q' }, [])).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('vfs-index rerank adapter (indexing.rs:4914 rerank_results)', () => {
  const results = [
    { embeddingId: 'e1', resourceId: 'r1', chunkIndex: 0, chunkText: 'first', score: 0.03, resourceTitle: 'T1' },
    { embeddingId: 'e2', resourceId: 'r2', chunkIndex: 4, chunkText: 'second', score: 0.02 },
  ];

  it('reranks through llmReranker and maps scores back onto the original search results', async () => {
    handle = (_body, response) => response.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.6 }, { index: 0, relevance_score: 0.4 }] }));
    const out = await createRerankRuntime(host.ctx).rerank('query', results);
    expect(out).toEqual([{ ...results[1], score: Math.fround(0.6) }, { ...results[0], score: Math.fround(0.4) }]);
    expect(requests[0]!.body.documents).toEqual(['first', 'second']);
  });

  it('skips reranking without an assignment and surfaces provider failures with the Rust prefix', async () => {
    await host.ctx.llm.saveModelAssignments({ reranker_model_config_id: null });
    expect(await createRerankRuntime(host.ctx).rerank('query', results)).toEqual(results);
    expect(requests).toEqual([]);
    await host.ctx.llm.saveModelAssignments({ reranker_model_config_id: 'text-rr' });
    handle = (_body, response) => { response.statusCode = 500; response.end(''); };
    await expect(createRerankRuntime(host.ctx).rerank('query', results)).rejects.toThrow('重排序失败: 重排序服务暂时不可用，请稍后重试');
  });
});
