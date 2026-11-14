// chatanki_executor.rs:9647–9751 plan_route / call_vlm_extract through the production run-input wiring
// (createChatAnkiRunInputSources) over the real L01/L02 plugins and the published
// llmAnkiRouting + llmRawPrompt.callAnkiRoutedRawPrompt (model2_pipeline.rs:8632–8672).
// Only the remote HTTP endpoint is local; task labels are observed through task-specific failover chains.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createLogService } from '../../../platform/log/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import {
  defaultBudgetConfig, InjectionBudgetManager, newInjectionItem,
} from '../../../platform/storage/injection-budget.ts';
import llm from '../../llm/index.ts';
import type { ApiConfig, FailoverPolicy, LlmUsageRecorder } from '../../llm/api.ts';
import providers from '../../llm-providers/index.ts';
import { createChatAnkiRunInputSources } from '../src/run-input-sources.ts';

type UsageEntry = Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0];

const IMAGES = [{ mime: 'image/png', base64: 'AAAA' }];
const IMAGE_CONTENT = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

const requests: Array<Record<string, any>> = [];
const usage: UsageEntry[] = [];
const warnings: string[] = [];
let status: (model: string) => number = () => 200;
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push(body);
  const code = status(body.model);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(code === 200
    ? JSON.stringify({
      id: 'local-routed', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `from ${body.model}` } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })
    : JSON.stringify({ error: { message: `local status ${code}` } }));
});

let dir = '';
let port = 0;
let host: Awaited<ReturnType<typeof createTestHost>>;
let dispose: () => Promise<void> = async () => undefined;

// gpt-* models: provider quirks put force_json on the wire as response_format.
function apiConfig(id: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id, name: id, vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: `local-${id}`, baseUrl: `http://127.0.0.1:${port}/v1`, model: `gpt-local-${id}`,
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
    isImageGeneration: false, enabled: true, modelAdapter: 'general', maxOutputTokens: 8192,
    temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1', isBuiltin: false,
    isReadOnly: false, reasoningEffort: null, reasoningMode: null, thinkingEnabled: false,
    thinkingBudget: null, includeThoughts: false, minP: null, topK: null, enableThinking: null,
    supportsReasoning: false, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
    presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null,
    verbosity: null, isFavorite: false, maxTokensLimit: null, contextWindow: null,
    extraBody: null, resolvedAdapterId: null,
    ...overrides,
  };
}

async function failover(taskFallbacks: FailoverPolicy['taskFallbacks']): Promise<void> {
  await host.ctx.llm.saveFailoverPolicy({
    ...(await host.ctx.llm.getFailoverPolicy()), enabled: true, taskFallbacks, defaultFallbacks: [],
  });
}

function sources(routing: 'published' | 'absent') {
  const built = createChatAnkiRunInputSources({
    chatSession: {} as never,
    rawPrompt: host.ctx.llmRawPrompt,
    routing: routing === 'published' ? host.ctx.llmAnkiRouting : undefined,
    vfsDatabase: undefined, vfsRepo: undefined, vfsResolver: undefined, docs: undefined,
    warn: (message) => { warnings.push(message); },
  });
  if (built === null) throw new Error('expected run input sources');
  return built;
}

function failoverEvents(before: number): unknown[] {
  return host.eventsNamed('llm-failover').slice(before);
}

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected local TCP address');
  port = address.port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-routed-raw-prompt-'));
  const paths = createPaths({ dataDir: dir, platform: 'linux', env: {
    HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
  } });
  const log = createLogService({ paths, debug: false, version: 'test' });
  const secrets = createSecretsService({ os: paths.os, log: log.logger('chatanki_test'), keystore: null });
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  const secureStore = secrets.openStore(dir, { keystore: null });
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => secureStore, secrets });
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, providers, llm],
    provide: {
      paths, log, secrets, settings, storage,
      // These unused VFS capabilities are registration prerequisites, not providers under test.
      vfsDatabase: {}, vfsRepo: { essays: {} },
      llmUsage: { cacheDebugEnabled: () => false, recordLlmUsageCacheExtWithIdentity: (entry: UsageEntry) => { usage.push(entry); } },
      injectionBudget: {
        defaultConfig: defaultBudgetConfig,
        createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config),
        newItem: newInjectionItem,
      },
    },
  });
  dispose = async () => {
    await host.dispose();
    storage.dispose();
    await log.close();
  };
}, 120_000);

afterAll(async () => {
  await dispose();
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  requests.length = 0; usage.length = 0; warnings.length = 0;
  status = () => 200;
  await host.ctx.llm.saveApiConfigurations([
    apiConfig('main', { isMultimodal: true }), apiConfig('backup', { isMultimodal: true }),
    apiConfig('vision', { isMultimodal: true }),
  ]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'main', exam_sheet_ocr_model_config_id: 'vision' });
  await failover({});
});

