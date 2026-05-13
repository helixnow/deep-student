import { describe, expect, it } from 'vitest';
import {
  deepSeekV32EffortToBudget,
  resolveDeepSeekReasoningControl,
} from '../deepseekReasoningControls';

describe('DeepSeek reasoning control mapping', () => {
  it('maps SiliconFlow V3.2 depth presets to thinking budgets', () => {
    expect(deepSeekV32EffortToBudget('low')).toBe(2048);
    expect(deepSeekV32EffortToBudget('medium')).toBe(8192);
    expect(deepSeekV32EffortToBudget('high')).toBe(16384);
    expect(deepSeekV32EffortToBudget('xhigh')).toBe(32768);
  });

  it('uses high/max effort for V4 models including SiliconFlow-hosted V4 ids', () => {
    expect(resolveDeepSeekReasoningControl('deepseek-v4-pro', true).kind).toBe('v4-effort');
    expect(resolveDeepSeekReasoningControl('deepseek-ai/DeepSeek-V4-Pro', true).kind).toBe('v4-effort');
  });

  it('uses low/medium/high/xhigh budget presets for V3.2 models', () => {
    const control = resolveDeepSeekReasoningControl('deepseek-ai/DeepSeek-V3.2', false);

    expect(control.kind).toBe('v32-budget-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});
