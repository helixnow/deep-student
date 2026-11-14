/** WP-022: real L01/L02 + F3/F4 providers, encrypted configuration and actual usage persistence. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestHost } from '../../../kernel/testing.ts';
import storage from '../../../platform/storage/index.ts';
import secrets from '../../../platform/secrets/index.ts';
import settings from '../../../platform/settings/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { image } from '../../../platform/native/image/index.ts';
// boundary-allow cross-plugin-import: installs L01's official entry, never imports its implementation.
import providers from '../../llm-providers/index.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import { embeddingService, type TextEmbeddingService } from '../api.ts';

// Installing the five real plugins plus the loopback server takes ~10s on a loaded box.
// The per-test budget has to cover the 50 real embedding round-trips below, so the fixed
// setup is installed once in a hook instead of competing with those calls for the 30s limit.
let root: string, server: Server, host: Awaited<ReturnType<typeof createTestHost>>;
const logs: string[] = [], keys: (string | undefined)[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wp022-embedding-'));
  let count = 0;
  server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the real request body before responding */ }
    keys.push(request.headers.authorization); count++;
    response.end(JSON.stringify({ data: [{ embedding: [1, 2] }],
      ...(count === 1 ? { usage: { prompt_tokens: 11 } } : {}) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const logger = { debug: (message: string) => logs.push(message), info: (message: string) => logs.push(message),
    warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };
  host = await createTestHost({ app: { dataDir: root },
    plugins: [secrets, [storage, { dataLocalDir: root }], settings, providers, plugin], provide: {
      paths: { os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
      log: { logger: () => logger }, nativeTokenizer: tokenizer, nativeImage: image,
      vfsDatabase: {}, vfsRepo: { essays: {} }, storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    }, shell: () => null });
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

it('text embedding uses encrypted F4 credentials and persists F3 usage through the installed owner', async () => {
  await host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'text', name: 'text', model: 'text-embedding-3-small',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'plaintext-secret',
    enabled: true, isEmbedding: true, isMultimodal: false, isReranker: false, modelAdapter: 'openai' })]);
  const live = (await host.ctx.llm.getApiConfigs()).find(config => config.id === 'text')!;
  const stored = JSON.parse(host.ctx.settings.get('vendor_configs')!).find((vendor: { id: string }) => vendor.id === live.vendorId);
  expect(host.ctx.secrets.isEncryptedFormat(stored.apiKey)).toBe(true);
  expect(live.apiKey).toBe('plaintext-secret');
  const embedding = host.ctx.get(embeddingService.name) as TextEmbeddingService;
  expect(embedding).toBe(host.ctx['embedding@1']);
  // The original collector flushes at 50 records or every 5 seconds. An earlier timer flush
  // may split this batch; wait for that same owner interval, not just one microtask.
  for (let i = 0; i < 50; i++) expect(await embedding.callEmbeddingApi(['a'], 'text')).toEqual([[1, 2]]);
  await expect.poll(async () => (await host.invoke<unknown[]>('llm_usage_recent', { limit: 100 })).length,
    { timeout: 5000 }).toBe(50);
  const rows = await host.invoke<Record<string, unknown>[]>('llm_usage_recent', { limit: 100 });
  expect(rows).toHaveLength(50);
  expect(rows.filter(row => row.tokenSource === 'api')).toHaveLength(1);
  expect(rows.filter(row => row.tokenSource === 'heuristic')).toHaveLength(49);
  expect(rows.find(row => row.tokenSource === 'api')).toMatchObject({ callerType: 'embedding',
    modelId: 'text-embedding-3-small', promptTokens: 11, completionTokens: 0, totalTokens: 11,
    adapter: 'openai_embeddings', success: true });
  for (const row of rows) {
    for (const field of ['reasoningTokens', 'cachedTokens', 'cacheWriteTokens', 'callerId', 'durationMs', 'variantId', 'runId']) {
      expect(row).not.toHaveProperty(field);
    }
  }
  expect(keys).toEqual(Array(50).fill('Bearer plaintext-secret'));
  expect(logs.some(message => message.includes('[LLM Usage] 使用量记录成功'))).toBe(true);
});
