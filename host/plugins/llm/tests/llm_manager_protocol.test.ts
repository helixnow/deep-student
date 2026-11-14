import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../api.ts';
import {
  getProviderProtocolRecord, providerAllowedProtocols, resolvePreferredProtocolForProvider,
  shouldUseOpenaiResponsesForConfig,
} from '../src/protocol.ts';
import { defaultVendorConfig } from '../src/config_store.ts';
import {
  buildProviderAdapterForConfig, normalizeNonstreamResponseToOpenaiForConfig,
} from '../src/mod_compat.ts';
import { applyReasoningConfig, type JsonObject } from '../src/question_authoring.ts';
import { makeConfig } from './support.ts';

function asRecord(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as { [key: string]: unknown }
    : {};
}

function requestBodyOf(body: unknown): { [key: string]: unknown } {
  return asRecord(body);
}

describe('llm_manager/mod.rs', () => {
  it('vendor_config_default_uses_registry_backed_openai_defaults', () => {
    const vendor = defaultVendorConfig();

    expect(vendor.providerType).toBe('openai');
    expect(vendor.apiProtocol).toBe('openai_responses');
    expect(vendor.supportsOpenaiResponses).toBe(true);
  });

  it('resolve_preferred_protocol_for_provider_uses_registry_defaults_for_native_vendors', () => {
    expect(
      resolvePreferredProtocolForProvider(
        'anthropic',
        'anthropic',
        'https://api.anthropic.com/v1',
        null,
      ),
    ).toBe('anthropic_messages');
    expect(
      resolvePreferredProtocolForProvider(
        'gemini',
        'google',
        'https://generativelanguage.googleapis.com',
        null,
      ),
    ).toBe('google_generate_content');
    expect(
      resolvePreferredProtocolForProvider(
        'siliconflow',
        'general',
        'https://api.siliconflow.cn/v1',
        null,
      ),
    ).toBe('openai_chat_completions');
  });

  it('registry_level_responses_support_only_unlocks_option_without_switching_default', () => {
    // qwen/doubao：注册表 supports_openai_responses=true（白名单制端点），
    // 默认路由必须保持 default_protocol = chat completions。
    for (const [provider, baseUrl] of [
      ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
      ['ernie', 'https://qianfan.baidubce.com/v2'],
    ] as Array<[string, string]>) {
      const record = getProviderProtocolRecord(provider);
      expect(record, `${provider} provider should exist in registry`).not.toBeNull();
      if (record === null) continue;
      expect(record.supports_openai_responses, `${provider} supports flag`).toBe(true);
      expect(
        record.allowed_protocols.includes('openai_responses'),
        `${provider} should keep responses selectable`,
      ).toBe(true);
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', baseUrl, null),
        `${provider} default routing should stay on chat completions`,
      ).toBe('openai_chat_completions');
      // 供应商级显式声明仍可切换到 Responses。
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', baseUrl, true),
        `${provider} explicit opt-in should unlock responses`,
      ).toBe('openai_responses');
    }

    for (const provider of ['grok', 'xai']) {
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', 'https://api.x.ai/v1', null),
        `${provider} should honor its registry Responses default`,
      ).toBe('openai_responses');
    }
  });

  it('responses_routing_accepts_all_model_adapters_when_the_host_declares_support', () => {
    for (const adapter of [
      'qwen',
      'deepseek',
      'doubao',
      'anthropic',
      'claude',
      'google',
      'gemini',
    ]) {
      const explicit = makeConfig({
        providerType: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        modelAdapter: adapter,
        apiProtocol: 'openai_responses',
        supportsOpenaiResponses: true,
      });
      expect(
        shouldUseOpenaiResponsesForConfig(explicit),
        `${adapter} should honor an explicitly supported Responses protocol`,
      ).toBe(true);

      const defaulted = { ...explicit, apiProtocol: null };
      expect(
        shouldUseOpenaiResponsesForConfig(defaulted),
        `${adapter} should use the vendor-declared Responses default`,
      ).toBe(true);
    }

    const officialOpenaiWithCompatibleAdapter = makeConfig({
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelAdapter: 'deepseek',
      apiProtocol: null,
      supportsOpenaiResponses: null,
    });
    expect(shouldUseOpenaiResponsesForConfig(officialOpenaiWithCompatibleAdapter)).toBe(true);
  });

  it('protocol_routing_uses_native_transports_only_when_the_protocol_selects_them', () => {
    const cases: Array<[string, string, string | null, string, string, string]> = [
      [
        'anthropic',
        'anthropic',
        null,
        'https://api.anthropic.com',
        'claude-sonnet-4-6',
        '/v1/messages',
      ],
      [
        'gemini',
        'google',
        null,
        'https://generativelanguage.googleapis.com',
        'gemini-3.1-pro-preview',
        ':streamGenerateContent',
      ],
      [
        'custom',
        'anthropic',
        null,
        'https://one-api.example.com/v1',
        'claude-sonnet-4-6',
        '/chat/completions',
      ],
      [
        'openrouter',
        'google',
        null,
        'https://openrouter.ai/api/v1',
        'google/gemini-3.1-pro-preview',
        '/chat/completions',
      ],
      [
        'custom',
        'anthropic',
        'openai_responses',
        'https://one-api.example.com/v1',
        'anthropic/claude-sonnet-4-6',
        '/responses',
      ],
    ];

    for (const [provider, modelAdapter, apiProtocol, baseUrl, model, expectedUrl] of cases) {
      const config: ApiConfig = makeConfig({
        providerType: provider,
        modelAdapter,
        apiProtocol,
        supportsOpenaiResponses: apiProtocol === null ? null : true,
        baseUrl,
        model,
      });
      const request = buildProviderAdapterForConfig(config).buildRequest(
        config.baseUrl,
        'test-key',
        config.model,
        {
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
        },
      );
      expect(request.url, `provider=${provider}, adapter=${modelAdapter}, url=${request.url}`)
        .toContain(expectedUrl);
    }
  });

  it('explicit_native_protocols_still_select_native_transports_on_custom_hosts', () => {
    const cases: Array<[string, string, string]> = [
      ['anthropic', 'anthropic_messages', '/messages'],
      ['google', 'google_generate_content', ':streamGenerateContent'],
    ];

    for (const [adapter, protocol, expectedUrl] of cases) {
      const config = makeConfig({
        providerType: 'custom',
        modelAdapter: adapter,
        apiProtocol: protocol,
        baseUrl: 'https://proxy.example.com/v1',
        model: adapter === 'anthropic' ? 'claude-sonnet-4-6' : 'gemini-3.1-pro-preview',
      });
      const request = buildProviderAdapterForConfig(config).buildRequest(
        config.baseUrl,
        'test-key',
        config.model,
        {
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
        },
      );
      expect(request.url, `url=${request.url}`).toContain(expectedUrl);
    }
  });

  it('explicit_native_protocols_use_native_reasoning_body_dialects_on_custom_hosts', () => {
    const cases: Array<[string, string, string, string]> = [
      ['anthropic', 'anthropic_messages', 'claude-sonnet-4-6', 'thinking'],
      ['google', 'google_generate_content', 'gemini-3.1-pro-preview', 'thinkingConfig'],
    ];

    for (const [adapter, protocol, model, expectedField] of cases) {
      const config = makeConfig({
        providerType: 'custom',
        providerScope: 'custom',
        modelAdapter: adapter,
        apiProtocol: protocol,
        model,
        supportsReasoning: true,
        thinkingEnabled: true,
        reasoningEffort: 'high',
      });
      const body: JsonObject = { temperature: 0.7 };

      applyReasoningConfig(body, config, null);

      expect(body[expectedField], `body=${JSON.stringify(body)}`).toBeDefined();
      expect(body.enable_thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
    }
  });

  it('proxied_claude_and_gemini_keep_openai_nonstream_responses_unchanged', () => {
    const response = {
      id: 'chatcmpl_proxy',
      choices: [{ message: { role: 'assistant', content: 'complete' } }],
      usage: { completion_tokens: 12 },
    };

    for (const [provider, adapter] of [['custom', 'anthropic'], ['openrouter', 'google']] as const) {
      const config = makeConfig({
        providerType: provider,
        modelAdapter: adapter,
        apiProtocol: 'openai_chat_completions',
        baseUrl: 'https://proxy.example.com/v1',
      });
      expect(normalizeNonstreamResponseToOpenaiForConfig(config, response)).toEqual(response);
    }
  });

  it('proxied_model_families_use_gateway_reasoning_fields', () => {
    const cases: Array<[string, string, string, boolean]> = [
      ['custom', 'anthropic', 'claude-sonnet-4-6', false],
      ['openrouter', 'google', 'google/gemini-3.1-pro-preview', true],
      ['custom', 'qwen', 'qwen3.5-plus', false],
      ['openrouter', 'zhipu', 'z-ai/glm-5', true],
      ['one-api', 'moonshot', 'moonshotai/kimi-k2.5', false],
    ];

    for (const [provider, adapter, model, usesNestedReasoning] of cases) {
      const config = makeConfig({
        providerType: provider,
        providerScope: provider,
        modelAdapter: adapter,
        apiProtocol: 'openai_chat_completions',
        model,
        supportsReasoning: true,
        thinkingEnabled: true,
        reasoningEffort: 'high',
      });
      const body: JsonObject = { temperature: 0.7 };

      applyReasoningConfig(body, config, null);

      if (usesNestedReasoning) {
        expect(asRecord(body.reasoning).effort).toBe('high');
        expect(body.reasoning_effort, `body=${JSON.stringify(body)}`).toBeUndefined();
      } else {
        expect(body.reasoning_effort).toBe('high');
        expect(body.reasoning, `body=${JSON.stringify(body)}`).toBeUndefined();
      }
      expect(body.enable_thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
      expect(body.thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
      expect(body.thinkingConfig, `body=${JSON.stringify(body)}`).toBeUndefined();
      expect(body.output_config, `body=${JSON.stringify(body)}`).toBeUndefined();
    }
  });

  it('proxied_provider_effort_aliases_normalize_to_openai_values', () => {
    const cases: Array<[string, string, string, string]> = [
      ['doubao', 'doubao-seed-1-6-thinking', 'auto', 'medium'],
      ['minimax', 'MiniMax-M3', 'adaptive', 'medium'],
      ['ernie', 'ernie-5.0-thinking', 'max', 'max'],
      ['deepseek', 'deepseek-v4-pro', 'max', 'max'],
      ['zhipu', 'glm-5.2', 'disabled', 'none'],
    ];

    for (const [adapter, model, requested, expected] of cases) {
      const config = makeConfig({
        providerType: 'custom',
        providerScope: 'custom',
        modelAdapter: adapter,
        apiProtocol: 'openai_chat_completions',
        model,
        supportsReasoning: true,
        thinkingEnabled: true,
        reasoningEffort: requested,
      });
      const body: JsonObject = { temperature: 0.7 };

      applyReasoningConfig(body, config, null);

      expect(body.reasoning_effort, `adapter=${adapter}, requested=${requested}, body=${JSON.stringify(body)}`)
        .toBe(expected);
      expect(body.enable_thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
      expect(body.thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
    }
  });

  it('proxied_budget_only_reasoning_maps_to_standard_effort', () => {
    const config = makeConfig({
      providerType: 'sub2api',
      providerScope: 'sub2api',
      modelAdapter: 'qwen',
      apiProtocol: 'openai_chat_completions',
      model: 'qwen3.7-plus',
      supportsReasoning: true,
      thinkingEnabled: true,
      thinkingBudget: 32768,
      includeThoughts: true,
    });
    const body: JsonObject = { temperature: 0.7 };

    applyReasoningConfig(body, config, null);

    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.enable_thinking, `body=${JSON.stringify(body)}`).toBeUndefined();
    expect(body.thinking_budget, `body=${JSON.stringify(body)}`).toBeUndefined();
    expect(body.include_thoughts, `body=${JSON.stringify(body)}`).toBeUndefined();
  });

  it('proxied_toggle_only_reasoning_survives_responses_conversion', () => {
    for (const [thinkingEnabled, expectedEffort] of [[false, 'none'], [true, 'medium']] as const) {
      const config = makeConfig({
        providerType: 'custom',
        providerScope: 'custom',
        modelAdapter: 'anthropic',
        apiProtocol: 'openai_responses',
        supportsOpenaiResponses: true,
        model: 'anthropic/claude-sonnet-4-6',
        supportsReasoning: true,
        thinkingEnabled,
      });
      const body: JsonObject = {
        model: config.model,
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      };

      applyReasoningConfig(body, config, null);
      const request = buildProviderAdapterForConfig(config)
        .buildRequest(config.baseUrl, 'test-key', config.model, body);
      const requestBody = requestBodyOf(request.body);

      expect(asRecord(requestBody.reasoning).effort).toBe(expectedEffort);
      expect(requestBody.enable_thinking).toBeUndefined();
    }
  });

  it('openrouter_reasoning_survives_responses_conversion_without_double_wrapping', () => {
    const config = makeConfig({
      providerType: 'openrouter',
      providerScope: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelAdapter: 'google',
      apiProtocol: 'openai_responses',
      supportsOpenaiResponses: true,
      model: 'google/gemini-3.1-pro-preview',
      supportsReasoning: true,
      thinkingEnabled: true,
      reasoningEffort: 'high',
    });
    const body: JsonObject = {
      model: config.model,
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    };

    applyReasoningConfig(body, config, null);
    expect(asRecord(body.reasoning).effort).toBe('high');
    expect(body.reasoning_effort).toBeUndefined();

    const request = buildProviderAdapterForConfig(config)
      .buildRequest(config.baseUrl, 'test-key', config.model, body);
    const requestBody = requestBodyOf(request.body);
    const reasoning = asRecord(requestBody.reasoning);

    expect(reasoning.effort).toBe('high');
    expect(reasoning.summary).toBe('auto');
    expect(requestBody.reasoning_effort).toBeUndefined();
    expect(reasoning.reasoning).toBeUndefined();
  });

  it('openrouter_chat_request_uses_nested_reasoning_dialect', () => {
    const config = makeConfig({
      providerType: 'openrouter',
      providerScope: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelAdapter: 'anthropic',
      apiProtocol: 'openai_chat_completions',
      model: 'anthropic/claude-sonnet-4.6',
      supportsReasoning: true,
      reasoningEffort: 'high',
    });
    const body: JsonObject = {
      model: config.model,
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    };

    applyReasoningConfig(body, config, null);
    const request = buildProviderAdapterForConfig(config)
      .buildRequest(config.baseUrl, 'test-key', config.model, body);
    const requestBody = requestBodyOf(request.body);

    expect(request.url.endsWith('/chat/completions'), `url=${request.url}`).toBe(true);
    expect(asRecord(requestBody.reasoning).effort).toBe('high');
    expect(requestBody.reasoning_effort).toBeUndefined();
  });

  it('providers_without_responses_endpoint_no_longer_allow_openai_responses', () => {
    for (const provider of [
      'zhipu',
      'moonshot',
      'minimax',
      'mimo',
      'nvidia',
      'siliconflow',
      'mistral',
    ]) {
      const allowed = providerAllowedProtocols(provider);
      expect(
        allowed.includes('openai_responses'),
        `${provider} must not expose the phantom openai_responses protocol`,
      ).toBe(false);
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', '', null),
      ).toBe('openai_chat_completions');
    }
  });
});
