import { describe, expect, it } from 'vitest';
import {
  getModelDefaultParameters,
  inferCapabilities,
  inferModelContextWindow,
} from '../modelCapabilities';

describe('modelCapabilities DeepSeek version defaults', () => {
  it('detects DeepSeek V4 as the shared DeepSeek adapter family', () => {
    const caps = inferCapabilities({ id: 'deepseek-v4-pro', providerScope: 'deepseek' });

    expect(caps.modelAdapter).toBe('deepseek');
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });

  it('uses official DeepSeek V4 defaults with reasoning effort and conservative output', () => {
    const defaults = getModelDefaultParameters('deepseek-v4-pro');

    expect(defaults).toMatchObject({
      enableThinking: true,
      includeThoughts: true,
      reasoningEffort: 'high',
      maxOutputTokens: 8192,
      temperature: 0.6,
    });
    expect(defaults).not.toHaveProperty('thinkingBudget');
    expect(defaults.maxOutputTokens).toBeLessThan(384_000);
  });

  it('keeps SiliconFlow DeepSeek V3.2 defaults unchanged', () => {
    expect(getModelDefaultParameters('deepseek-ai/DeepSeek-V3.2', { providerScope: 'siliconflow' })).toEqual({
      enableThinking: true,
      thinkingBudget: 8192,
      includeThoughts: true,
      temperature: 0.6,
    });
  });

  it('uses V4 model defaults with SiliconFlow thinking-budget formatting for V4-shaped ids', () => {
    const defaults = getModelDefaultParameters('deepseek-ai/DeepSeek-V4-Pro', { providerScope: 'siliconflow' });

    expect(defaults).toMatchObject({
      enableThinking: true,
      thinkingBudget: 8192,
      includeThoughts: true,
      maxOutputTokens: 8192,
      temperature: 0.6,
    });
    expect(defaults).not.toHaveProperty('reasoningEffort');
  });

  it('distinguishes DeepSeek V4 and V3.2 context windows', () => {
    expect(inferModelContextWindow({ id: 'deepseek-v4-pro', providerScope: 'deepseek' })).toBe(1_000_000);
    expect(inferModelContextWindow({ id: 'deepseek-ai/DeepSeek-V3.2', providerScope: 'siliconflow' })).toBe(128_000);
  });
});
