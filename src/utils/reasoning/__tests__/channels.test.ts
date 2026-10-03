import { describe, expect, it } from 'vitest';

import { resolveReasoningControl, matchModelFamily } from '../registry';
import {
  extractModelVersion,
  matchModelFamily as matchFamilyDirect,
  matchesOpenAiOSeries,
} from '../modelFamily';
import { resolveGenericChannel, resolveQwenChannel } from '../channels';
import {
  resolveDeepSeekRuntimeReasoningControl,
  resolveDeepSeekRuntimeReasoningSelection,
} from '../../deepseekReasoningControls';

describe('方案 E：家族包含匹配', () => {
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
    expect(matchModelFamily('qwen-deepseek-mix')).toBe('deepseek');
  });
});

describe('渠道并行思考强度（方案 D + E）', () => {
  describe('Qwen 渠道', () => {
    it('qwen3.8 系走 reasoning_effort 档位（low/medium/xhigh）', () => {
      for (const model of ['qwen3.8-max', 'Qwen/qwen3.8-27b', 'relay-x-qwen3.8-flash']) {
        const control = resolveQwenChannel({ model });
        expect(control?.kind).toBe('qwen-effort');
        expect(control?.canDisable).toBe(true);
        expect(control?.options.map(o => o.value)).toEqual(['low', 'medium', 'xhigh']);
      }
    });

    it('默认档取最高：qwen3.8 → xhigh，qwen3.7 混合 → max(262144)', () => {
      expect(resolveReasoningControl({ model: 'qwen3.8-max', adapterId: 'qwen' }).defaultValue).toBe('xhigh');
      const hybrid = resolveReasoningControl({ model: 'qwen3.7-max', adapterId: 'qwen' });
      expect(hybrid.kind).toBe('qwen-budget-effort');
      expect(hybrid.defaultValue).toBe('max');
    });

    it('SiliconFlow 宿主变体上限 32768（不含 262144 档）', () => {
      const control = resolveQwenChannel({
        model: 'qwen3.7-max',
        providerType: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
      });
      expect(control?.options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
      const xhigh = control?.options.find(o => o.value === 'xhigh');
      expect(xhigh?.defaultLabel).toContain('32768');
    });

    it('QwQ 强制思考不可关闭', () => {
      const control = resolveQwenChannel({ model: 'qwq-32b' });
      expect(control?.kind).toBe('toggle-only');
      expect(control?.canDisable).toBe(false);
    });

    it('qwen-effort 选择只产出 effort，不产出 budget（与 thinking_budget 互斥）', () => {
      const control = resolveQwenChannel({ model: 'qwen3.8-max' })!;
      const selection = resolveDeepSeekRuntimeReasoningSelection({
        control,
        enableThinking: true,
        reasoningEffort: 'medium',
        thinkingBudget: 16384,
      });
      expect(selection.reasoningEffort).toBe('medium');
      expect(selection.thinkingBudget).toBeUndefined();
    });
  });

  describe('OpenAI 渠道', () => {
    it('gpt-6 系识别为 openai-effort，默认最高档 max', () => {
      const control = resolveReasoningControl({ model: 'gpt-6-sol', adapterId: 'openai' });
      expect(control.kind).toBe('openai-effort');
      expect(control.options.map(o => o.value)).toContain('max');
      expect(control.defaultValue).toBe('max');
    });

    it('gpt-5.6 默认 max；gpt-5 默认 high（options 末位）', () => {
      expect(resolveReasoningControl({ model: 'gpt-5.6', adapterId: 'general' }).defaultValue).toBe('max');
      expect(resolveReasoningControl({ model: 'gpt-5', adapterId: 'general' }).defaultValue).toBe('high');
    });

    it('中转前缀 gpt ID 仍命中（包含语义）', () => {
      const control = resolveReasoningControl({ model: 'relay-gpt-5.6-terra', adapterId: 'general' });
      expect(control.kind).toBe('openai-effort');
      expect(control.defaultValue).toBe('max');
    });
  });

  describe('智谱渠道（GLM-5.3 规范漂移修正）', () => {
    it('glm-5.3（含中转前缀）强制思考，effort 仅 low/high/max，默认 max', () => {
      const control = resolveReasoningControl({ model: 'codex666-glm-5.3-flash', adapterId: 'zhipu' });
      expect(control.kind).toBe('glm-effort');
      expect(control.canDisable).toBe(false);
      expect(control.options.map(o => o.value)).toEqual(['low', 'high', 'max']);
      expect(control.defaultValue).toBe('max');
    });

    it('glm-5.2 保留全档位且可关闭，默认 max', () => {
      const control = resolveReasoningControl({ model: 'glm-5.2', adapterId: 'zhipu' });
      expect(control.kind).toBe('glm-effort');
      expect(control.canDisable).toBe(true);
      expect(control.defaultValue).toBe('max');
    });
  });

  describe('Moonshot 渠道（K3 effort 开放）', () => {
    it('kimi-k3 为 moonshot-effort（low/high/max，默认 max，不可关闭）', () => {
      const control = resolveReasoningControl({ model: 'kimi-k3', adapterId: 'moonshot' });
      expect(control.kind).toBe('moonshot-effort');
      expect(control.canDisable).toBe(false);
      expect(control.defaultValue).toBe('max');
    });
  });

  describe('Grok 渠道', () => {
    it('grok-4.7 含 xhigh 档且默认 xhigh、不可关闭', () => {
      const control = resolveReasoningControl({ model: 'grok-4.7', adapterId: 'grok' });
      expect(control.kind).toBe('grok-effort');
      expect(control.canDisable).toBe(false);
      expect(control.options.map(o => o.value)).toContain('xhigh');
      expect(control.defaultValue).toBe('xhigh');
    });

    it('grok-4.5 不含 xhigh 档（默认 high）', () => {
      const control = resolveReasoningControl({ model: 'grok-4.5', adapterId: 'grok' });
      expect(control.options.map(o => o.value)).not.toContain('xhigh');
      expect(control.defaultValue).toBe('high');
    });

    it('grok-4.3 保持可关闭，默认最高档 high', () => {
      const control = resolveReasoningControl({ model: 'grok-4.3', adapterId: 'grok' });
      expect(control.canDisable).toBe(true);
      expect(control.defaultValue).toBe('high');
    });
  });

  describe('Gemini 渠道', () => {
    it('gemini-3.8-flash 默认最高档 high（方案 E 覆盖官方 medium 默认）', () => {
      const control = resolveReasoningControl({ model: 'gemini-3.8-flash', adapterId: 'google' });
      expect(control.kind).toBe('gemini-flash-effort');
      expect(control.defaultValue).toBe('high');
    });

    it('gemini-3.5-flash-lite 默认最高档 high', () => {
      const control = resolveReasoningControl({ model: 'gemini-3.5-flash-lite', adapterId: 'google' });
      expect(control.defaultValue).toBe('high');
    });
  });

  describe('generic 渠道思考强度开关', () => {
    it('开关打开：openai-effort 四档，默认最高档 xhigh', () => {
      const raw = resolveGenericChannel({ model: 'some-unknown-llm', supportsReasoning: true });
      expect(raw.kind).toBe('openai-effort');
      expect(raw.options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
      const control = resolveReasoningControl({ model: 'some-unknown-llm', adapterId: 'general', supportsReasoning: true });
      expect(control.defaultValue).toBe('xhigh');
    });

    it('开关关闭：仅思考开关（toggle-only）', () => {
      const control = resolveGenericChannel({ model: 'some-unknown-llm', supportsReasoning: false });
      expect(control.kind).toBe('toggle-only');
      expect(control.options).toHaveLength(0);
    });

    it('注册表路径：general 渠道 + 开关打开 → 档位下拉', () => {
      const control = resolveReasoningControl({
        model: 'some-unknown-llm',
        adapterId: 'general',
        supportsReasoning: true,
      });
      expect(control.kind).toBe('openai-effort');
    });
  });

  describe('注册表与兜底', () => {
    it('家族渠道对陌生模型回退仅开关（不误给 effort 档位）', () => {
      const control = resolveReasoningControl({ model: 'qwen-totally-unknown-variant', adapterId: 'qwen' });
      expect(control.kind).toBe('toggle-only');
    });

    it('无 adapterId 时走原判定链（存量行为兼容）', () => {
      expect(resolveReasoningControl({ model: 'deepseek-v4-pro' }).kind).toBe('v4-effort');
      expect(
        resolveReasoningControl({ model: 'deepseek-v4-pro' }).kind
      ).toBe(
        resolveDeepSeekRuntimeReasoningControl({ model: 'deepseek-v4-pro', supportsReasoningEffort: false }).kind
      );
    });

    it('渠道身份路径：qwen 渠道 + 中转前缀 qwen3.8-max → qwen-effort', () => {
      const control = resolveReasoningControl({
        model: 'relay-x-qwen3.8-max',
        adapterId: 'qwen',
        providerType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      });
      expect(control.kind).toBe('qwen-effort');
      expect(control.defaultValue).toBe('xhigh');
    });
  });
});
