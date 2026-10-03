import { describe, expect, it } from 'vitest';
import {
  deepSeekV32EffortToBudget,
  resolveReasoningControl,
} from '@/utils/reasoning';

// 2026-10-03 方案 F：设置页原先通过 resolveDeepSeekReasoningControl 拿到
// 按家族裁剪的档位集合（v4-effort / v32-budget-effort / openai-effort…）。
// 现统一为五档，档位可用性交由后端能力表映射，本文件断言设置页依赖的新契约。

const UNIFIED = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('设置页思考强度控制（统一五档契约）', () => {
  it('SiliconFlow 托管的 V3.2 仍使用 budget 换算（托管方言未变）', () => {
    expect(deepSeekV32EffortToBudget('low')).toBe(2048);
    expect(deepSeekV32EffortToBudget('medium')).toBe(8192);
    expect(deepSeekV32EffortToBudget('high')).toBe(16384);
    expect(deepSeekV32EffortToBudget('xhigh')).toBe(32768);
  });

  it('V4 模型（含托管形态）给统一五档且可关闭', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-ai/DeepSeek-V4-Pro', 'deepseek-flash']) {
      const control = resolveReasoningControl({ model, adapterId: 'deepseek' });
      expect(control.options.map(option => option.value), model).toEqual(UNIFIED);
      expect(control.canDisable, model).toBe(true);
    }
  });

  it('V3.2 模型同样给统一五档（档位差异不再由设置页裁剪）', () => {
    const control = resolveReasoningControl({
      model: 'deepseek-ai/DeepSeek-V3.2',
      adapterId: 'deepseek',
    });
    expect(control.options.map(option => option.value)).toEqual(UNIFIED);
  });

  it('GPT-5.6 给统一五档且可关闭（含原生的 max 档）', () => {
    const control = resolveReasoningControl({ model: 'gpt-5.6', adapterId: 'openai' });
    expect(control.kind).not.toBe('toggle-only');
    expect(control.options.map(option => option.value)).toEqual(UNIFIED);
    expect(control.canDisable).toBe(true);
  });

  it('设置页渠道身份走 modelAdapter：zhipu 上的 glm-5.3 强制思考', () => {
    const control = resolveReasoningControl({ model: 'glm-5.3', adapterId: 'zhipu' });
    expect(control.canDisable).toBe(false);
    expect(control.options.map(option => option.value)).toEqual(UNIFIED);
  });
});
