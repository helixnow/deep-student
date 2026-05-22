import { describe, expect, it } from 'vitest';
import {
  deepSeekV32EffortToBudget,
  resolveDeepSeekRuntimeReasoningControl,
  resolveDeepSeekRuntimeReasoningSelection,
} from '../deepseekReasoningControls';

describe('DeepSeek runtime reasoning controls', () => {
  it('uses low/medium/high/xhigh runtime options for OpenAI GPT-5 family', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'gpt-5.5',
      providerType: 'openai',
      providerScope: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(control.kind).toBe('openai-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('uses high/max runtime options for official DeepSeek V4', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'deepseek-v4-pro',
      providerType: 'deepseek',
      providerScope: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
    });

    expect(control.kind).toBe('v4-effort');
    expect(control.options.map((option) => option.value)).toEqual(['high', 'max']);
  });

  it('uses high/max runtime options for future SiliconFlow DeepSeek V4', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      providerType: 'siliconflow',
      providerScope: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
    });

    expect(control.kind).toBe('v4-effort');
    expect(control.options.map((option) => option.value)).toEqual(['high', 'max']);
  });

  it('uses low/medium/high/xhigh runtime options for SiliconFlow DeepSeek V3.2', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'deepseek-ai/DeepSeek-V3.2',
      providerType: 'siliconflow',
      providerScope: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
    });

    expect(control.kind).toBe('v32-budget-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('keeps unknown non-DeepSeek models toggle-only', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'gpt-4o-mini',
      providerType: 'openai-compatible',
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(control.kind).toBe('toggle-only');
    expect(control.options).toEqual([]);
  });

  it('normalizes OpenAI runtime depth to reasoning effort only', () => {
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'gpt-5.5', providerType: 'openai' }),
        enableThinking: true,
        reasoningEffort: 'xhigh',
        thinkingBudget: 32768,
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'xhigh', thinkingBudget: undefined });
  });

  it('clears versioned runtime depth fields for toggle-only models', () => {
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'gpt-4o-mini', providerType: 'openai-compatible' }),
        enableThinking: true,
        reasoningEffort: 'max',
        thinkingBudget: 32768,
      })
    ).toEqual({ enableThinking: true, reasoningEffort: undefined, thinkingBudget: undefined });
  });

  it('normalizes the current runtime depth when switching model versions', () => {
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'deepseek-v4-pro', providerType: 'deepseek' }),
        enableThinking: true,
        reasoningEffort: 'xhigh',
        thinkingBudget: 32768,
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'max', thinkingBudget: undefined });

    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'deepseek-ai/DeepSeek-V3.2', providerType: 'siliconflow' }),
        enableThinking: true,
        reasoningEffort: 'max',
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'xhigh', thinkingBudget: deepSeekV32EffortToBudget('xhigh') });
  });
});
