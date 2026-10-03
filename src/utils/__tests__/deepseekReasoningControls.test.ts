import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_V32_EFFORT_BUDGETS,
  QWEN_EFFORT_BUDGETS,
  deepSeekV32BudgetToEffort,
  deepSeekV32EffortToBudget,
  qwenBudgetToEffort,
  qwenEffortToBudget,
} from '../reasoning/conversions';
import { resolveReasoningControl } from '../reasoning';
import { isOfficialDeepSeekEndpoint } from '../reasoning/endpoints';

// 2026-10-03 方案 F：本文件原先断言「按模型家族裁剪档位集合」的旧契约
// （resolveDeepSeekRuntimeReasoningControl / ...Selection 及其 14 种 kind）。
// 该契约已由统一五档 + 后端能力映射取代，故重写为：
//   1. 档位↔budget 换算（历史方言仍在托管宿主上生效）
//   2. 官方端点识别
//   3. 统一五档在 DeepSeek/Qwen 渠道上的行为（档位集合一致，仅 canDisable 分家）

const UNIFIED = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('档位 ↔ thinking_budget 换算（托管宿主方言）', () => {
  it('DeepSeek V3.x 的 budget 档位为 2048/8192/16384/32768', () => {
    expect(DEEPSEEK_V32_EFFORT_BUDGETS).toEqual({
      low: 2048,
      medium: 8192,
      high: 16384,
      xhigh: 32768,
    });
  });

  it('deepSeekV32EffortToBudget：max 并入 xhigh 上限（宿主上限 32768）', () => {
    expect(deepSeekV32EffortToBudget('low')).toBe(2048);
    expect(deepSeekV32EffortToBudget('medium')).toBe(8192);
    expect(deepSeekV32EffortToBudget('high')).toBe(16384);
    expect(deepSeekV32EffortToBudget('xhigh')).toBe(32768);
    expect(deepSeekV32EffortToBudget('max')).toBe(32768);
    expect(deepSeekV32EffortToBudget('unknown')).toBeUndefined();
    expect(deepSeekV32EffortToBudget(undefined)).toBeUndefined();
  });

  it('deepSeekV32BudgetToEffort：反向映射按区间，缺省为 medium', () => {
    expect(deepSeekV32BudgetToEffort(1024)).toBe('low');
    expect(deepSeekV32BudgetToEffort(4096)).toBe('medium');
    expect(deepSeekV32BudgetToEffort(16384)).toBe('high');
    expect(deepSeekV32BudgetToEffort(999_999)).toBe('xhigh');
    expect(deepSeekV32BudgetToEffort(undefined)).toBe('medium');
    expect(deepSeekV32BudgetToEffort(NaN)).toBe('medium');
  });

  it('Qwen 混合思考的 budget 档位覆盖到 262144', () => {
    expect(QWEN_EFFORT_BUDGETS.low).toBe(1024);
    expect(QWEN_EFFORT_BUDGETS.medium).toBe(4096);
    expect(QWEN_EFFORT_BUDGETS.high).toBe(16384);
    expect(QWEN_EFFORT_BUDGETS.xhigh).toBe(65536);
    expect(QWEN_EFFORT_BUDGETS.max).toBe(262144);
  });

  it('qwenEffortToBudget / qwenBudgetToEffort 互为往返', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(qwenBudgetToEffort(qwenEffortToBudget(level))).toBe(level);
    }
    expect(qwenEffortToBudget(undefined)).toBe(QWEN_EFFORT_BUDGETS.medium);
    expect(qwenBudgetToEffort(undefined)).toBe('medium');
  });
});

describe('官方端点识别', () => {
  it('host 精确匹配 api.deepseek.com 才算官方', () => {
    expect(isOfficialDeepSeekEndpoint({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isOfficialDeepSeekEndpoint({ baseUrl: 'https://api.deepseek.com.proxy.example/v1' })).toBe(false);
    expect(isOfficialDeepSeekEndpoint({ baseUrl: 'https://proxy.example/v1' })).toBe(false);
  });

  it('无 baseUrl 时按 provider 声明判定', () => {
    expect(isOfficialDeepSeekEndpoint({ providerType: 'deepseek' })).toBe(true);
    expect(isOfficialDeepSeekEndpoint({ providerType: 'siliconflow' })).toBe(false);
  });

  it('非法 URL 不抛异常，按非官方处理', () => {
    expect(isOfficialDeepSeekEndpoint({ baseUrl: 'not-a-url' })).toBe(false);
  });
});

describe('统一五档在 DeepSeek / Qwen 渠道上的行为', () => {
  it('DeepSeek V4 与 V4.1 Flash 均给统一五档且可关闭', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-ai/DeepSeek-V4-Pro']) {
      const control = resolveReasoningControl({ model, adapterId: 'deepseek' });
      expect(control.options.map(o => o.value), model).toEqual(UNIFIED);
      expect(control.canDisable, model).toBe(true);
    }
  });

  it('DeepSeek R1 系为强制思考（不可关闭）但仍有档位', () => {
    const control = resolveReasoningControl({ model: 'deepseek-r1-0528', adapterId: 'deepseek' });
    expect(control.canDisable).toBe(false);
    expect(control.options.map(o => o.value)).toEqual(UNIFIED);
  });

  it('Qwen 混合思考（3.7 及更早）给统一五档且可关闭', () => {
    for (const model of ['qwen3.7-max', 'qwen3.6-plus', 'qwen-plus', 'qwen-turbo']) {
      const control = resolveReasoningControl({ model, adapterId: 'qwen' });
      expect(control.options.map(o => o.value), model).toEqual(UNIFIED);
      expect(control.canDisable, model).toBe(true);
    }
  });

  it('qwen3-*-thinking 强制思考不可关闭', () => {
    const control = resolveReasoningControl({ model: 'qwen3-235b-thinking', adapterId: 'qwen' });
    expect(control.canDisable).toBe(false);
  });
});
