/**
 * dstu-mcp tools/mod.rs:653-700 `call_web_search_fallback`: `ToolRegistry::new_with([WebSearchTool])` with the
 * fallback `ToolContext` (`db` present, `supports_tools=false`, `stage="fallback"`, `llm_manager=None`).
 *
 * The registry from mcp supplies argument parsing, the 15 s `call_tool` timeout and the `!ok` mapping; this module
 * supplies the DB-dependent parts of `WebSearchTool::invoke` (mod.rs:826-932) and `do_aggregated_search`
 * (mod.rs:1166-1383). Rerank needs `llm_manager`, which the fallback never has.
 */
import type { WebSearchFallback } from '../../llm/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { charCount, f32ToJsonNumber, rustTrim, takeChars } from '../../../platform/util/portable.ts';
import { CN_TRUSTED_SITES, createWebSearchToolRegistry, doSearch, hasValidKeys, loadToolConfig } from '../../mcp/api.ts';
import type { RagSourceInfo, SearchInput, SearchResult, ToolConfig } from '../../mcp/api.ts';
import { readSettingOrNone } from './settings.ts';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface WebSearchFallbackDeps {
  settings: SettingsStore;
  emit(event: string, payload: unknown): void;
  log(level: LogLevel, message: string): void;
  /** Logger handed to mcp `doSearch` (provider diagnostics). */
  searchLog(message: string): void;
}

const NO_ENGINE_SELECTED = '请在输入栏选择搜索引擎以启用外部搜索功能';

interface AggregatedItem { title: string; url: string; snippet: string; rank: number; score: number }
type CnWhitelist = NonNullable<ToolConfig['cn_whitelist']>;

