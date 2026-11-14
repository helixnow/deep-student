import { describe, expect, it } from 'vitest';
import {
  applyGenerationParams, applyLegacyGenerationTokenLimit, buildTestChatRequestBody,
  effectiveMaxTokens,
} from '../src/generation.ts';
import { resolveQuirks } from '../src/provider_quirks.ts';
import { getAdapter } from '../src/adapters/registry.ts';
import { applyRuntimeReasoningOverrides } from '../src/runtime_reasoning.ts';
import { extractUsageTokens } from '../src/usage.ts';
import {
  attachReasoningPassbackPayload, ensureOfficialDeepseekV4ReasoningPassback,
} from '../src/passback.ts';
import {
  attachResponseReasoningReplayItem, attachWebSearchReplayItems, numberedWebSearchSources,
} from '../src/replay.ts';
import { makeConfig, type Body } from './support.ts';

describe('llm_manager/model2_pipeline.rs', () => {
  it('numbered_web_search_sources_aligns_with_retrieval_block_schema', () => {
    const payload = {
      id: 'ws_1',
      stage: 'completed',
      sources: [
        { title: 'Alpha', url: 'https://a.example.com', snippet: 'snippet A' },
        { title: 'Beta', url: 'https://b.example.com' },
      ],
    };
    const numbered = numberedWebSearchSources(payload);
    expect(numbered[0]).toMatchObject({
      index: 1,
      citationTag: '[搜索-1]',
      typeIndex: 1,
      source_type: 'web_search',
      url: 'https://a.example.com',
      snippet: 'snippet A',
    });
    expect(numbered[1]).toMatchObject({
      index: 2,
      citationTag: '[搜索-2]',
      snippet: null,
    });
  });

  it('attach_web_search_replay_items_filters_and_attaches', () => {
    const metadata = {
      openai_responses_web_search_items: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          search_results: [{ url: 'https://a.example.com', title: 'A' }],
        },
        { type: 'message', id: 'not_a_search' },
      ],
    };
    const assistant: Body = { role: 'assistant', content: 'answer' };
    attachWebSearchReplayItems(metadata, assistant);
    const items = assistant.response_web_search_items as Body[];
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe('ws_1');
    expect(items[0]!.type).toBe('web_search_call');

    const untouched: Body = { role: 'assistant', content: 'answer' };
    attachWebSearchReplayItems(null, untouched);
    expect(untouched.response_web_search_items).toBeUndefined();
    attachWebSearchReplayItems({}, untouched);
    expect(untouched.response_web_search_items).toBeUndefined();
  });

  it('attach_response_reasoning_replay_item_attaches_reasoning_only', () => {
    const metadata = {
      openai_responses_reasoning_item: {
        type: 'reasoning',
        id: 'rs_final',
        encrypted_content: 'enc-final',
      },
    };
    const assistant: Body = { role: 'assistant', content: 'answer' };
    attachResponseReasoningReplayItem(metadata, assistant);
    expect((assistant.response_reasoning_item as Body).id).toBe('rs_final');

    const bogus = {
      openai_responses_reasoning_item: { type: 'message', id: 'not_reasoning' },
    };
    const untouched: Body = { role: 'assistant', content: 'answer' };
    attachResponseReasoningReplayItem(bogus, untouched);
    expect(untouched.response_reasoning_item).toBeUndefined();

    attachResponseReasoningReplayItem(null, untouched);
    expect(untouched.response_reasoning_item).toBeUndefined();
    attachResponseReasoningReplayItem({}, untouched);
    expect(untouched.response_reasoning_item).toBeUndefined();
  });

  it('mimo_reasoning_generation_params_use_completion_tokens_and_sampling', () => {
    const config = makeConfig({
      model: 'mimo-v2.5-pro', providerType: 'mimo', providerScope: 'mimo',
      modelAdapter: 'mimo', isReasoning: true, supportsReasoning: true,
      maxOutputTokens: 131_072, temperature: 1.0, topPOverride: 0.95,
    });
    const body: Body = { model: config.model, messages: [], stream: true };
    applyGenerationParams(body, config, resolveQuirks(config));
    expect(body.max_completion_tokens).toBe(131_072);
    expect(Object.prototype.hasOwnProperty.call(body, 'max_tokens')).toBe(false);
    expect(body.temperature).toBe(1.0);
    expect(body.top_p as number).toBeCloseTo(0.95, 6);
  });

  it('non_mimo_reasoning_generation_params_preserve_adapter_max_tokens', () => {
    const config = makeConfig({
      model: 'kimi-k2-thinking', providerType: 'moonshot', providerScope: 'moonshot',
      modelAdapter: 'moonshot', isReasoning: true, maxOutputTokens: 4096,
    });
    const body: Body = { model: config.model, messages: [], max_tokens: 32_000 };
    applyGenerationParams(body, config, resolveQuirks(config));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBe(32_000);
  });

  it('official_deepseek_v4_max_effort_preserves_explicit_output_budget', () => {
    const config = makeConfig({
      model: 'deepseek-v4-pro', providerType: 'deepseek', providerScope: 'deepseek',
      modelAdapter: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
      supportsReasoning: true, isReasoning: true, thinkingEnabled: true,
      reasoningEffort: 'max', maxOutputTokens: 32_768,
    });
    const body: Body = { model: config.model, messages: [], stream: true };
    getAdapter('deepseek', 'deepseek', 'deepseek').applyReasoningConfig(body, config, true);
    applyGenerationParams(body, config, resolveQuirks(config));
    expect(body.reasoning_effort).toBe('max');
    expect(body.max_tokens).toBe(32_768);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('official_deepseek_v4_sampling_writes_f32_fields_as_json_f32 (deepseek.rs:324-326, apply_official_sampling as_f64)', () => {
    const official = (thinkingEnabled: boolean) => makeConfig({
      model: 'deepseek-v4-pro', providerType: 'deepseek', providerScope: 'deepseek',
      modelAdapter: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', supportsReasoning: true,
      isReasoning: thinkingEnabled, thinkingEnabled, temperature: Math.fround(0.3), topPOverride: Math.fround(0.97),
    });
    const thinking = official(true);
    const withThinking: Body = { model: thinking.model, messages: [], stream: true };
    getAdapter('deepseek', 'deepseek', 'deepseek').applyReasoningConfig(withThinking, thinking, true);
    applyGenerationParams(withThinking, thinking, resolveQuirks(thinking));
    expect(withThinking.temperature).toBeUndefined();
    expect(withThinking.top_p).toBe(0.97);
    const plain = official(false);
    const withoutThinking: Body = { model: plain.model, messages: [], stream: true };
    getAdapter('deepseek', 'deepseek', 'deepseek').applyReasoningConfig(withoutThinking, plain, false);
    applyGenerationParams(withoutThinking, plain, resolveQuirks(plain));
    expect(withoutThinking.temperature).toBe(0.3);
    expect(withoutThinking.top_p).toBeUndefined();
  });

  it('legacy_max_token_paths_switch_to_completion_tokens_for_mimo_only', () => {
    const config = makeConfig({
      model: 'mimo-v2.5', providerType: 'mimo', providerScope: 'mimo', modelAdapter: 'mimo',
    });
    const body: Body = { model: config.model, messages: [], max_tokens: 8000 };
    applyLegacyGenerationTokenLimit(body, resolveQuirks(config), 4096);
    expect(body.max_completion_tokens).toBe(4096);
    expect(Object.prototype.hasOwnProperty.call(body, 'max_tokens')).toBe(false);
  });

  it('ocr_legacy_payload_uses_configured_output_budget_without_task_caps', () => {
    const config = makeConfig({ maxOutputTokens: 40_000, maxTokensLimit: null });
    const quirks = resolveQuirks(config);
    const body: Body = { model: config.model, messages: [], temperature: 0.0 };
    applyLegacyGenerationTokenLimit(
      body, quirks, effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit),
    );
    expect(body.max_tokens).toBe(40_000);

    const small = makeConfig({ maxOutputTokens: 1_024, maxTokensLimit: null });
    const smallBody: Body = { model: small.model, messages: [], temperature: 0.0 };
    applyLegacyGenerationTokenLimit(
      smallBody, resolveQuirks(small),
      effectiveMaxTokens(small.maxOutputTokens, small.maxTokensLimit),
    );
    expect(smallBody.max_tokens).toBe(1_024);
  });

  it('mimo_connection_test_body_uses_chat_completions_token_field', () => {
    const body = buildTestChatRequestBody('mimo-v2.5-pro', 'https://api.xiaomimimo.com/v1');
    expect(body.max_completion_tokens).toBe(32);
    expect(Object.prototype.hasOwnProperty.call(body, 'max_tokens')).toBe(false);
    expect((body.thinking as Body).type).toBe('disabled');
  });

  it('test_runtime_reasoning_overrides_replace_saved_profile_depth', () => {
    const config = makeConfig({ reasoningEffort: 'high', thinkingBudget: 8192 });
    applyRuntimeReasoningOverrides(config, true, 'max', 32_768);
    expect(config.reasoningEffort).toBe('max');
    expect(config.thinkingBudget).toBe(32_768);
    expect(config.enableThinking).toBe(true);
  });

  it('test_runtime_reasoning_disable_clears_saved_and_stale_depth', () => {
    const config = makeConfig({ reasoningEffort: 'high', thinkingBudget: 8192 });
    applyRuntimeReasoningOverrides(config, false, 'max', 32_768);
    expect(config.enableThinking).toBe(false);
    expect(config.reasoningEffort).toBeNull();
    expect(config.thinkingBudget).toBeNull();
  });

  it('test_runtime_reasoning_disable_uses_none_for_openai_protocols', () => {
    for (const [providerType, apiProtocol] of [
      ['custom', 'openai_chat_completions'],
      ['azure', 'openai_responses'],
    ] as const) {
      const config = makeConfig({
        providerType, apiProtocol, modelAdapter: 'general', model: 'gpt-5.5',
        supportsReasoning: true, isReasoning: true,
        reasoningEffort: 'high', thinkingBudget: 8192,
      });
      applyRuntimeReasoningOverrides(config, false, null, null);
      expect(config.enableThinking).toBe(false);
      expect(config.reasoningEffort).toBe('none');
      expect(config.thinkingBudget).toBeNull();

      const body: Body = { temperature: 0.7, top_p: 0.9 };
      getAdapter(null, null, 'general').applyReasoningConfig(body, config, false);
      expect(body.reasoning_effort).toBe('none');
      expect(body.enable_thinking).toBeUndefined();
    }
  });

  it('test_runtime_reasoning_disable_is_ignored_for_forced_openai_models', () => {
    for (const [providerType, model] of [
      ['openai_codex', 'gpt-5.5'],
      ['openai', 'gpt-5-pro'],
      ['custom', 'gpt-5'],
      ['custom', 'gpt-oss-120b'],
    ] as const) {
      const config = makeConfig({
        providerType, apiProtocol: 'openai_responses', model,
        reasoningEffort: 'high', thinkingBudget: 8192,
      });
      applyRuntimeReasoningOverrides(config, false, null, null);
      expect(config.enableThinking, `model=${model}`).toBe(true);
      expect(config.reasoningEffort, `model=${model}`).toBe('high');
      expect(config.thinkingBudget, `model=${model}`).toBe(8192);
    }
  });

  it('test_runtime_reasoning_disable_is_not_forced_by_non_openai_pro_suffix', () => {
    for (const [providerType, apiProtocol, model] of [
      ['deepseek', null, 'deepseek-v4-pro'],
      ['mimo', 'openai_chat_completions', 'mimo-v2.5-pro'],
    ] as const) {
      const config = makeConfig({
        providerType, apiProtocol: apiProtocol ?? undefined,
        model, reasoningEffort: 'high', thinkingBudget: 8192,
      });
      applyRuntimeReasoningOverrides(config, false, null, null);
      expect(config.enableThinking, `model=${model}`).toBe(false);
      expect(config.reasoningEffort, `model=${model}`).toBeNull();
      expect(config.thinkingBudget, `model=${model}`).toBeNull();
    }
  });

  it('test_deepseek_tool_passback_preserves_empty_reasoning_content', () => {
    const config = makeConfig({
      providerType: 'deepseek', modelAdapter: 'deepseek', model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1', supportsReasoning: true, isReasoning: true,
    });
    const assistant: Body = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_empty_reasoning',
        type: 'function',
        function: { name: 'builtin_test', arguments: '{}' },
      }],
    };
    attachReasoningPassbackPayload(assistant, resolveQuirks(config).reasoning_passback, '');
    expect(assistant.reasoning_content).toBe('');
  });

  it('test_official_v4_passback_self_check_heals_missing_reasoning_on_tool_calls', () => {
    const config = makeConfig({
      providerType: 'deepseek', modelAdapter: 'deepseek', model: 'deepseek-v4.1-flash',
      baseUrl: 'https://api.deepseek.com/v1', supportsReasoning: true, isReasoning: true,
    });
    const body: Body = {
      model: 'deepseek-v4.1-flash',
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u1' },
        {
          role: 'assistant', content: '', reasoning_content: 'thought',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
        { role: 'user', content: 'continue' },
      ],
    };
    ensureOfficialDeepseekV4ReasoningPassback(body, config);
    const messages = body.messages as Body[];
    expect(messages[2]!.reasoning_content).toBe('thought');
    expect(messages[4]!.reasoning_content).toBe('');
    expect(messages[6]!.reasoning_content).toBeUndefined();
  });

  it('test_official_v4_passback_self_check_noop_cases', () => {
    const official = makeConfig({
      providerType: 'deepseek', modelAdapter: 'deepseek', model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1', supportsReasoning: true, isReasoning: true,
    });
    const toolCallAssistant = {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
    };
    const makeBody = (thinking: unknown, tools: unknown): Body => ({
      thinking, tools, messages: [structuredClone(toolCallAssistant)],
    });

    const disabled = makeBody({ type: 'disabled' }, [{}]);
    ensureOfficialDeepseekV4ReasoningPassback(disabled, official);
    expect((disabled.messages as Body[])[0]!.reasoning_content).toBeUndefined();

    const noTools = makeBody({ type: 'enabled' }, []);
    ensureOfficialDeepseekV4ReasoningPassback(noTools, official);
    expect((noTools.messages as Body[])[0]!.reasoning_content).toBeUndefined();

    const relayConfig = { ...official, baseUrl: 'https://relay.example.com/v1' };
    const relay = makeBody({ type: 'enabled' }, [{}]);
    ensureOfficialDeepseekV4ReasoningPassback(relay, relayConfig);
    expect((relay.messages as Body[])[0]!.reasoning_content).toBeUndefined();
  });

  it('extract_usage_tokens_preserves_measured_zero_cache_values', () => {
    const measuredZero = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const measured = extractUsageTokens(measuredZero, 99, 99);
    expect(measured.cachedTokens).toBe(0);
    expect(measured.cacheWriteTokens).toBe(0);

    const unmeasured = extractUsageTokens({ input_tokens: 10, output_tokens: 5 }, 99, 99);
    expect(unmeasured.cachedTokens).toBeNull();
    expect(unmeasured.cacheWriteTokens).toBeNull();
  });

  it('extract_usage_tokens_supports_openai_gemini_and_reasoning_shapes', () => {
    const openai = extractUsageTokens({
      prompt_tokens: 12, completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    }, 0, 0);
    expect(openai).toEqual({
      promptTokens: 12, completionTokens: 7, reasoningTokens: 2,
      cachedTokens: 3, cacheWriteTokens: null,
    });

    const gemini = extractUsageTokens({
      promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 1,
      totalTokenCount: 13,
    }, 0, 0);
    expect(gemini.promptTokens).toBe(8);
    expect(gemini.completionTokens).toBe(4);
    expect(gemini.reasoningTokens).toBe(1);

    const derived = extractUsageTokens({ total_tokens: 20, completion_tokens: 6 }, 0, 0);
    expect(derived.promptTokens).toBe(14);
  });
});
