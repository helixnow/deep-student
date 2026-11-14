import { describe, expect, it } from 'vitest';
import { makeConfig } from './support.ts';
import {
  canReplayReasoningState, computeReasoningStateScope, deduplicateReasoningChunks,
  pickCanonicalReasoningText, sanitizeHistoryReasoningForTarget,
} from '../src/reasoning_state_scope.ts';
import {
  normalizeProviderUsageWithCache, providerAcceptsPromptCacheKey, resolveToolChoicePreservingCache,
  scopedPromptCacheKey, stablePromptCacheKey,
} from '../src/prompt_cache.ts';
import {
  findReasoningLevelProfile, mapReasoningLevelForConfig, mapSiliconFlowReasoningOverride,
  resolveAlwaysThinkingFallback,
} from '../src/reasoning_level_map.ts';

const target = makeConfig({ providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiProtocol: 'openai_chat_completions' });

describe('reasoning state scope', () => {
  it('binds the provider, normalized endpoint, model and effective protocol without leaking secrets', () => {
    const config = { ...target, supportsOpenaiResponses: true, baseUrl: ' https://user:secret@PRIVATE.example:443/v1/ ' };
    const scope = computeReasoningStateScope(config);
    expect(JSON.parse(scope)).toHaveLength(4);
    expect(scope).not.toMatch(/PRIVATE|private|secret|user/);
    expect(canReplayReasoningState(scope, { ...config, baseUrl: 'https://private.example/v1', model: ' GPT-5 ' })).toBe(true);
    const withNewSecret = { ...config, apiKey: 'new-key' };
    expect(canReplayReasoningState(scope, withNewSecret)).toBe(true);
    for (const change of [{ model: 'gpt-5.1' }, { providerType: 'custom' }, { baseUrl: 'https://other.example/v1' },
      { apiProtocol: 'openai_responses' }]) {
      expect(canReplayReasoningState(scope, { ...config, ...change })).toBe(false);
    }
    expect(canReplayReasoningState(undefined, config)).toBe(false);
    expect(computeReasoningStateScope({ ...target, providerType: null, providerScope: ' OPENAI ' }))
      .toBe(computeReasoningStateScope(target));
    expect(computeReasoningStateScope({ ...target, apiProtocol: null }))
      .toBe(computeReasoningStateScope({ ...target, apiProtocol: 'openai_responses' }));
  });

  it('preserves exact native state only for an identical scope', () => {
    const message = {
      role: 'assistant', stateScope: computeReasoningStateScope(target), content: 'answer', reasoning_content: 'visible',
      providerState: { items: [{ type: 'thinking', thinking: 'visible', signature: 'anthropic' },
        { type: 'redacted_thinking', data: 'redacted' }, { type: 'reasoning', encrypted_content: 'responses' }] },
      thought_signature: 'gemini', extra_content: { google: { thought_signature: 'nested' } },
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'openrouter' }],
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{"signature":"user-data"}' }, extra_content: { thought_signature: 'tool-secret' } }],
    };
    expect(sanitizeHistoryReasoningForTarget([message], target)[0]).toBe(message);
    for (const config of [{ ...target, model: 'gpt-5.1' }, { ...target, baseUrl: 'https://relay.example/v1' },
      { ...target, apiProtocol: 'openai_responses' }]) {
      const [clean] = sanitizeHistoryReasoningForTarget([message], config);
      expect(clean).toBeDefined();
      expect(clean).toMatchObject({ role: 'assistant', content: 'answer', reasoning_content: 'visible',
        tool_calls: [{ id: 'call', function: { arguments: '{"signature":"user-data"}' } }] });
      expect(clean).not.toHaveProperty('providerState');
      expect(clean).not.toHaveProperty('reasoning_details');
      expect(clean).not.toHaveProperty('thought_signature');
      expect(clean).not.toHaveProperty('extra_content');
      expect(clean!.tool_calls[0]).not.toHaveProperty('extra_content');
    }
    expect(message.tool_calls[0]).toHaveProperty('extra_content');
  });

  it('sanitizes unscoped native blocks while preserving readable reasoning and tool evidence', () => {
    const [message] = sanitizeHistoryReasoningForTarget([{
      role: 'assistant', content: [{ type: 'thinking', thinking: 'readable', signature: 'secret' },
        { type: 'redacted_thinking', data: 'secret' }, { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't', name: 'lookup', input: { signature: 'user data' } }],
      providerState: { stateScope: 'old', items: [{ type: 'reasoning', encrypted_content: 'secret', summary: [{ type: 'summary_text', text: 'summary' }] }] },
    }], target);
    expect(message).toBeDefined();
    expect(message!.content).toEqual([{ type: 'text', text: 'readable' }, { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 't', name: 'lookup', input: { signature: 'user data' } }]);
    expect(message).toHaveProperty('reasoning_content', 'summary');
    const scoped = { providerState: { stateScope: computeReasoningStateScope(target), items: [{ signature: 'keep' }] } };
    expect(sanitizeHistoryReasoningForTarget([scoped], target)[0]).toBe(scoped);
  });
});

