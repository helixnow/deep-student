/** model2_pipeline.rs:8632 call_anki_routed_raw_prompt over the real L01 adapters and local HTTP. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { getEventListeners, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin for public adapter integration.
import providers from '../../llm-providers/index.ts';
import llm from '../index.ts';
import { llmAnkiRoutingService, llmRawPromptService, type ApiConfig, type LlmAnkiRouting, type LlmRawPrompt,
  type LlmUsageRecorder, type RoleDecision } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import { realInjectionBudget } from './host.ts';
import { makeConfig } from './support.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let raw: LlmRawPrompt;
let routing: LlmAnkiRouting;
let baseUrl: string;
let handle: (body: Record<string, unknown>, response: ServerResponse) => void;
const requests: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }[] = [];
const usage: Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0][] = [];
const logs: { level: string; message: string }[] = [];
const values = new Map<string, string>();
let failNextRead: string | null = null;
const settings: SettingsStore = {
  get: key => {
    if (key === failNextRead) { failNextRead = null; throw new Error('disk error'); }
    return values.get(key) ?? null;
  },
  save: (key, value) => { values.set(key, value); },
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
  meta: { id: 'test.anki-routed-consumer' }, inject: [llmRawPromptService.name, llmAnkiRoutingService.name],
  apply(ctx) { raw = ctx.llmRawPrompt; routing = ctx.llmAnkiRouting; },
});
const answer = { choices: [{ message: { content: '{"route":"vlm_full"}' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } };
// gpt-* models: provider_quirks force_json_response_format makes force_json observable on the wire.
const MODELS: Record<string, string> = { main: 'gpt-4o', card: 'gpt-4o-mini', backup: 'gpt-4.1', vision: 'gpt-4.1-mini' };
function config(id: string, overrides: Partial<ApiConfig> = {}) {
  return makeConfig({ id, name: id, model: MODELS[id]!, enabled: true, apiKey: `local-${id}`, baseUrl,
    apiProtocol: 'openai_chat_completions', ...overrides });
}
function decision(role: RoleDecision['role'], configId: string): RoleDecision {
  return { role, configId, model: MODELS[configId] ?? configId, slot: 'mainModel', degraded: false, isMultimodal: false, reason: 'test' };
}
function debugLines(needle: string) {
  return logs.filter(entry => entry.level === 'debug' && entry.message.includes(needle)).map(entry => entry.message);
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected rejection');
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
    log: { logger: () => ({ debug: record('debug'), info: record('info'), error: record('error'), warn: record('warn') }) },
    llmUsage: { cacheDebugEnabled: () => false,
      recordLlmUsageCacheExtWithIdentity: (entry: typeof usage[number]) => { usage.push(entry); } },
  } });
}, 120_000);
afterAll(async () => {
  await host?.dispose(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(async () => {
  requests.length = 0; usage.length = 0; logs.length = 0;
  await host.ctx.llm.saveApiConfigurations([config('main'), config('card')]);
  await host.ctx.llm.saveModelAssignments({ model2_config_id: 'main', anki_card_model_config_id: 'card' });
  await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: false });
  handle = (_body, response) => response.end(JSON.stringify(answer));
});

describe('llmRawPrompt.callAnkiRoutedRawPrompt (model2_pipeline.rs:8632)', () => {
  it('a real routing decision sends the routed config with JSON mode and caller anki', async () => {
    const generator = await routing.resolveAnkiRoleDecision('generator', 'auto');
    expect(generator).toMatchObject({ role: 'generator', configId: 'card' });
    const output = await raw.callAnkiRoutedRawPrompt(generator, 'chatanki.plan_route', '规划路由', null);
    expect(output).toEqual({ assistant_message: '{"route":"vlm_full"}', raw_response: JSON.stringify(answer),
      chain_of_thought_details: null, cancelled: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({ model: 'gpt-4o-mini', stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: '规划路由' }] }], response_format: { type: 'json_object' } });
    expect(requests[0]!.headers.authorization).toBe('Bearer local-card');
    expect(usage).toEqual([expect.objectContaining({ callerType: 'anki', model: 'gpt-4o-mini', success: true })]);
    expect(debugLines('回退 model2')).toEqual([]);
  });

  it('a null decision calls model2 with caller anki', async () => {
    await raw.callAnkiRoutedRawPrompt(null, 'chatanki.plan_route', 'p', null);
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(usage).toEqual([expect.objectContaining({ callerType: 'anki', model: 'gpt-4o' })]);
    expect(debugLines('回退 model2')).toEqual([]);
  });

  it('a missing, disabled or non-text routed config falls back to model2 with the Rust debug line', async () => {
    for (const routed of [
      config('card', { enabled: false }), config('card', { isEmbedding: true }),
      config('card', { isReranker: true }), config('card', { isImageGeneration: true }), null,
    ]) {
      requests.length = 0; usage.length = 0; logs.length = 0;
      await host.ctx.llm.saveApiConfigurations(routed === null ? [config('main')] : [config('main'), routed]);
      await raw.callAnkiRoutedRawPrompt(decision('critic', 'card'), 'anki_critic.run_critic_pass', 'p', null);
      expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);
      expect(usage).toEqual([expect.objectContaining({ callerType: 'anki', model: 'gpt-4o' })]);
      expect(debugLines('[ANKI_ROUTING]')).toEqual(['[ANKI_ROUTING] critic 角色配置 card 已不可用，回退 model2']);
    }
  });

  it('a getApiConfigs failure while resolving the routed config takes the model2 fallback', async () => {
    failNextRead = 'vendor_configs';
    await raw.callAnkiRoutedRawPrompt(decision('planner', 'card'), 'chatanki.plan_route', 'p', null);
    expect(failNextRead).toBeNull();
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);
    expect(debugLines('[ANKI_ROUTING]')).toEqual(['[ANKI_ROUTING] planner 角色配置 card 已不可用，回退 model2']);
  });

  it('the routed call fails over with the caller task; the model2 fallback uses task utility', async () => {
    // Distinct keys: transient failures cool keys down for the rest of the shared host.
    await host.ctx.llm.saveApiConfigurations([config('main', { apiKey: 'failover-main' }),
      config('card', { apiKey: 'failover-card' }), config('backup')]);
    await host.ctx.llm.saveFailoverPolicy({ ...(await host.ctx.llm.getFailoverPolicy()), enabled: true,
      taskFallbacks: { 'chatanki.plan_route': ['backup'], utility: ['backup'] }, defaultFallbacks: [] });
    handle = (body, response) => {
      if (body.model === 'gpt-4.1') response.end(JSON.stringify(answer));
      else { response.writeHead(503); response.end('unavailable'); }
    };
    const before = host.eventsNamed('llm-failover').length;
    await raw.callAnkiRoutedRawPrompt(decision('planner', 'card'), 'chatanki.plan_route', 'p', null);
    await raw.callAnkiRoutedRawPrompt(null, 'chatanki.plan_route', 'p', null);
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4.1']);
    expect(host.eventsNamed('llm-failover').slice(before)).toEqual([
      expect.objectContaining({ task: 'chatanki.plan_route', kind: 'model_fallback', from_config_id: 'card', to_config_id: 'backup' }),
      expect.objectContaining({ task: 'utility', kind: 'model_fallback', from_config_id: 'main', to_config_id: 'backup' }),
    ]);
    expect(usage.map(entry => [entry.callerType, entry.model, entry.success])).toEqual([['anki', 'gpt-4.1', true], ['anki', 'gpt-4.1', true]]);
  });

  it('a routed call failure propagates without a model2 retry; chatanki plan_route owns that fallback', async () => {
    let served = 0;
    handle = (_body, response) => {
      if (served++ === 0) { response.writeHead(400); response.end('bad planner'); }
      else response.end(JSON.stringify(answer));
    };
    // chatanki_executor.rs:9657-9662: plan_route resolves the Planner role in Auto mode (main-model slot first).
    const routed = await routing.resolveAnkiRoleDecision('planner', 'auto');
    expect(routed).toMatchObject({ role: 'planner', configId: 'main', slot: 'mainModel' });
    const error = await rejection(raw.callAnkiRoutedRawPrompt(routed, 'chatanki.plan_route', 'p', null));
    expect(error).toMatchObject({ error_type: 'LLM', message: 'RAW_PROMPT API请求失败: 400 Bad Request - bad planner' });
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o']);
    expect(usage).toEqual([]);
    expect(debugLines('回退 model2')).toEqual([]);
    // chatanki_executor.rs:9673-9683: (Err, decision.is_some()) → call_model2_raw_prompt(prompt, None, Anki).
    const fallback = await raw.callModel2RawPrompt('p', null, 'anki');
    expect(fallback.assistant_message).toBe('{"route":"vlm_full"}');
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o', 'gpt-4o']);
    expect(usage.map(entry => [entry.callerType, entry.model, entry.success])).toEqual([['anki', 'gpt-4o', true]]);
  });

  it('images reach a multimodal routed config as data URLs', async () => {
    await host.ctx.llm.saveApiConfigurations([config('main'), config('vision', { isMultimodal: true })]);
    await raw.callAnkiRoutedRawPrompt(decision('vlm', 'vision'), 'chatanki.vlm_route', '看图', [{ mime: 'image/png', base64: 'AAAA' }]);
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4.1-mini']);
    expect(requests[0]!.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
  });

  it('a pre-aborted signal rejects with its reason before HTTP; a live signal leaves no listeners', async () => {
    const aborted = new AbortController(); aborted.abort();
    expect(await rejection(raw.callAnkiRoutedRawPrompt(decision('planner', 'card'), 't', 'p', null, aborted.signal)))
      .toBe(aborted.signal.reason);
    expect(requests).toEqual([]); expect(usage).toEqual([]);
    const live = new AbortController();
    await raw.callAnkiRoutedRawPrompt(decision('planner', 'card'), 't', 'p', null, live.signal);
    await raw.callAnkiRoutedRawPrompt(null, 't', 'p', null, live.signal);
    expect(requests.map(entry => entry.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(getEventListeners(live.signal, 'abort')).toEqual([]);
  });
});
