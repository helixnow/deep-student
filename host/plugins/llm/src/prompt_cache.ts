/** 稳定 prompt_cache_key（model2_pipeline.rs stable_prompt_cache_key / provider_accepts_prompt_cache_key）。 */
import type { ApiConfig } from '../api.ts';
import { isOfficialDeepseekConfig, resolvesToOfficialOpenai, shouldUseOpenaiResponsesForConfig } from './protocol.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { reasoningScopeHash } from './reasoning_state_scope.ts';

export const FALLBACK_PROMPT_CACHE_KEY = 'deep-student-background';

/** 同一输入永远得到同一 key；空白 session 归入后台键。 */
export function stablePromptCacheKey(sessionId: string | null | undefined): string {
  const trimmed = (sessionId ?? '').trim();
  return trimmed === '' ? FALLBACK_PROMPT_CACHE_KEY : trimmed;
}

/** OpenAI 缓存路由亲和参数只在 Responses 协议或 OpenAI 官方 Chat Completions 写入。 */
export function providerAcceptsPromptCacheKey(config: ApiConfig): boolean {
  if (isOfficialDeepseekConfig(config)) return false;
  return shouldUseOpenaiResponsesForConfig(config)
    || resolvesToOfficialOpenai(config.providerType, config.baseUrl);
}

/** Account and session identifiers never travel to upstreams as plaintext. */
export function scopedPromptCacheKey(sessionId: string | null | undefined, userOrAccountScope: string): string {
  return `ds-cache-${reasoningScopeHash(JSON.stringify([userOrAccountScope.trim(), stablePromptCacheKey(sessionId)]))}`;
}

function auditedCacheEndpoint(config: ApiConfig): boolean {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (url.protocol !== 'https:') return false;
  const protocol = effectiveApiProtocolForConfig(config);
  const model = config.model.trim().toLowerCase();
  if (url.hostname === 'api.anthropic.com' && protocol === 'anthropic_messages') {
    return /^claude-(?:3[.-]|(?:sonnet|opus|haiku)-4(?:[.-]|$))/.test(model);
  }
  return url.hostname === 'api.openai.com'
    && ['openai_chat_completions', 'openai_responses'].includes(protocol)
    && /^(?:gpt-(?:4o|4\.1|5(?:\.[0-6])?|6\.1)(?:-|$)|o[134](?:-|$))/.test(model);
}

/** Keep an audited tool prefix stable on the final no-tool round. */
export function resolveToolChoicePreservingCache<T>(
  config: ApiConfig, tools: readonly T[] | null | undefined, allowToolCalls: boolean,
): { tools?: readonly T[]; tool_choice?: 'auto' | 'none' } {
  if (!tools?.length) return {};
  if (allowToolCalls) return { tools, tool_choice: 'auto' };
  return auditedCacheEndpoint(config) ? { tools, tool_choice: 'none' } : {};
}

export interface ProviderUsageWithCache {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningTokens: number | null;
  cacheHitRate: number | null;
}

/** OpenAI cached tokens are a subset; Anthropic cache reads/writes are additive.
 * Unknown measurements remain null (including the hit-rate denominator). */
export function normalizeProviderUsageWithCache(providerProtocol: string, rawUsage: unknown): ProviderUsageWithCache {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const usage = object(rawUsage);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const anthropic = ['anthropic', 'anthropic_messages', 'anthropic-messages'].includes(providerProtocol);
  const inputDetails = object(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const outputDetails = object(usage.completion_tokens_details ?? usage.output_tokens_details);
  const cacheReadInputTokens = number(anthropic ? usage.cache_read_input_tokens : inputDetails.cached_tokens ?? usage.cached_tokens);
  const cacheCreationInputTokens = number(usage.cache_creation_input_tokens);
  const baseInput = number(usage.prompt_tokens ?? usage.input_tokens);
  const inputTokens = baseInput === null ? null : baseInput
    + (anthropic ? (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) : 0);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: number(usage.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheReadInputTokens, cacheCreationInputTokens,
    reasoningTokens: number(outputDetails.reasoning_tokens ?? usage.reasoning_tokens),
    cacheHitRate: inputTokens !== null && inputTokens > 0 && cacheReadInputTokens !== null ? cacheReadInputTokens / inputTokens : null,
  };
}
