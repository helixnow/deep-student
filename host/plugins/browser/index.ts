import { CommandError, definePlugin } from '../../kernel/api.ts';
import { AppError } from '../../platform/errors/api.ts';
import type { HttpRequestInit, HttpService } from '../../platform/http/api.ts';
import type { SettingsStore } from '../../platform/settings/api.ts';
import { createFeatureFlagCommands } from '../../platform/settings/feature-flag-commands.ts';
import type {} from '../../platform/storage/api.ts';
import { rustTrim } from '../../platform/util/portable.ts';
import type {} from '../agent-skills/api.ts';
import { artifactRoot } from '../agent-workspace/api.ts';
import type {} from '../vfs/api.ts';
import type {} from '../vfs-index/api.ts';
import type {} from '../vfs-repos/api.ts';
import type { AgentToolsService } from '../agent-skills/api.ts';
import type { VfsDatabase } from '../vfs/api.ts';
import type { UnitBuilderService, VfsIndexService } from '../vfs-index/api.ts';
import type { VfsReposService } from '../vfs-repos/api.ts';
import { browserToolPolicy, indexWebpageToolPolicy } from './api.ts';
import { BrowserToolExecutor } from './src/browser-tool-executor.ts';
import { createWebSearchFallback } from './src/web-search-fallback.ts';
import { IndexWebpageToolExecutor } from './src/index-webpage-executor.ts';
import { doSearch, hasValidKeys, loadToolConfig, toolConfigFromEnv } from '../mcp/api.ts';
import { createWebSearchToolRegistry } from '../mcp/api.ts';
import type { SearchInput, SearchResult, ToolConfig } from '../mcp/api.ts';
import { ensurePublicSettingKey, ensurePublicSettingPrefix, errorMessage, namespaceConfig, securityStatus } from './src/settings.ts';
import { networkProbe } from './src/network-probe.ts';
import { BrowserRuntimeService, type BrowserPlatform } from './src/browser-service.ts';
import { BrowserDatabase } from './src/database.ts';
import { ShellBrowserSurface } from './src/surface-host.ts';
import { BrowserFailure } from './src/error.ts';
import { mapBrowserError, stateResult, type JsonValue } from './src/command-result.ts';
import { BROWSER_CONTENT_LABEL } from './src/session.ts';
import { nowTimestamp } from './src/time.ts';
import { registerSearchSettings } from './src/register-search-settings.ts';

