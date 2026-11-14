/** llmRawPrompt production entry (model2_pipeline.rs:8570–9346 + tests L3702–L3840). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { CryptoService, EncryptedData } from '../../../platform/secrets/api.ts';
import llm from '../index.ts';
import type { ApiConfig, LlmUsageRecorder } from '../api.ts';
import { ESTABLISH_RETRIES_WITHOUT_FALLBACK } from '../src/routing.ts';
import { makeConfig, type Body } from './support.ts';
import { PROVIDER_TYPE as OPENCODE_GO_PROVIDER_TYPE, SESSION_HEADER } from '../src/opencode_go.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.dispose();
});

function encryptApiKey(value: string): EncryptedData {
  return { ciphertext: Buffer.from(value, 'utf8').toString('base64'), nonce: '', version: 2 };
}
const crypto = {
  encryptApiKey,
  decryptApiKey: (data: EncryptedData) => Buffer.from(data.ciphertext, 'base64').toString('utf8'),
  migratePlaintextKey: (value: string) => JSON.stringify(encryptApiKey(value)),
  verifyKeyIntegrity: () => true,
} as unknown as CryptoService;

function memorySettings(): SettingsStore {
  const plain = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    get: (key: string) => plain.get(key) ?? null,
    save: (key: string, value: string) => { plain.set(key, value); },
    delete: (key: string) => plain.delete(key),
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { secrets.set(key, value); },
    deleteSecret: async (key: string) => { secrets.delete(key); },
  } as unknown as SettingsStore;
}

type UsageRecord = Parameters<LlmUsageRecorder['recordLlmUsageCacheExtWithIdentity']>[0];

async function rawHost(configs: ApiConfig[], model2: string) {
  const usage: UsageRecord[] = [];
  const recorder: LlmUsageRecorder = {
    cacheDebugEnabled: () => false,
    recordLlmUsageCacheExtWithIdentity: (record) => { usage.push(record); },
  };
  const host = await createTestHost({ plugins: [llm], provide: { settings: memorySettings(), secrets: {
    isEncryptedFormat: (value: string) => value.trim().startsWith('{'), openCrypto: async () => crypto,
  }, llmUsage: recorder } });
  hosts.push(host);
  await host.invoke('save_api_configurations', { configs });
  await host.invoke('save_model_assignments', { assignments: { model2_config_id: model2 } });
  return { host, usage };
}

function rawPromptConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return makeConfig({ id: 'cfg_raw_prompt_test', name: 'raw-prompt-test', model: 'test-model',
    baseUrl: 'https://flaky.example/v1', apiKey: 'sk-test', enabled: true, ...overrides });
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

const OK_BODY = '{"id":"chatcmpl-t","object":"chat.completion","created":1,"model":"test-model","choices":[{"index":0,'
  + '"message":{"role":"assistant","content":"摘要结果"},"finish_reason":"stop"}],'
  + '"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}';

interface Seen { url: string; body: Body; headers: Headers; signal: AbortSignal | null }
function captureFetch(respond: (index: number) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) as Body, headers: new Headers(init?.headers),
      signal: init?.signal ?? null });
    return respond(seen.length);
  }) as typeof fetch;
  return seen;
}

describe('llmRawPrompt.callModel2RawPromptOpts (call_raw_prompt_with_config_scoped)', () => {
  it('raw_prompt_retries_on_empty_200_then_succeeds', async () => {
    const { host, usage } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch((index) => index === 1 ? new Response('', { status: 200 }) : jsonResponse(200, OK_BODY));
    const out = await host.ctx.llmRawPrompt.callModel2RawPromptOpts('总结一下对话', true, 'chat_v2', 'compaction');
    expect(out.assistant_message).toBe('摘要结果');
    expect(out.cancelled).toBe(false);
    expect(out.chain_of_thought_details).toBeNull();
    expect(JSON.parse(out.raw_response!)).toMatchObject({ choices: [{ message: { content: '摘要结果' } }] });
    expect(seen).toHaveLength(2);
    // Parse failure records a failed heuristic 0-token row; success records API usage.
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ callerType: 'chat_v2', model: 'test-model', success: false, promptTokens: 0,
      completionTokens: 0, tokenSource: 'heuristic', adapter: 'openai_chat_completions', sessionId: null, durationMs: null });
    expect(usage[0]!.errorMessage).toContain('解析RAW_PROMPT响应失败');
    expect(usage[1]).toMatchObject({ callerType: 'chat_v2', success: true, errorMessage: null, promptTokens: 10,
      completionTokens: 5, tokenSource: 'api', adapter: 'openai_chat_completions' });
  });

  it('raw_prompt_exhausts_retries_on_persistent_empty_200', async () => {
    const { host } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch(() => new Response('', { status: 200 }));
    await expect(host.ctx.llmRawPrompt.callModel2RawPromptOpts('总结一下对话', true, 'chat_v2', 'compaction'))
      .rejects.toMatchObject({ message: expect.stringContaining('解析RAW_PROMPT响应失败') });
    expect(seen).toHaveLength(ESTABLISH_RETRIES_WITHOUT_FALLBACK);
  }, 20_000);

  it('raw_prompt_sends_json_only_accept_header', async () => {
    const { host } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    await host.ctx.llmRawPrompt.callModel2RawPromptOpts('ping', true, 'chat_v2', 'compaction');
    expect(seen[0]!.headers.get('accept')).toBe('application/json');
  });

  it('raw_prompt_does_not_retry_on_400', async () => {
    const { host, usage } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch(() => jsonResponse(400, '{"error":"bad request"}'));
    await expect(host.ctx.llmRawPrompt.callModel2RawPromptOpts('ping', true, 'chat_v2', 'compaction'))
      .rejects.toMatchObject({ error_type: 'LLM', message: expect.stringContaining('400') });
    expect(seen).toHaveLength(1);
    expect(usage).toHaveLength(0);
  });

  it('raw prompt applies reasoning and generation before the actual Anthropic adapter (L02-03)', async () => {
    const config = rawPromptConfig({ id: 'claude', model: 'claude-sonnet-5', modelAdapter: 'anthropic', providerType: 'anthropic',
      apiProtocol: 'anthropic_messages', baseUrl: 'https://provider.invalid/v1/messages', supportsReasoning: true,
      thinkingEnabled: true, reasoningEffort: 'high', maxOutputTokens: 4096 });
    const { host } = await rawHost([config], 'claude');
    const seen = captureFetch(() => new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn' })));
    const out = await host.ctx.llmRawPrompt.callModel2RawPromptOpts('question', false, { other: 'handout' }, 'utility');
    expect(out.assistant_message).toBe('answer');
    expect(seen[0]!.url).toBe(config.baseUrl);
    expect(seen[0]!.body).toHaveProperty('thinking');
    expect(seen[0]!.body).not.toHaveProperty('temperature');
  });

  it('force_json controls response_format for gpt-* models (RawPromptOptions)', async () => {
    const config = rawPromptConfig({ id: 'gpt', model: 'gpt-4o', baseUrl: 'https://api.example/v1' });
    const { host } = await rawHost([config], 'gpt');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    await host.ctx.llmRawPrompt.callModel2RawPromptOpts('json please', true, { other: 'handout' }, 'utility');
    await host.ctx.llmRawPrompt.callModel2RawPromptOpts('markdown please', false, { other: 'handout' }, 'utility');
    expect(seen[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(seen[1]!.body).not.toHaveProperty('response_format');
    expect(seen[0]!.body).toMatchObject({ model: 'gpt-4o', stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'json please' }] }] });
  });

  it('call_llm_for_boundary routes through the raw prompt service with other:boundary_detection usage', async () => {
    const { host, usage } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    captureFetch(() => jsonResponse(200, OK_BODY));
    const result = await host.invoke<Record<string, unknown>>('call_llm_for_boundary', { prompt: 'find boundary' });
    expect(result).toEqual({ assistant_message: '摘要结果', input_tokens: 0, output_tokens: 0 });
    expect(usage[0]).toMatchObject({ callerType: { other: 'boundary_detection' }, success: true });
  });
});

describe('llmRawPrompt.callRawPromptWithConfigIdAndImages (model2_pipeline.rs:8786)', () => {
  const vision = () => rawPromptConfig({ id: 'vision', model: 'vision-model', isMultimodal: true });
  const image = { mime: 'image/png', base64: 'iVBORw0KGgo=' };

  it('validates images and exact config before any request', async () => {
    const { host } = await rawHost([vision(), rawPromptConfig({ id: 'off', model: 'off-model', isMultimodal: true, enabled: false }),
      rawPromptConfig({ id: 'text', model: 'text-model' })], 'text');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    const service = host.ctx.llmRawPrompt;
    await expect(service.callRawPromptWithConfigIdAndImages('vision', 'p', [], 'chat_v2'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '多模态 raw prompt 至少需要一张图片' });
    await expect(service.callRawPromptWithConfigIdAndImages('missing', 'p', [image], 'chat_v2'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '找不到指定的多模态模型配置: missing' });
    await expect(service.callRawPromptWithConfigIdAndImages('off', 'p', [image], 'chat_v2'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '指定的多模态模型已禁用: off' });
    await expect(service.callRawPromptWithConfigIdAndImages('text', 'p', [image], 'chat_v2'))
      .rejects.toMatchObject({ error_type: 'Configuration', message: '指定配置不是可用于视觉理解的多模态语言模型: text' });
    expect(seen).toHaveLength(0);
  });

  it('matches by model name, appends data-URL image parts after the text and never sets response_format', async () => {
    const { host, usage } = await rawHost([vision()], 'vision');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    const out = await host.ctx.llmRawPrompt.callRawPromptWithConfigIdAndImages('vision-model', 'describe', [image], { other: 'handout_vlm' });
    expect(out.assistant_message).toBe('摘要结果');
    expect(seen[0]!.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }]);
    expect(seen[0]!.body).not.toHaveProperty('response_format');
    expect(usage[0]).toMatchObject({ callerType: { other: 'handout_vlm' }, model: 'vision-model', success: true });
  });

  it('cancellable variant: pre-cancelled and in-flight cancellation reject with visual observation cancelled', async () => {
    const { host } = await rawHost([vision()], 'vision');
    const pre = new AbortController();
    pre.abort();
    const seen = captureFetch(() => new Promise<Response>(() => undefined));
    await expect(host.ctx.llmRawPrompt.callRawPromptWithConfigIdAndImagesCancellable('vision', 'p', [image], 'chat_v2', pre.signal))
      .rejects.toMatchObject({ error_type: 'LLM', message: 'visual observation cancelled' });
    expect(seen).toHaveLength(0);
    const live = new AbortController();
    const pending = host.ctx.llmRawPrompt.callRawPromptWithConfigIdAndImagesCancellable('vision', 'p', [image], 'chat_v2', live.signal);
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    live.abort();
    await expect(pending).rejects.toMatchObject({ error_type: 'LLM', message: 'visual observation cancelled' });
    expect(seen[0]!.signal?.aborted).toBe(true);
  });
});

describe('llmRawPrompt agent-scoped exits (model2_pipeline.rs:8692 / :8867)', () => {
  it('callAgentCompactionRawPrompt resolves id then model name, keeps Markdown (no response_format) and records chat_v2', async () => {
    const gpt = rawPromptConfig({ id: 'gpt-main', model: 'gpt-4o', baseUrl: 'https://api.example/v1' });
    const { host, usage } = await rawHost([gpt, rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    const byModel = await host.ctx.llmRawPrompt.callAgentCompactionRawPrompt('gpt-4o', 'summarize', 'sess-1');
    expect(byModel.assistant_message).toBe('摘要结果');
    expect(seen[0]!.body).toMatchObject({ model: 'gpt-4o', stream: false });
    expect(seen[0]!.body).not.toHaveProperty('response_format');
    expect(usage.at(-1)).toMatchObject({ callerType: 'chat_v2', model: 'gpt-4o', success: true });
  });

  it('callAgentCompactionRawPrompt falls back to model2 when the id/model is unknown', async () => {
    const { host } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    await host.ctx.llmRawPrompt.callAgentCompactionRawPrompt('missing-config', 'summarize', 'sess-1');
    expect(seen[0]!.url).toBe('https://flaky.example/v1/chat/completions');
    expect(seen[0]!.body).toMatchObject({ model: 'test-model' });
  });

  it('agent session becomes the OpenCode Go session header', async () => {
    const { host } = await rawHost([rawPromptConfig()], 'cfg_raw_prompt_test');
    const go = rawPromptConfig({ id: 'go', model: 'glm-5', providerType: OPENCODE_GO_PROVIDER_TYPE, baseUrl: 'https://go.example/v1' });
    vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue([go]);
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    await host.ctx.llmRawPrompt.callAgentCompactionRawPrompt('go', 'summarize', 'agent-session-42');
    expect(seen[0]!.headers.get(SESSION_HEADER)).toBe('agent-session-42');
  });

  it('callAgentChatTitleRawPrompt uses the chat title model with JSON mode and thinking disabled', async () => {
    const title = rawPromptConfig({ id: 'title', model: 'gpt-4o-mini', baseUrl: 'https://title.example/v1' });
    const { host, usage } = await rawHost([title, rawPromptConfig()], 'cfg_raw_prompt_test');
    await host.invoke('save_model_assignments', { assignments: { model2_config_id: 'cfg_raw_prompt_test', chat_title_model_config_id: 'title' } });
    const seen = captureFetch(() => jsonResponse(200, OK_BODY));
    await host.ctx.llmRawPrompt.callAgentChatTitleRawPrompt('title please', 'sess-9');
    expect(seen[0]!.url).toBe('https://title.example/v1/chat/completions');
    expect(seen[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(usage.at(-1)).toMatchObject({ callerType: 'chat_v2', model: 'gpt-4o-mini', success: true });
  });
});
