import { CommandError, definePlugin } from '../../kernel/api.ts';
import type {} from '../../platform/http/api.ts';
import type {} from '../../platform/log/api.ts';
import type {} from '../../platform/settings/api.ts';
import { toRfc3339 } from '../../platform/time/index.ts';
import { rustTrim } from '../../platform/util/portable.ts';
import type { LlmMcpTools } from '../llm/api.ts';
import type { JsonValue } from './api.ts';
import { loadMcpConfig, mcpStatus, saveMcpConfig } from './src/config.ts';
import {
  createRemoteTransportForConfig, testHttp, testSse, testStreamableHttpRmcp, testWebSocket,
  type McpRemoteNetwork,
} from './src/probe-core.ts';
import { HostMcpService } from './src/service-core.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default definePlugin({
  meta: {
    id: 'dstu.mcp', lane: 'L19-mcp-browser', platforms: ['mobile'], provides: ['mcp'],
    commands: [
      'get_mcp_config', 'save_mcp_config', 'get_mcp_status', 'get_mcp_tools', 'reload_mcp_client', 'preheat_mcp_tools',
      'test_mcp_http', 'test_mcp_sse', 'test_mcp_websocket', 'test_rmcp_streamable_http',
    ],
  },
  inject: ['settings', 'http', 'webSearch', 'log'],
  apply(ctx) {
    const log = ctx.log.logger('dstu_mcp::mcp');
    const probeLog = (level: 'warn' | 'error', text: string): void => log[level](text);
    const network: McpRemoteNetwork = {
      // These endpoints come from explicit settings or a direct connection test, like a configured model/WebDAV server.
      // Do not reuse this port for model-supplied URLs. A redirect or different SSE message origin needs its own approval.
      fetch: async (url, init) => {
        const target = new URL(url);
        if (target.username || target.password) throw new Error('An MCP endpoint must not contain embedded credentials');
        const response = await ctx.http.fetch(target, {
          method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined,
          signal: init.signal ?? undefined, timeoutMs: null, redirect: 'manual',
        });
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel();
          throw new TypeError('MCP redirects are disabled; configure the final endpoint URL');
        }
        return response;
      },
      sameOriginSse: true,
      openWebSocket: (raw) => {
        const url = new URL(raw);
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('An MCP WebSocket endpoint must use ws:// or wss://');
        if (url.username || url.password) throw new Error('An MCP endpoint must not contain embedded credentials');
        return new WebSocket(url);
      },
    };
    const service = new HostMcpService({
      log: (level, text) => { log[level](text); },
      namespacePrefix: () => ctx.settings.get('mcp.tools.namespace_prefix'),
      webSearch: ctx.webSearch,
      webSearchDb: { settings: ctx.settings, port: ctx.webSearch },
      emitEvent: (event, payload) => ctx.backendEvents.emit(event, payload),
      emitTo: (target, event, payload) => ctx.backendEvents.emitTo(target, event, payload),
      listenWindow: (window, event, receive) => ctx.backendEvents.listenWindow(window, event, receive),
      onToolsChanged: () => ctx.backendEvents.emit('mcp_tools_changed', { ts: toRfc3339() }),
    }, config => createRemoteTransportForConfig(config, network));
    ctx.provide('mcp', service);
    ctx.effect(() => () => service.dispose());
    const settings = () => loadMcpConfig(ctx.settings, text => log.warn(text));
    const useBackend = () => ctx.settings.get('mcp.mode') === 'backend';
    const llmCache = () => ctx.get('llmMcpTools') as LlmMcpTools | undefined;
    let lastError: string | null = null;
    let backendOperation = Promise.resolve();
    const reloadBackend = (): Promise<void> => {
      backendOperation = backendOperation.catch(() => undefined).then(async () => {
        if (!useBackend()) {
          await service.dispose();
          lastError = null;
          return;
        }
        try {
          const config = settings();
          if (config.transport.type === 'stdio') throw new Error('标准输入输出（stdio）MCP 仅桌面端可用');
          await service.initializeGlobalClient(config);
          lastError = null;
        } catch (error) {
          await service.dispose();
          lastError = message(error);
          throw error;
        }
      });
      return backendOperation;
    };
    if (useBackend()) void reloadBackend().catch(error => log.warn(`MCP connection failed: ${message(error)}`));

    ctx.commands.register('get_mcp_config', settings);
    ctx.commands.register<{ config: JsonValue }>('save_mcp_config', ({ config }) => {
      saveMcpConfig(ctx.settings, config);
      return true;
    });
    ctx.commands.register('get_mcp_status', async () => {
      const status = mcpStatus(ctx.settings);
      const client = await service.getGlobalClient();
      const connected = client?.isConnected() ?? false;
      return {
        ...status, available: true, connected,
        last_error: useBackend() ? lastError : null,
        tools_count: connected && client ? (await client.listTools().catch(() => [])).length : 0,
      };
    });
    ctx.commands.register('get_mcp_tools', async () => (await service.getGlobalClient())?.listTools() ?? []);
    ctx.commands.register('reload_mcp_client', async () => {
      llmCache()?.clear();
      try {
        await reloadBackend();
        return { success: true, message: useBackend() ? 'MCP server connected' : 'MCP frontend tools refreshed' };
      } catch (error) {
        throw new CommandError(message(error));
      }
    });
    ctx.commands.register('preheat_mcp_tools', async (_args, call) => {
      const cache = llmCache();
      if (!cache) throw new CommandError('MCP tool cache is unavailable');
      return { ok: true, count: await cache.preheat(call.source) };
    });
    ctx.commands.register<{ endpoint: string; apiKey: string; env?: Record<string, string> | null }>(
      'test_mcp_http', ({ endpoint, apiKey, env }) => testHttp(endpoint, rustTrim(apiKey) || null, env ?? null, probeLog, network),
    );
    ctx.commands.register<{ endpoint: string; apiKey: string; env?: Record<string, string> | null }>(
      'test_mcp_sse', ({ endpoint, apiKey, env }) => testSse(endpoint, rustTrim(apiKey) || null, env ?? null, probeLog, network),
    );
    ctx.commands.register<{ url: string }>('test_mcp_websocket', ({ url }) => testWebSocket(url, network));
    ctx.commands.register<{ url: string; apiKey?: string | null }>(
      'test_rmcp_streamable_http', ({ url, apiKey }) => testStreamableHttpRmcp(url, apiKey ?? null, network),
    );
  },
});
