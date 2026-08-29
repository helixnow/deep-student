import { describe, expect, it } from 'vitest';

import {
  getAllowedProtocolsForProviderType,
  getProviderProtocolRecord,
  providerSupportsOpenAiResponses,
  resolvePreferredProtocol,
} from '../providerProtocolRegistry';

describe('providerProtocolRegistry', () => {
  it('marks official OpenAI as responses-first', () => {
    const entry = getProviderProtocolRecord('openai');

    expect(entry?.provider_type).toBe('openai');
    expect(entry?.supports_openai_responses).toBe(true);
    expect(entry?.default_protocol).toBe('openai_responses');
  });

  it('defaults official DeepSeek to Responses since V4-Flash GA (2026-08)', () => {
    // 2026-07-31 V4-Flash 正式版公测：官方 Responses API 已可用（仅 v4-flash 系列），
    // 供应商默认路由切到 responses；模型级门控由 modelConverters 负责。
    expect(getProviderProtocolRecord('deepseek')?.supports_openai_responses).toBe(true);
    expect(getProviderProtocolRecord('deepseek')?.default_protocol).toBe('openai_responses');
    expect(getAllowedProtocolsForProviderType('deepseek')).toContain('openai_responses');
    expect(
      resolvePreferredProtocol({
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        adapter: 'deepseek',
      }),
    ).toBe('openai_responses');
  });

  it('no longer exposes the phantom responses protocol for providers without a responses endpoint', () => {
    for (const provider of ['zhipu', 'moonshot', 'minimax', 'mimo', 'nvidia', 'siliconflow', 'mistral']) {
      expect(getAllowedProtocolsForProviderType(provider)).not.toContain('openai_responses');
    }
  });

  it('keeps responses selectable for aggregator/local runtimes with stateless implementations', () => {
    for (const provider of ['openrouter', 'ollama', 'custom', 'general']) {
      expect(getAllowedProtocolsForProviderType(provider)).toContain('openai_responses');
      expect(getProviderProtocolRecord(provider)?.supports_openai_responses).toBe(false);
    }
  });

  it('keeps Qwen and Doubao on chat completions by default even though responses is now unlocked', () => {
    // 2026-07：百炼与方舟 Responses 端点已 GA 但为模型白名单制，
    // supports_openai_responses=true 仅解锁可选项，默认路由保持 chat completions。
    expect(getProviderProtocolRecord('qwen')?.supports_openai_responses).toBe(true);
    expect(getProviderProtocolRecord('doubao')?.supports_openai_responses).toBe(true);

    expect(
      resolvePreferredProtocol({
        providerType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        adapter: 'qwen',
      }),
    ).toBe('openai_chat_completions');
    expect(
      resolvePreferredProtocol({
        providerType: 'doubao',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        adapter: 'doubao',
      }),
    ).toBe('openai_chat_completions');
  });

  it('registers the 2026 provider additions with current protocol defaults', () => {
    for (const provider of ['grok', 'xai', 'ernie', 'mistral']) {
      const record = getProviderProtocolRecord(provider);
      expect(record, `${provider} should exist in registry`).toBeDefined();
      expect(record?.allowed_protocols).not.toContain('anthropic_messages');
    }
    expect(getProviderProtocolRecord('grok')?.default_protocol).toBe('openai_responses');
    expect(getProviderProtocolRecord('xai')?.default_protocol).toBe('openai_responses');
    expect(getProviderProtocolRecord('ernie')?.default_protocol).toBe('openai_chat_completions');
    expect(getProviderProtocolRecord('mistral')?.default_protocol).toBe('openai_chat_completions');
    expect(getProviderProtocolRecord('grok')?.supports_openai_responses).toBe(true);
    expect(getProviderProtocolRecord('xai')?.supports_openai_responses).toBe(true);
    expect(getProviderProtocolRecord('ernie')?.supports_openai_responses).toBe(true);
    expect(getProviderProtocolRecord('mistral')?.supports_openai_responses).toBe(false);
  });

  it('allows vendor-level explicit opt-in to switch unlocked providers onto responses', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        adapter: 'qwen',
        supportsOpenAIResponses: true,
      }),
    ).toBe('openai_responses');
    expect(
      resolvePreferredProtocol({
        providerType: 'grok',
        baseUrl: 'https://api.x.ai/v1',
        adapter: 'general',
        supportsOpenAIResponses: true,
      }),
    ).toBe('openai_responses');
  });

  it('keeps generic third-party OpenAI-compatible providers on chat completions by default', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        adapter: 'general',
      }),
    ).toBe('openai_chat_completions');
  });

  it('keeps OpenAI-labeled relay base URLs on chat completions unless explicitly supported', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'openai',
        baseUrl: 'https://proxy.example.com/v1',
        adapter: 'general',
      }),
    ).toBe('openai_chat_completions');
  });

  it('only treats exact api.openai.com hosts as official OpenAI', () => {
    expect(
      providerSupportsOpenAiResponses({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).toBe(true);
    // 中转 URL 在 path 中携带官方域名时不得误判为官方端点。
    expect(
      providerSupportsOpenAiResponses({
        providerType: 'openai',
        baseUrl: 'https://myproxy.com/api.openai.com/v1',
      }),
    ).toBe(false);
    expect(
      providerSupportsOpenAiResponses({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com.evil.example/v1',
      }),
    ).toBe(false);
    expect(
      resolvePreferredProtocol({
        providerType: 'openai',
        baseUrl: 'https://myproxy.com/api.openai.com/v1',
        adapter: 'general',
      }),
    ).toBe('openai_chat_completions');
  });

  it('uses responses when a third-party provider explicitly declares support', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        adapter: 'general',
        supportsOpenAIResponses: true,
      }),
    ).toBe('openai_responses');
  });

  it('uses OpenAI-compatible defaults for Claude and Gemini on proxy hosts', () => {
    for (const adapter of ['anthropic', 'google']) {
      expect(
        resolvePreferredProtocol({
          providerType: 'custom',
          baseUrl: 'https://one-api.example.com/v1',
          adapter,
        }),
      ).toBe('openai_chat_completions');
      expect(
        resolvePreferredProtocol({
          providerType: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          adapter,
          supportsOpenAIResponses: true,
        }),
      ).toBe('openai_responses');
    }
  });

  it('exposes only native protocols for Anthropic and Gemini', () => {
    expect(getAllowedProtocolsForProviderType('anthropic')).toEqual(['anthropic_messages']);
    expect(getAllowedProtocolsForProviderType('gemini')).toEqual(['google_generate_content']);
  });

  it('routes official Anthropic/Gemini hosts to native protocols even under a mislabeled providerType', () => {
    // 官方端点只说原生协议：providerType 误配为 custom/openai 时官方 host 覆盖之，
    // 避免 2026.8 官方 Claude/Gemini 被当成 OpenAI 兼容端点后 404/协议错。
    for (const providerType of ['custom', 'openai', 'general']) {
      expect(
        resolvePreferredProtocol({
          providerType,
          baseUrl: 'https://api.anthropic.com',
          adapter: 'general',
        }),
        `${providerType} + official Anthropic host`,
      ).toBe('anthropic_messages');
      expect(
        resolvePreferredProtocol({
          providerType,
          baseUrl: 'https://generativelanguage.googleapis.com',
          adapter: 'general',
        }),
        `${providerType} + official Gemini host`,
      ).toBe('google_generate_content');
    }

    // 带 path、无 scheme、尾斜杠等常见写法同样按 hostname 精确识别。
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://api.anthropic.com/v1/',
        adapter: 'anthropic',
      }),
    ).toBe('anthropic_messages');
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'generativelanguage.googleapis.com/v1beta',
        adapter: 'google',
      }),
    ).toBe('google_generate_content');

    // 官方 providerType + 官方 host 的既有原生路由不变。
    expect(
      resolvePreferredProtocol({
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        adapter: 'anthropic',
      }),
    ).toBe('anthropic_messages');
    expect(
      resolvePreferredProtocol({
        providerType: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        adapter: 'google',
      }),
    ).toBe('google_generate_content');
  });

  it('does not treat relay URLs embedding official Anthropic/Gemini domains as official hosts', () => {
    // path 携带官方域名（中转伪造）不得命中。
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://myproxy.com/api.anthropic.com/v1',
        adapter: 'anthropic',
      }),
    ).toBe('openai_chat_completions');
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://myproxy.com/generativelanguage.googleapis.com/v1beta',
        adapter: 'google',
      }),
    ).toBe('openai_chat_completions');
    // 子域伪造不得命中。
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://api.anthropic.com.evil.example/v1',
        adapter: 'anthropic',
      }),
    ).toBe('openai_chat_completions');
    expect(
      resolvePreferredProtocol({
        providerType: 'custom',
        baseUrl: 'https://generativelanguage.googleapis.com.evil.example/v1beta',
        adapter: 'google',
      }),
    ).toBe('openai_chat_completions');
  });
});
