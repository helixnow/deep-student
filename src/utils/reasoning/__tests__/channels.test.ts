import { describe, expect, it } from 'vitest';

import { resolveReasoningControl } from '../registry';
import {
  extractModelVersion,
  matchModelFamily as matchFamilyDirect,
  matchesOpenAiOSeries,
} from '../modelFamily';
import {
  resolveGenericChannel,
  resolveQwenChannel,
  UNIFIED_REASONING_LEVELS,
} from '../channels';

const UNIFIED_LEVEL_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('家族包含匹配', () => {
  it('中转前缀 ID 命中正确家族（codex666-glm-5.3-flash → zhipu）', () => {
    expect(matchFamilyDirect('codex666-glm-5.3-flash')).toBe('zhipu');
    expect(matchFamilyDirect('relay-x-qwen3.8-max')).toBe('qwen');
    expect(matchFamilyDirect('my-deepseek-v4-pro')).toBe('deepseek');
    expect(matchFamilyDirect('chatgpt-4o')).toBe('openai');
  });

  it('版本号从 ID 任意位置提取（不锚定前缀）', () => {
    expect(extractModelVersion('codex666-glm-5.3-flash')).toEqual([5, 3]);
    expect(extractModelVersion('grok-4.7')).toEqual([4, 7]);
    expect(extractModelVersion('qwen3.8-max')).toEqual([3, 8]);
    expect(extractModelVersion('kimi-k3')).toBeUndefined(); // 无 x.y 形态
    expect(extractModelVersion('deepseek-v3.2')).toEqual([3, 2]);
  });

  it('o 系列保持词边界特例（避免裸包含误命中）', () => {
    expect(matchesOpenAiOSeries('o3-mini')).toBe(true);
    expect(matchesOpenAiOSeries('prompt3')).toBe(false);
    expect(matchesOpenAiOSeries('gpt-3')).toBe(false);
  });

  it('包含匹配不因多关键词顺序误判：固定优先级', () => {
    // 同时含 deepseek 与 qwen 关键词时按 KEYWORD_ORDER 先命中 deepseek
    expect(matchFamilyDirect('qwen-deepseek-mix')).toBe('deepseek');
  });
});