function hasAnyKey(config: ToolConfig, engine: string): boolean {
  switch (engine) {
    case 'serpapi': return config.keys.serpapi !== null;
    case 'tavily': return config.keys.tavily !== null;
    case 'brave': return config.keys.brave !== null;
    case 'zhipu': return config.keys.zhipu !== null;
    case 'bocha': return config.keys.bocha !== null;
    case 'deepseek': return config.keys.deepseek !== null;
    default: return false;
  }
}
export default definePlugin({
  meta: {
    id: 'dstu.browser', lane: 'L19-mcp-browser',
    provides: ['webSearch', 'llmWebSearchFallback', 'browser', 'browserToolPolicy', 'webpageToolPolicy'],
    commands: ['save_setting', 'get_setting', 'delete_setting', 'get_settings_by_prefix', 'delete_settings_by_prefix',
      'get_security_status', 'detect_tool_conflicts', 'get_tools_namespace_config',
      'get_cn_whitelist_config', 'get_provider_strategies_config', 'save_provider_strategies_config',
      'get_feature_flags', 'update_feature_flag', 'is_feature_enabled',
      'test_search_engine', 'test_web_search_connectivity', 'test_all_search_engines', 'network_probe',
      'browser_open_session', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
      'browser_get_state', 'browser_close', 'browser_focus', 'browser_release_surface_focus',
      'browser_set_surface_bounds', 'browser_set_surface_visibility', 'browser_get_surface_host_mode',
      'browser_content_user_input', 'browser_take_over', 'browser_snapshot', 'browser_click',
      'browser_type', 'browser_set_input_files', 'browser_list_downloads', 'browser_list_task_downloads',
      'browser_scroll'],
  },
  inject: ['settings', 'storage', 'log', 'featureFlags'],
  apply(ctx) {
    const searchLog = (message: string): void => {
      ctx.log?.logger?.('dstu_mcp::tools::web_search')?.warn?.(message);
    };
    // Optional `http` service routes web search through Host proxy & network policy when present,
    // while keeping minimal/test hosts without `http` working over `globalThis.fetch`.
    let optionalHttp: HttpService | undefined = ctx.get('http') as HttpService | undefined;
    ctx.inject(['http'], scoped => {
      optionalHttp = scoped.http;
      scoped.effect(() => () => { optionalHttp = undefined; });
    });
    const httpFetch: typeof fetch = (input, init) => {
      const http = optionalHttp ?? (ctx.get('http') as HttpService | undefined);
      if (http !== undefined && typeof http.fetch === 'function') {
        return http.fetch(input instanceof Request ? input.url : input, {
          method: init?.method,
          headers: init?.headers,
          body: init?.body as HttpRequestInit['body'],
          signal: init?.signal ?? undefined,
          redirect: init?.redirect,
        });
      }
      return globalThis.fetch(input, init);
    };
    // L13 loads config before emitting its start event, then searches with the run signal.
    const webSearchDoSearch = async (
      first: SearchInput | ToolConfig, input?: SearchInput | AbortSignal, signal?: AbortSignal,
    ): Promise<SearchResult> => {
      if (input === undefined || 'aborted' in input) {
        return doSearch(await loadToolConfig(ctx.settings, searchLog), first as SearchInput, searchLog, input, httpFetch);
      }
      return doSearch(first as ToolConfig, input, searchLog, signal, httpFetch);
    };
    ctx.provide('webSearch', {
      loadConfig: async (settings: SettingsStore | null): Promise<ToolConfig> =>
        settings === null ? toolConfigFromEnv() : loadToolConfig(settings, searchLog),
      doSearch: webSearchDoSearch,
    });
    // tools/mod.rs:630-648 install_web_search_fallback: llm's supports_tools=false injection path.
    ctx.provide('llmWebSearchFallback', createWebSearchFallback({
      settings: ctx.settings,
      emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
      log: (level, message) => { ctx.log?.logger?.('dstu_mcp::tools')?.[level]?.(message); },
      searchLog,
      fetchImpl: httpFetch,
    }));
    const flagCommands = createFeatureFlagCommands({
      featureFlags: ctx.featureFlags, settings: ctx.settings, appVersion: ctx.app.version, debug: ctx.app.debug,
    });
    const featureFlagEnabled = (name: string): boolean => flagCommands.isFeatureEnabled({ featureName: name });
    const platform = ctx.app.platform as BrowserPlatform;
    const surface = ctx.get('browserSurface')
      ?? new ShellBrowserSurface(ctx.shell, platform, ctx.backendEvents);
    const browserService = new BrowserRuntimeService({
      db: new BrowserDatabase({
        database: name => ctx.storage.database(name),
        pathOf: name => ctx.storage.pathOf(name),
      }),
      settings: ctx.settings,
      surface,
      platform,
      featureFlags: { isEnabled: featureFlagEnabled },
      emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
      log: (level, message) => { ctx.log?.logger?.('dstu_browser')?.[level]?.(message); },
      // extensions.rs:186 ChatV2DownloadArtifactRoot: runtime_roots::artifact_root(app, id, true).path
      artifactRoot: async chatSessionId => artifactRoot(ctx.app.dataDir, chatSessionId, true).path,
    });
    ctx.effect(() => () => browserService.dispose());
    ctx.provide('browser', browserService);
    ctx.provide('browserToolPolicy', browserToolPolicy);
    ctx.provide('webpageToolPolicy', indexWebpageToolPolicy);
    // `test_search_engine`: shared by the IPC command and `dstu_config_search_test`.
    const testSearchEngine = async (engine: string) => {
      const started = performance.now();
      // cmd/web_search.rs:485-512: `num_results` is not a WebSearchTool field, so top_k stays 5.
      const registry = createWebSearchToolRegistry({ doSearch: (input, signal) => webSearchDoSearch(input, signal) });
      const [ok, , error] = await registry.callTool(
        'web_search',
        { query: 'AI artificial intelligence', num_results: 3, force_engine: engine },
        { supports_tools: true, mcp_client: null, stream_event: null, stage: 'test', memory_enabled: null },
      );
      const responseTime = Math.trunc(performance.now() - started);
      if (ok) return { ok: true, message: `${engine}搜索引擎连接正常`, response_time: responseTime, test_query: 'AI artificial intelligence' };
      const errorMessageText = error ?? '未知错误';
      return {
        ok: false, message: `${engine}搜索引擎测试失败: ${errorMessageText}`,
        response_time: responseTime, test_query: 'AI artificial intelligence', error_details: errorMessageText,
      };
    };
    const browserExecutor = new BrowserToolExecutor({
      service: () => browserService,
      settings: ctx.settings,
      featureFlagEnabled,
      searchConfig: {
        settings: ctx.settings,
        emit: (event, payload) => { ctx.backendEvents.emit(event, payload); },
        testEngine: engine => testSearchEngine(engine),
        log: (level, message) => { ctx.log?.logger?.('dstu_browser_search_config')?.[level]?.(message); },
      },
      runtimeRoots: () => ctx.get('runtimeRoots') ?? null,
      log: (level, message) => { ctx.log?.logger?.('dstu_browser_agent')?.[level]?.(message); },
    });
    const vfsDatabase = (): VfsDatabase | undefined =>
      ctx.get('vfsDatabase') as VfsDatabase | undefined;
    const indexExecutor = new IndexWebpageToolExecutor({
      connection: () => {
        const database = vfsDatabase();
        if (database === undefined) return null;
        try { return database.getConnSafe(); }
        catch (error) {
          ctx.log?.logger?.('dstu_browser_agent')?.warn?.(
            `[IndexWebpageToolExecutor] VFS connection unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
      blobsDir: () => vfsDatabase()?.blobsDir() ?? null,
      repos: () => (ctx.get('vfsRepo') as VfsReposService | undefined) ?? null,
      unitBuilder: () => (ctx.get('vfsUnitBuilder') as UnitBuilderService | undefined) ?? null,
      indexing: () => (ctx.get('vfsIndex') as VfsIndexService | undefined)?.indexing ?? null,
      statusSummary: () => {
        const index = ctx.get('vfsIndex') as VfsIndexService | undefined;
        return index?.getStatusSummary?.() ?? null;
      },
      log: (level, message) => { ctx.log?.logger?.('dstu_browser_agent')?.[level]?.(message); },
    });
    // L07 publishes the executor registration surface; L04's ToolExecutorRegistry
    // consumes `toolExecutors()` when it assembles dispatch. Register lazily so
    // plugin load order does not matter.
    let toolExecutorsRegistered = false;
    ctx.inject(['agentTools'], scoped => {
      if (toolExecutorsRegistered) return;
      const tools = scoped.get('agentTools') as AgentToolsService | undefined;
      if (tools === undefined || typeof tools.registerToolExecutors !== 'function') return;
      tools.registerToolExecutors([browserExecutor, indexExecutor]);
      toolExecutorsRegistered = true;
      scoped.effect(() => () => { toolExecutorsRegistered = false; });
    });
    const browserFail = (error: unknown): never => {
      if (error instanceof BrowserFailure) throw new CommandError(mapBrowserError(error.error));
      if (error instanceof CommandError) throw error;
      throw new CommandError(error instanceof Error ? error.message : String(error));
    };
    const browserState = async (sessionId: string) => {
      const state = browserService.getState(sessionId);
      if (state === null) throw new CommandError(`NOT_FOUND: session ${sessionId}`);
      return stateResult(state, browserService.getHistoryEntries(sessionId), platform);
    };
    ctx.commands.register<{ url: string; displayName?: string | null; chatSessionId?: string | null; reuseExisting?: boolean | null; fromAgent?: boolean | null }>(
      'browser_open_session', async args => {
        try {
          const state = await browserService.openSession({
            url: args.url, displayName: args.displayName ?? null,
            chatSessionId: args.chatSessionId ?? null,
            reuseExisting: args.reuseExisting ?? true, fromAgent: args.fromAgent ?? false,
          });
          return stateResult(state, browserService.getHistoryEntries(state.id), platform);
        } catch (error) { return browserFail(error); }
      });
    ctx.commands.register<{ sessionId: string; url: string; replace?: boolean | null; fromAgent?: boolean | null }>(
      'browser_navigate', async args => {
        try {
          const state = await browserService.navigate(
            args.sessionId, args.url, args.replace ?? false, args.fromAgent ?? false,
          );
          return stateResult(state, browserService.getHistoryEntries(state.id), platform);
        } catch (error) { return browserFail(error); }
      });
    ctx.commands.register<{ sessionId: string }>('browser_back', async ({ sessionId }) => {
      try {
        const state = await browserService.back(sessionId);
        return stateResult(state, browserService.getHistoryEntries(state.id), platform);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string }>('browser_forward', async ({ sessionId }) => {
      try {
        const state = await browserService.forward(sessionId);
        return stateResult(state, browserService.getHistoryEntries(state.id), platform);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; hard?: boolean | null }>('browser_reload', async ({ sessionId }) => {
      try {
        const state = await browserService.reload(sessionId);
        return stateResult(state, browserService.getHistoryEntries(state.id), platform);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId?: string | null }>('browser_get_state', async ({ sessionId }) => {
      try {
        await browserService.assertGatesOpen();
        if (sessionId !== undefined && sessionId !== null) return await browserState(sessionId);
        const state = browserService.getActiveState();
        return state === null ? null : stateResult(state, browserService.getHistoryEntries(state.id), platform);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId?: string | null }>('browser_close', async ({ sessionId }) => {
      try {
        if (sessionId !== undefined && sessionId !== null) {
          const active = browserService.getActiveState();
          if (active === null || active.id !== sessionId) throw new CommandError(`NOT_FOUND: session ${sessionId}`);
        }
        await browserService.closeSession();
        return null;
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId?: string | null }>('browser_focus', async ({ sessionId }) => {
      try {
        await browserService.assertGatesOpen();
        let id = sessionId ?? null;
        if (id === null) {
          const active = browserService.getActiveState();
          if (active === null) throw new CommandError('NOT_FOUND: no active browser session');
          id = active.id;
        }
        await browserService.focus(id);
        return null;
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string }>('browser_release_surface_focus', async ({ sessionId }) => {
      try {
        await browserService.assertGatesOpen();
        await browserService.releaseSurfaceFocus(sessionId);
        return null;
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{
      sessionId: string; x: number; y: number; width: number; height: number;
      viewportWidth: number; viewportHeight: number;
      occlusions?: import('./api.ts').SurfaceCssOcclusion[] | null;
      inputOcclusions?: import('./api.ts').SurfaceCssOcclusion[] | null;
      sequence: number;
    }>('browser_set_surface_bounds', async args => {
      try {
        await browserService.assertGatesOpen();
        return await browserService.setSurfaceBounds(
          args.sessionId, args.x, args.y, args.width, args.height,
          args.viewportWidth, args.viewportHeight,
          args.occlusions ?? [], args.inputOcclusions ?? [], args.sequence,
        );
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; visible: boolean; focus?: boolean | null }>(
      'browser_set_surface_visibility', async args => {
        try {
          await browserService.assertGatesOpen();
          return await browserService.setSurfaceVisibility(
            args.sessionId, args.visible, args.focus ?? false,
          );
        } catch (error) { return browserFail(error); }
      });
    ctx.commands.register('browser_get_surface_host_mode', () => browserService.surfaceHostMode());
    ctx.commands.register<{ sessionId: string; nonce: string; kind: string }>(
      'browser_content_user_input', (args, call) => {
        try {
          if (call.source.webview !== BROWSER_CONTENT_LABEL) {
            throw new CommandError('FORBIDDEN: trusted browser input requires browser-content Webview');
          }
          browserService.contentUserInput(args.sessionId, args.nonce, args.kind);
          return null;
        } catch (error) { return browserFail(error); }
      });
    ctx.commands.register('browser_take_over', async () => {
      try {
        await browserService.assertGatesOpen();
        const state = browserService.takeOver();
        return stateResult(state, browserService.getHistoryEntries(state.id), platform);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; maxChars?: number | null }>('browser_snapshot', async args => {
      try {
        return await browserService.snapshot(args.sessionId, args.maxChars ?? null);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; ref: string }>('browser_click', async args => {
      try { return await browserService.click(args.sessionId, args.ref); }
      catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; ref: string; text: string; submit?: boolean | null }>(
      'browser_type', async args => {
        try { return await browserService.type(args.sessionId, args.ref, args.text, args.submit ?? false); }
        catch (error) { return browserFail(error); }
      });
    ctx.commands.register<{ sessionId: string; ref: string; files: JsonValue }>(
      'browser_set_input_files', async args => {
        try { return await browserService.setInputFiles(args.sessionId, args.ref, args.files); }
        catch (error) { return browserFail(error); }
      });
    ctx.commands.register<{ sessionId: string }>('browser_list_downloads', async ({ sessionId }) => {
      try {
        await browserService.assertGatesOpen();
        browserService.getState(sessionId);
        return browserService.listDownloads(sessionId);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ chatSessionId: string }>('browser_list_task_downloads', async ({ chatSessionId }) => {
      try {
        await browserService.assertGatesOpen();
        return browserService.listTaskDownloads(chatSessionId);
      } catch (error) { return browserFail(error); }
    });
    ctx.commands.register<{ sessionId: string; direction?: string | null; amount?: number | null; ref?: string | null }>(
      'browser_scroll', async args => {
        try {
          return await browserService.scroll(
            args.sessionId, args.direction ?? null, args.amount ?? null, args.ref ?? null,
          );
        } catch (error) { return browserFail(error); }
      });
    ctx.commands.register<{ key: string; value: string }>('save_setting', async ({ key, value }) => {
      ensurePublicSettingKey(key);
      try { await ctx.settings.saveSecret(key, value); }
      catch (e) { throw new CommandError(AppError.database(`保存设置失败: ${errorMessage(e)}`)); }
      if (key === 'desktop.workbenchBrowserNetworkMode') ctx.get('browser')?.syncNetworkModeValue(value);
      return true;
    });
    ctx.commands.register<{ key: string }>('get_setting', async ({ key }) => {
      ensurePublicSettingKey(key);
      try { return await ctx.settings.getSecret(key); }
      catch (e) { throw new CommandError(AppError.database(`读取设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ key: string }>('delete_setting', async ({ key }) => {
      ensurePublicSettingKey(key);
      try { return await ctx.settings.deleteSecret(key); }
      catch (e) { throw new CommandError(AppError.database(`删除设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ prefix: string }>('get_settings_by_prefix', ({ prefix }) => {
      ensurePublicSettingPrefix(prefix);
      try { return ctx.settings.listByPrefix(prefix).map(row => [row.key, row.value, row.updatedAt]); }
      catch (e) { throw new CommandError(AppError.database(`按前缀查询设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register<{ prefix: string }>('delete_settings_by_prefix', ({ prefix }) => {
      ensurePublicSettingPrefix(prefix);
      try { return ctx.settings.deleteByPrefix(prefix); }
      catch (e) { throw new CommandError(AppError.database(`按前缀批量删除设置失败: ${errorMessage(e)}`)); }
    });
    ctx.commands.register('get_security_status', () => securityStatus());
    // Rust explicitly disables backend conflict detection; frontend SDK owns namespacing.
    ctx.commands.register('detect_tool_conflicts', () => []);
    ctx.commands.register('get_tools_namespace_config', () => namespaceConfig(ctx.settings));

    registerSearchSettings(ctx, () => {
      ctx.log?.logger?.('deep_student::cmd::web_search')?.info?.('Provider策略配置已保存');
    });

    ctx.commands.register('get_feature_flags', flagCommands.getFeatureFlags);
    ctx.commands.register('update_feature_flag', flagCommands.updateFeatureFlag);
    ctx.commands.register('is_feature_enabled', flagCommands.isFeatureEnabled);

    ctx.commands.register<{ engine: string }>('test_search_engine', async ({ engine }) => {
      return await testSearchEngine(engine);
    });

    // RUST-FIX(RF-W05-web-search-connectivity-unregistered): cmd/web_search.rs:43 is a #[tauri::command] the
    // frontend wraps (settingsApi.ts), but Rust never put it in generate_handler!, so invoking it always failed.
    ctx.commands.register<{ engine?: string | null }>('test_web_search_connectivity', async ({ engine }) => {
      const config = await loadToolConfig(ctx.settings, searchLog);
      if (engine != null && rustTrim(engine) !== '') config.default_engine = engine;
      const result = await doSearch(config, {
        query: 'connectivity test', top_k: 1, engine: null, site: null,
        time_range: null, start: null, force_engine: null,
      }, searchLog, undefined, httpFetch);
      return result.ok ? { success: true, usage: result.usage ?? null } : { success: false, detail: result };
    });

    ctx.commands.register('test_all_search_engines', async () => {
      const config = await loadToolConfig(ctx.settings, searchLog);
      const engines: [string, string][] = [
        ['bing_rss', 'Bing RSS（免费）'], ['google_cse', 'Google CSE'], ['serpapi', 'SerpAPI'],
        ['tavily', 'Tavily'], ['brave', 'Brave'], ['searxng', 'SearXNG'],
        ['zhipu', '智谱 AI'], ['bocha', '博查 AI'], ['deepseek', 'DeepSeek 官方搜索'],
      ];
      const results: Record<string, unknown> = {};
      for (const [engineId, engineName] of engines) {
        const started = performance.now();
        const hasConfig = engineId === 'bing_rss' ? true
          : engineId === 'google_cse' ? config.keys.google_cse !== null && config.keys.google_cse_cx !== null
            : engineId === 'searxng' ? config.keys.searxng_endpoint !== null
              : hasAnyKey(config, engineId);
        if (!hasConfig) {
          results[engineId] = { name: engineName, status: 'not_configured', message: '缺少API密钥或端点配置', elapsed_ms: 0 };
          continue;
        }
        const result = await doSearch(config, {
          query: 'test connectivity', top_k: 1, engine: engineId, site: null,
          time_range: null, start: null, force_engine: null,
        }, searchLog, undefined, httpFetch);
        const elapsed = Math.trunc(performance.now() - started);
        if (result.ok) {
          results[engineId] = {
            name: engineName, status: 'success', message: '连接成功', elapsed_ms: elapsed,
            results_count: result.citations?.length ?? 0,
          };
        } else {
          const error = typeof result.error === 'string' ? result.error : '未知错误';
          results[engineId] = { name: engineName, status: 'failed', message: error, elapsed_ms: elapsed };
        }
      }
      const values = Object.values(results) as { status: string }[];
      const success = values.filter(entry => entry.status === 'success').length;
      const configured = values.filter(entry => entry.status !== 'not_configured').length;
      return {
        results,
        summary: { total: values.length, configured, success, failed: configured - success },
        timestamp: nowTimestamp(),
      };
    });

    ctx.commands.register<{ url: string; method?: string | null; timeoutMs?: number | null }>(
      'network_probe', async ({ url, method, timeoutMs }) => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          throw new CommandError(`仅支持 http/https URL: ${url}`);
        }
        return networkProbe(url, method, timeoutMs);
      });
  },
});