describe('reasoning chunk deduplication', () => {
  it('uses only the first nonempty text alias, including empty placeholders', () => {
    expect(pickCanonicalReasoningText({ reasoning_content: ' ', reasoning: '', reasoning_text: 'text', summary_text: 'summary' })).toBe('text');
    expect(pickCanonicalReasoningText({ reasoning_content: 'first', reasoning: 'first', reasoning_text: 'first' })).toBe('first');
    expect(pickCanonicalReasoningText(null)).toBe('');
    expect(deduplicateReasoningChunks([{ reasoning_content: 'A', reasoning: 'A' }, { reasoning: 'B' },
      { mode: 'snapshot', reasoning_content: 'AB' }]).reasoning_content).toBe('AB');
  });

  it('does not repeat Responses delta, done, item and final output snapshots', () => {
    const item = { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hello world' }] };
    const result = deduplicateReasoningChunks([
      { type: 'response.reasoning_summary_text.delta', delta: 'hello ' },
      { type: 'response.reasoning_summary_text.delta', delta: 'world' },
      { type: 'response.reasoning_summary_text.done', text: 'hello world' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { output: [item] } },
    ]);
    expect(result.reasoning_content).toBe('hello world');
    expect(deduplicateReasoningChunks([{ reasoning: 'a' }, { reasoning: 'a' }]).reasoning_content).toBe('aa');
  });

  it('keeps same-index differing types and IDs separate, and snapshots do not duplicate ciphertext', () => {
    const result = deduplicateReasoningChunks([
      { reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'thought' },
        { index: 0, type: 'reasoning.encrypted', id: 'a', data: 'A' },
        { index: 0, type: 'reasoning.encrypted', id: 'b', data: 'B' }] },
      { reasoning_details: [{ index: 0, type: 'reasoning.encrypted', id: 'a', data: '2' }] },
      { mode: 'snapshot', reasoning_details: [{ index: 0, type: 'reasoning.encrypted', id: 'a', data: 'A2' }] },
    ]);
    expect(result.reasoning_content).toBe('thought');
    expect(result.reasoning_details).toEqual([{ index: 0, type: 'reasoning.text', text: 'thought' },
      { index: 0, type: 'reasoning.encrypted', id: 'a', data: 'A2' },
      { index: 0, type: 'reasoning.encrypted', id: 'b', data: 'B' }]);
  });
});

describe('scoped prompt cache and final tool round', () => {
  it('leaves legacy cache behavior unchanged and isolates opaque keys by account and session', () => {
    expect(stablePromptCacheKey(' session ')).toBe('session');
    expect(stablePromptCacheKey(' ')).toBe('deep-student-background');
    expect(providerAcceptsPromptCacheKey(target)).toBe(true);
    const key = scopedPromptCacheKey('private-session', 'private-user');
    expect(key).toBe(scopedPromptCacheKey(' private-session ', 'private-user'));
    expect(key).not.toMatch(/private/);
    expect(key).not.toBe(scopedPromptCacheKey('private-session', 'other-user'));
    expect(key).not.toBe(scopedPromptCacheKey('other-session', 'private-user'));
    expect(scopedPromptCacheKey('bc', 'a')).not.toBe(scopedPromptCacheKey('c', 'ab'));
  });

  it('retains the exact tools array with none only on audited HTTPS/model/protocol combinations', () => {
    const tools = [{ type: 'function', function: { name: 'lookup' } }];
    expect(resolveToolChoicePreservingCache(target, tools, false)).toEqual({ tools, tool_choice: 'none' });
    expect(resolveToolChoicePreservingCache(target, tools, false).tools).toBe(tools);
    expect(resolveToolChoicePreservingCache(target, tools, true)).toEqual({ tools, tool_choice: 'auto' });
    expect(resolveToolChoicePreservingCache(target, [], false)).toEqual({});
    for (const change of [{ baseUrl: 'https://proxy.example/v1' }, { baseUrl: 'http://api.openai.com/v1' },
      { baseUrl: 'https://api.openai.com.evil.example/v1' }, { model: 'gpt-99' }, { apiProtocol: 'anthropic_messages' }]) {
      expect(resolveToolChoicePreservingCache({ ...target, ...change }, tools, false)).toEqual({});
    }
    expect(resolveToolChoicePreservingCache(makeConfig({ baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6', apiProtocol: 'anthropic_messages' }), tools, false)).toEqual({ tools, tool_choice: 'none' });
  });
});

describe('cache usage normalization', () => {
  it('does not double count OpenAI cache and reasoning subsets', () => {
    expect(normalizeProviderUsageWithCache('openai_chat_completions', {
      prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 }, total_tokens: 120,
    })).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cacheReadInputTokens: 40, cacheCreationInputTokens: null, reasoningTokens: 10, cacheHitRate: 0.4 });
    expect(normalizeProviderUsageWithCache('openai_responses', {
      input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 25 },
    })).toMatchObject({ inputTokens: 50, totalTokens: 55, cacheHitRate: 0.5 });
  });

  it('adds Anthropic cache reads and writes to input', () => {
    expect(normalizeProviderUsageWithCache('anthropic_messages', {
      input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 5,
    })).toMatchObject({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheHitRate: 0.6,
      cacheReadInputTokens: 60, cacheCreationInputTokens: 30 });
  });

  it('distinguishes unknown and zero cache measurements', () => {
    expect(normalizeProviderUsageWithCache('openai_responses', {})).toMatchObject({ inputTokens: null, cacheHitRate: null });
    expect(normalizeProviderUsageWithCache('openai_responses', { input_tokens: 0, cached_tokens: 0 }).cacheHitRate).toBeNull();
    expect(normalizeProviderUsageWithCache('openai_responses', { input_tokens: 100 }).cacheHitRate).toBeNull();
    expect(normalizeProviderUsageWithCache('openai_responses', { cached_tokens: 10 }).cacheHitRate).toBeNull();
    expect(normalizeProviderUsageWithCache('openai_responses', { input_tokens: 100, cached_tokens: 0 }).cacheHitRate).toBe(0);
  });
});

