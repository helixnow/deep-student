import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION, appendProviderHeaderIfAbsent, mergeConfiguredProviderHeaders,
  preparePlainProviderRequest, preparedFromProvider,
} from '../src/prepared_request.ts';
import { providerAdapterForConfig } from '../src/provider_adapter.ts';
import {
  OPENAI_BASE_URL, PROVIDER_TYPE, TASK_SESSION_ID, VENDOR_ID, userAgent,
} from '../src/opencode_go.ts';
import { makeConfig } from './support.ts';
import type { ApiConfig } from '../api.ts';

function opencodeGoTestConfig(protocol: string, baseUrl: string): ApiConfig {
  return makeConfig({
    id: 'builtin-opencode-go-test',
    vendorId: VENDOR_ID,
    providerType: PROVIDER_TYPE,
    apiProtocol: protocol,
    supportsOpenaiResponses: true,
    apiKey: 'go-key',
    baseUrl,
    model: 'deepseek-v4.1-flash',
    modelAdapter: 'general',
    headers: { 'User-Agent': 'Mozilla/5.0 spoofed' },
  });
}

function snapshotConfigs(): Array<[string, ApiConfig]> {
  const protocols: Array<[string, string, string, string, string, string]> = [
    ['openai_chat_completions/official', 'mistral', 'mistral', 'https://api.mistral.ai/v1', 'mistral-small-latest', 'openai_chat_completions'],
    ['openai_chat_completions/third_party', 'qwen', 'qwen', 'https://proxy.example.com/v1', 'qwen3-max', 'openai_chat_completions'],
    ['openai_responses/official', 'openai', 'general', 'https://api.openai.com/v1', 'gpt-5.5', 'openai_responses'],
    ['openai_responses/third_party', 'custom', 'general', 'https://responses.example.com/v1', 'openai/gpt-5.5', 'openai_responses'],
    ['anthropic_messages/official', 'anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', 'anthropic_messages'],
    ['anthropic_messages/third_party', 'custom', 'anthropic', 'https://anthropic-proxy.example.com/v1', 'claude-sonnet-4-5', 'anthropic_messages'],
    ['google_generate_content/official', 'google', 'gemini', 'https://generativelanguage.googleapis.com', 'gemini-3-flash', 'google_generate_content'],
    ['google_generate_content/third_party', 'custom', 'gemini', 'https://gemini-proxy.example.com', 'gemini-3-flash', 'google_generate_content'],
  ];
  const result: Array<[string, ApiConfig]> = [];
  for (const [name, provider, adapter, baseUrl, model, protocol] of protocols) {
    for (const reasoning of [false, true]) {
      result.push([
        `${name}/reasoning=${reasoning}`,
        makeConfig({
          providerType: provider,
          providerScope: provider,
          modelAdapter: adapter,
          baseUrl,
          model,
          apiProtocol: protocol,
          supportsOpenaiResponses: protocol === 'openai_responses' ? true : null,
          apiKey: 'snapshot-key',
          isReasoning: reasoning,
          supportsReasoning: reasoning,
          supportsTools: true,
          headers: { 'X-Snapshot-Route': 'phase-1' },
        }),
      ]);
    }
  }
  return result;
}

describe('llm_manager/model2_pipeline.rs', () => {
  it('prepared_provider_request_phase1_snapshot', () => {
    const requestBody = {
      model: 'snapshot-placeholder',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 32,
      stream: false,
    };
    const snapshot = snapshotConfigs().map(([name, config]) => {
      const prepared = preparePlainProviderRequest(
        providerAdapterForConfig(config), config, requestBody, null, null, 'phase-1 snapshot',
      );
      const headers = [...new Set(prepared.headers.map(([header]) => header.toLowerCase()))].sort();
      const body = prepared.body as { [key: string]: unknown };
      const bodyKeys = Object.keys(body).sort();
      return {
        case: name,
        url: prepared.url.replace('snapshot-key', '<api-key>'),
        header_keys: headers,
        body_keys: bodyKeys,
      };
    });
    const fixtureUrl = new URL('./fixtures/provider_requests_phase1.json', import.meta.url);
    const expected = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')) as unknown;
    expect(snapshot).toEqual(expected);
  });

  it('opencode_go_is_allowed_outside_agent_conversations', () => {
    const config = opencodeGoTestConfig('openai_chat_completions', OPENAI_BASE_URL);
    const adapter = providerAdapterForConfig(config);
    const prepared = preparePlainProviderRequest(
      adapter, config, { model: config.model, messages: [] }, null, 'translation', 'test',
    );
    expect(prepared.opencodeGo).toBe(true);
    expect(prepared.headers
      .filter(([name]) => name.toLowerCase() === 'x-opencode-session')
      .map(([, value]) => value)).toEqual(['translation']);

    const fallback = preparePlainProviderRequest(
      adapter, config, { model: config.model, messages: [] }, null, '   ', 'test',
    );
    expect(fallback.headers
      .filter(([name]) => name.toLowerCase() === 'x-opencode-session')
      .map(([, value]) => value)).toEqual([TASK_SESSION_ID]);
  });

  it('opencode_go_agent_request_carries_own_identity_and_session', () => {
    const config = opencodeGoTestConfig('openai_chat_completions', OPENAI_BASE_URL);
    const adapter = providerAdapterForConfig(config);
    const prepared = preparePlainProviderRequest(
      adapter, config, { model: config.model, messages: [] },
      null, 'sess_abc', 'test', 'sess_abc',
    );
    expect(prepared.opencodeGo).toBe(true);
    expect(prepared.url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    const values = (name: string): string[] => prepared.headers
      .filter(([candidate]) => candidate.toLowerCase() === name.toLowerCase())
      .map(([, value]) => value);
    expect(values('user-agent')).toEqual([userAgent(APP_VERSION)]);
    expect(values('x-opencode-session')).toEqual(['sess_abc']);
  });

  it('non_go_requests_are_unaffected_by_agent_scope', () => {
    const config = makeConfig({
      ...opencodeGoTestConfig('openai_chat_completions', 'https://api.deepseek.com/v1'),
      vendorId: 'builtin-deepseek',
      providerType: 'deepseek',
      headers: null,
    });
    const prepared = preparePlainProviderRequest(
      providerAdapterForConfig(config), config, { model: config.model, messages: [] },
      null, null, 'test', 'sess_abc',
    );
    expect(prepared.opencodeGo).toBe(false);
    expect(prepared.headers.some(([name]) => name.toLowerCase() === 'x-opencode-session')).toBe(false);
  });

  it('configured_headers_reach_prepared_request_without_overriding_transport_headers', () => {
    const prepared = preparedFromProvider({
      url: 'https://proxy.example.com/v1/responses',
      headers: [
        ['Authorization', 'Bearer adapter-key'],
        ['Content-Type', 'application/json'],
      ],
      body: {},
    });
    mergeConfiguredProviderHeaders(prepared, {
      'X-Proxy-Group': 'codex-pool',
      authorization: 'Bearer wrong',
      'CONTENT-TYPE': 'text/plain',
      'bad header': 'ignored',
    });
    const header = (name: string): string | undefined => prepared.headers
      .find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
    expect(header('x-proxy-group')).toBe('codex-pool');
    expect(header('authorization')).toBe('Bearer adapter-key');
    expect(header('content-type')).toBe('application/json');
    expect(header('bad header')).toBeUndefined();
    expect(() => appendProviderHeaderIfAbsent(prepared.headers, 'bad header', 'x')).not.toThrow();
  });
});
