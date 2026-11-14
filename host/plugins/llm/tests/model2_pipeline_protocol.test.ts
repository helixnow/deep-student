import { describe, expect, it } from 'vitest';
import { shouldUseOpenaiResponsesForConfig, isOpenaiCodexOAuth,
  AUTH_MODE_OPENAI_CODEX_OAUTH } from '../src/protocol.ts';
import { providerAdapterForConfig } from '../src/provider_adapter.ts';
import { isOpencodeGoConfig } from '../src/opencode_go.ts';
import { makeConfig } from './support.ts';

describe('llm_manager/model2_pipeline.rs', () => {
  it('test_should_use_openai_responses_for_declared_openai_compatible_responses_support', () => {
    const config = makeConfig({
      modelAdapter: 'general', model: 'gpt-4o-mini',
      supportsOpenaiResponses: true, isReasoning: false, supportsReasoning: false,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(true);
    expect(providerAdapterForConfig(config).requiresExplicitStreamCompletion()).toBe(true);
  });

  it('test_should_not_use_openai_responses_for_non_general_adapter', () => {
    const config = makeConfig({
      modelAdapter: 'qwen', model: 'o4-mini', isReasoning: true, supportsReasoning: true,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(false);
  });

  it('test_explicit_openai_responses_protocol_overrides_legacy_heuristics', () => {
    const config = makeConfig({
      modelAdapter: 'general', apiProtocol: 'openai_responses', model: 'gpt-4o-mini',
      providerType: 'openai', baseUrl: 'https://api.openai.com/v1',
      isReasoning: false, supportsReasoning: false,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(true);
    expect(providerAdapterForConfig(config).requiresExplicitStreamCompletion()).toBe(true);
  });

  it('codex_oauth_transport_requires_explicit_auth_mode', () => {
    const config = makeConfig({
      providerType: 'openai_codex', authMode: AUTH_MODE_OPENAI_CODEX_OAUTH,
      apiProtocol: 'openai_responses', baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.4',
    });
    expect(isOpenaiCodexOAuth(config)).toBe(true);
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(true);
    expect(isOpenaiCodexOAuth({ ...config, authMode: null })).toBe(false);
  });

  it('test_explicit_openai_responses_protocol_is_downgraded_for_third_party_openai_compatible_endpoint', () => {
    const config = makeConfig({
      modelAdapter: 'general', apiProtocol: 'openai_responses', providerType: 'openai',
      baseUrl: 'https://api.qsl.fan/v1', model: 'deepseek-v4-pro',
      isReasoning: true, supportsReasoning: true,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(false);
  });

  it('test_explicit_chat_completions_protocol_blocks_responses_for_reasoning_models', () => {
    const config = makeConfig({
      modelAdapter: 'general', apiProtocol: 'openai_chat_completions', model: 'o4-mini',
      isReasoning: true, supportsReasoning: true,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(false);
  });

  it('test_official_openai_defaults_to_responses_without_explicit_protocol', () => {
    const config = makeConfig({
      modelAdapter: 'general', providerType: 'openai', baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini', isReasoning: false, supportsReasoning: false,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(true);
  });

  it('test_official_deepseek_documented_models_default_to_responses', () => {
    for (const model of [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
      'deepseek-chat',
      'deepseek-reasoner',
    ]) {
      const config = makeConfig({
        modelAdapter: 'deepseek', providerType: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1', model,
        supportsReasoning: true, isReasoning: true,
      });
      expect(shouldUseOpenaiResponsesForConfig(config), `model=${model}`).toBe(true);
      expect(
        providerAdapterForConfig(config).requiresExplicitStreamCompletion(),
        `model=${model}`,
      ).toBe(true);
    }
  });

  it('test_official_deepseek_v3_stays_on_chat_completions_even_with_explicit_responses', () => {
    for (const model of ['deepseek-v3.2', 'deepseek-v3.1']) {
      const config = makeConfig({
        modelAdapter: 'deepseek', providerType: 'deepseek',
        apiProtocol: 'openai_responses', baseUrl: 'https://api.deepseek.com/v1', model,
        supportsReasoning: true, isReasoning: true,
      });
      expect(shouldUseOpenaiResponsesForConfig(config), `model=${model}`).toBe(false);
      const request = providerAdapterForConfig(config).buildRequest(
        config.baseUrl, 'test-key', config.model, { messages: [] },
      );
      expect(request.url, `model=${model}`).toContain('/chat/completions');
    }
  });

  it('test_third_party_deepseek_v4_flash_hosting_keeps_registry_default', () => {
    const config = makeConfig({
      modelAdapter: 'deepseek', providerType: 'siliconflow', providerScope: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4-Flash',
      supportsReasoning: true, isReasoning: true,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(false);
    const explicit = { ...config, apiProtocol: 'openai_responses' };
    expect(shouldUseOpenaiResponsesForConfig(explicit)).toBe(false);
  });

  it('test_third_party_declared_responses_support_defaults_to_responses_without_explicit_protocol', () => {
    const config = makeConfig({
      modelAdapter: 'general', providerType: 'custom',
      baseUrl: 'https://proxy.example.com/v1', supportsOpenaiResponses: true,
      model: 'gpt-4o-mini', isReasoning: false, supportsReasoning: false,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(true);
  });

  it('test_generic_third_party_gpt4_stays_on_chat_completions_without_explicit_protocol', () => {
    const config = makeConfig({
      modelAdapter: 'general', providerType: 'custom',
      baseUrl: 'https://proxy.example.com/v1', model: 'gpt-4o-mini',
      isReasoning: false, supportsReasoning: false,
    });
    expect(shouldUseOpenaiResponsesForConfig(config)).toBe(false);
  });

});
