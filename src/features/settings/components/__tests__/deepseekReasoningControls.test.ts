import { describe, expect, it } from 'vitest';
import {
  deepSeekV32EffortToBudget,
  normalizeDeepSeekV4Effort,
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

  it('uses low/high/max effort for DeepSeek V4.1 Flash (deepseek-flash)', () => {
    const control = resolveDeepSeekReasoningControl('deepseek-flash', true);
    expect(control.kind).toBe('v4-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'high', 'max']);
  });

  it('normalizes V4 effort per official mapping (low stays low, ultra to max)', () => {
    expect(normalizeDeepSeekV4Effort('minimal')).toBe('low');
    expect(normalizeDeepSeekV4Effort('low')).toBe('low');
    expect(normalizeDeepSeekV4Effort('medium')).toBe('high');
    expect(normalizeDeepSeekV4Effort('high')).toBe('high');
    expect(normalizeDeepSeekV4Effort('xhigh', true)).toBe('high');
    expect(normalizeDeepSeekV4Effort('xhigh', false)).toBe('max');
    expect(normalizeDeepSeekV4Effort('xhigh')).toBe('max');
    expect(normalizeDeepSeekV4Effort('max')).toBe('max');
    expect(normalizeDeepSeekV4Effort('ultra')).toBe('max');
    expect(normalizeDeepSeekV4Effort(undefined)).toBe('high');
  });

  it('uses low/medium/high/xhigh budget presets for V3.2 models', () => {
    const control = resolveDeepSeekReasoningControl('deepseek-ai/DeepSeek-V3.2', false);

    expect(control.kind).toBe('v32-budget-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('exposes the native max depth for GPT-5.6 settings controls', () => {
    const control = resolveDeepSeekReasoningControl('gpt-5.6', false);

    expect(control.kind).toBe('openai-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(control.canDisable).toBe(true);
  });
});
