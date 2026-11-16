/**
 * 移动端浏览器/搜索插件（dstu.browser, platforms: ['mobile']）：
 * - 提供 `llmWebSearchFallback`、`browserToolPolicy`、`webpageToolPolicy` 服务
 * - 实现 `network_probe`
 * - `webSearch` 服务与 `test_search_engine` / `test_web_search_connectivity` / `test_all_search_engines`
 *   由 `dstu.mobile.web-search`（browser/mobile-search.ts）提供，这里不重复注册
 * - 桌面内嵌 webview 命令（`browser_*`）仍由 `dstu.mobile.compat` 声明为不支持
 * - FeatureFlag 命令由 `dstu.settings` 注册，白名单/策略配置命令由 `dstu.mobile.web-search` 注册，避免重复注册冲突
 */
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import { browserToolPolicy } from './src/tool-executor.ts';
import { indexWebpageToolPolicy } from './src/index-webpage.ts';
import { networkProbe } from './src/network-probe.ts';
import { createWebSearchFallback } from './src/web-search-fallback.ts';

const PORTABLE_COMMANDS = ['network_probe'] as const;

function createFetchBridge(ctx: Context): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const http = ctx.get('http');
    if (http !== undefined && (typeof input === 'string' || input instanceof URL)) {
      return http.fetch(input, init as Parameters<typeof http.fetch>[1]);
    }
    return globalThis.fetch(input, init);
  };
}

export default definePlugin({
  meta: {
    id: 'dstu.browser',
    lane: 'L19-mcp-browser',
    provides: ['llmWebSearchFallback', 'browserToolPolicy', 'webpageToolPolicy'],
    platforms: ['mobile'],
    commands: [...PORTABLE_COMMANDS],
  },
  inject: ['settings', 'log'],
  apply(ctx: Context) {
    const rawLogger = (ctx.logger?.('dstu.browser') ?? ctx.log.logger('dstu.browser')) as unknown as Record<
      string,
      ((message: string) => void) | undefined
    >;
    const fetchImpl = createFetchBridge(ctx);
    const emitLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
      const fn = rawLogger[level] ?? rawLogger.info ?? rawLogger.warn;
      fn?.call(rawLogger, message);
    };

    ctx.provide('browserToolPolicy', browserToolPolicy);
    ctx.provide('webpageToolPolicy', indexWebpageToolPolicy);
    ctx.provide('llmWebSearchFallback', createWebSearchFallback({
      settings: ctx.settings,
      emit: (event, payload) => { ctx.get('backendEvents')?.emit(event, payload); },
      log: emitLog,
      searchLog: message => { emitLog('info', message); },
      fetchImpl,
    }));

    ctx.commands.register<{
      url: string;
      method?: string | null;
      timeoutMs?: number | null;
    }>('network_probe', async ({ url, method, timeoutMs }) => (
      networkProbe(url, method ?? null, timeoutMs ?? null, fetchImpl)
    ));
  },
});

export { PORTABLE_COMMANDS as BROWSER_PORTABLE_COMMANDS };
