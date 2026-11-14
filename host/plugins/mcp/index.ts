import { CommandError, definePlugin } from '../../kernel/api.ts';
import { AppError } from '../../platform/errors/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../platform/settings/api.ts';
import type {} from '../../platform/log/api.ts';
import type {} from '../../platform/secrets/api.ts';
import type { LlmMcpTools } from '../llm/api.ts';
import type { JsonValue } from './api.ts';
import { loadMcpConfig, mcpStatus, saveMcpConfig } from './src/config.ts';
import { readMcpAllowUnapproved, readMcpToolsList, writeMcpAllowUnapproved } from './src/mcp-settings.ts';
import { StdioSessionManager } from './src/stdio-proxy.ts';
import { normalizeCommandPath, validateStdioStart } from './src/stdio-validation.ts';
import { testHttp, testSse, testStdio, testStreamableHttpRmcp, testWebSocket } from './src/probe.ts';
import { McpOAuthManager } from './src/oauth-manager.ts';
import { HostMcpService } from './src/service.ts';
import { toRfc3339 } from '../../platform/time/index.ts';
import { rustTrim } from '../../platform/util/index.ts';

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * `CallContext.signal` aborts when the plugin stops or when the caller abandons the invoke
 * (kernel/API.md §2). A Rust OAuth flow survives a page reload and still persists its token,
 * so an abandon only releases the dead reply; a plugin stop cancels the flow through `stop`.
 */
