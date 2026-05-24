import { describe, expect, it } from 'vitest';

import {
  getAllowedProtocolsForProviderType,
  getProviderProtocolRecord,
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

  it('keeps Qwen on chat completions by default until a stronger capability signal exists', () => {
    expect(
      resolvePreferredProtocol({
        providerType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        adapter: 'qwen',
      }),
    ).toBe('openai_chat_completions');
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
