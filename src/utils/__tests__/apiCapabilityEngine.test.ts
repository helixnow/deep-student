import { describe, expect, it } from 'vitest';
import { inferApiCapabilities } from '../apiCapabilityEngine';
import { findModelRecordById } from '../modelCapabilityRegistry';

describe('apiCapabilityEngine vision inference', () => {
  it('does not treat GLM-4.7 as multimodal', () => {
    const caps = inferApiCapabilities({ id: 'Pro/zai-org/GLM-4.7' });
    expect(caps.vision).toBe(false);
  });

  it('keeps GLM vision variants as multimodal', () => {
    const caps = inferApiCapabilities({ id: 'zai-org/GLM-4.6V' });
    expect(caps.vision).toBe(true);
  });

  it('treats qwen3.5-plus as multimodal', () => {
    const caps = inferApiCapabilities({ id: 'qwen3.5-plus' });
    expect(caps.vision).toBe(true);
    expect(caps.functionCalling).toBe(true);
    expect(caps.supportsThinkingTokens).toBe(true);
  });

  it('treats qwen3.5-flash as reasoning capable but not multimodal by default', () => {
    const caps = inferApiCapabilities({ id: 'qwen3.5-flash' });
    expect(caps.vision).toBe(false);
    expect(caps.functionCalling).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.supportsThinkingTokens).toBe(true);
  });

  it('prefers SiliconFlow scoped Qwen3.5 records for provider model ids', () => {
    const record = findModelRecordById('Qwen/Qwen3.5-32B', { providerScope: 'siliconflow' });
    expect(record?.provider_scope).toBe('siliconflow');
    expect(record?.provider_model_id).toBe('Qwen/Qwen3.5-32B');

    const caps = inferApiCapabilities({
      id: 'Qwen/Qwen3.5-32B',
      providerScope: 'siliconflow',
    });
    expect(caps.vision).toBe(false);
    expect(caps.functionCalling).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(32768);
  });

  it('keeps generic open-source Qwen3.5 records when provider scope is absent', () => {
    const record = findModelRecordById('qwen3.5-122b-a10b');
    expect(record?.provider_scope).toBeUndefined();
    expect(record?.model_id).toBe('qwen3.5-122b-a10b');
  });

  it('matches SiliconFlow Qwen3.5 provider ids even without explicit provider scope', () => {
    const record = findModelRecordById('Qwen/Qwen3.5-397B-A17B');
    expect(record?.provider_scope).toBe('siliconflow');
    expect(record?.provider_model_id).toBe('Qwen/Qwen3.5-397B-A17B');
  });
});

describe('apiCapabilityEngine DeepSeek version inference', () => {
  it('treats official DeepSeek V4 as hybrid reasoning with V4 effort and 1M context', () => {
    const caps = inferApiCapabilities({ id: 'deepseek-v4-pro', providerScope: 'deepseek' });
    expect(caps.functionCalling).toBe(true);
    expect(caps.supportsHybridReasoning).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(true);
    expect(caps.supportsThinkingTokens).toBe(false);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it('keeps official DeepSeek legacy aliases as V4-compatible aliases', () => {
    const chatCaps = inferApiCapabilities({ id: 'deepseek-chat', providerScope: 'deepseek' });
    const reasonerCaps = inferApiCapabilities({ id: 'deepseek-reasoner', providerScope: 'deepseek' });

    expect(chatCaps.supportsHybridReasoning).toBe(true);
    expect(chatCaps.supportsReasoningEffort).toBe(true);
    expect(chatCaps.contextWindow).toBe(1_000_000);
    expect(reasonerCaps.reasoning).toBe(true);
    expect(reasonerCaps.supportsReasoningEffort).toBe(true);
  });

  it('preserves SiliconFlow DeepSeek V3.2 as thinking-budget based 128K hybrid reasoning', () => {
    const caps = inferApiCapabilities({
      id: 'deepseek-ai/DeepSeek-V3.2',
      providerScope: 'siliconflow',
    });

    expect(caps.supportsHybridReasoning).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(false);
    expect(caps.contextWindow).toBe(128_000);
  });

  it('classifies SiliconFlow DeepSeek V4-shaped ids as V4 models without official effort fields', () => {
    const caps = inferApiCapabilities({
      id: 'deepseek-ai/DeepSeek-V4-Pro',
      providerScope: 'siliconflow',
    });

    expect(caps.supportsHybridReasoning).toBe(true);
    expect(caps.supportsReasoningEffort).toBe(false);
    expect(caps.contextWindow).toBe(1_000_000);
  });
});
