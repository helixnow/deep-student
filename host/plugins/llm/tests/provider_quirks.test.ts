import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEndpointQuirks, resolveQuirks } from '../src/provider_quirks.ts';
import { makeConfig } from './support.ts';

const snapshotPath = new URL('./fixtures/provider_quirks_phase1.json', import.meta.url);

describe('provider_quirks.rs', () => {
  function config(provider: string, adapter: string, model: string) {
    return makeConfig({
      providerType: provider, providerScope: provider, modelAdapter: adapter, model,
      baseUrl: `https://${provider}.example.com/v1`,
    });
  }

  it('provider_decision_matrix_preserves_phase1_behavior', () => {
    const cases = [
      { name: 'mimo reasoning', config: makeConfig({ ...config('mimo', 'mimo', 'mimo-v2.5-pro'), isReasoning: true }),
        generation: 'max_completion_tokens', legacy: 'max_completion_tokens', sampling: true, strip: false },
      { name: 'mistral reasoning', config: makeConfig({ ...config('mistral', 'mistral', 'magistral-medium-2507'), isReasoning: true }),
        generation: 'max_tokens', legacy: 'max_tokens', sampling: false, strip: false },
      { name: 'qwen reasoning', config: makeConfig({ ...config('qwen', 'qwen', 'qwen3-max'), isReasoning: true }),
        generation: 'max_completion_tokens', legacy: 'max_tokens', sampling: false, strip: true },
      { name: 'official deepseek responses', config: makeConfig({
        ...config('deepseek', 'deepseek', 'deepseek-v4-flash'),
        baseUrl: 'https://api.deepseek.com/v1', supportsTools: true, isReasoning: true,
      }), generation: 'max_completion_tokens', legacy: 'max_tokens', sampling: false, strip: false },
      { name: 'third-party deepseek chat', config: makeConfig({
        ...config('siliconflow', 'deepseek', 'deepseek-ai/deepseek-v4-flash'),
        supportsTools: true, isReasoning: true,
      }), generation: 'max_completion_tokens', legacy: 'max_tokens', sampling: false, strip: false },
    ] as const;

    for (const item of cases) {
      const actual = resolveQuirks(item.config);
      expect(actual.max_tokens_field, item.name).toBe(item.generation);
      expect(actual.legacy_max_tokens_field, item.name).toBe(item.legacy);
      expect(actual.sampling_params_allowed, item.name).toBe(item.sampling);
      expect(actual.strip_tool_choice_on_tool_result, item.name).toBe(item.strip);
    }
  });

  it('runtime_reasoning_patterns_preserve_forced_and_disableable_models', () => {
    for (const model of ['gpt-5', 'openai/gpt-5-mini', 'gpt-5-pro', 'gpt-oss-120b', 'o3']) {
      const cfg = config('custom', 'general', model);
      cfg.apiProtocol = 'openai_responses';
      expect(resolveQuirks(cfg).runtime_reasoning.force_enabled, model).toBe(true);
    }
    const modern = config('custom', 'general', 'gpt-5.5');
    modern.apiProtocol = 'openai_responses';
    expect(resolveQuirks(modern).runtime_reasoning).toEqual({
      force_enabled: false, disabled_effort: 'none',
    });
  });

  it('endpoint_matrix_keeps_mimo_test_payload_detection', () => {
    expect(resolveEndpointQuirks('other-model', 'https://api.xiaomimimo.com/v1').use_mimo_test_payload).toBe(true);
    expect(resolveEndpointQuirks('MiMo-V2.5', 'https://proxy.example/v1').use_mimo_test_payload).toBe(true);
    expect(resolveEndpointQuirks('mistral-small', 'https://api.mistral.ai/v1').use_mimo_test_payload).toBe(false);
  });

  it('provider_quirks_phase1_snapshot', () => {
    const protocols = [
      ['openai_chat_completions/official', 'mistral', 'mistral', 'https://api.mistral.ai/v1', 'mistral-small-latest', 'openai_chat_completions'],
      ['openai_chat_completions/third_party', 'qwen', 'qwen', 'https://proxy.example.com/v1', 'qwen3-max', 'openai_chat_completions'],
      ['openai_responses/official', 'openai', 'general', 'https://api.openai.com/v1', 'gpt-5.5', 'openai_responses'],
      ['openai_responses/third_party', 'custom', 'general', 'https://responses.example.com/v1', 'openai/gpt-5.5', 'openai_responses'],
      ['anthropic_messages/official', 'anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', 'anthropic_messages'],
      ['anthropic_messages/third_party', 'custom', 'anthropic', 'https://anthropic-proxy.example.com/v1', 'claude-sonnet-4-5', 'anthropic_messages'],
      ['google_generate_content/official', 'google', 'gemini', 'https://generativelanguage.googleapis.com', 'gemini-3-flash', 'google_generate_content'],
      ['google_generate_content/third_party', 'custom', 'gemini', 'https://gemini-proxy.example.com', 'gemini-3-flash', 'google_generate_content'],
    ] as const;

    const snapshot: Array<{ case: string; quirks: unknown }> = [];
    for (const [name, provider, adapter, baseUrl, model, protocol] of protocols) {
      for (const reasoning of [false, true]) {
        const cfg = makeConfig({
          providerType: provider, providerScope: provider, modelAdapter: adapter,
          baseUrl, model, apiProtocol: protocol,
          supportsOpenaiResponses: protocol === 'openai_responses' ? true : null,
          isReasoning: reasoning, supportsReasoning: reasoning, supportsTools: true,
        });
        snapshot.push({ case: `${name}/reasoning=${reasoning}`, quirks: resolveQuirks(cfg) });
      }
    }

    const expected = readFileSync(snapshotPath, 'utf8').trimEnd();
    expect(JSON.stringify(snapshot, null, 2)).toBe(expected);
  });
});