describe('统一五档（方案 F）', () => {
  it('统一档位表就是五档：low/medium/high/xhigh/max', () => {
    expect(UNIFIED_REASONING_LEVELS.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
  });

  describe('所有渠道返回同一套档位集合', () => {
    // 这是方案 F 的核心不变式：档位集合不再按模型裁剪。
    const cases: Array<[string, string, string]> = [
      ['Qwen3.8', 'qwen3.8-max', 'qwen'],
      ['Qwen 混合思考', 'qwen3.7-max', 'qwen'],
      ['OpenAI gpt-6', 'gpt-6-sol', 'openai'],
      ['OpenAI gpt-5.6', 'gpt-5.6', 'general'],
      ['中转前缀 gpt', 'relay-gpt-5.6-terra', 'general'],
      ['DeepSeek V4', 'deepseek-v4-pro', 'deepseek'],
      ['GLM-5.3', 'codex666-glm-5.3-flash', 'zhipu'],
      ['GLM-5.2', 'glm-5.2', 'zhipu'],
      ['Kimi K3', 'kimi-k3', 'moonshot'],
      ['Grok 4.7', 'grok-4.7', 'grok'],
      ['Grok 4.5', 'grok-4.5', 'grok'],
      ['Gemini 3.8 Flash', 'gemini-3.8-flash', 'google'],
      ['Claude Opus 5', 'claude-opus-5', 'anthropic'],
      ['Mistral Medium', 'mistral-medium-3.5', 'mistral'],
    ];

    it.each(cases)('%s（%s）返回统一五档', (_label, model, adapterId) => {
      const control = resolveReasoningControl({ model, adapterId });
      expect(control.kind).not.toBe('toggle-only');
      expect(control.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
    });
  });

  describe('canDisable 表达关闭语义（唯一随模型变化的维度）', () => {
    it('可关闭：Qwen3.8 / GLM-5.2 / DeepSeek V4 / Grok 4.3 / Mistral', () => {
      for (const [model, adapterId] of [
        ['qwen3.8-max', 'qwen'],
        ['glm-5.2', 'zhipu'],
        ['deepseek-v4-pro', 'deepseek'],
        ['grok-4.3', 'grok'],
        ['mistral-medium-3.5', 'mistral'],
      ] as const) {
        expect(resolveReasoningControl({ model, adapterId }).canDisable, model).toBe(true);
      }
    });

    it('不可关闭（强制思考）：GLM-5.3 / Kimi K3 / Gemini 3 / Grok 4.5+ / QwQ', () => {
      for (const [model, adapterId] of [
        ['codex666-glm-5.3-flash', 'zhipu'],
        ['kimi-k3', 'moonshot'],
        ['gemini-3.8-flash', 'google'],
        ['grok-4.7', 'grok'],
        ['qwq-32b', 'qwen'],
      ] as const) {
        expect(resolveReasoningControl({ model, adapterId }).canDisable, model).toBe(false);
      }
    });
  });

  describe('Qwen 渠道', () => {
    it('QwQ 等纯推理型号：仍展示档位但不可关闭', () => {
      // 强制思考模型同样有强度档位（官方 QwQ 支持 effort），只是不能关闭。
      const control = resolveQwenChannel({ model: 'qwq-32b' });
      expect(control?.kind).toBe('effort');
      expect(control?.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
      expect(control?.canDisable).toBe(false);
    });

    it('中转前缀的 qwen3.8 也被识别（包含语义）', () => {
      for (const model of ['relay-x-qwen3.8-max', 'Qwen/qwen3.8-27b']) {
        const control = resolveQwenChannel({ model });
        expect(control?.options.map(o => o.value), model).toEqual(UNIFIED_LEVEL_VALUES);
      }
    });

    it('qwen3.8 默认档对齐后端注册表 default=xhigh；其余 qwen3 系保持 medium', () => {
      expect(resolveQwenChannel({ model: 'qwen3.8-max' })?.defaultValue).toBe('xhigh');
      expect(resolveQwenChannel({ model: 'embed-gateway_qwen3.8-max' })?.defaultValue).toBe('xhigh');
      expect(resolveQwenChannel({ model: 'qwen3.7-max' })?.defaultValue).toBe('medium');
    });
  });

  describe('generic 渠道思考强度开关', () => {
    it('开关打开：给出统一五档', () => {
      const control = resolveGenericChannel({ model: 'some-unknown-llm', supportsReasoning: true });
      expect(control.kind).toBe('effort');
      expect(control.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
    });

    it('开关关闭且模型名不像推理模型：仅思考开关', () => {
      const control = resolveGenericChannel({ model: 'some-unknown-llm', supportsReasoning: false });
      expect(control.kind).toBe('toggle-only');
      expect(control.options).toHaveLength(0);
    });
  });

  describe('零交叉判定链（C3）', () => {
    it('宿主渠道不再"清扫"其他家族：general 上的 gemini 由 generic 兜底而非 gemini 渠道', () => {
      // 旧实现会 sweepFamilies 依次尝试 openai→qwen→…→gemini，把 gemini 模型
      // 交给 gemini 渠道映射，导致档位语义随宿主漂移。
      // 新实现：general 渠道自决（中性兜底），不转交。
      const control = resolveReasoningControl({ model: 'gemini-3.8-flash', adapterId: 'general' });
      expect(control.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
      // gemini 渠道本身则标记为不可关闭（3.x 强制思考）；general 兜底不知情，
      // 这正是"按身份判定"的体现——差异来自渠道，而非编排顺序。
      const viaGemini = resolveReasoningControl({ model: 'gemini-3.8-flash', adapterId: 'google' });
      expect(viaGemini.canDisable).toBe(false);
    });

    it('未注册的 adapterId 走中性兜底，不猜测家族', () => {
      const control = resolveReasoningControl({ model: 'gpt-6-sol', adapterId: 'not-a-real-adapter' });
      expect(control.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
      // 中性兜底对 gpt-6 判为强制思考（isForcedThinkingModelId 覆盖 o/codex/gpt-oss/pro）
      // 但 gpt-6-sol 不属强制名单，故可关闭。
      expect(control.canDisable).toBe(true);
    });

    it('adapterId 缺失时按模型名定位唯一家族渠道（不依次尝试）', () => {
      const viaName = resolveReasoningControl({ model: 'deepseek-v4-pro' });
      expect(viaName.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
      expect(viaName.canDisable).toBe(true);
    });

    it('渠道只按自身身份判定：wrong-family adapterId 不命中家族', () => {
      // zhipu 渠道收到 gemini 模型 → 家族门控不通过 → 中性兜底（而非交给 gemini 渠道）
      const control = resolveReasoningControl({ model: 'gemini-3.8-flash', adapterId: 'zhipu' });
      expect(control.options.map(o => o.value)).toEqual(UNIFIED_LEVEL_VALUES);
    });
  });
});
