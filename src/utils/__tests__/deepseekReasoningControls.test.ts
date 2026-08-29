import { describe, expect, it } from 'vitest';
import {
  deepSeekV32EffortToBudget,
  resolveDeepSeekRuntimeReasoningControl,
  resolveDeepSeekRuntimeReasoningSelection,
} from '../deepseekReasoningControls';

describe('DeepSeek runtime reasoning controls', () => {
  it('uses modern runtime options for OpenAI GPT-5.5 and represents none as off', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'gpt-5.5',
      providerType: 'openai',
      providerScope: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(control.kind).toBe('openai-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(control.canDisable).toBe(true);
  });

  it.each([
    ['gpt-5', 'openai', ['minimal', 'low', 'medium', 'high'], false],
    ['gpt-5-pro', 'openai', ['high'], false],
    ['gpt-5.5-pro', 'openai', ['medium', 'high', 'xhigh'], false],
    ['gpt-oss-120b', 'openai-compatible', ['low', 'medium', 'high'], false],
    ['gpt-5.1', 'openai', ['low', 'medium', 'high'], true],
    ['gpt-5.5', 'openai_codex', ['low', 'medium', 'high', 'xhigh'], false],
    ['gpt-5.6', 'openai', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['gpt-5.6-sol', 'openai_codex', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['gpt-5.6-terra', 'openai_codex', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['codex-mini-latest', 'openai_codex', ['low', 'medium', 'high'], false],
    ['gpt-5', 'openai_codex', ['minimal', 'low', 'medium', 'high'], false],
  ] as const)('crops OpenAI/Codex effort levels for %s', (model, providerType, values, canDisable) => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model,
      providerType,
      providerScope: providerType,
    });

    expect(control.options.map((option) => option.value)).toEqual(values);
    expect(control.canDisable).toBe(canDisable);
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

  it('uses SiliconFlow budget presets instead of the hosted model effort dialect', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({
      model: 'THUDM/GLM-5.2',
      providerType: 'siliconflow',
      providerScope: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
    });

    expect(control.kind).toBe('v32-budget-effort');
    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control,
        enableThinking: true,
        reasoningEffort: 'high',
      })
    ).toEqual({
      enableThinking: true,
      reasoningEffort: 'high',
      thinkingBudget: 16384,
    });
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

  it.each([
    'grok-4.10-non-reasoning',
    'gpt-5.1-chat-latest',
    'foo1-model',
    'vision-o3cr-model',
  ])('does not classify incidental OpenAI-family substrings as reasoning models: %s', (model) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });

    expect(control.kind).toBe('toggle-only');
    expect(control.options).toEqual([]);
  });

  it.each([
    ['gemini-3.1-pro-preview', 'gemini-pro-effort', ['low', 'high'], false],
    ['gemini-3.5-flash', 'gemini-flash-effort', ['minimal', 'low', 'medium', 'high'], false],
    ['claude-opus-4-8', 'anthropic-adaptive-effort', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['claude-sonnet-4-6', 'anthropic-adaptive-effort', ['low', 'medium', 'high', 'max'], true],
    ['claude-haiku-5', 'anthropic-adaptive-effort', ['low', 'medium', 'high', 'max'], true],
    ['claude-fable-5', 'anthropic-adaptive-effort', ['low', 'medium', 'high', 'xhigh', 'max'], false],
    ['glm-5.2', 'glm-effort', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], true],
    ['grok-4.3-latest', 'grok-effort', ['low', 'medium', 'high'], true],
    ['grok-latest', 'grok-effort', ['low', 'medium', 'high'], true],
    ['grok-4.20-multi-agent-0309', 'grok-effort', ['low', 'medium', 'high', 'xhigh'], false],
    ['mistral-medium-latest', 'mistral-effort', ['low', 'medium', 'high'], true],
    ['ernie-5.0-thinking', 'ernie-effort', ['high', 'max'], true],
  ] as const)('exposes the official runtime effort matrix for %s', (model, kind, values, canDisable) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });

    expect(control.kind).toBe(kind);
    expect(control.options.map((option) => option.value)).toEqual(values);
    expect(control.canDisable).toBe(canDisable);
  });

  it.each([
    ['gemini-3.5-flash', 'medium'],
    // flash-lite 包含 "gemini-3.5-flash" 子串，需先匹配，默认 "minimal"（与后端 gemini.rs 一致）
    ['gemini-3.5-flash-lite', 'minimal'],
    ['gemini-3.5-flash-lite-preview-08-2026', 'minimal'],
    ['gemini-3.1-flash-lite', 'minimal'],
    ['gemini-3-flash-preview', 'high'],
    ['gemini-3.1-pro-preview', 'high'],
  ] as const)('uses the provider default reasoning depth for %s', (model, expected) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });

    expect(resolveDeepSeekRuntimeReasoningSelection({ control, enableThinking: true })).toEqual({
      enableThinking: true,
      reasoningEffort: expected,
      thinkingBudget: undefined,
    });
  });

  it.each([
    'qwen3.7-plus',
    'doubao-seed-1-6-thinking',
    'MiniMax-M3',
    'mimo-v2.5-pro',
    'kimi-k2.6',
  ])('keeps budget/toggle-only reasoning models without invented effort levels: %s', (model) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });

    expect(control.kind).toBe('toggle-only');
    expect(control.options).toEqual([]);
  });

  it.each([
    'gpt-5.3-codex',
    'gemini-2.5-pro',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2-thinking',
    'kimi-thinking-preview',
    'kimi-vl-a3b-thinking',
    'MiniMax-M2.7',
    'deepseek-ai/DeepSeek-R1',
    'QwQ-32B',
    'qwen3.7-max-preview',
    'qwen3.7-max-2026-05-17',
    'Qwen/Qwen3-235B-A22B-Thinking-2507',
    'Qwen/Qwen3-VL-235B-A22B-Thinking',
  ])('marks forced-thinking models as non-disableable: %s', (model) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });
    expect(control.canDisable).toBe(false);
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control,
        enableThinking: false,
      }).enableThinking
    ).toBe(true);
  });

  it.each([
    'kimi-k2.5',
    'kimi-k2.6',
    'MiniMax-M3',
  ])('keeps modern adaptive thinking models disableable: %s', (model) => {
    expect(resolveDeepSeekRuntimeReasoningControl({ model }).canDisable).toBe(true);
  });

  // 后端 moonshot 适配器对 K3+ 固定发送 reasoning_effort=max 且推理不可关闭；
  // 前端必须 forced（canDisable=false），且不发明后端不接受的档位选项。
  it.each([
    'kimi-k3',
    'kimi-k3-0905-preview',
    'moonshotai/Kimi-K3-Instruct',
    'kimi-k3.1',
  ])('aligns Kimi K3+ with the backend forced reasoning_effort=max contract: %s', (model) => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model });

    expect(control.kind).toBe('toggle-only');
    expect(control.options).toEqual([]);
    expect(control.canDisable).toBe(false);
    expect(
      resolveDeepSeekRuntimeReasoningSelection({ control, enableThinking: false })
    ).toEqual({ enableThinking: true, reasoningEffort: undefined, thinkingBudget: undefined });
  });

  it.each([
    'kimi-k2.6',
    'kimi-k2-0905-preview',
    'kimi-latest',
    'moonshot-v1-128k',
  ])('does not misclassify non-K3 Kimi/Moonshot models as forced K3: %s', (model) => {
    expect(resolveDeepSeekRuntimeReasoningControl({ model }).canDisable).toBe(true);
  });

  it.each([
    'qwen3.7-plus',
    'qwen3.7-max-2026-06-08',
    'qwen-plus',
    'qwen-turbo',
  ])('keeps hybrid Qwen models disableable: %s', (model) => {
    expect(resolveDeepSeekRuntimeReasoningControl({ model }).canDisable).toBe(true);
  });

  it('normalizes vendor effort choices and clears stale budgets', () => {
    const control = resolveDeepSeekRuntimeReasoningControl({ model: 'gemini-3.5-flash' });

    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control,
        enableThinking: true,
        reasoningEffort: 'minimal',
        thinkingBudget: 32768,
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'minimal', thinkingBudget: undefined });
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

  it('keeps the max runtime depth for GPT-5.6 instead of falling back', () => {
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'gpt-5.6', providerType: 'openai' }),
        enableThinking: true,
        reasoningEffort: 'max',
        thinkingBudget: 32768,
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'max', thinkingBudget: undefined });

    // 非 5.6 的 GPT-5 系列不认识 max，仍回退到 medium
    expect(
      resolveDeepSeekRuntimeReasoningSelection({
        control: resolveDeepSeekRuntimeReasoningControl({ model: 'gpt-5.5', providerType: 'openai' }),
        enableThinking: true,
        reasoningEffort: 'max',
      })
    ).toEqual({ enableThinking: true, reasoningEffort: 'medium', thinkingBudget: undefined });
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
