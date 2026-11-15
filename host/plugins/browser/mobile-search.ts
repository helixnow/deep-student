/** External provider search, without Electron's browser window or the desktop MCP registry. */
import { definePlugin } from '../../kernel/core.ts';
import type { HttpRequestInit } from '../../platform/http/api.ts';
import type { SettingsStore } from '../../platform/settings/api.ts';
import type { CancellableWebSearchPort, SearchInput, WebSearchService } from '../mcp/api.ts';
import { doSearch, hasValidKeys, loadToolConfig, toolConfigFromEnv, type ToolConfig } from '../mcp/portable.ts';
import { nowTimestamp } from './src/time.ts';
import { registerSearchSettings } from './src/register-search-settings.ts';

const engines = {
  bing_rss: 'Bing RSS（免费）', google_cse: 'Google CSE', serpapi: 'SerpAPI', tavily: 'Tavily',
  brave: 'Brave', searxng: 'SearXNG', zhipu: '智谱 AI', bocha: '博查 AI', deepseek: 'DeepSeek 官方搜索',
};
const probeInput = (query: string, engine: string | null, limit = 1): SearchInput => ({
  query, top_k: limit, engine, site: null, time_range: null, start: null, force_engine: null,
});

export default definePlugin({
  meta: {
    id: 'dstu.mobile.web-search', lane: 'L19-mcp-browser', platforms: ['mobile'],
    provides: ['webSearch'],
    commands: [
      'test_search_engine', 'test_all_search_engines', 'test_web_search_connectivity',
      'get_cn_whitelist_config', 'get_provider_strategies_config', 'save_provider_strategies_config',
    ],
  },
  inject: ['settings', 'http'],
  apply(ctx) {
    const log = (message: string) => ctx.logger('web-search').warn(message);
    const fetcher: typeof fetch = (input, init) => ctx.http.fetch(input instanceof Request ? input.url : input, {
      method: init?.method, headers: init?.headers, body: init?.body as HttpRequestInit['body'],
      signal: init?.signal ?? undefined, redirect: init?.redirect,
    });
    const search = (config: ToolConfig, input: SearchInput, signal?: AbortSignal) => doSearch(config, input, log, signal, fetcher);
    const load = async (settings: SettingsStore | null) => settings === null ? toolConfigFromEnv() : loadToolConfig(settings, log);
    const service: WebSearchService & CancellableWebSearchPort = {
      loadConfig: load,
      async doSearch(first: SearchInput | ToolConfig, second?: SearchInput | AbortSignal, signal?: AbortSignal) {
        if (second === undefined || 'aborted' in second) return search(await load(ctx.settings), first as SearchInput, second);
        return search(first as ToolConfig, second, signal);
      },
    };
    ctx.provide('webSearch', service);
    registerSearchSettings(ctx);
    ctx.commands.register<{ engine: string }>('test_search_engine', async ({ engine }) => {
      const started = performance.now();
      const query = 'AI artificial intelligence';
      const result = await search(await load(ctx.settings), { ...probeInput(query, null, 5), force_engine: engine });
      const base = { response_time: Math.trunc(performance.now() - started), test_query: query };
      if (result.ok) return { ...base, ok: true, message: `${engine}搜索引擎连接正常` };
      const error = typeof result.error === 'string' ? result.error : '未知错误';
      return { ...base, ok: false, message: `${engine}搜索引擎测试失败: ${error}`, error_details: error };
    });
    ctx.commands.register<{ engine?: string | null }>('test_web_search_connectivity', async ({ engine }) => {
      const result = await search(await load(ctx.settings), probeInput('connectivity test', engine?.trim() || null));
      return result.ok ? { success: true, usage: result.usage ?? null } : { success: false, detail: result };
    });
    ctx.commands.register('test_all_search_engines', async () => {
      const config = await load(ctx.settings);
      const entries = await Promise.all(Object.entries(engines).map(async ([id, name]) => {
        if (!hasValidKeys(config.keys, id)) return [id, { name, status: 'not_configured', message: '缺少API密钥或端点配置', elapsed_ms: 0 }] as const;
        const started = performance.now();
        const result = await search(config, probeInput('test connectivity', id));
        const elapsed_ms = Math.trunc(performance.now() - started);
        return [id, result.ok
          ? { name, status: 'success', message: '连接成功', elapsed_ms, results_count: result.citations?.length ?? 0 }
          : { name, status: 'failed', message: typeof result.error === 'string' ? result.error : '未知错误', elapsed_ms }] as const;
      }));
      const success = entries.filter(([, entry]) => entry.status === 'success').length;
      const configured = entries.filter(([, entry]) => entry.status !== 'not_configured').length;
      return { results: Object.fromEntries(entries), summary: { total: entries.length, configured, success, failed: configured - success }, timestamp: nowTimestamp() };
    });
  },
});
