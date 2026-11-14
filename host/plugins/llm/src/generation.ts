/** Generation parameter assembly (model2_pipeline.rs apply_generation_params).
 * The sampling fields are f32 on ApiConfig; `json!(f32)` under arbitrary_precision writes the shortest f32 decimal.
 */
import { f32ToJsonNumber } from '../../../platform/util/portable.ts';
import type { ApiConfig } from '../api.ts';
import { applyOfficialDeepseekGenerationParams } from './adapters/deepseek.ts';
import { resolveEndpointQuirks, type MaxTokensField, type ProviderQuirks } from './provider_quirks.ts';
import { removeKey } from './json_map.ts';

type JsonObject = { [key: string]: unknown };

export function effectiveMaxTokens(
  maxOutputTokens: number, maxTokensLimit: number | null,
): number {
  const requested = maxOutputTokens > 0 ? maxOutputTokens : 8192;
  return maxTokensLimit !== null && maxTokensLimit > 0
    ? Math.min(requested, maxTokensLimit) : requested;
}

function applyTokenLimit(body: JsonObject, field: MaxTokensField, maxTokens: number): void {
  if (field === 'max_tokens') {
    body.max_tokens = maxTokens;
    removeKey(body, 'max_completion_tokens');
  } else {
    body.max_completion_tokens = maxTokens;
    removeKey(body, 'max_tokens');
  }
}

function applyGenerationTokenLimit(
  body: JsonObject, quirks: ProviderQuirks, maxTokens: number,
): void {
  if (quirks.max_tokens_field === 'max_completion_tokens' && quirks.preserve_existing_max_tokens) {
    body.max_completion_tokens = maxTokens;
  } else {
    applyTokenLimit(body, quirks.max_tokens_field, maxTokens);
  }
}

export function applyLegacyGenerationTokenLimit(
  body: JsonObject, quirks: ProviderQuirks, maxTokens: number,
): void {
  applyTokenLimit(body, quirks.legacy_max_tokens_field, maxTokens);
}

export function applyGenerationParams(
  body: JsonObject, config: ApiConfig, quirks: ProviderQuirks,
): void {
  if (applyOfficialDeepseekGenerationParams(body, config)) return;
  const maxTokens = effectiveMaxTokens(config.maxOutputTokens, config.maxTokensLimit);
  applyGenerationTokenLimit(body, quirks, maxTokens);
  if (quirks.sampling_params_allowed) {
    body.temperature = f32ToJsonNumber(config.temperature);
    if (config.topPOverride !== null && config.topPOverride !== undefined) {
      body.top_p = f32ToJsonNumber(config.topPOverride);
    }
    if (config.frequencyPenaltyOverride !== null && config.frequencyPenaltyOverride !== undefined) {
      body.frequency_penalty = f32ToJsonNumber(config.frequencyPenaltyOverride);
    }
    if (config.presencePenaltyOverride !== null && config.presencePenaltyOverride !== undefined) {
      body.presence_penalty = f32ToJsonNumber(config.presencePenaltyOverride);
    }
  }
}

/** 连接测试用请求体（model2_pipeline.rs build_test_chat_request_body）。 */
export function buildTestChatRequestBody(
  model: string, baseUrl: string,
): { [key: string]: unknown } {
  if (resolveEndpointQuirks(model, baseUrl).use_mimo_test_payload) {
    return {
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 32,
      temperature: 1.0,
      thinking: { type: 'disabled' },
    };
  }
  return {
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 5,
    temperature: 0.1,
  };
}
