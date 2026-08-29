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

  it('uses official DeepSeek V4 defaults with reasoning effort and 32K request default', () => {
    const defaults = getModelDefaultParameters('deepseek-v4-pro');

    expect(defaults).toMatchObject({
      enableThinking: true,
      includeThoughts: true,
      reasoningEffort: 'high',
      maxOutputTokens: 32_768,
      temperature: 0.6,
    });
    expect(defaults).not.toHaveProperty('thinkingBudget');
    expect(defaults.maxOutputTokens).toBe(32_768);
  });

  it('keeps SiliconFlow DeepSeek V3.2 defaults unchanged', () => {
    expect(getModelDefaultParameters('deepseek-ai/DeepSeek-V3.2', { providerScope: 'siliconflow' })).toEqual({
      enableThinking: true,
      reasoningEffort: 'medium',
      thinkingBudget: 8192,
      includeThoughts: true,
      temperature: 0.6,
    });
  });

  it('uses high/max effort defaults for SiliconFlow V4-shaped ids', () => {
    const defaults = getModelDefaultParameters('deepseek-ai/DeepSeek-V4-Pro', { providerScope: 'siliconflow' });

    expect(defaults).toMatchObject({
      enableThinking: true,
      includeThoughts: true,
      reasoningEffort: 'high',
      maxOutputTokens: 32_768,
      temperature: 0.6,
    });
    expect(defaults).not.toHaveProperty('thinkingBudget');
  });

  it('distinguishes DeepSeek V4 and V3.2 context windows', () => {
    expect(inferModelContextWindow({ id: 'deepseek-v4-pro', providerScope: 'deepseek' })).toBe(1_000_000);
    expect(inferModelContextWindow({ id: 'deepseek-ai/DeepSeek-V3.2', providerScope: 'siliconflow' })).toBe(128_000);
  });
});

describe('inferModelContextWindow registry small-context passthrough', () => {
  it('keeps registry-confirmed qwen3.5-32b at 32768 instead of lifting to >=100K', () => {
    const descriptor = { id: 'qwen3.5-32b', providerScope: 'siliconflow' };

    expect(inferModelContextWindow(descriptor)).toBe(32_768);
    // P0 回归：命中注册表后不得再走 maxOutputTokens 启发式（旧逻辑会抬到 >=100K）
    expect(inferModelContextWindow(descriptor, 8_192)).toBe(32_768);
    expect(inferModelContextWindow(descriptor, 65_536)).toBe(32_768);
  });

  it('keeps SiliconFlow provider-prefixed Qwen3.5-32B ids at 32768', () => {
    expect(
      inferModelContextWindow({ id: 'Qwen/Qwen3.5-32B', providerScope: 'siliconflow' }, 8_192)
    ).toBe(32_768);
  });

  it('keeps registry-confirmed glm-4.5v at 64000 instead of lifting to >=100K', () => {
    expect(inferModelContextWindow('glm-4.5v')).toBe(64_000);
    expect(inferModelContextWindow('glm-4.5v', 8_192)).toBe(64_000);
    expect(inferModelContextWindow({ id: 'glm-4.5v' }, 96_000)).toBe(64_000);
  });

  it('keeps rule hits above the fallback unchanged', () => {
    expect(inferModelContextWindow('claude-fable-5', 8_192)).toBe(1_000_000);
    expect(inferModelContextWindow('gemini-2.5-pro')).toBe(1_000_000);
  });

  it('still applies the maxOutputTokens heuristic only for unmatched models', () => {
    // 未命中且无 maxOutputTokens：返回 DEFAULT_FALLBACK_CONTEXT_WINDOW (100_000)
    expect(inferModelContextWindow('mystery-model-x')).toBe(100_000);
    // 未命中 + maxOutputTokens：max(100_000, 4 * maxOutputTokens)
    expect(inferModelContextWindow('mystery-model-x', 8_192)).toBe(100_000);
    expect(inferModelContextWindow('mystery-model-x', 50_000)).toBe(200_000);
  });
});