describe('audited reasoning levels', () => {
  it('keeps GLM-5.3 forced thinking and gives Flash its narrower exact profile', () => {
    expect(findReasoningLevelProfile(makeConfig({ model: 'glm-5.3' }))).toMatchObject({ levels: ['low', 'high', 'max'], canDisable: false });
    const config = makeConfig({ model: 'minimax-m3.1-flash', providerType: 'minimax', reasoningEffort: 'max' });
    expect(findReasoningLevelProfile(config)).toMatchObject({ levels: ['low', 'medium', 'high'], canDisable: false });
    expect(mapReasoningLevelForConfig(config)?.reasoningEffort).toBe('high');
    expect(findReasoningLevelProfile({ ...config, model: 'minimax-m3.1' })?.levels).toContain('max');
  });

  it.each([['gpt-5', 'minimal'], ['gpt-5-pro', 'high'], ['o1', 'low'], ['o3-mini', 'low'],
    ['o4-mini', 'low'], ['glm-5.3', 'low'], ['minimax-m3.1-flash', 'low']])('maps off for %s to %s', (model, expected) => {
    const config = makeConfig({ model, reasoningEffort: 'none' });
    expect(resolveAlwaysThinkingFallback(config)?.reasoningEffort).toBe(expected);
    expect(mapReasoningLevelForConfig(config)).toBeNull(); // Legacy mapper preserves explicit none.
    expect(config.reasoningEffort).toBe('none');
  });

  it('leaves unset, switchable and unknown models alone', () => {
    for (const model of ['gpt-5.1', 'gpt-50', 'unknown', 'gpt-5-chat-latest', 'o1-preview']) {
      expect(resolveAlwaysThinkingFallback(makeConfig({ model, reasoningEffort: 'none' }))).toBeNull();
    }
    expect(resolveAlwaysThinkingFallback(makeConfig({ model: 'glm-5.3', reasoningEffort: null }))).toBeNull();
  });

  it.each(['Pro/deepseek-ai/DeepSeek-V4', 'deepseek-ai/DeepSeek-V4-Flash', 'Pro/zai-org/GLM-5.2'])('isolates SiliconFlow %s overrides', model => {
    const config = makeConfig({ model, providerType: 'siliconflow', reasoningEffort: 'xhigh' });
    expect(mapSiliconFlowReasoningOverride(config)?.reasoningEffort).toBe('max');
    expect(mapReasoningLevelForConfig(config)?.reasoningEffort).toBe('max');
    expect(mapSiliconFlowReasoningOverride({ ...config, reasoningEffort: 'low' })?.reasoningEffort).toBe('high');
    expect(mapSiliconFlowReasoningOverride({ ...config, reasoningEffort: 'high' })).toBeNull();
    expect(mapSiliconFlowReasoningOverride({ ...config, reasoningEffort: 'none' })).toBeNull();
    expect(mapSiliconFlowReasoningOverride({ ...config, providerType: 'custom' })).toBeNull();
    expect(mapSiliconFlowReasoningOverride({ ...config, providerType: 'custom', baseUrl: 'https://api.siliconflow.cn/v1' })?.reasoningEffort).toBe('max');
  });
});