describe('plan_route (chatanki_executor.rs:9647–9690)', () => {
  it('a Planner decision is sent by the routed exit: JSON mode, caller anki, task chatanki.plan_route with its failover chain', async () => {
    await failover({ 'chatanki.plan_route': ['backup'] });
    status = (model) => model === 'gpt-local-main' ? 503 : 200;
    const before = host.eventsNamed('llm-failover').length;
    expect(await sources('published').planner.callAnkiRoutedRawPrompt('chatanki.plan_route', '规划路由'))
      .toBe('from gpt-local-backup');
    expect(requests.map((body) => [body.model, body.response_format])).toEqual([
      ['gpt-local-main', { type: 'json_object' }], ['gpt-local-backup', { type: 'json_object' }],
    ]);
    expect(requests[1]!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '规划路由' }] }]);
    expect(failoverEvents(before)).toEqual([expect.objectContaining({
      task: 'chatanki.plan_route', kind: 'model_fallback', from_config_id: 'main', to_config_id: 'backup',
    })]);
    expect(usage.map((entry) => [entry.callerType, entry.model, entry.success]))
      .toEqual([['anki', 'gpt-local-backup', true]]);
    expect(warnings).toEqual([]);
  });

  it('a failed Planner call warns and retries model2 once with task utility', async () => {
    await failover({ utility: ['backup'] });
    let mainCalls = 0;
    status = (model) => model === 'gpt-local-main' ? (++mainCalls === 1 ? 400 : 503) : 200;
    const before = host.eventsNamed('llm-failover').length;
    expect(await sources('published').planner.callAnkiRoutedRawPrompt('chatanki.plan_route', 'p'))
      .toBe('from gpt-local-backup');
    expect(requests.map((body) => body.model)).toEqual(['gpt-local-main', 'gpt-local-main', 'gpt-local-backup']);
    expect(requests.every((body) => body.response_format?.type === 'json_object')).toBe(true);
    expect(failoverEvents(before)).toEqual([expect.objectContaining({
      task: 'utility', kind: 'model_fallback', from_config_id: 'main', to_config_id: 'backup',
    })]);
    expect(warnings).toEqual([expect.stringMatching(/^\[chatanki\] Planner 槽调用失败，回退原 model2 路径: \S/)]);
  });

  it('without a decision the routed exit calls model2 (task utility) and a failure is not retried', async () => {
    await failover({ 'chatanki.plan_route': ['backup'], utility: ['backup'] });
    status = (model) => model === 'gpt-local-main' ? 503 : 200;
    const before = host.eventsNamed('llm-failover').length;
    expect(await sources('absent').planner.callAnkiRoutedRawPrompt('chatanki.plan_route', 'p'))
      .toBe('from gpt-local-backup');
    expect(failoverEvents(before)).toEqual([expect.objectContaining({ task: 'utility', from_config_id: 'main' })]);

    requests.length = 0;
    await failover({});
    status = () => 400;
    await expect(sources('absent').planner.callAnkiRoutedRawPrompt('chatanki.plan_route', 'p')).rejects.toBeDefined();
    expect(requests.map((body) => body.model)).toEqual(['gpt-local-main']);
    expect(warnings).toEqual([]);
  });
});

describe('call_vlm_extract (chatanki_executor.rs:9713–9751)', () => {
  it('a Vlm decision sends the vision-slot config the images with the caller task and its failover chain', async () => {
    await host.ctx.llm.saveApiConfigurations([
      apiConfig('main', { isMultimodal: true }), apiConfig('vision', { isMultimodal: true }),
      apiConfig('vision2', { isMultimodal: true }),
    ]);
    await failover({ 'chatanki.vlm_full_extract': ['vision2'] });
    status = (model) => model === 'gpt-local-vision' ? 503 : 200;
    const before = host.eventsNamed('llm-failover').length;
    expect(await sources('published').vlm.callVlmExtract('chatanki.vlm_full_extract', '识图', IMAGES))
      .toBe('from gpt-local-vision2');
    expect(requests.map((body) => [body.model, body.response_format])).toEqual([
      ['gpt-local-vision', { type: 'json_object' }], ['gpt-local-vision2', { type: 'json_object' }],
    ]);
    expect(requests[0]!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '识图' }, IMAGE_CONTENT] }]);
    expect(failoverEvents(before)).toEqual([expect.objectContaining({
      task: 'chatanki.vlm_full_extract', kind: 'model_fallback', from_config_id: 'vision', to_config_id: 'vision2',
    })]);
    expect(usage.map((entry) => [entry.callerType, entry.model])).toEqual([['anki', 'gpt-local-vision2']]);
    expect(warnings).toEqual([]);
  });

  it('a failed Vlm call warns and retries model2 with the same images once', async () => {
    status = (model) => model === 'gpt-local-vision' ? 400 : 200;
    expect(await sources('published').vlm.callVlmExtract('chatanki.vlm_light_extract', '识图', IMAGES))
      .toBe('from gpt-local-main');
    expect(requests.map((body) => body.model)).toEqual(['gpt-local-vision', 'gpt-local-main']);
    expect(requests.map((body) => body.messages)).toEqual([
      [{ role: 'user', content: [{ type: 'text', text: '识图' }, IMAGE_CONTENT] }],
      [{ role: 'user', content: [{ type: 'text', text: '识图' }, IMAGE_CONTENT] }],
    ]);
    expect(usage.map((entry) => [entry.callerType, entry.model, entry.success])).toEqual([['anki', 'gpt-local-main', true]]);
    expect(warnings).toEqual([expect.stringMatching(/^\[chatanki\] Vlm 槽调用失败，回退原 model2 图片提取路径: \S/)]);
  });

  it('without a decision the images go to model2 and a failure is not retried', async () => {
    expect(await sources('absent').vlm.callVlmExtract('chatanki.vlm_light_extract', '识图', IMAGES))
      .toBe('from gpt-local-main');
    status = () => 400;
    await expect(sources('absent').vlm.callVlmExtract('chatanki.vlm_light_extract', '识图', IMAGES)).rejects.toBeDefined();
    expect(requests.map((body) => body.model)).toEqual(['gpt-local-main', 'gpt-local-main']);
    expect(warnings).toEqual([]);
  });
});
