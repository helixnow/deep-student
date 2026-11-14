import { describe, expect, it } from 'vitest';
import {
  getPassbackPolicy, getPolicyName, requiresReasoningPassback, requiresThoughtSignature,
  shouldPassbackPlainAssistantReasoning, shouldPassbackPlainAssistantReasoningForRequest,
  usesReasoningDetailsFormat,
} from '../src/reasoning_policy.ts';
import { makeConfig } from './support.ts';

const make = (provider: string | null, model: string, isReasoning: boolean) => makeConfig({
  id: 'test', name: 'Test', providerType: provider ?? undefined, model, isReasoning,
  enabled: true, modelAdapter: 'openai', maxOutputTokens: 4096, supportsTools: true,
  supportsReasoning: isReasoning,
});

describe('reasoning_policy.rs', () => {
  it('test_deepseek_r1', () => {
    const config = make('deepseek', 'deepseek-r1-0528', true);
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(false);
  });

  it('test_deepseek_reasoner', () => {
    expect(getPassbackPolicy(make('openai', 'deepseek-reasoner', true))).toBe('deep_seek_style');
  });

  it('test_deepseek_v3', () => {
    const config = make('siliconflow', 'deepseek-ai/deepseek-v3.2', true);
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
  });

  it('test_deepseek_v4_official', () => {
    const config = makeConfig({
      id: 'test', name: 'Test', providerType: 'deepseek', model: 'deepseek-v4-pro',
      isReasoning: true, enabled: true, modelAdapter: 'openai', supportsTools: true,
      supportsReasoning: true, baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoning(config)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, true)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, false)).toBe(false);
  });

  it('test_deepseek_v41_flash_official', () => {
    const config = makeConfig({
      id: 'test', name: 'Test', providerType: 'deepseek', model: 'deepseek-flash',
      isReasoning: true, enabled: true, modelAdapter: 'openai', supportsTools: true,
      supportsReasoning: true, baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoning(config)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, true)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, false)).toBe(false);
  });

  it('test_deepseek_v3_no_reasoning', () => {
    expect(getPassbackPolicy(make('siliconflow', 'deepseek-ai/deepseek-v3.2', false))).toBe('no_passback');
  });

  it('test_openrouter_gemini', () => {
    const config = make('openrouter', 'google/gemini-2.5-flash-preview', false);
    expect(getPassbackPolicy(config)).toBe('reasoning_details');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(true);
  });

  it('test_google_direct_gemini', () => {
    expect(getPassbackPolicy(make('google', 'gemini-2.5-flash-preview', false))).toBe('reasoning_details');
  });

  it('test_google_gemini_thought_signatures_cover_25_and_3x', () => {
    expect(requiresThoughtSignature(make('google', 'gemini-2.5-flash', false))).toBe(true);
    expect(requiresThoughtSignature(make('google', 'gemini-3.5-flash', false))).toBe(true);
  });

  it('test_deepseek_alias_tools_request_keeps_plain_reasoning_history', () => {
    const config = makeConfig({
      id: 'test', name: 'Test', providerType: 'deepseek', model: 'deepseek-reasoner',
      isReasoning: true, enabled: true, modelAdapter: 'openai', supportsTools: true,
      supportsReasoning: true, baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(shouldPassbackPlainAssistantReasoning(config)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, true)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, false)).toBe(false);
  });

  it('test_non_deepseek_plain_reasoning_history_still_passes_back_when_required', () => {
    const config = make('moonshot', 'kimi-k2-thinking', true);
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoning(config)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(config, false)).toBe(true);
  });

  it('test_thirdparty_gemini_with_reasoning', () => {
    expect(getPassbackPolicy(make('custom', 'gemini-2.5-flash', true))).toBe('deep_seek_style');
  });

  it('test_thirdparty_gemini_no_reasoning', () => {
    expect(getPassbackPolicy(make('custom', 'gemini-2.5-flash', false))).toBe('no_passback');
  });

  it('test_minimax_m2', () => {
    expect(getPassbackPolicy(make('minimax', 'minimax/m2-reasoning', true))).toBe('reasoning_details');
  });

  it('test_openrouter_o1', () => {
    expect(getPassbackPolicy(make('openrouter', 'openai/o1-preview', false))).toBe('reasoning_details');
  });

  it('test_sonar_reasoning', () => {
    expect(getPassbackPolicy(make('perplexity', 'sonar-reasoning-pro', false))).toBe('deep_seek_style');
  });

  it('test_xai_grok', () => {
    expect(getPassbackPolicy(make('xai', 'grok-3', true))).toBe('deep_seek_style');
  });

  it('test_claude', () => {
    const config = make('anthropic', 'claude-3-opus', false);
    expect(getPassbackPolicy(config)).toBe('no_passback');
    expect(requiresReasoningPassback(config)).toBe(false);
  });

  it('test_generic_reasoning_model', () => {
    expect(getPassbackPolicy(make('siliconflow', 'glm-4-thinking', true))).toBe('deep_seek_style');
  });

  it('test_generic_non_reasoning_model', () => {
    expect(getPassbackPolicy(make('openai', 'gpt-4o', false))).toBe('no_passback');
  });

  it('test_should_passback_reasoning_for_request_routing', () => {
    const legacy = make('deepseek', 'deepseek-r1', true);
    const v4 = makeConfig({
      id: 'test', name: 'Test', providerType: 'deepseek', model: 'deepseek-v4',
      isReasoning: true, enabled: true, modelAdapter: 'openai', supportsTools: true,
      supportsReasoning: true, baseUrl: 'https://api.deepseek.com/v1',
    });
    const thirdPartyV4 = make('siliconflow', 'deepseek-ai/DeepSeek-V4-Pro', true);
    const normal = make('openai', 'gpt-4o', false);

    expect(shouldPassbackPlainAssistantReasoningForRequest(legacy, false)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(thirdPartyV4, false)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(v4, false)).toBe(false);
    expect(shouldPassbackPlainAssistantReasoningForRequest(v4, true)).toBe(true);
    expect(shouldPassbackPlainAssistantReasoningForRequest(normal, true)).toBe(false);
  });

  it('test_policy_name', () => {
    expect(getPolicyName('deep_seek_style')).toBe('DeepSeek Style (reasoning_content)');
    expect(getPolicyName('reasoning_details')).toBe('Reasoning Details (reasoning_details array)');
    expect(getPolicyName('no_passback')).toBe('No Passback');
  });

  it('test_openrouter_kimi_k2_thinking', () => {
    const config = make('openrouter', 'moonshotai/kimi-k2-thinking', true);
    expect(getPassbackPolicy(config)).toBe('reasoning_details');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(true);
  });

  it('test_openrouter_kimi_k2_instruct', () => {
    expect(getPassbackPolicy(make('openrouter', 'moonshotai/kimi-k2', false))).toBe('no_passback');
  });

  it('test_moonshot_kimi_k2_thinking', () => {
    const config = make('moonshot', 'kimi-k2-thinking', true);
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(false);
  });

  it('test_thirdparty_kimi_k2_thinking', () => {
    expect(getPassbackPolicy(make('siliconflow', 'kimi-k2-thinking', true))).toBe('deep_seek_style');
  });

  it('test_moonshot_kimi_k25', () => {
    const config = make('moonshot', 'kimi-k2.5', true);
    expect(getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(false);
  });

  it('test_thirdparty_kimi_k25', () => {
    expect(getPassbackPolicy(make('siliconflow', 'kimi-k2.5', true))).toBe('deep_seek_style');
  });

  it('test_thirdparty_kimi_k2_5_alt_format', () => {
    expect(getPassbackPolicy(make('siliconflow', 'kimi-k2-5', true))).toBe('deep_seek_style');
  });

  it('test_openrouter_kimi_k25', () => {
    expect(getPassbackPolicy(make('openrouter', 'moonshotai/kimi-k2.5', true))).toBe('deep_seek_style');
  });

  it('test_openrouter_gpt5', () => {
    const config = make('openrouter', 'openai/gpt-5.2', false);
    expect(getPassbackPolicy(config)).toBe('reasoning_details');
    expect(requiresReasoningPassback(config)).toBe(true);
    expect(usesReasoningDetailsFormat(config)).toBe(true);
  });

  it('test_openrouter_gpt5_pro', () => {
    expect(getPassbackPolicy(make('openrouter', 'openai/gpt-5.2-pro', false))).toBe('reasoning_details');
  });

  it('test_openrouter_gpt5_instant', () => {
    expect(getPassbackPolicy(make('openrouter', 'openai/gpt-5.2-chat-latest', false))).toBe('reasoning_details');
  });

  it('test_openai_native_gpt5', () => {
    expect(getPassbackPolicy(make('openai', 'gpt-5.2', false))).toBe('no_passback');
  });
});