function untilAbandoned<T>(flow: Promise<T>, signal: AbortSignal, stop: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      if (reason === 'window-closed' || reason === 'reloaded') {
        reject(new Error(`OAuth authorization continues after the caller abandoned the invoke (${reason})`));
      } else {
        stop.abort(reason);
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    flow.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * L02 `llmMcpTools`, the frontend MCP tool cache (`llm_manager/mod.rs:8199-8211,8263-8267`).
 * The backend MCP client is disabled, but reload/preheat still clear and refill that cache.
 * Resolved per call, not injected: the other MCP commands must not wait on dstu.llm.
 */
function llmMcpTools(ctx: Context): LlmMcpTools {
  const service = ctx.reflect.get('llmMcpTools', false) as LlmMcpTools | null | undefined;
  if (service == null) {
    throw new CommandError(AppError.internal('llmMcpTools 服务不可用（dstu.llm 未就绪），无法执行 MCP 工具缓存清理/预热'));
  }
  return service;
}

/**
 * `lib.rs:1625-1642`: backend MCP starts only when `mcp.mode=backend`;
 * failures are logged and never block application startup.
 */
function startBackendMcp(
  ctx: Context, service: HostMcpService,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): void {
  let mode: string | null = null;
  try { mode = ctx.settings.get('mcp.mode'); }
  catch { mode = null; }
  if (mode !== 'backend') {
    log('info', `🔧 [MCP] 后端MCP已禁用(mode=${mode ?? 'frontend'}),使用前端SDK`);
    return;
  }
  void (async () => {
    try {
      const config = loadMcpConfig(ctx.settings,
        message => { ctx.log?.logger?.('dstu_mcp')?.warn?.(message); });
      log('info', '🔧 [MCP] Initializing MCP client with config: transport='
        + `${JSON.stringify(config.transport)}, performance=${JSON.stringify(config.performance)}`);
      await service.initializeGlobalClient(config);
      log('info', '✅ MCP 客户端初始化成功');
    } catch (error) {
      log('error', `❌ MCP 客户端初始化失败: ${errorText(error)}`);
    }
  })();
}

export default definePlugin({
  meta: { id: 'dstu.mcp', lane: 'L19-mcp-browser',
    provides: ['mcp'],
    commands: ['get_mcp_config', 'import_mcp_config', 'export_mcp_config', 'get_mcp_status', 'get_mcp_tools', 'save_mcp_config',
      'mcp_stdio_start', 'mcp_stdio_send', 'mcp_stdio_close', 'get_mcp_stdio_allow_unapproved', 'set_mcp_stdio_allow_unapproved',
      'test_mcp_connection', 'test_mcp_websocket', 'test_mcp_sse', 'test_mcp_http', 'test_rmcp_streamable_http',
      'reload_mcp_client', 'preheat_mcp_tools',
      'start_mcp_oauth', 'cancel_mcp_oauth', 'revoke_mcp_oauth', 'get_mcp_oauth_status', 'get_mcp_oauth_access_token'] },
  inject: ['settings', 'secrets', 'webSearch', 'log'],
  apply(ctx: Context) {
    // Rust global.rs readers log after transport shutdown too. Bind the real loggers
    // while the plugin context is active; EOF callbacks must not resolve services again.
    const stdioLogger = ctx.log?.logger?.('dstu_mcp::mcp::stdio_proxy');
    const mcpLogger = ctx.log?.logger?.('dstu_mcp::mcp');
    const toolsLogger = ctx.log?.logger?.('dstu_mcp::tools');
    const sessions = new StdioSessionManager(
      (event, payload) => ctx.backendEvents.emit(event, payload),
      (level, message) => { stdioLogger?.[level]?.(message); },
    );
    ctx.effect(() => () => sessions.dispose());
    const mcpLog = (level: 'info' | 'warn' | 'error', message: string): void => {
      mcpLogger?.[level]?.(message);
    };
    const probeLog = (level: 'warn' | 'error', message: string): void => {
      ctx.log.logger('dstu_mcp::mcp::test_helpers')[level](message);
    };
    const mcpService = new HostMcpService({
      log: mcpLog,
      webSearch: ctx.webSearch,
      webSearchDb: { settings: ctx.settings, port: ctx.webSearch },
      webSearchLog: (level, message) => { toolsLogger?.[level]?.(message); },
      namespacePrefix: () => {
        try { return ctx.settings.get('mcp.tools.namespace_prefix'); }
        catch { return null; }
      },
      emitEvent: (event, payload) => { ctx.backendEvents.emit(event, payload); },
      emitTo: (target, event, payload) => { ctx.backendEvents.emitTo(target, event, payload); },
      listenWindow: (window, event, receive) => ctx.backendEvents.listenWindow(window, event, receive),
      onToolsChanged: () => {
        mcpLog('info', '🔧 [MCP] tools/list_changed received → clearing LLMManager MCP tool cache');
        ctx.backendEvents.emit('mcp_tools_changed', { ts: toRfc3339() });
      },
    });
    ctx.provide('mcp', mcpService);
    ctx.effect(() => () => mcpService.dispose());
    startBackendMcp(ctx, mcpService, mcpLog);
    ctx.commands.register('get_mcp_config', () => loadMcpConfig(ctx.settings,
      message => { ctx.log?.logger?.('dstu_mcp')?.warn?.(message); }));
    ctx.commands.register('import_mcp_config', () => { throw new CommandError(AppError.validation('Import functionality has been removed')); });
    ctx.commands.register('export_mcp_config', () => { throw new CommandError(AppError.validation('Export functionality has been removed')); });
    ctx.commands.register('get_mcp_status', () => mcpStatus(ctx.settings));
    // src/cmd/mcp.rs:59: backend tool listing is deliberately disabled in Rust.
    ctx.commands.register('get_mcp_tools', () => []);
    ctx.commands.register<{ config: JsonValue }>('save_mcp_config', ({ config }) => {
      try { saveMcpConfig(ctx.settings, config); }
      catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      return true;
    });
    ctx.commands.register('get_mcp_stdio_allow_unapproved', async () => {
      try { return await readMcpAllowUnapproved(ctx.settings); }
      catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
    });
    ctx.commands.register<{ enabled: boolean }>('set_mcp_stdio_allow_unapproved', async ({ enabled }) => {
      try { await writeMcpAllowUnapproved(ctx.settings, enabled); }
      catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      const log = ctx.log?.logger?.('dstu_mcp::mcp::stdio_proxy') ?? ctx.log?.logger?.('dstu_mcp');
      if (enabled) log?.warn?.(`MCP UNAPPROVED MODE ENABLED: mcp.stdio.allowUnapproved set to true — mcp_stdio_start will bypass approved-config gate`);
      else log?.info?.(`MCP UNAPPROVED MODE DISABLED: mcp.stdio.allowUnapproved set to false`);
      return null;
    });
    ctx.commands.register<{ command: string; args: string[]; env?: Record<string, string> | null; framing?: string | null; cwd?: string | null }>(
      'mcp_stdio_start', async ({ command, args, env, framing, cwd }) => {
        const envMap = env ?? {};
        let allow = false;
        try { allow = await readMcpAllowUnapproved(ctx.settings); } catch { allow = false; }
        try {
          if (allow) {
            const normalizedCommand = normalizeCommandPath(command);
            const defaultCwd = (() => { try { return process.cwd(); } catch { return '.'; } })();
            const log = ctx.log?.logger?.('dstu_mcp::mcp::stdio_proxy') ?? ctx.log?.logger?.('dstu_mcp');
            log?.warn?.(`mcp_stdio_start UNAPPROVED MODE: command=${JSON.stringify(command)} args=${JSON.stringify(args)} cwd=${JSON.stringify(cwd)} framing=${JSON.stringify(framing)} env_keys=${JSON.stringify(Object.keys(envMap))} — approved-config gate bypassed by user setting mcp.stdio.allowUnapproved`);
            return await sessions.start(normalizedCommand, args, envMap, framing ?? 'jsonl', cwd ?? defaultCwd);
          }
          const entries = await readMcpToolsList(ctx.settings);
          const validated = validateStdioStart(entries, command, args, envMap, cwd ?? null, framing ?? null);
          return await sessions.start(validated.command, validated.args, validated.env, validated.framing, validated.cwd);
        } catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      });
    ctx.commands.register<{ sessionId: string; payload: string }>('mcp_stdio_send', async ({ sessionId, payload }) => {
      try { await sessions.send(sessionId, payload); }
      catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      return null;
    });
    ctx.commands.register<{ sessionId: string }>('mcp_stdio_close', async ({ sessionId }) => {
      try { await sessions.close(sessionId); }
      catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      return null;
    });

    ctx.commands.register<{ command: string; args: string[]; env?: Record<string, string> | null; cwd?: string | null; framing?: string | null }>(
      'test_mcp_connection', async ({ command, args, env, cwd, framing }) => {
        const envMap = env ?? {};
        try {
          const entries = await readMcpToolsList(ctx.settings);
          const validated = validateStdioStart(entries, command, args, envMap, cwd ?? null, framing ?? null);
          return await testStdio(
            validated.command, validated.args, validated.env, validated.cwd,
            validated.framing, step => { ctx.backendEvents.emit('mcp-test-progress', { step }); },
            mcpLog,
          );
        } catch (e) { throw new CommandError(AppError.internal(errorText(e))); }
      });
    ctx.commands.register<{ url: string; env?: Record<string, string> | null }>(
      'test_mcp_websocket', async ({ url }) => testWebSocket(url));
    ctx.commands.register<{ endpoint: string; apiKey: string; env?: Record<string, string> | null }>(
      'test_mcp_sse', async ({ endpoint, apiKey, env }) => {
        const trimmed = rustTrim(apiKey);
        return testSse(endpoint, trimmed === '' ? null : trimmed, env ?? null, probeLog);
      });
    ctx.commands.register<{ endpoint: string; apiKey: string; env?: Record<string, string> | null }>(
      'test_mcp_http', async ({ endpoint, apiKey, env }) => {
        const trimmed = rustTrim(apiKey);
        return testHttp(endpoint, trimmed === '' ? null : trimmed, env ?? null, probeLog);
      });
    ctx.commands.register<{ url: string; apiKey?: string | null }>(
      'test_rmcp_streamable_http', async ({ url, apiKey }) => testStreamableHttpRmcp(url, apiKey ?? null));
    ctx.commands.register('reload_mcp_client', async () => {
      try { llmMcpTools(ctx).clear(); }
      catch (e) {
        if (e instanceof CommandError) throw e;
        throw new CommandError(AppError.internal(errorText(e)));
      }
      return { success: true, message: 'Backend MCP disabled; frontend SDK in use' };
    });
    ctx.commands.register('preheat_mcp_tools', async (_args, call) => {
      let count: number;
      try { count = await llmMcpTools(ctx).preheat(call.source); }
      catch (e) {
        if (e instanceof CommandError) throw e;
        throw new CommandError(AppError.internal(errorText(e)));
      }
      return { ok: true, count };
    });

    const oauthManager = (): McpOAuthManager => {
      const store = ctx.secrets.openStore(ctx.app.dataDir);
      return new McpOAuthManager({
        fetch: (input, init) => fetch(input, init),
        openUrl: async url => { await ctx.shell.request('plugin:opener|open_url', { url }); },
        secureStore: store,
        now: () => new Date(),
        log: (level, message) => { ctx.log?.logger?.('dstu_mcp::mcp::auth')?.[level]?.(message); },
      });
    };
    let oauthInstance: McpOAuthManager | null = null;
    const oauth = (): McpOAuthManager => (oauthInstance ??= oauthManager());
    ctx.effect(() => () => { oauthInstance?.dispose(); });

    ctx.commands.register<{
      serverId: string; resourceUrl: string; clientId?: string | null;
      clientSecret?: string | null; scopes?: string[] | null;
    }>('start_mcp_oauth', async (args, call) => {
      try {
        const stop = new AbortController();
        const outcome = await untilAbandoned(oauth().startOAuth({
          serverId: args.serverId, resourceUrl: args.resourceUrl,
          clientId: args.clientId ?? null, clientSecret: args.clientSecret ?? null,
          scopes: args.scopes ?? [], openBrowser: true,
        }, { signal: stop.signal }), call.signal, stop);
        // Rust `StartOAuthOutcome.access_token` is `skip_serializing`.
        return {
          server_id: outcome.server_id,
          token_type: outcome.token_type,
          expires_at: outcome.expires_at,
          authorization_url: outcome.authorization_url,
          redirect_uri: outcome.redirect_uri,
        };
      } catch (e) { throw new CommandError(errorText(e)); }
    });
    ctx.commands.register<{ serverId: string }>('cancel_mcp_oauth', async ({ serverId }) => {
      await oauth().cancelOAuth(serverId);
      return null;
    });
    ctx.commands.register<{ serverId: string }>('revoke_mcp_oauth', async ({ serverId }) => {
      try { await oauth().revokeToken(serverId); }
      catch (e) { throw new CommandError(errorText(e)); }
      return null;
    });
    ctx.commands.register<{ serverId: string; resourceUrl: string }>(
      'get_mcp_oauth_status', async ({ serverId, resourceUrl }) => {
        const authorized = await oauth().hasOAuthSessionForResource(serverId, resourceUrl);
        return { server_id: serverId, authorized };
      });
    ctx.commands.register<{ serverId: string; resourceUrl: string }>(
      'get_mcp_oauth_access_token', async ({ serverId, resourceUrl }) => {
        try { return await oauth().getBearerTokenForResource(serverId, resourceUrl); }
        catch { return null; }
      });
  },
});
