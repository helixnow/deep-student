// Rust `WebSearchTool::invoke` (dstu-mcp/src/tools/mod.rs:722-1162) and
// `WebSearchTool::do_aggregated_search` (mod.rs:1166-1383). The optional reranker
// (mod.rs:930-1081) needs an L02 reranker API that is not published yet (BLOCKERS.md L19-V2-09).
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type {
  CancellableWebSearchPort, JsonValue, RagSourceInfo, SearchInput, SearchResult, ToolInvocation,
  WebSearchService,
} from '../api.ts';
import {
  TOOL_NAME, buildInjectText, citationOf, classifyError, f32ScoreJson, normalizeScore, normalizeUrl,
  type SearchItem, type ToolConfig,
} from './web-search-core.ts';
import { hasValidKeys, isUrlWhitelisted } from './web-search-config.ts';

export type WebSearchToolLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** Rust `ToolContext.db` as `WebSearchTool` reads it: the settings table and a config-taking search port. */
export interface WebSearchToolDb {
  settings: SettingsStore;
  port: CancellableWebSearchPort;
}

export interface WebSearchToolBackend {
  /** `db: None`: one `do_search` per call, no engine gate or session routing. */
  service: WebSearchService;
  db: WebSearchToolDb | null;
  log: WebSearchToolLog;
}

