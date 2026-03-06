import { describe, expect, it } from 'vitest';
import { inferApiCapabilities } from '../apiCapabilityEngine';

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
  });
});
