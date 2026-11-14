import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../api.ts';
import { MiniMaxAdapter, parseMiniMaxVersion } from '../src/adapters/minimax.ts';
import { requestAdapterForConfig } from '../src/adapters/registry.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new MiniMaxAdapter();

function createTestConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return makeConfig({
    supportsReasoning: true,
    isReasoning: true,
    thinkingEnabled: true,
    reasoningSplit: true,
    ...overrides,
  });
}

describe('adapters/minimax.rs', () => {
  it('test_parse_m_version', () => {
    expect(parseMiniMaxVersion('MiniMax-M3')).toStrictEqual([3, 0]);
    expect(parseMiniMaxVersion('MiniMax-M2.7-highspeed')).toStrictEqual([2, 7]);
    expect(parseMiniMaxVersion('MiniMax-M2.5')).toStrictEqual([2, 5]);
    expect(parseMiniMaxVersion('M2-her')).toStrictEqual([2, 0]);
    expect(parseMiniMaxVersion('MiniMax-M3.5')).toStrictEqual([3, 5]);
    expect(parseMiniMaxVersion('abab6.5s-chat')).toBeNull();
  });

  it('test_no_enable_thinking', () => {
    const config = createTestConfig({ model: 'MiniMax-M2.5' });
    const body: Body = {};

    adapter.applyReasoningConfig(body, config, true);

    // MiniMax 不应该添加 enable_thinking
    expect('enable_thinking' in body).toBe(false);
  });

  it('test_m2_thinking_removed', () => {
    const config = createTestConfig({ model: 'MiniMax-M2.5' });
    const body: Body = { thinking: { type: 'disabled' } };

    adapter.applyReasoningConfig(body, config, null);

    // M2.x 思考无法关闭，thinking 参数无效，保持移除行为
    expect('thinking' in body).toBe(false);
  });

  it('test_m3_thinking_adaptive_when_enabled', () => {
    const config = createTestConfig({ model: 'MiniMax-M3' });
    const body: Body = {};

    adapter.applyReasoningConfig(body, config, true);

    // M3 开思考用 adaptive（不是 enabled）
    expect(body.thinking).toStrictEqual({ type: 'adaptive' });
  });

  it('test_m3_thinking_disabled_intent_preserved', () => {
    const config = createTestConfig({ model: 'MiniMax-M3' });
    const body: Body = {};

    adapter.applyReasoningConfig(body, config, false);

    // 旧实现把 thinking 一律移除，M3 上用户的关闭意图被吞——现在必须传达
    expect(body.thinking).toStrictEqual({ type: 'disabled' });
  });

  it('test_m3_normalizes_enabled_to_adaptive', () => {
    const config = createTestConfig({ model: 'MiniMax-M3' });
    // 上游通用逻辑可能注入 enabled，M3 只接受 adaptive/disabled
    const body: Body = { thinking: { type: 'enabled' } };

    adapter.applyReasoningConfig(body, config, null);

    expect(body.thinking).toStrictEqual({ type: 'adaptive' });
  });

  it('test_m3_keeps_explicit_disabled_in_body', () => {
    // thinkingEnabled: true
    const config = createTestConfig({ model: 'MiniMax-M3' });
    const body: Body = { thinking: { type: 'disabled' } };

    adapter.applyReasoningConfig(body, config, null);

    // body 中已显式给出的 disabled（用户 extra 参数）优先于配置
    expect(body.thinking).toStrictEqual({ type: 'disabled' });
  });

  it('test_m3_unsupported_fields_removed', () => {
    const config = createTestConfig({ model: 'MiniMax-M3' });
    const body: Body = {
      enable_thinking: true,
      thinking_budget: 2048,
      include_thoughts: true,
    };

    adapter.applyReasoningConfig(body, config, true);

    expect('enable_thinking' in body).toBe(false);
    expect('thinking_budget' in body).toBe(false);
    expect('include_thoughts' in body).toBe(false);
    expect(body.thinking).toStrictEqual({ type: 'adaptive' });
  });

  it('test_keep_sampling_params', () => {
    const config = createTestConfig();
    const body: Body = { temperature: 1.0, top_p: 0.9 };

    adapter.applyReasoningConfig(body, config, null);

    // MiniMax 应该保留 temperature 和 top_p
    expect('temperature' in body).toBe(true);
    expect('top_p' in body).toBe(true);
  });

  it('test_reasoning_split', () => {
    const config = createTestConfig();
    const body: Body = {};

    adapter.applyCommonParams(body, config);

    expect(body.reasoning_split).toBe(true);
  });

  it('test_reasoning_split_is_applied_through_llm_manager_pipeline', () => {
    const config = createTestConfig({
      model: 'MiniMax-M3',
      modelAdapter: 'minimax',
      providerType: 'minimax',
      reasoningSplit: true,
    });
    const body: Body = { model: config.model, messages: [], stream: true };

    // LLMManager::apply_reasoning_config 的适配器分派（request_adapter_for_config）
    requestAdapterForConfig(config).applyReasoningConfig(body, config, true);

    expect(body.reasoning_split).toBe(true);
    expect(body.thinking).toStrictEqual({ type: 'adaptive' });
    expect('enable_thinking' in body).toBe(false);
  });

  // Rust 只接受 1~2 位 minor（`(1..=2).contains(&minor_str.len())`），
  // 更长的数字串按无 minor 处理；确认 TS 与 Rust 同口径。
  it('parseMiniMaxVersion_ignores_minor_with_more_than_two_digits', () => {
    expect(parseMiniMaxVersion('MiniMax-M3.555')).toStrictEqual([3, 0]);
    expect(parseMiniMaxVersion('MiniMax-M2-1234-highspeed')).toStrictEqual([2, 0]);
    expect(parseMiniMaxVersion('MiniMax-M3.55')).toStrictEqual([3, 55]);
  });
});
