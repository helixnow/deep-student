/**
 * `qbank_resolve_authoring_route` 的模型校验与视觉兜底选择。
 *
 * Rust 该命令没有内联测试；这里锁定从 L02
 * `resolve_question_authoring_config` / `resolve_visual_fallback` 复刻的选择顺序，
 * 防止命令接线后出现“任意多模态配置都能兜底”或忽略优先级。
 */
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import {
  pickVisualFallback, resolveVisualFallback, validateAuthoringConfig,
} from '../src/authoring-route.ts';
import type { LLMManager, LlmOcrModels } from '../../llm/api.ts';
import { rangePlanRequiredError, type SourceRangePlan } from '../src/source-range-plan.ts';

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'cfg_main', name: '主模型', vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: '', baseUrl: '', model: 'main', isMultimodal: false, isReasoning: false,
    isEmbedding: false, isReranker: false, isImageGeneration: false, enabled: true,
    modelAdapter: '', maxOutputTokens: 4096, temperature: 0, supportsTools: true,
    geminiApiVersion: '', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
    resolvedAdapterId: null,
    ...overrides,
  };
}

function expectConfiguration(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    expect((error as { appError?: { error_type?: string; message?: string } }).appError)
      .toMatchObject({ error_type: 'Configuration', message });
    return;
  }
  throw new Error('expected a Configuration AppError');
}

describe('qbank_resolve_authoring_route', () => {
  it('validates_missing_disabled_special_and_zero_token_models_like_rust', () => {
    expectConfiguration(() => validateAuthoringConfig(undefined, 'missing'),
      '找不到指定的解析模型: missing');
    expectConfiguration(() => validateAuthoringConfig(config({ enabled: false }), null),
      '解析模型必须是已启用的对话模型');
    expectConfiguration(() => validateAuthoringConfig(config({ isEmbedding: true }), null),
      '解析模型必须是已启用的对话模型');
    expectConfiguration(() => validateAuthoringConfig(config({ isReranker: true }), null),
      '解析模型必须是已启用的对话模型');
    expectConfiguration(() => validateAuthoringConfig(config({ isImageGeneration: true }), null),
      '解析模型必须是已启用的对话模型');
    expectConfiguration(() => validateAuthoringConfig(config({ maxOutputTokens: 0 }), null),
      '模型 token 配置必须为正数');
    expectConfiguration(() => validateAuthoringConfig(config({ maxTokensLimit: 0 }), null),
      '模型 token 配置必须为正数');
    expectConfiguration(() => validateAuthoringConfig(config({ contextWindow: 0 }), null),
      '模型 token 配置必须为正数');
    expect(validateAuthoringConfig(config({ isMultimodal: true }), null).id).toBe('cfg_main');
  });

  it('prefers_ocr_config_then_enabled_engines_by_priority_and_rejects_unusable_candidates', () => {
    const ocr = config({ id: 'cfg_ocr', isMultimodal: true });
    const high = config({ id: 'cfg_high', isMultimodal: true });
    const low = config({ id: 'cfg_low', isMultimodal: true });
    expect(pickVisualFallback([high], ocr, [])).toBe(ocr);

    expect(pickVisualFallback([low, high], null, [
      { config_id: 'cfg_low', enabled: true, priority: 20 },
      { config_id: 'cfg_high', enabled: true, priority: 10 },
      { config_id: 'cfg_ocr', enabled: true, priority: 1 },
    ])).toBe(high);

    expect(pickVisualFallback([
      config({ id: 'cfg_disabled', isMultimodal: true, enabled: false }),
      config({ id: 'cfg_embedding', isMultimodal: true, isEmbedding: true }),
      config({ id: 'cfg_reranker', isMultimodal: true, isReranker: true }),
      config({ id: 'cfg_text', isMultimodal: false }),
    ], null, [
      { config_id: 'cfg_disabled', enabled: true, priority: 1 },
      { config_id: 'cfg_embedding', enabled: true, priority: 2 },
      { config_id: 'cfg_reranker', enabled: true, priority: 3 },
      { config_id: 'cfg_text', enabled: true, priority: 4 },
      { config_id: 'cfg_high', enabled: false, priority: 5 },
    ])).toBeNull();
  });

  it('ocr_config_present_but_unusable_falls_through_to_engine_candidates', async () => {
    // Rust resolve_visual_fallback：OCR 配置读到但不可用时继续查启用引擎，而不是直接报错。
    const ocr = config({ id: 'cfg_ocr', isMultimodal: false });
    const engine = config({ id: 'cfg_engine', isMultimodal: true });
    const host = {
      llm: { getApiConfigs: async () => [engine] } as unknown as LLMManager,
      ocr: {
        getOcrModelConfig: async () => ocr,
        getAvailableOcrModels: async () => [{ config_id: 'cfg_engine', enabled: true, priority: 1 }],
      } as unknown as LlmOcrModels,
    };
    await expect(resolveVisualFallback(host)).resolves.toBe(engine);
    const none = { ...host, llm: { getApiConfigs: async () => [] } as unknown as LLMManager };
    await expect(resolveVisualFallback(none)).rejects.toMatchObject({
      appError: { error_type: 'Configuration', message: '当前主模型无视觉能力，且未配置可用的多模态视觉兜底模型' } });
  });
});

describe('range_plan_required_error', () => {
  const plan = { reason: 'context_window', requires_user_selection: true } as unknown as SourceRangePlan;
  it('keeps_non_object_details_unchanged_and_extends_object_details_in_place', () => {
    // plan.rs:490-510：只有对象 details 才插入字段；None → {}；其他类型原样保留。
    expect(rangePlanRequiredError({ error_type: 'LLM', message: 'm', details: 'raw' }, plan).details).toBe('raw');
    const fromNone = rangePlanRequiredError({ error_type: 'LLM', message: 'm', details: null }, plan).details;
    expect(fromNone).toMatchObject({ code: 'SOURCE_RANGE_PLAN_REQUIRED', provider_error: 'm' });
    const kept = rangePlanRequiredError({ error_type: 'LLM', message: 'm', details: { status: 400, code: 'x' } }, plan);
    expect(Object.keys(kept.details as object).slice(0, 3)).toEqual(['status', 'code', 'reason']);
    expect((kept.details as { code: string }).code).toBe('SOURCE_RANGE_PLAN_REQUIRED');
  });
});
