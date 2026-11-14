import type { ChatSession, TokenUsage } from '../api.ts';
import { orderedNowEpochNanos, parseRfc3339, toRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';

/** chrono's UTC serde form, keeping fractional precision from persisted RFC3339 values. */
export function utcTimestamp(value: string): string {
  return toRfc3339Opts(parseRfc3339(value)?.epochNanos ?? 0n, 'AutoSi', true);
}

export function databaseTimestamp(value: string): string {
  return toRfc3339(parseRfc3339(value)?.epochNanos ?? 0n);
}

/** `Utc::now()` in chrono's serde form (`Z`), as held on in-memory session and group values. */
export function utcNow(): string {
  return toRfc3339Opts(orderedNowEpochNanos(), 'AutoSi', true);
}

/** `Utc::now().to_rfc3339()`, the form Rust binds into SQLite TEXT columns (`+00:00`). */
export function databaseNow(): string {
  return toRfc3339(orderedNowEpochNanos());
}

export function newSession(id: string, mode: string): ChatSession {
  const now = utcNow();
  return { id, mode, titleLocked: false, persistStatus: 'active', createdAt: now, updatedAt: now };
}

export function generateSessionId(): string { return `sess_${globalThis.crypto.randomUUID()}`; }

/** `TokenUsage::from_api` (types.rs:169-192): exact API-reported counts. */
export function tokenUsageFromApi(prompt: number, completion: number, reasoning: number | null = null): TokenUsage {
  const total = Math.min(prompt + completion, 0xffffffff);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    source: 'api',
    reasoningTokens: reasoning ?? undefined,
    cachedTokens: undefined,
    cacheWriteTokens: undefined,
    lastRoundPromptTokens: total,
    lastRoundInputTokens: prompt,
  };
}

/** types.rs:182-224. */
export function tokenUsageFromApiWithCache(prompt: number, completion: number, reasoning: number | null,
  cached: number | null): TokenUsage {
  return { ...tokenUsageFromApi(prompt, completion, reasoning), cachedTokens: cached ?? undefined };
}
export function tokenUsageFromEstimate(prompt: number, completion: number, precise: boolean): TokenUsage {
  return { ...tokenUsageFromApi(prompt, completion), source: precise ? 'tiktoken' : 'heuristic' };
}
export function tokenUsageZero(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'tiktoken' };
}
export function tokenUsageHasTokens(usage: TokenUsage): boolean { return usage.totalTokens > 0; }
export function tokenSourceDisplay(source: TokenUsage['source']): string { return source; }

/** types.rs:234-275. lastRoundPromptTokens keeps its historical prompt+completion meaning. */
export function accumulateTokenUsage(usage: TokenUsage, other: TokenUsage): void {
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    usage[field] = Math.min(usage[field] + other[field], 0xffffffff);
  }
  if (usage.source !== other.source) usage.source = 'mixed';
  for (const field of ['reasoningTokens', 'cachedTokens', 'cacheWriteTokens'] as const) {
    const next = other[field];
    if (next != null) usage[field] = usage[field] == null ? next : Math.min(usage[field]! + next, 0xffffffff);
  }
  const window = Math.min(other.promptTokens + other.completionTokens, 0xffffffff);
  if (window > 0) {
    usage.lastRoundPromptTokens = window;
    usage.lastRoundInputTokens = other.promptTokens;
  }
}
