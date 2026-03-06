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
