import { describe, expect, it } from 'vitest';
import { DoubaoAdapter } from '../src/adapters/doubao.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new DoubaoAdapter();
const typeOf = (body: Body) => (body.thinking as Body).type;

describe('adapters/doubao.rs', () => {
  it('test_thinking_type_enabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, model: 'doubao-1-5-thinking-pro-250415' }), null);
    expect(typeOf(body)).toBe('enabled');
  });
  it('test_thinking_type_disabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: false, model: 'doubao-1-5-thinking-pro-250415' }), null);
    expect(typeOf(body)).toBe('disabled');
  });
  it('test_seed_model_auto_mode', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'auto', model: 'doubao-seed-1-6-thinking-250715' }), null);
    expect(typeOf(body)).toBe('auto');
  });
  it('test_seed_model_medium_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'medium', model: 'doubao-seed-1-6-vision-250715' }), null);
    expect(typeOf(body)).toBe('auto');
  });
  it('test_thinking_pro_m_supports_auto', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'auto', model: 'doubao-1-5-thinking-pro-m-250428' }), null);
    expect(typeOf(body)).toBe('auto');
  });
  it('test_thinking_pro_non_m_no_auto', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'auto', model: 'doubao-1-5-thinking-pro-250415' }), null);
    expect(typeOf(body)).toBe('enabled');
  });
  it('test_seed_model_default_enabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, model: 'doubao-seed-1-6-thinking-250715' }), null);
    expect(typeOf(body)).toBe('enabled');
  });
  it('test_keep_temperature', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({ isReasoning: true }))).toBe(false);
  });
  it('test_passback_policy_deepseek_style', () => {
    expect(adapter.getPassbackPolicy(makeConfig({ supportsReasoning: true, model: 'doubao-seed-1-6-thinking-250715' }))).toBe('deep_seek_style');
  });
  it('test_passback_policy_no_passback', () => {
    expect(adapter.getPassbackPolicy(makeConfig({ model: 'doubao-1.5-pro-32k' }))).toBe('no_passback');
  });
  it('test_non_reasoning_model_no_thinking', () => {
    const body: Body = {};
    expect(adapter.applyReasoningConfig(body, makeConfig({ model: 'doubao-1.5-pro-32k' }), null)).toBe(false);
    expect(body.thinking).toBeUndefined();
  });
});
