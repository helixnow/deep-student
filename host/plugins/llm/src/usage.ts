/** Usage token 提取（model2_pipeline.rs LLMManager::extract_usage_tokens）。 */
import type { JsonValue } from '../../../platform/errors/api.ts';

type JsonObject = { [key: string]: JsonValue };

export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function get(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const object = asObject(current);
    if (object === null) return undefined;
    current = object[key];
  }
  return current;
}

function asU32(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return Math.min(value, 0xffff_ffff);
}

function maxDefined(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

/** 从多种供应商 usage 形状提取计费 token；显式 0 是真实测量值。 */
export function extractUsageTokens(
  usage: JsonValue | null | undefined,
  fallbackCompletionTokens: number,
  fallbackPromptTokens: number,
): UsageTokens {
  if (usage === null || usage === undefined) {
    return {
      promptTokens: fallbackPromptTokens,
      completionTokens: fallbackCompletionTokens,
      reasoningTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
    };
  }

  const rawPrompt = asU32(get(usage, 'prompt_tokens'))
    ?? asU32(get(usage, 'input_tokens'))
    ?? asU32(get(usage, 'promptTokenCount'))
    ?? 0;
  const completionTokens = asU32(get(usage, 'completion_tokens'))
    ?? asU32(get(usage, 'output_tokens'))
    ?? asU32(get(usage, 'candidatesTokenCount'))
    ?? fallbackCompletionTokens;

  let promptTokens = rawPrompt;
  if (rawPrompt === 0) {
    const total = asU32(get(usage, 'total_tokens'))
      ?? asU32(get(usage, 'totalTokenCount'))
      ?? 0;
    promptTokens = total > completionTokens ? total - completionTokens : fallbackPromptTokens;
  }

  const reasoningTokens = asU32(get(usage, 'reasoning_tokens'))
    ?? asU32(get(usage, 'thoughtsTokenCount'))
    ?? asU32(get(usage, 'completion_tokens_details', 'reasoning_tokens'))
    ?? asU32(get(usage, 'output_tokens_details', 'reasoning_tokens'));

  const cachedTokens = maxDefined([
    asU32(get(usage, 'cache_read_input_tokens')),
    asU32(get(usage, 'prompt_tokens_details', 'cached_tokens')),
    asU32(get(usage, 'input_tokens_details', 'cached_tokens')),
    asU32(get(usage, 'prompt_cache_hit_tokens')),
    asU32(get(usage, 'cached_tokens')),
  ]);

  const cacheWriteTokens = maxDefined([
    asU32(get(usage, 'cache_creation_input_tokens')),
    asU32(get(usage, 'input_tokens_details', 'cache_write_tokens')),
    asU32(get(usage, 'cache_write_tokens')),
  ]);

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
  };
}
