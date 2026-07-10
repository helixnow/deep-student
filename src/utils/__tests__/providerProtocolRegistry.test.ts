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

  it('keeps DeepSeek on chat completions by default', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        adapter: 'deepseek',
      }),
    ).toBe('openai_chat_completions');
  });

  it('no longer exposes the phantom responses protocol for providers without a responses endpoint', () => {
    for (const provider of ['deepseek', 'zhipu', 'moonshot', 'minimax', 'mimo', 'nvidia', 'siliconflow', 'mistral']) {
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

  it('registers the 2026 provider additions with chat-completions defaults', () => {
    for (const provider of ['grok', 'xai', 'ernie', 'mistral']) {
      const record = getProviderProtocolRecord(provider);
      expect(record, `${provider} should exist in registry`).toBeDefined();
      expect(record?.default_protocol).toBe('openai_chat_completions');
      expect(record?.allowed_protocols).not.toContain('anthropic_messages');
    }
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

  it('exposes only native protocols for Anthropic and Gemini', () => {
    expect(getAllowedProtocolsForProviderType('anthropic')).toEqual(['anthropic_messages']);
    expect(getAllowedProtocolsForProviderType('gemini')).toEqual(['google_generate_content']);
  });
});
