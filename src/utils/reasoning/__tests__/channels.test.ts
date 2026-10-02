import { describe, expect, it } from 'vitest';

import { resolveReasoningControl } from '../registry';
import { resolveGenericChannel, resolveQwenChannel } from '../channels';
import {
  resolveDeepSeekRuntimeReasoningControl,
  resolveDeepSeekRuntimeReasoningSelection,
} from '../../deepseekReasoningControls';

describe('渠道并行思考强度（方案 D）', () => {
  describe('Qwen 渠道', () => {
    it('qwen3.8 系走 reasoning_effort 档位（low/medium/xhigh，默认 xhigh）', () => {
      for (const model of ['qwen3.8-max', 'qwen3.8-flash', 'Qwen/qwen3.8-27b']) {
        const control = resolveQwenChannel({ model });
        expect(control?.kind).toBe('qwen-effort');
        expect(control?.canDisable).toBe(true);
        expect(control?.defaultValue).toBe('xhigh');
        expect(control?.options.map(o => o.value)).toEqual(['low', 'medium', 'xhigh']);
      }
    });

    it('qwen3.7 及更早混合思考模型走 budget 档位', () => {
      const control = resolveQwenChannel({ model: 'qwen3.7-max' });
      expect(control?.kind).toBe('qwen-budget-effort');
      expect(control?.options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('SiliconFlow 宿主变体的 xhigh 上限为 32768（不含 262144 档）', () => {
      const control = resolveQwenChannel({
        model: 'qwen3.7-max',
        providerType: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
      });
      expect(control?.kind).toBe('qwen-budget-effort');
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
    it('gpt-6 系识别为 openai-effort 且含 max 档', () => {
      const control = resolveReasoningControl({ model: 'gpt-6-sol', adapterId: 'openai' });
      expect(control.kind).toBe('openai-effort');
      expect(control.options.map(o => o.value)).toContain('max');
      expect(control.canDisable).toBe(true);
    });

    it('gpt-5.6 仍含原生 max 档', () => {
      const control = resolveReasoningControl({ model: 'gpt-5.6', adapterId: 'general' });
      expect(control.kind).toBe('openai-effort');
      expect(control.options.map(o => o.value)).toContain('max');
    });
  });

  describe('智谱渠道（GLM-5.3 规范漂移修正）', () => {
    it('glm-5.3 强制思考，effort 仅 low/high/max', () => {
      const control = resolveReasoningControl({ model: 'glm-5.3', adapterId: 'zhipu' });
      expect(control.kind).toBe('glm-effort');
      expect(control.canDisable).toBe(false);
      expect(control.options.map(o => o.value)).toEqual(['low', 'high', 'max']);
      expect(control.defaultValue).toBe('max');
    });

    it('glm-5.2 保留全档位且可关闭', () => {
      const control = resolveReasoningControl({ model: 'glm-5.2', adapterId: 'zhipu' });
      expect(control.kind).toBe('glm-effort');
      expect(control.canDisable).toBe(true);
      expect(control.options.map(o => o.value)).toContain('minimal');
    });
  });

  describe('Moonshot 渠道（K3 effort 开放）', () => {
    it('kimi-k3 为 moonshot-effort（low/high/max，默认 max，不可关闭）', () => {
      const control = resolveReasoningControl({ model: 'kimi-k3', adapterId: 'moonshot' });
      expect(control.kind).toBe('moonshot-effort');
      expect(control.canDisable).toBe(false);
      expect(control.options.map(o => o.value)).toEqual(['low', 'high', 'max']);
      expect(control.defaultValue).toBe('max');
    });
  });

  describe('Grok 渠道（4.5+ 不可关闭 / xhigh 仅 4.6+）', () => {
    it('grok-4.7 含 xhigh 档且不可关闭', () => {
      const control = resolveReasoningControl({ model: 'grok-4.7', adapterId: 'grok' });
      expect(control.kind).toBe('grok-effort');
      expect(control.canDisable).toBe(false);
      expect(control.options.map(o => o.value)).toContain('xhigh');
    });

    it('grok-4.5 不含 xhigh 档', () => {
      const control = resolveReasoningControl({ model: 'grok-4.5', adapterId: 'grok' });
      expect(control.options.map(o => o.value)).not.toContain('xhigh');
      expect(control.canDisable).toBe(false);
    });

    it('grok-4.3 保持可关闭', () => {
      const control = resolveReasoningControl({ model: 'grok-4.3', adapterId: 'grok' });
      expect(control.canDisable).toBe(true);
    });
  });

  describe('Gemini 渠道（3.8/3.7 默认档修正）', () => {
    it('gemini-3.8-flash 默认 medium', () => {
      const control = resolveReasoningControl({ model: 'gemini-3.8-flash', adapterId: 'google' });
      expect(control.kind).toBe('gemini-flash-effort');
      expect(control.defaultValue).toBe('medium');
    });

    it('gemini-3.5-flash-lite 默认 minimal', () => {
      const control = resolveReasoningControl({ model: 'gemini-3.5-flash-lite', adapterId: 'google' });
      expect(control.defaultValue).toBe('minimal');
    });
  });

  describe('generic 渠道思考强度开关', () => {
    it('开关打开：openai-effort 四档（low/medium/high/xhigh）', () => {
      const control = resolveGenericChannel({ model: 'some-unknown-llm', supportsReasoning: true });
      expect(control.kind).toBe('openai-effort');
      expect(control.options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(control.canDisable).toBe(true);
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
    it('家族渠道对陌生模型回退 generic（不再被其他家族分支截胡）', () => {
      const control = resolveReasoningControl({ model: 'totally-unknown', adapterId: 'qwen' });
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

    it('渠道身份路径：qwen 渠道 + qwen3.8-max → qwen-effort', () => {
      const control = resolveReasoningControl({
        model: 'qwen3.8-max',
        adapterId: 'qwen',
        providerType: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      });
      expect(control.kind).toBe('qwen-effort');
    });
  });
});