describe('modelCapabilities OpenAI GPT-5 defaults', () => {
  it('uses OpenAI GPT-5.5 defaults with reasoning effort and verbosity', () => {
    expect(getModelDefaultParameters('gpt-5.5', { providerScope: 'openai' })).toMatchObject({
      enableThinking: true,
      includeThoughts: true,
      reasoningEffort: 'medium',
      verbosity: 'medium',
      maxOutputTokens: 128_000,
      temperature: 1.0,
    });
  });

  it('uses stronger defaults for OpenAI GPT-5.5 Pro and GPT-5 Pro', () => {
    expect(getModelDefaultParameters('gpt-5.5-pro', { providerScope: 'openai' })).toMatchObject({
      reasoningEffort: 'high',
      verbosity: 'medium',
    });

    expect(getModelDefaultParameters('gpt-5-pro', { providerScope: 'openai' })).toMatchObject({
      reasoningEffort: 'high',
      verbosity: 'medium',
    });
  });

  it('uses lower-cost defaults for GPT-5.4 mini and nano variants', () => {
    expect(getModelDefaultParameters('gpt-5.4-mini', { providerScope: 'openai' })).toMatchObject({
      reasoningEffort: 'medium',
      verbosity: 'medium',
    });

    expect(getModelDefaultParameters('gpt-5.4-nano', { providerScope: 'openai' })).toMatchObject({
      reasoningEffort: 'low',
      verbosity: 'low',
    });
  });
});

describe('modelCapabilities NVIDIA provider defaults', () => {
  it('keeps NVIDIA-hosted vendor/model ids on the generic adapter path', () => {
    const deepseekCaps = inferCapabilities({
      id: 'deepseek-ai/deepseek-v4-flash',
      providerScope: 'nvidia',
    });
    const qwenCaps = inferCapabilities({
      id: 'qwen/qwen3.5-122b-a10b',
      providerScope: 'nvidia',
    });

    expect(deepseekCaps.modelAdapter).toBe('general');
    expect(qwenCaps.modelAdapter).toBe('general');
    expect(deepseekCaps.supportsReasoning).toBe(true);
  });

  it('does not inject thinking parameters by default for NVIDIA-hosted reasoning models', () => {
    const defaults = getModelDefaultParameters('deepseek-ai/deepseek-v4-flash', {
      providerScope: 'nvidia',
    });

    expect(defaults).not.toHaveProperty('enableThinking');
    expect(defaults).not.toHaveProperty('reasoningEffort');
    expect(defaults).not.toHaveProperty('thinkingBudget');
    expect(defaults).not.toHaveProperty('includeThoughts');
  });
});

describe('modelCapabilities Xiaomi MiMo provider defaults', () => {
  it('keeps MiMo hosted models on the MiMo adapter path', () => {
    const proCaps = inferCapabilities({
      id: 'mimo-v2.5-pro',
      providerScope: 'mimo',
    });
    const omniCaps = inferCapabilities({
      id: 'mimo-v2.5',
      providerScope: 'mimo',
    });

    expect(proCaps.modelAdapter).toBe('mimo');
    expect(proCaps.supportsReasoning).toBe(true);
    expect(proCaps.supportsTools).toBe(true);
    expect(omniCaps.modelAdapter).toBe('mimo');
    expect(omniCaps.isMultimodal).toBe(true);
  });

  it('uses MiMo model-specific token and sampling defaults', () => {
    expect(getModelDefaultParameters('mimo-v2.5-pro', { providerScope: 'mimo' })).toMatchObject({
      enableThinking: true,
      includeThoughts: true,
      maxOutputTokens: 131_072,
      temperature: 1.0,
    });

    expect(getModelDefaultParameters('mimo-v2-flash', { providerScope: 'mimo' })).toMatchObject({
      enableThinking: false,
      includeThoughts: false,
      maxOutputTokens: 65_536,
      temperature: 0.3,
    });
  });
});