const SELECTED_ENGINES_KEY = 'session.selected_search_engines';
const NO_ENGINE_SELECTED = '请在输入栏选择搜索引擎以启用外部搜索功能';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(args: Record<string, JsonValue>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function integerField(args: Record<string, JsonValue>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseSearchInput(args: JsonValue): SearchInput | null {
  if (!isObject(args)) return null;
  const query = stringField(args, 'query') ?? '';
  if (rustTrim(query) === '') return null;
  return {
    query,
    top_k: integerField(args, 'top_k') ?? 5,
    engine: stringField(args, 'engine'),
    site: stringField(args, 'site'),
    time_range: stringField(args, 'time_range'),
    start: integerField(args, 'start'),
    force_engine: stringField(args, 'force_engine'),
  };
}

/** `db.get_setting(key)`: `ok: false` is Rust's `Err`, which each caller treats differently. */
type SettingRead = { ok: true; value: string | null } | { ok: false };
function readSetting(settings: SettingsStore, key: string): SettingRead {
  try { return { ok: true, value: settings.get(key) }; }
  catch { return { ok: false }; }
}

function splitEngines(raw: string): string[] {
  return raw.split(',').map(rustTrim).filter(engine => engine !== '');
}

/** Rust `{:?}` of a `Vec<&String>`. */
function debugList(values: string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(', ')}]`;
}

/** Rust `str::lines`: `\n` or `\r\n` terminators, no empty line after a final terminator. */
function rustLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const last = parts.pop()!;
  const lines = parts.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (last !== '') lines.push(last);
  return lines;
}

/** `invoke` for `web_search`; `stage` is `ToolContext.stage` (`"test"` skips the engine gate). */
export async function invokeWebSearchTool(
  backend: WebSearchToolBackend, args: JsonValue, stage: string | null, signal: AbortSignal,
): Promise<ToolInvocation> {
  let input = parseSearchInput(args);
  if (input === null) return [false, null, 'query is empty', { elapsed_ms: 0 }, null, null];

  let result: SearchResult;
  const db = backend.db;
  if (db === null) {
    try { result = await backend.service.doSearch(input, signal); }
    catch (error) { return [false, null, errorText(error), null, null, null]; }
    return toolInvocation(result);
  }

  const testMode = stage === 'test';
  const selected = readSetting(db.settings, SELECTED_ENGINES_KEY);
  if (!testMode && selected.ok && selected.value !== null && input.engine !== null) {
    // Rust collects into a HashSet, whose iteration order is unspecified; keep first-seen order.
    const allowed = [...new Set(splitEngines(selected.value))];
    if (!allowed.includes(input.engine)) {
      return [false, null,
        `引擎 '${input.engine}' 不在允许列表中。可用引擎: ${allowed.join(', ')}。请到设置页配置相应API密钥。`,
        { elapsed_ms: 0, available_engines: allowed }, null, null];
    }
  }
  if (!testMode) {
    if (!selected.ok || selected.value === null) {
      backend.log('debug', '外部搜索工具被跳过: 未配置搜索引擎');
      return [false, null, NO_ENGINE_SELECTED, null, null, null];
    }
    if (rustTrim(selected.value) === '') {
      backend.log('debug', '外部搜索工具被跳过: 未选择搜索引擎');
      return [false, null, NO_ENGINE_SELECTED, null, null, null];
    }
  }

  let config: ToolConfig;
  try { config = await db.port.loadConfig(db.settings); }
  catch (error) { return [false, null, `config error: ${errorText(error)}`, { elapsed_ms: 0 }, null, null]; }

  if (input.engine !== null && !hasValidKeys(config.keys, input.engine)) {
    backend.log('info', `LLM 指定引擎 '${input.engine}' 未配置 API key，忽略并使用默认引擎`);
    input = { ...input, engine: null };
  }

  try { result = await routedSearch(backend, db.port, config, input, selected, signal); }
  catch (error) { return [false, null, errorText(error), null, null, null]; }
  return toolInvocation(result);
}

/** mod.rs:864-928: force_engine, then aggregation over keyed engines, then the session's single engine. */
async function routedSearch(
  backend: WebSearchToolBackend, port: CancellableWebSearchPort, config: ToolConfig,
  input: SearchInput, selected: SettingRead, signal: AbortSignal,
): Promise<SearchResult> {
  if (!selected.ok || selected.value === null) return port.doSearch(config, input, signal);
  const engines = splitEngines(selected.value);
  if (input.force_engine !== null) {
    backend.log('info', `强制使用引擎: ${input.force_engine}`);
    return port.doSearch(config, { ...input, engine: input.force_engine }, signal);
  }
  if (engines.length > 1 && input.engine === null) {
    const usable = engines.filter(engine => hasValidKeys(config.keys, engine));
    const skipped = engines.filter(engine => !hasValidKeys(config.keys, engine));
    if (skipped.length > 0) backend.log('info', `跳过未配置 API key 的引擎: ${debugList(skipped)}`);
    if (usable.length > 1) {
      backend.log('info', `启动多引擎聚合搜索，引擎数量: ${usable.length}`);
      return aggregatedSearch(backend, port, config, input, usable, signal);
    }
    if (usable.length === 1) {
      backend.log('info', `仅一个引擎有有效 API key，自动使用: ${usable[0]!}`);
      return port.doSearch(config, { ...input, engine: usable[0]! }, signal);
    }
    backend.log('warn', '所有选中引擎均未配置 API key，回退到默认引擎');
    return port.doSearch(config, input, signal);
  }
  if (input.engine === null && engines.length === 1) {
    backend.log('info', `仅选择单个搜索引擎，自动使用 session 配置的引擎: ${engines[0]!}`);
    return port.doSearch(config, { ...input, engine: engines[0]! }, signal);
  }
  return port.doSearch(config, input, signal);
}

/** mod.rs:1166-1383: concurrent per-engine search, CN-whitelist + URL dedupe, score sort, f32 re-rank. */
async function aggregatedSearch(
  backend: WebSearchToolBackend, port: CancellableWebSearchPort, config: ToolConfig,
  input: SearchInput, engines: string[], signal: AbortSignal,
): Promise<SearchResult> {
  const started = performance.now();
  const outcomes = await Promise.allSettled(
    engines.map(engine => port.doSearch(config, { ...input, engine }, signal)));
  if (signal.aborted) throw signal.reason;

  const items: SearchItem[] = [];
  const providers: Record<string, JsonValue> = {};
  const failedProviders: string[] = [];
  outcomes.forEach((outcome, index) => {
    const engine = engines[index]!;
    if (outcome.status === 'rejected') {
      backend.log('error', `引擎任务执行失败: ${errorText(outcome.reason)}`);
      return;
    }
    const result = outcome.value;
    if (!result.ok) {
      failedProviders.push(engine);
      backend.log('warn', `引擎 ${engine} 搜索失败: ${JSON.stringify(result.error ?? null)}`);
      return;
    }
    if (result.citations === undefined) return;
    result.citations.forEach((citation, rank) => items.push({
      title: citation.fileName,
      url: citation.documentId,
      snippet: rustLines(citation.chunkText).slice(0, 2).join(' '),
      rank: rank + 1,
      score_hint: Math.fround(citation.score),
    }));
    providers[engine] = result.citations.length;
  });

  if (items.length === 0) {
    const message = '所有搜索引擎都失败了';
    return {
      name: TOOL_NAME, ok: false, args: input, error: message, error_details: classifyError(message),
      usage: { elapsed_ms: Math.trunc(performance.now() - started), failed_providers: failedProviders, aggregated: true },
    };
  }

  const seen = new Set<string>();
  const unique: SearchItem[] = [];
  for (const item of items) {
    const normalized = normalizeUrl(item.url);
    const passes = config.cn_whitelist === null || isUrlWhitelisted(config.cn_whitelist, item.url);
    if (passes && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(item);
    } else if (!passes) {
      backend.log('debug', `URL被中文白名单过滤: ${item.url}`);
    }
  }
  unique.sort((a, b) => (b.score_hint ?? 0) - (a.score_hint ?? 0));
  const kept = unique.slice(0, config.reranker?.top_k ?? input.top_k);
  kept.forEach((item, index) => {
    item.rank = index + 1;
    item.score_hint = normalizeScore(index + 1, input.top_k);
  });
  const citations = kept.map(citationOf);
  const injectText = buildInjectText(config, {
    items: kept,
    raw: { aggregated: true, providers, total_unique_results: citations.length },
    provider: 'aggregated',
  });
  return {
    name: TOOL_NAME, ok: true, args: input,
    result: { aggregated: true, providers, failed_providers: failedProviders, total_unique_results: citations.length },
    citations,
    usage: {
      elapsed_ms: Math.trunc(performance.now() - started), reranking_time_ms: null,
      providers, failed_providers: failedProviders, aggregated: true,
    },
    inject_text: injectText,
  };
}

/** mod.rs:1083-1161: `!ok` takes `error.message` (else "web_search error"); citations keep their f32 score. */
function toolInvocation(result: SearchResult): ToolInvocation {
  if (!result.ok) {
    const message = isObject(result.error) && typeof result.error.message === 'string'
      ? result.error.message : 'web_search error';
    return [false, result.result ?? null, message, result.usage ?? { elapsed_ms: 0 }, null, null];
  }
  const citations: RagSourceInfo[] = (result.citations ?? []).map(citation => ({
    ...citation, score: f32ScoreJson(citation.score),
  }));
  return [true, result.result ?? null, null, result.usage ?? null, citations, result.inject_text ?? null];
}
