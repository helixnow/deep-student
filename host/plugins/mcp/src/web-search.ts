// web_search orchestration: runtime controls, retries, caching and result shaping.
import type { RagSourceInfo, SearchInput, SearchResult } from '../api.ts';
import {
  TOOL_NAME, ToolError, buildInjectText, citationOf, normalizeCustomDateRange,
  normalizeScore, normalizeTimeRangeKey, normalizeUrl, toolErrorResult,
  type ProviderStrategy, type SearchItem, type ToolConfig,
} from './web-search-core.ts';
import { defaultProviderStrategy, getStrategy, hostAllowed } from './web-search-config.ts';
import {
  ZERO_KEY_FALLBACK_ORDER, assessZeroKeySearchQuality, createProvider, filterBoilerplateItems,
  isRetryable, searchZeroKeyFallback, type Provider, type ProviderResult, type ZeroKeyQualityAssessment,
  type ZeroKeyQualityReason,
} from './web-search-providers.ts';

// =============================
// Runtime controls
// =============================

interface StrategyFingerprint {
  max_concurrent_requests: number | null;
  rate_limit_per_minute: number | null;
  cache_enabled: boolean;
  cache_ttl_secs: number;
  cache_max_entries: number;
}
function fingerprintOf(strategy: ProviderStrategy): StrategyFingerprint {
  const ttl = strategy.cache_ttl_seconds ?? 300;
  const max = strategy.cache_max_entries ?? 128;
  return {
    max_concurrent_requests: strategy.max_concurrent_requests ?? null,
    rate_limit_per_minute: strategy.rate_limit_per_minute ?? null,
    cache_enabled: (strategy.cache_enabled ?? true) && ttl > 0 && max > 0,
    cache_ttl_secs: Math.max(ttl, 1), cache_max_entries: Math.max(max, 1),
  };
}
function sameFingerprint(a: StrategyFingerprint, b: StrategyFingerprint): boolean {
  return a.max_concurrent_requests === b.max_concurrent_requests
    && a.rate_limit_per_minute === b.rate_limit_per_minute
    && a.cache_enabled === b.cache_enabled && a.cache_ttl_secs === b.cache_ttl_secs
    && a.cache_max_entries === b.cache_max_entries;
}
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];
  constructor(limit: number) { this.available = limit; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.available > 0) this.available -= 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => { signal?.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReasonOf(signal!));
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.available += 1;
  }
}
class RateLimiter {
  private readonly window: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }
  acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const next = this.chain.then(() => { throwIfAborted(signal); return this.waitForSlot(signal); });
    this.chain = next.catch(() => undefined);
    if (signal === undefined) return next;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortReasonOf(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      next.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    if (this.limit === 0) return;
    const windowMs = 60000;
    let now = performance.now();
    while (this.window.length > 0 && now - this.window[0]! >= windowMs) this.window.shift();
    if (this.window.length >= this.limit) {
      const oldest = this.window[0]!;
      const wait = windowMs - (now - oldest);
      if (wait > 0) await sleep(wait, signal);
      now = performance.now();
      while (this.window.length > 0 && now - this.window[0]! >= windowMs) this.window.shift();
    }
    this.window.push(performance.now());
  }
}
class CacheState {
  private readonly entries = new Map<string, { inserted_at: number; result: SearchResult }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }
  get(key: string): SearchResult | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    if (performance.now() - entry.inserted_at <= this.ttlMs) {
      this.entries.set(key, entry);
      return structuredClone(entry.result);
    }
    return null;
  }
  insert(key: string, value: SearchResult): void {
    this.entries.delete(key);
    this.entries.set(key, { inserted_at: performance.now(), result: structuredClone(value) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
class ProviderRuntimeState {
  private readonly semaphore: Semaphore | null;
  private readonly rateLimiter: RateLimiter | null;
  private readonly cache: CacheState | null;
  readonly fingerprint: StrategyFingerprint;

  constructor(fingerprint: StrategyFingerprint) {
    this.fingerprint = fingerprint;
    this.semaphore = fingerprint.max_concurrent_requests !== null && fingerprint.max_concurrent_requests !== 0
      ? new Semaphore(fingerprint.max_concurrent_requests) : null;
    this.rateLimiter = fingerprint.rate_limit_per_minute !== null && fingerprint.rate_limit_per_minute !== 0
      ? new RateLimiter(fingerprint.rate_limit_per_minute) : null;
    this.cache = fingerprint.cache_enabled ? new CacheState(fingerprint.cache_max_entries, fingerprint.cache_ttl_secs * 1000) : null;
  }
  async acquirePermit(signal?: AbortSignal): Promise<(() => void) | null> { return this.semaphore === null ? null : this.semaphore.acquire(signal); }
  async acquireRateSlot(signal?: AbortSignal): Promise<void> { if (this.rateLimiter !== null) await this.rateLimiter.acquire(signal); }
  getCached(key: string): SearchResult | null { return this.cache?.get(key) ?? null; }
  storeCache(key: string, value: SearchResult): void { this.cache?.insert(key, value); }
}
class ProviderRuntimeManager {
  private readonly states = new Map<string, ProviderRuntimeState>();
  getState(provider: string, strategy: ProviderStrategy): { state: ProviderRuntimeState; fingerprint: StrategyFingerprint } {
    const fingerprint = fingerprintOf(strategy);
    const existing = this.states.get(provider);
    if (existing !== undefined && sameFingerprint(existing.fingerprint, fingerprint)) return { state: existing, fingerprint };
    const state = new ProviderRuntimeState(fingerprint);
    this.states.set(provider, state);
    return { state, fingerprint };
  }
}
const PROVIDER_RUNTIME = new ProviderRuntimeManager();
export function resetProviderRuntime(): void {
  // Test hook: Rust keeps process-global state; tests that need isolation call this.
  (PROVIDER_RUNTIME as unknown as { states: Map<string, ProviderRuntimeState> }).states.clear();
}

function normalizeList(list: string[]): string {
  const values = [...new Set(list.map(item => item.trim().toLowerCase()).filter(item => item !== ''))];
  values.sort();
  return values.join('|');
}
function formatOption(value: number | null): string { return value === null ? 'None' : `Some(${value})`; }
export function buildCacheKey(input: SearchInput, engine: string, config: ToolConfig, fingerprint: StrategyFingerprint | null): string {
  const segments: string[] = [
    `query=${input.query.trim().toLowerCase()}`,
    `engine=${engine.toLowerCase()}`,
    `topk=${input.top_k}`,
    `site=${input.site?.trim().toLowerCase() ?? ''}`,
    `time=${normalizeTimeRangeKey(input.time_range)}`,
    `tavily_depth=${config.tavily_search_depth?.trim().toLowerCase() ?? ''}`,
    `start=${input.start ?? 1}`,
    `forced=${input.force_engine?.trim().toLowerCase() ?? ''}`,
    `reranker=${config.reranker?.enabled ?? false}::${config.reranker?.top_k ?? 0}`,
    `inject=${config.inject_snippet_max_chars ?? 180}::${config.inject_total_max_chars ?? 1900}`,
    `timeout=${config.timeout_ms ?? 15000}`,
    `retry=${config.retry?.max_attempts ?? 2}::${config.retry?.initial_delay_ms ?? 200}`,
  ];
  if (engine.toLowerCase() === 'google_cse') {
    const endpoint = config.keys.google_cse_endpoint?.trim() ?? '';
    if (endpoint !== '') segments.push(`google_endpoint=${endpoint}`);
  }
  if (config.site_whitelist !== null) segments.push(`white=${normalizeList(config.site_whitelist)}`);
  if (config.site_blacklist !== null) segments.push(`black=${normalizeList(config.site_blacklist)}`);
  if (config.cn_whitelist !== null) {
    segments.push(`cn_enabled=${config.cn_whitelist.enabled}`);
    segments.push(`cn_use_default=${config.cn_whitelist.use_default_list}`);
    if (config.cn_whitelist.custom_sites !== null) segments.push(`cn_custom=${normalizeList(config.cn_whitelist.custom_sites)}`);
  }
  if (fingerprint !== null) {
    segments.push(`fp=${formatOption(fingerprint.max_concurrent_requests)}|${formatOption(fingerprint.rate_limit_per_minute)}|${fingerprint.cache_enabled}|${fingerprint.cache_ttl_secs}|${fingerprint.cache_max_entries}`);
  }
  return segments.join('||');
}

// =============================
// Orchestration
// =============================

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortReasonOf(signal)); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(abortReasonOf(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw abortReasonOf(signal);
}

export async function doSearch(
  config: ToolConfig, input: SearchInput,
  log: (message: string) => void = () => undefined,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
): Promise<SearchResult> {
  throwIfAborted(signal);
  if (input.top_k === 0) {
    return {
      name: TOOL_NAME, ok: true, args: input,
      result: { raw: {}, provider: 'none' },
      citations: [],
      usage: { elapsed_ms: 0, retries: 0, provider_latency_ms: 0, provider: 'none' },
    };
  }
  if (input.time_range !== null) {
    const trimmed = input.time_range.trim();
    if (trimmed === '') input = { ...input, time_range: null };
    else if (trimmed !== input.time_range) input = { ...input, time_range: trimmed };
  }
  const engine = input.force_engine ?? input.engine ?? config.default_engine ?? 'bing_rss';
  const customRange = input.time_range === null ? null : normalizeCustomDateRange(input.time_range);
  if (customRange !== null) {
    if (engine !== 'brave' && engine !== 'deepseek') {
      return toolErrorResult(input, new ToolError('config',
        'custom time_range only supported by brave/deepseek; use 1d|7d|30d|365d|1y|12m'), 0);
    }
    input = { ...input, time_range: customRange };
  }

  const effective = structuredClone(config);
  let runtimeState: ProviderRuntimeState;
  let runtimeFingerprint: StrategyFingerprint;
  if (config.provider_strategies !== null) {
    const strategy = getStrategy(config.provider_strategies, engine);
    const state = PROVIDER_RUNTIME.getState(engine, strategy);
    runtimeState = state.state;
    runtimeFingerprint = state.fingerprint;
    if (strategy.timeout_ms !== null && strategy.timeout_ms !== undefined) {
      if (config.provider_strategies_overridden || !config.timeout_ms_overridden) effective.timeout_ms = strategy.timeout_ms;
    }
    if (strategy.max_retries !== null && strategy.max_retries !== undefined) {
      if (effective.retry !== null) effective.retry.max_attempts = Math.max(strategy.max_retries, 1);
      else effective.retry = { max_attempts: Math.max(strategy.max_retries, 1), initial_delay_ms: strategy.initial_retry_delay_ms ?? 200 };
    }
    if (strategy.initial_retry_delay_ms !== null && strategy.initial_retry_delay_ms !== undefined && effective.retry !== null) {
      effective.retry.initial_delay_ms = strategy.initial_retry_delay_ms;
    }
  } else {
    const state = PROVIDER_RUNTIME.getState(engine, defaultProviderStrategy());
    runtimeState = state.state;
    runtimeFingerprint = state.fingerprint;
  }

  const cacheKey = buildCacheKey(input, engine, effective, runtimeFingerprint);
  const cached = runtimeState.getCached(cacheKey);
  if (cached !== null) return cached;

  const release = await runtimeState.acquirePermit(signal);
  try {
    await runtimeState.acquireRateSlot(signal);
    let provider: Provider;
    try { provider = createProvider(engine, fetcher); }
    catch (error) {
      return toolErrorResult(input, error instanceof ToolError ? error : new ToolError('unknown', String(error)), 0);
    }
    const retry = effective.retry ?? { max_attempts: 2, initial_delay_ms: 200 };
    const started = performance.now();
    let attempt = 0;
    let result: ProviderResult | null = null;
    let primaryError: ToolError | null = null;
    for (;;) {
      throwIfAborted(signal);
      try { result = await provider.search(effective, input, log, signal); break; }
      catch (error) {
        throwIfAborted(signal);
        const toolError = error instanceof ToolError ? error : new ToolError('unknown', error instanceof Error ? error.message : String(error));
        if (attempt + 1 < Math.max(retry.max_attempts, 1) && isRetryable(toolError)) {
          const delay = Math.min(retry.initial_delay_ms * Math.pow(2, attempt), 60000);
          attempt += 1;
          await sleep(delay, signal);
          continue;
        }
        if (engine === 'bing_rss') {
          primaryError = toolError;
          break;
        }
        return toolErrorResult(input, toolError, Math.trunc(performance.now() - started));
      }
    }
    throwIfAborted(signal);
    if (engine === 'bing_rss') {
      const primaryRawItems = result?.response.items ?? [];
      const primaryAllowed = primaryRawItems.filter(item => hostAllowed(config, item.url));
      const primaryQuality: ZeroKeyQualityAssessment = result === null
        ? {
          ok: false, reason: 'empty', matchedGroupCount: 0, totalGroupCount: 0,
          matchedLaterGroupCount: 0, boilerplateCount: 0, score: -20,
        }
        : assessZeroKeySearchQuality(input.query, primaryAllowed, input.site, input.top_k);
      if (result !== null && primaryQuality.ok) {
        const cleaned = filterBoilerplateItems(primaryAllowed, input.query, input.site);
        const items = standardize(cleaned.length > 0 ? cleaned : primaryAllowed, input.top_k);
        const citations: RagSourceInfo[] = items.map(citationOf);
        const injectText = buildInjectText(config, { items, raw: result.response.raw, provider: result.response.provider });
        const elapsed = Math.trunc(performance.now() - started);
        const searchResult: SearchResult = {
          name: TOOL_NAME, ok: true, args: input,
          result: { raw: result.response.raw, provider: result.response.provider },
          citations,
          usage: {
            elapsed_ms: elapsed,
            provider_latency_ms: result.usage.provider_latency_ms ?? 0,
            provider: result.usage.provider ?? engine,
          },
          inject_text: injectText,
        };
        runtimeState.storeCache(cacheKey, searchResult);
        return searchResult;
      }

      const primaryReason: ZeroKeyQualityReason | 'provider_error' = primaryError !== null ? 'provider_error' : primaryQuality.reason;
      log(`[web_search][bing_rss] primary result degraded (${primaryReason}), trying zero-key fallbacks`);
      const attempted: string[] = [];
      let totalFallbackLatency = result?.usage.provider_latency_ms ?? 0;
      let anyFallbackResponded = result !== null;
      let bestCandidate: {
        backend: string;
        items: SearchItem[];
        raw: import('../api.ts').JsonValue;
        quality: ZeroKeyQualityAssessment;
      } | null = null;
      const seenFallbackUrls = new Set<string>();

      for (const backend of ZERO_KEY_FALLBACK_ORDER) {
        throwIfAborted(signal);
        attempted.push(backend);
        try {
          const candidate = await searchZeroKeyFallback(backend, effective, input, fetcher, log, signal);
          anyFallbackResponded = true;
          totalFallbackLatency += candidate.latencyMs;
          const allowed = candidate.items.filter(item => hostAllowed(config, item.url));
          const deduped: SearchItem[] = [];
          for (const item of allowed) {
            const normalized = normalizeUrl(item.url);
            if (seenFallbackUrls.has(normalized)) continue;
            seenFallbackUrls.add(normalized);
            deduped.push({ ...item, url: normalized, rank: deduped.length + 1 });
          }
          const quality = assessZeroKeySearchQuality(input.query, deduped, input.site, input.top_k);
          if (quality.ok && deduped.length > 0) {
            const cleaned = filterBoilerplateItems(deduped, input.query, input.site);
            const items = standardize(cleaned.length > 0 ? cleaned : deduped, input.top_k);
            const citations: RagSourceInfo[] = items.map(citationOf);
            const injectText = buildInjectText(config, { items, raw: candidate.raw, provider: 'bing_rss' });
            const elapsed = Math.trunc(performance.now() - started);
            const searchResult: SearchResult = {
              name: TOOL_NAME, ok: true, args: input,
              result: {
                raw: candidate.raw,
                provider: 'bing_rss',
                fallback_provider: backend,
                fallback_reason: primaryReason,
              },
              citations,
              usage: {
                elapsed_ms: elapsed,
                provider_latency_ms: totalFallbackLatency,
                provider: 'bing_rss',
                fallback_provider: backend,
              },
              inject_text: injectText,
            };
            runtimeState.storeCache(cacheKey, searchResult);
            return searchResult;
          }
          const nonBoilerplate = filterBoilerplateItems(deduped, input.query, input.site);
          if (nonBoilerplate.length > 0 && quality.reason !== 'boilerplate_domain' && quality.reason !== 'same_host_spam'
            && quality.reason !== 'first_token_truncation'
            && (bestCandidate === null || quality.score > bestCandidate.quality.score)) {
            bestCandidate = { backend, items: nonBoilerplate, raw: candidate.raw, quality };
          }
        } catch (error) {
          throwIfAborted(signal);
          log(`[web_search][bing_rss] fallback ${backend} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const elapsed = Math.trunc(performance.now() - started);
      if (bestCandidate !== null && bestCandidate.quality.matchedGroupCount > 0) {
        const items = standardize(bestCandidate.items, input.top_k);
        const citations: RagSourceInfo[] = items.map(citationOf);
        const injectText = buildInjectText(config, { items, raw: bestCandidate.raw, provider: 'bing_rss' });
        const searchResult: SearchResult = {
          name: TOOL_NAME, ok: true, args: input,
          result: {
            raw: bestCandidate.raw,
            provider: 'bing_rss',
            fallback_provider: bestCandidate.backend,
            fallback_reason: primaryReason,
          },
          citations,
          usage: {
            elapsed_ms: elapsed,
            provider_latency_ms: totalFallbackLatency,
            provider: 'bing_rss',
            fallback_provider: bestCandidate.backend,
          },
          inject_text: injectText,
        };
        runtimeState.storeCache(cacheKey, searchResult);
        return searchResult;
      }

      // Preserve non-boilerplate semantic/synonym primary hits when fallbacks cannot improve on them.
      if (result !== null && primaryQuality.reason === 'zero_overlap' && primaryAllowed.length > 0) {
        const cleaned = filterBoilerplateItems(primaryAllowed, input.query, input.site);
        if (cleaned.length > 0) {
          const items = standardize(cleaned, input.top_k);
          const citations: RagSourceInfo[] = items.map(citationOf);
          const injectText = buildInjectText(config, { items, raw: result.response.raw, provider: result.response.provider });
          const searchResult: SearchResult = {
            name: TOOL_NAME, ok: true, args: input,
            result: { raw: result.response.raw, provider: result.response.provider },
            citations,
            usage: {
              elapsed_ms: elapsed,
              provider_latency_ms: totalFallbackLatency,
              provider: result.usage.provider ?? engine,
            },
            inject_text: injectText,
          };
          runtimeState.storeCache(cacheKey, searchResult);
          return searchResult;
        }
      }

      if (primaryError !== null && !anyFallbackResponded) {
        return toolErrorResult(input, primaryError, elapsed);
      }

      const warning = `Free default search (bing_rss + zero-key fallbacks) returned degraded or blocked results for "${input.query.trim()}" (${primaryReason}). Do not repeat the exact same query; configure a dedicated search API key (Tavily, Brave, DeepSeek, Google CSE, or SearXNG) in Settings or narrow the search terms. / 免费默认搜索源（含零密钥回退）当前未返回与「${input.query.trim()}」直接相关的有效结果（原因：${primaryReason}），请勿重复提交相同搜索词；建议在设置中配置独立搜索 API 或改写关键词。`;
      return {
        name: TOOL_NAME, ok: true, args: input,
        result: {
          raw: { format: 'degraded', reason: primaryReason, attempted_fallbacks: attempted },
          provider: 'bing_rss',
          degraded: true,
          degraded_reason: primaryReason,
          warning,
        },
        citations: [],
        usage: {
          elapsed_ms: elapsed,
          provider_latency_ms: totalFallbackLatency,
          provider: 'bing_rss',
          degraded: true,
        },
        inject_text: `【外部搜索降级提示】\n${warning}\n`,
      };
    }

    const elapsed = Math.trunc(performance.now() - started);
    const preFiltered = result!.response.items.filter(item => hostAllowed(config, item.url));
    const items = standardize(preFiltered, input.top_k);
    const citations: RagSourceInfo[] = items.map(citationOf);
    const injectText = buildInjectText(config, { items, raw: result!.response.raw, provider: result!.response.provider });
    const searchResult: SearchResult = {
      name: TOOL_NAME, ok: true, args: input,
      result: { raw: result!.response.raw, provider: result!.response.provider },
      citations,
      usage: {
        elapsed_ms: elapsed,
        provider_latency_ms: result!.usage.provider_latency_ms ?? 0,
        provider: result!.usage.provider ?? engine,
      },
      inject_text: injectText,
    };
    runtimeState.storeCache(cacheKey, searchResult);
    return searchResult;
  } finally { release?.(); }
}

export function standardize(items: SearchItem[], topK: number): SearchItem[] {
  if (topK === 0) return [];
  const seen = new Set<string>();
  const output: SearchItem[] = [];
  for (const item of items) {
    const url = normalizeUrl(item.url);
    if (seen.has(url)) continue;
    seen.add(url);
    output.push({ ...item, url });
    if (output.length >= topK) break;
  }
  for (const item of output) if (item.score_hint === null) item.score_hint = normalizeScore(item.rank, topK);
  return output;
}

export {
  CN_TRUSTED_SITES, applyDbOverrides, calculateRetryDelay, defaultProviderKeys,
  defaultProviderStrategies, defaultProviderStrategy, defaultToolConfig, getStrategy,
  hasValidKeys, hostAllowed, isHostWhitelisted, isUrlWhitelisted, loadToolConfig,
  mergedWhitelist, normalizeProviderStrategies, parseProviderStrategies,
  serializeProviderStrategies, shouldRetry, toolConfigFromEnv,
} from './web-search-config.ts';
export type { DbOverrideSources } from './web-search-config.ts';
export {
  GOOGLE_CSE_DEFAULT_ENDPOINT, ZERO_KEY_FALLBACK_ORDER, assessZeroKeySearchQuality,
  buildDeepseekQuery, createProvider, decodeSearchRedirectUrl, deepseekSiteClause,
  deepseekTimeClause, extractQueryTermGroups, filterBoilerplateItems, googleCseEndpoint,
  hasCjkText, isRetryable, isZeroKeyBoilerplateUrl, mapDeepseekError, parseBingHtml,
  parseBingRss, parseDeepseekResults, parseDuckDuckGoHtml, parseMediaWikiSearch,
  searchZeroKeyFallback,
} from './web-search-providers.ts';
export type {
  Provider, ProviderResult, ZeroKeyFallbackBackend, ZeroKeyFallbackCandidate,
  ZeroKeyQualityAssessment, ZeroKeyQualityReason,
} from './web-search-providers.ts';
export {
  DEFAULT_TOP_K, TOOL_NAME, ToolError, buildInjectText, citationOf, classifyError, errorResult,
  f32ScoreJson, hostAsFileName, htmlUnescape, normalizeCustomDateRange, normalizeScore, normalizeUrl,
  redactUrlSecrets, statusDisplay, stripHtml, toolErrorResult, truncate, urlHost,
} from './web-search-core.ts';
export type {
  CnWhitelistConfig, ErrorCode, ProviderKeys, ProviderResponse, ProviderStrategies,
  ProviderStrategy, RerankerConfig, RetryConfig, SearchInput, SearchItem, SpecialHandling,
  StandardError, ToolConfig, Usage,
} from './web-search-core.ts';
