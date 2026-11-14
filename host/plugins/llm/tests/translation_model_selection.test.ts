import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from './host.ts';
import llm from '../index.ts';
import translation from '../../translation/index.ts';
import { makeConfig } from './support.ts';
import type { ApiConfig } from '../api.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let baseUrl: string;
let requests = 0;
const values = new Map<string, string>();
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume the request before replying */ }
  requests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: [DONE]\n\n');
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ plugins: [llm, translation], provide: {
    settings: {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
      getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => false,
    },
    secrets: { isEncryptedFormat: () => false,
      openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
  } });
}, 120_000);
afterAll(async () => {
  await host?.dispose();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function config(id: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, enabled: true, baseUrl, model: 'test-model', authMode: 'none',
    apiProtocol: 'openai_chat_completions', ...overrides });
}
function translate() {
  return host.invoke('translate_text_stream', { request: {
    session_id: 'selection-regression', text: 'hello', src_lang: 'en', tgt_lang: 'zh',
  } });
}

it.each([
  ['disabled', { enabled: false }],
  ['embedding', { isEmbedding: true }],
  ['reranker', { isReranker: true }],
  ['image generation', { isImageGeneration: true }],
] satisfies [string, Partial<ApiConfig>][])(
  'rejects a translation assignment changed to %s before sending source text', async (_label, overrides) => {
    await host.ctx.llm.saveApiConfigurations([config('dedicated'), config('chat')]);
    await host.ctx.llm.saveModelAssignments({ translation_model_config_id: 'dedicated', model2_config_id: 'chat' });
    // Assign while usable, then disable/change the model without clearing its assignment.
    await host.ctx.llm.saveApiConfigurations([config('dedicated', overrides), config('chat')]);
    requests = 0;
    await expect(translate()).rejects.toMatchObject({
      message: '翻译模型已禁用或不支持文本调用',
    });
    expect(requests).toBe(0);
  },
);

it('keeps dedicated-model priority and uses model2 only when no translation model is assigned', async () => {
  await host.ctx.llm.saveApiConfigurations([config('dedicated'), config('chat')]);
  await host.ctx.llm.saveModelAssignments({ translation_model_config_id: 'dedicated', model2_config_id: 'chat' });
  expect((await host.ctx.llm.getTranslationModelConfig()).id).toBe('dedicated');
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'chat' });
  expect((await host.ctx.llm.getTranslationModelConfig()).id).toBe('chat');
  requests = 0;
  await expect(translate()).resolves.toMatchObject({ translated_text: '译文' });
  expect(requests).toBe(1);
  await host.ctx.llm.saveApiConfigurations([config('chat', { enabled: false })]);
  requests = 0;
  await expect(translate()).rejects.toMatchObject({
    message: '翻译模型已禁用或不支持文本调用',
  });
  expect(requests).toBe(0);
});
