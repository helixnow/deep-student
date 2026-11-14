import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import storagePlugin from '../../../platform/storage/index.ts';
import secretsPlugin from '../../../platform/secrets/index.ts';
import vectorPlugin from '../../../platform/vector/index.ts';
import settingsPlugin from '../../../platform/settings/index.ts';
// boundary-allow cross-plugin-impl: regression exercises the actual L02 error-producing model resolver
import llmPlugin from '../../llm/index.ts';
// boundary-allow cross-plugin-impl: install L02's actual provider dependency
import providersPlugin from '../../llm-providers/index.ts';
// boundary-allow cross-plugin-impl: actual L11 persistence owner
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: actual L13 database service needed by L02
import vfsPlugin from '../../vfs/index.ts';
// boundary-allow cross-plugin-impl: actual notes owner required by L13
import notesPlugin from '../../notes/index.ts';
import type { ApiConfig } from '../../llm/api.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

const missing = '未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。';
const model: ApiConfig = {
  id: 'owner-model', name: 'owner-model', model: 'embed', apiKey: 'key', baseUrl: 'https://example.invalid/v1',
  vendorId: null, vendorName: null, providerType: 'openai', providerScope: null, authMode: null,
  apiProtocol: 'openai', supportsOpenaiResponses: null, isMultimodal: false, isReasoning: false,
  isEmbedding: true, isReranker: false, isImageGeneration: false, enabled: true, modelAdapter: 'openai',
  maxOutputTokens: 1024, temperature: 0, supportsTools: false, geminiApiVersion: 'v1beta',
  isBuiltin: false, isReadOnly: false, reasoningEffort: null, reasoningMode: null, thinkingEnabled: false,
  thinkingBudget: null, includeThoughts: false, minP: null, topK: null, enableThinking: null,
  supportsReasoning: false, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
  presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null,
  verbosity: null, isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null, resolvedAdapterId: null,
};
let root: string;
let host: TestHost;
let emptyProfiles: string;
const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
const logs: string[] = [];
const logger = { debug: (message: string) => logs.push(message), info: (message: string) => logs.push(message),
  warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ method: request.method, url: request.url, body });
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ data: body.input.map(() => ({ embedding: Array<number>(64).fill(0.25) })) }));
});

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-embedding-owner-');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  model.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ app: { dataDir: root },
    plugins: [secretsPlugin, [storagePlugin, { dataLocalDir: root }], settingsPlugin,
      reposPlugin, notesPlugin, vectorPlugin, plugin, vfsPlugin, providersPlugin, llmPlugin],
    provide: { paths: { ...pathsServiceDouble(), appDataDir: root,
      os: { home: root, data: root, dataLocal: root, config: root, temp: root } },
      log: { logger: () => logger }, nativeImage: {}, nativeTokenizer: {},
      storageStartupSync: { resetDefaultAfterLocalPurge() { throw new Error('clean test root has no purge marker'); } },
    } });
  // Let L02 materialize its built-in snapshot before removing all configurations.
  await host.ctx.llm.getApiConfigs();
  await host.ctx.llm.saveApiConfigurations([]);
  emptyProfiles = host.ctx.settings.get('model_profiles')!;
  expect(emptyProfiles).toBe('[]');
  process.stdout.write(`WP-219 runtime ${JSON.stringify({ execPath: process.execPath, versions: process.versions })}\n`);
}, 180_000);

afterAll(async () => {
  try { await host?.dispose(); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

it('R12-02 get_embedding_model_info preserves real L02 AppError Display through indexResource', async () => {
  await host.ctx.llm.saveApiConfigurations([]);
  const db = host.ctx.storage.database('vfs');
  const resource = host.ctx.vfsRepo.resources.createOrReuse(db, 'note', 'Missing owner configuration '.repeat(5), null, null, null);
  await expect(host.ctx.vfsIndex.indexing.indexResource(resource.resourceId))
    .rejects.toMatchObject({ message: `获取嵌入模型配置失败: ${missing}` });
  expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
  expect(requests).toHaveLength(0);
});

it('R12-02 get_embedding_model_id preserves real L02 AppError Display through query embedding', async () => {
  await host.ctx.llm.saveApiConfigurations([]);
  await expect(host.ctx.vfsIndex.fullSearch!.generateQueryEmbedding('query'))
    .rejects.toMatchObject({ message: `获取嵌入模型配置失败: ${missing}` });
  expect(requests).toHaveLength(0);
});

it('R12-02 ensure_model_assignment_unchanged preserves the re-read prefix with real L02 errors', async () => {
  await host.ctx.llm.saveApiConfigurations([model]);
  expect(await host.ctx.llmEmbeddingModels.getEmbeddingModelConfig()).toMatchObject({ id: model.id, model: model.model });
  const db = host.ctx.storage.database('vfs');
  const resource = host.ctx.vfsRepo.resources.createOrReuse(db, 'note', 'Configuration disappears after embedding '.repeat(3), null, null, null);
  const progress: Array<[number, number]> = [];
  await expect(host.ctx.vfsIndex.indexing.indexResource(resource.resourceId, null, (processed, total) => {
    progress.push([processed, total]);
    // The callback is synchronous: restore L02's own empty configuration via F4,
    // after the real HTTP batch, so the real L02 resolver fails at the re-read.
    host.ctx.settings.save('model_profiles', emptyProfiles);
  }))
    .rejects.toMatchObject({ message: `重新读取嵌入模型配置失败: ${missing}` });
  expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
  expect(progress).toEqual([[1, 1]]);
  expect(requests).toEqual([{ method: 'POST', url: '/v1/embeddings',
    body: { model: model.model, input: ['Configuration disappears after embedding '.repeat(3).trim()], encoding_format: 'float' } }]);
  expect(logs).toContain('嵌入API调用成功，返回 1 个向量');
  expect((await host.ctx.llm.getApiConfigs()).some(config => config.id === model.id)).toBe(false);
  process.stdout.write(`WP-219 re-read RAW ${JSON.stringify({ requests, progress, segments: db.pluck('SELECT COUNT(*) FROM vfs_index_segments') })}\n`);
});