/** Rust `str::lines()`: `\n` or `\r\n` terminators; no empty line after a final terminator. */
function rustLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const last = parts.pop()!;
  const lines = parts.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (last !== '') lines.push(last);
  return lines;
}
/** `url::Url::host_str()` is the bare host (no port). */
function urlHost(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host === '' ? null : host;
  } catch { return null; }
}
/** web_search.rs:1379 `host_as_file_name`. */
function hostAsFileName(url: string): string { return urlHost(url) ?? 'unknown'; }
/** web_search.rs:1386 `normalize_score` (f32 arithmetic). */
function normalizeScore(rank: number, topK: number): number {
  if (topK === 0) return 0;
  return Math.min(Math.max(Math.fround((topK + 1 - rank) / topK), 0), 1);
}
/** web_search.rs:1269 `CnWhitelistConfig::is_url_whitelisted`. */
function isUrlWhitelisted(config: CnWhitelist, url: string): boolean {
  if (!config.enabled) return true;
  const host = urlHost(url);
  if (host === null) return false;
  const merged = [...config.use_default_list ? CN_TRUSTED_SITES : [], ...config.custom_sites ?? []];
  const lower = host.toLowerCase();
  return merged.some(domain => lower.endsWith(domain.toLowerCase()));
}
/** web_search.rs:1626 `build_inject_text` for `provider: "aggregated"` (never the DeepSeek content path). */
function buildAggregatedInjectText(config: ToolConfig, items: AggregatedItem[]): string {
  if (items.length === 0) return '';
  const snippetMax = config.inject_snippet_max_chars ?? 180;
  const limitChars = config.inject_total_max_chars ?? 1900;
  let buffer = '【外部搜索结果】\n';
  let count = charCount(buffer);
  for (const [index, item] of items.entries()) {
    const snippet = takeChars(item.snippet.replace(/<[^>]+>/g, ''), snippetMax);
    const line = `[${index + 1}] ${rustTrim(item.title)} — ${snippet}\nURL: ${item.url}\n\n`;
    count += charCount(line);
    buffer += line;
    if (count > limitChars) break;
  }
  return takeChars(buffer, limitChars);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** mod.rs:1166-1383 `WebSearchTool::do_aggregated_search` without a reranker. */
async function aggregatedSearch(
  deps: WebSearchFallbackDeps, config: ToolConfig, input: SearchInput, engines: string[], signal: AbortSignal | undefined,
): Promise<SearchResult> {
  const started = performance.now();
  const outcomes = await Promise.allSettled(
    engines.map(engine => doSearch(config, { ...input, engine }, deps.searchLog, signal)));
  if (signal?.aborted) throw signal.reason;
  const items: AggregatedItem[] = [];
  const providers: Record<string, number> = {};
  const failedProviders: string[] = [];
  outcomes.forEach((outcome, index) => {
    const engine = engines[index]!;
    if (outcome.status === 'rejected') {
      deps.log('error', `引擎任务执行失败: ${errorText(outcome.reason)}`);
      return;
    }
    const result = outcome.value;
    if (!result.ok) {
      failedProviders.push(engine);
      deps.log('warn', `引擎 ${engine} 搜索失败: ${JSON.stringify(result.error ?? null)}`);
      return;
    }
    if (result.citations === undefined) return;
    result.citations.forEach((citation, rank) => items.push({
      title: citation.fileName, url: citation.documentId,
      snippet: rustLines(citation.chunkText).slice(0, 2).join(' '),
      rank: rank + 1, score: Math.fround(citation.score),
    }));
    providers[engine] = result.citations.length;
  });
  if (items.length === 0) {
    return {
      name: 'web_search', ok: false, args: input, error: '所有搜索引擎都失败了',
      usage: { elapsed_ms: Math.trunc(performance.now() - started), failed_providers: failedProviders, aggregated: true },
    };
  }
  // Citation `document_id` is already `normalize_url` output, and `normalize_url` is idempotent.
  const seen = new Set<string>();
  const unique: AggregatedItem[] = [];
  for (const item of items) {
    const passes = config.cn_whitelist === null || isUrlWhitelisted(config.cn_whitelist, item.url);
    if (passes && !seen.has(item.url)) {
      seen.add(item.url);
      unique.push(item);
    } else if (!passes) deps.log('debug', `URL被中文白名单过滤: ${item.url}`);
  }
  unique.sort((a, b) => b.score > a.score ? 1 : b.score < a.score ? -1 : 0);
  const kept = unique.slice(0, config.reranker?.top_k ?? input.top_k);
  kept.forEach((item, index) => {
    item.rank = index + 1;
    item.score = normalizeScore(index + 1, input.top_k);
  });
  const citations: RagSourceInfo[] = kept.map((item, index) => ({
    documentId: item.url,
    fileName: rustTrim(item.title) === '' ? hostAsFileName(item.url) : item.title,
    chunkText: rustTrim(item.snippet) === '' ? `${item.title}\n${item.url}` : `${item.title} — ${item.snippet}\n${item.url}`,
    score: Math.min(Math.max(item.score, 0), 1),
    chunkIndex: index,
    sourceType: 'search',
  }));
  return {
    name: 'web_search', ok: true, args: input,
    result: { aggregated: true, providers, failed_providers: failedProviders, total_unique_results: citations.length },
    citations,
    usage: {
      elapsed_ms: Math.trunc(performance.now() - started), reranking_time_ms: null,
      providers, failed_providers: failedProviders, aggregated: true,
    },
    inject_text: buildAggregatedInjectText(config, kept),
  };
}

/**
 * mod.rs:826-932 with `ctx.db = Some`, `stage = "fallback"`: the engine-selection gate, then engine routing.
 * The fallback args are always `{query, top_k}` (model2_pipeline.rs:6040-6043), so `engine`/`force_engine` are unset.
 */
async function routedSearch(deps: WebSearchFallbackDeps, input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
  const selected = readSettingOrNone(deps.settings, 'session.selected_search_engines');
  if (selected === null || rustTrim(selected) === '') {
    deps.log('debug', selected === null ? '外部搜索工具被跳过: 未配置搜索引擎' : '外部搜索工具被跳过: 未选择搜索引擎');
    throw new Error(NO_ENGINE_SELECTED);
  }
  const config = await loadToolConfig(deps.settings, deps.searchLog);
  const engines = selected.split(',').map(rustTrim).filter(engine => engine !== '');
  if (engines.length > 1) {
    const usable = engines.filter(engine => hasValidKeys(config.keys, engine));
    const skipped = engines.filter(engine => !hasValidKeys(config.keys, engine));
    if (skipped.length) deps.log('info', `跳过未配置 API key 的引擎: ${JSON.stringify(skipped)}`);
    if (usable.length > 1) {
      deps.log('info', `启动多引擎聚合搜索，引擎数量: ${usable.length}`);
      return aggregatedSearch(deps, config, input, usable, signal);
    }
    if (usable.length === 1) {
      deps.log('info', `仅一个引擎有有效 API key，自动使用: ${usable[0]!}`);
      return doSearch(config, { ...input, engine: usable[0]! }, deps.searchLog, signal);
    }
    deps.log('warn', '所有选中引擎均未配置 API key，回退到默认引擎');
    return doSearch(config, input, deps.searchLog, signal);
  }
  if (engines.length === 1) {
    deps.log('info', `仅选择单个搜索引擎，自动使用 session 配置的引擎: ${engines[0]!}`);
    return doSearch(config, { ...input, engine: engines[0]! }, deps.searchLog, signal);
  }
  return doSearch(config, input, deps.searchLog, signal);
}

export function createWebSearchFallback(deps: WebSearchFallbackDeps): WebSearchFallback {
  const registry = createWebSearchToolRegistry({ doSearch: (input, signal) => routedSearch(deps, input, signal) });
  return {
    async call({ window, streamEvent, memoryEnabled, args }) {
      const [ok, , error, , citations, injectText] = await registry.callTool('web_search', args, {
        supports_tools: false, mcp_client: null, stream_event: streamEvent, stage: 'fallback',
        memory_enabled: memoryEnabled, window: window ?? null,
      });
      // mod.rs:1122-1150: sources are emitted only for a calling window and a non-empty citation list.
      if (ok && window != null && citations !== null && citations.length > 0) {
        deps.emit(`${streamEvent}_web_search`, {
          sources: citations.map(citation => ({
            document_id: citation.documentId, file_name: citation.fileName, chunk_text: citation.chunkText,
            score: f32ToJsonNumber(citation.score), chunk_index: citation.chunkIndex,
            source_type: 'search', origin: 'web_search', stage: 'fallback',
          })),
          stage: 'fallback', tool_name: 'web_search',
        });
      }
      return { ok, error, citations, injectText };
    },
  };
}
