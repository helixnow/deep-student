import type { TokenUsage } from '../../../../contracts/ipc/generated/L04-chat-session.ts';

/** serde_json::Value::as_u64: only non-negative finite integers qualify; `as u32` truncates. */
function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
function asU32(value: unknown): number | null {
  const raw = asU64(value);
  return raw === null ? null : raw % 0x1_0000_0000;
}
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}
const saturating = (a: number, b: number) => a + b > 0xffff_ffff ? 0xffff_ffff : a + b;

export function fromApi(prompt: number, completion: number, reasoning: number | null): TokenUsage {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: saturating(prompt, completion),
    source: 'api',
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
    lastRoundPromptTokens: saturating(prompt, completion), lastRoundInputTokens: prompt };
}
export function fromApiWithCache(prompt: number, completion: number, reasoning: number | null, cached: number | null): TokenUsage {
  return { ...fromApi(prompt, completion, reasoning),
    ...(cached === null ? {} : { cachedTokens: cached }) };
}
export function fromEstimate(prompt: number, completion: number, precise: boolean): TokenUsage {
  return { promptTokens: prompt, completionTokens: completion, totalTokens: saturating(prompt, completion),
    source: precise ? 'tiktoken' : 'heuristic',
    lastRoundPromptTokens: saturating(prompt, completion), lastRoundInputTokens: prompt };
}
/** types::TokenUsage::default(): TokenSource's serde default is Tiktoken. */
export function zero(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken' };
}
export function hasTokens(usage: TokenUsage): boolean { return usage.totalTokens > 0; }

const mergeOptional = (a: number | null | undefined, b: number | null | undefined): number | null | undefined => {
  if (a === null || a === undefined) return b === null || b === undefined ? undefined : b;
  if (b === null || b === undefined) return a;
  return saturating(a, b);
};
export function accumulate(target: TokenUsage, other: TokenUsage): void {
  target.promptTokens = saturating(target.promptTokens, other.promptTokens);
  target.completionTokens = saturating(target.completionTokens, other.completionTokens);
  target.totalTokens = saturating(target.totalTokens, other.totalTokens);
  if (target.source !== other.source) target.source = 'mixed';
  const reasoning = mergeOptional(target.reasoningTokens, other.reasoningTokens);
  if (reasoning !== undefined) target.reasoningTokens = reasoning;
  const cached = mergeOptional(target.cachedTokens, other.cachedTokens);
  if (cached !== undefined) target.cachedTokens = cached;
  const cacheWrite = mergeOptional(target.cacheWriteTokens, other.cacheWriteTokens);
  if (cacheWrite !== undefined) target.cacheWriteTokens = cacheWrite;
  const otherContext = saturating(other.promptTokens, other.completionTokens);
  if (otherContext > 0) {
    target.lastRoundPromptTokens = otherContext;
    target.lastRoundInputTokens = other.promptTokens;
  }
}

/** llm_adapter.rs:20-154. Every branch, including truncating u32 casts, is preserved. */
export function parseApiUsage(usage: unknown): TokenUsage | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const promptTokens = asU32(field(usage, 'prompt_tokens'));
  const completionTokens = asU32(field(usage, 'completion_tokens'));
  const inputTokens = asU32(field(usage, 'input_tokens'));
  const outputTokens = asU32(field(usage, 'output_tokens'));
  let prompt: number;
  let completion: number;
  if (promptTokens !== null && completionTokens !== null) { prompt = promptTokens; completion = completionTokens; }
  else if (inputTokens !== null && outputTokens !== null) { prompt = inputTokens; completion = outputTokens; }
  else if (promptTokens !== null) { prompt = promptTokens; completion = 0; }
  else if (completionTokens !== null) { prompt = 0; completion = completionTokens; }
  else if (inputTokens !== null) { prompt = inputTokens; completion = 0; }
  else if (outputTokens !== null) { prompt = 0; completion = outputTokens; }
  else return null;

  const reasoning = asU32(field(usage, 'reasoning_tokens'))
    ?? asU32(field(field(usage, 'completion_tokens_details'), 'reasoning_tokens'))
    ?? asU32(field(field(usage, 'output_tokens_details'), 'reasoning_tokens'))
    ?? null;

  const cacheCandidates = [
    asU64(field(usage, 'cache_read_input_tokens')),
    asU64(field(field(usage, 'prompt_tokens_details'), 'cached_tokens')),
    asU64(field(field(usage, 'input_tokens_details'), 'cached_tokens')),
    asU64(field(usage, 'prompt_cache_hit_tokens')),
    asU64(field(usage, 'cached_tokens')),
  ].filter((value): value is number => value !== null);
  const cached = cacheCandidates.length ? Math.min(Math.max(...cacheCandidates), 0xffff_ffff) : null;

  const writeCandidates = [
    asU64(field(usage, 'cache_creation_input_tokens')),
    asU64(field(field(usage, 'input_tokens_details'), 'cache_write_tokens')),
    asU64(field(usage, 'cache_write_tokens')),
  ].filter((value): value is number => value !== null);
  const cacheWrite = writeCandidates.length ? Math.min(Math.max(...writeCandidates), 0xffff_ffff) : null;

  const result = fromApiWithCache(prompt, completion, reasoning, cached);
  if (cacheWrite !== null) result.cacheWriteTokens = cacheWrite;
  return result;
}
