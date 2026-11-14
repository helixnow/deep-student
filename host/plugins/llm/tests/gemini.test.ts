import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new GeminiAdapter();
const config = (body: Body) => body.thinkingConfig as Body;

describe('adapters/gemini.rs', () => {
  it('test_gemini_25_thinking_budget', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: 4096, includeThoughts: true,
      model: 'gemini-2.5-pro',
    }), null);
    expect(config(body).thinkingBudget).toBe(4096);
    expect(config(body).includeThoughts).toBe(true);
  });

  it('test_gemini_3_thinking_level', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, reasoningEffort: 'high', model: 'gemini-3.1-pro-preview',
    }), null);
    expect(config(body).thinkingLevel).toBe('high');
    expect(config(body).thinkingBudget).toBeUndefined();
  });

  it('test_gemini_3_flash_default_level', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'gemini-3.5-flash',
    }), null);
    expect(config(body).thinkingLevel).toBe('medium');
  });

  it('test_gemini_3_pro_default_level_is_high', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'gemini-3.1-pro-preview',
    }), null);
    expect(config(body).thinkingLevel).toBe('high');
  });

  it('test_gemini_3_flash_medium_level', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, reasoningEffort: 'medium', model: 'gemini-3.5-flash',
    }), null);
    expect(config(body).thinkingLevel).toBe('medium');
  });

  it('test_gemini_3_flash_minimal_level', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'gemini-3.5-flash',
    }), null);
    expect(config(body).thinkingLevel).toBe('minimal');
  });

  it('test_gemini_3_pro_cannot_disable', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'gemini-3.1-pro-preview',
    }), null);
    expect(config(body).thinkingLevel).toBe('low');
  });

  it('test_gemini_25_drops_openai_compat_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, reasoningEffort: 'high', model: 'gemini-2.5-flash',
    }), null);
    expect(body.reasoning_effort).toBeUndefined();
    expect(config(body).thinkingBudget).toBe(-1);
  });

  it('test_gemini_api_version', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ geminiApiVersion: 'v1beta' }), null);
    expect(body.gemini_api_version).toBe('v1beta');
  });

  it('test_default_thinking_budget_gemini_25', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: null, model: 'gemini-2.5-pro',
    }), null);
    expect(config(body).thinkingBudget).toBe(-1);
  });

  it('test_gemini_25_flash_disable_thinking', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'gemini-2.5-flash',
    }), null);
    expect(config(body).thinkingBudget).toBe(0);
  });

  it('test_gemini_25_pro_budget_bounds', () => {
    const cases: Array<[number, number]> = [
      [-2, -1], [-1, -1], [0, 128], [32768, 32768], [50000, 32768],
    ];
    for (const [budget, expected] of cases) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({
        thinkingEnabled: true, thinkingBudget: budget, model: 'gemini-2.5-pro',
      }), null);
      expect(config(body).thinkingBudget, `budget=${budget}`).toBe(expected);
    }
  });

  it('test_gemini_25_flash_budget_bounds', () => {
    const cases: Array<[number, number]> = [
      [-2, -1], [-1, -1], [0, 0], [24576, 24576], [50000, 24576],
    ];
    for (const [budget, expected] of cases) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({
        thinkingEnabled: true, thinkingBudget: budget, model: 'gemini-2.5-flash',
      }), null);
      expect(config(body).thinkingBudget, `budget=${budget}`).toBe(expected);
    }
  });

  it('test_gemini_3_model_specific_default_levels', () => {
    const cases: Array<[string, string]> = [
      ['gemini-3.5-flash', 'medium'],
      ['gemini-3.5-flash-lite', 'minimal'],
      ['gemini-3.5-flash-lite-preview-08-2026', 'minimal'],
      ['gemini-3.1-flash-lite', 'minimal'],
      ['gemini-3-flash-preview', 'high'],
      ['gemini-3.1-pro-preview', 'high'],
    ];
    for (const [model, expected] of cases) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({
        thinkingEnabled: true, model,
      }), null);
      expect(config(body).thinkingLevel, `model=${model}`).toBe(expected);
    }
  });

  it('test_keeps_penalty_params', () => {
    const body: Body = {
      frequency_penalty: 0.5, presence_penalty: 0.5, temperature: 0.7,
    };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'gemini-2.5-pro' }), null);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(0.5);
    expect(body.temperature).toBe(0.7);
  });
});
