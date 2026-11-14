// Cross-lane `mcp` service: global client plus the MCP-facing tool registry.
// Rust sources: `mcp/global.rs` and `tools/mod.rs` (frontend MCP fallback).

import type {
  JsonValue, McpClient, McpService, RagSourceInfo, ToolContext,
  DetailedToolRegistry, ToolInvocation, ToolInvocationWithDetails, WebSearchService,
} from '../api.ts';
import type { EventTarget, WindowRef } from '../../../kernel/api.ts';
import { randomUUID } from 'node:crypto';
import type { McpConfig, ToolConflict } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import { ErrorDetails, ErrorDetailsBuilder, infer_error_code_from_message } from '../../../platform/errors/api.ts';
import { resolveFrontendMcpToolName } from './canonical-tools.ts';
import { connectMcpClient, type McpClientLog } from './client.ts';
import { f32ScoreJson } from './web-search-core.ts';
import {
  invokeWebSearchTool, type WebSearchToolBackend, type WebSearchToolDb, type WebSearchToolLog,
} from './web-search-tool.ts';

export type { WebSearchToolDb, WebSearchToolLog } from './web-search-tool.ts';

export interface McpServiceOptions {
  log: McpClientLog;
  namespacePrefix(): string | null;
  webSearch?: WebSearchService | null;
  /** Rust `ToolContext.db` for the local `web_search` tool: engine gate, session routing, aggregation. */
  webSearchDb?: WebSearchToolDb | null;
  /** `log::` target `dstu_mcp::tools` for the local `web_search` tool. */
  webSearchLog?: WebSearchToolLog;
  /** Rust `lib.rs` registers `tools/list_changed` to clear the tool cache. */
  onToolsChanged?: () => void;
  /** Rust `window.emit` sink for `{stream_event}_web_search` source previews. */
  emitEvent?: (event: string, payload: JsonValue) => void;
  /** Rust `window.emit("mcp-bridge-request")` targeted at the calling window. */
  emitTo?: (target: EventTarget, event: string, payload: JsonValue) => void;
  /** Rust `Window::listen` for `mcp-bridge-response:<corr>`; returns an idempotent disposer. */
  listenWindow?: (window: WindowRef, event: string, receive: (payload: unknown) => void) => () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rust `ToolRegistry::default_timeout_ms` (tools/mod.rs:92). */
const LOCAL_TOOL_TIMEOUT_MS = 15_000;

/** `tokio::time::timeout` for local tools; `null` means the tool timed out. */
async function withTimeout<T>(invoke: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      resolve(null);
      // Dropping tokio's timed-out future also drops the semaphore permit and HTTP request.
      controller.abort(new Error('tool timeout'));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
  });
  try {
    return await Promise.race([invoke(controller.signal), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

class McpToolRegistry implements DetailedToolRegistry {
  private readonly service: HostMcpService | null;
  private readonly namespacePrefix: () => string | null;
  private readonly webSearch: WebSearchToolBackend | null;
  private readonly emitEvent: ((event: string, payload: JsonValue) => void) | null;
  private readonly emitTo: ((target: EventTarget, event: string, payload: JsonValue) => void) | null;
  private readonly log: McpClientLog | null;
  private readonly listenWindow:
    ((window: WindowRef, event: string, receive: (payload: unknown) => void) => () => void) | null;

  constructor(
    service: HostMcpService | null, namespacePrefix: () => string | null, webSearch: WebSearchToolBackend | null,
    emitEvent: ((event: string, payload: JsonValue) => void) | null = null,
    emitTo: ((target: EventTarget, event: string, payload: JsonValue) => void) | null = null,
    listenWindow:
      ((window: WindowRef, event: string, receive: (payload: unknown) => void) => () => void) | null = null,
    log: McpClientLog | null = null,
  ) {
    this.service = service;
    this.namespacePrefix = namespacePrefix;
    this.webSearch = webSearch;
    this.emitEvent = emitEvent;
    this.emitTo = emitTo;
    this.listenWindow = listenWindow;
    this.log = log;
  }

  /** Rust `ToolRegistry::detect_tool_conflicts` deliberately returns an empty list. */
  async detectToolConflicts(): Promise<ToolConflict[]> {
    return [];
  }

  /** Rust `ToolRegistry::strip_mcp_namespace` (prefix only, no canonical decoding). */
  stripMcpNamespace(name: string): string {
    const prefix = this.namespacePrefix();
    if (prefix !== null && prefix !== '' && name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
    return name;
  }

  /** Rust `tools/mod.rs:1122-1150`: with a calling window, emit the search sources for early UI display. */
  private emitWebSearchSources(citations: RagSourceInfo[] | null, context: ToolContext): void {
    const streamEvent = context.stream_event;
    if (this.emitEvent === null || context.window == null || streamEvent === null
      || citations === null || citations.length === 0) return;
    const stage = context.stage ?? 'inline';
    this.emitEvent(`${streamEvent}_web_search`, {
      sources: citations.map(citation => ({
        document_id: citation.documentId,
        file_name: citation.fileName,
        chunk_text: citation.chunkText,
        score: f32ScoreJson(citation.score),
        chunk_index: citation.chunkIndex,
        source_type: 'search',
        origin: 'web_search',
        stage,
      })),
      stage,
      tool_name: 'web_search',
    });
  }

  /** Rust `call_frontend_mcp_tool` (tools/mod.rs:397-535). */
  private async callFrontendMcpTool(
    toolName: string, args: JsonValue, window: WindowRef, signal?: AbortSignal | null,
  ): Promise<ToolInvocation> {
    if (signal?.aborted) {
      return [false, null, 'MCP 调用已取消', null, null, null];
    }
    if (this.emitTo === null || this.listenWindow === null) {
      return [false, null, 'MCP 桥接通道中断', null, null, null];
    }
    let toolArgs = args;
    let serverId: string | null = null;
    let timeoutOverride: number | null = null;
    if (isObject(args)) {
      const rest: Record<string, JsonValue> = { ...args };
      const rawServer = rest._serverId;
      serverId = typeof rawServer === 'string' ? rawServer : null;
      delete rest._serverId;
      const hasPrimaryTimeout = '_timeoutMs' in rest;
      const rawTimeout = hasPrimaryTimeout ? rest._timeoutMs : rest.__bridgeTimeoutMs;
      if (typeof rawTimeout === 'number' && Number.isInteger(rawTimeout) && rawTimeout >= 0) {
        timeoutOverride = rawTimeout;
      }
      delete rest._timeoutMs;
      if (!hasPrimaryTimeout) delete rest.__bridgeTimeoutMs;
      toolArgs = rest;
    }
    const timeoutMs = timeoutOverride === null
      ? 180_000 : Math.min(Math.max(timeoutOverride, 1_000), 300_000);
    const correlationId = randomUUID();
    const eventName = `mcp-bridge-response:${correlationId}`;
    let settle!: (payload: unknown) => void;
    const response = new Promise<unknown>(resolve => { settle = resolve; });
    const dispose = this.listenWindow(window, eventName, payload => {
      if (typeof payload === 'string') {
        try { settle(JSON.parse(payload)); }
        catch { return; }
        return;
      }
      settle(payload);
    });
    try {
      this.emitTo({ kind: 'Window', label: window.window }, 'mcp-bridge-request', {
        correlationId, tool: toolName, serverId, args: toolArgs, timeoutMs,
      });
    } catch (error) {
      dispose();
      return [false, null, `bridge emit failed: ${errorText(error)}`, null, null, null];
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const racers: Promise<unknown>[] = [
      response,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('MCP 调用超时')); }, timeoutMs);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
      }),
    ];
    if (signal) {
      racers.push(new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(new Error('MCP 调用已取消')); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    try {
      const value = await Promise.race(racers);
      if (!isObject(value)) return [false, null, 'MCP 响应格式无效：缺少 ok 字段', null, null, null];
      if (typeof value.ok !== 'boolean') {
        return [false, null, 'MCP 响应格式无效：缺少 ok 字段', null, null, null];
      }
      const data = value.data ?? null;
      const error = typeof value.error === 'string' ? value.error : null;
      const elapsed: Record<string, JsonValue> = {
        trace_id: randomUUID(),
        tool_name: toolName,
        source: 'mcp-frontend',
      };
      const rawUsage = value.usage;
      const usage = rawUsage === undefined
        ? { bridge: 'frontend', ...elapsed }
        : isObject(rawUsage) ? { ...rawUsage, bridge: 'frontend', ...elapsed } : elapsed;
      return [value.ok, data, error, usage, null, null];
    } catch (error) {
      return [false, null, errorText(error), null, null, null];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      dispose();
    }
  }

  /** Rust `tools/mod.rs:149-318`; detailed calls have their own usage/error rules. */
  async callToolWithDetails(
    name: string, args: JsonValue, context: ToolContext,
  ): Promise<ToolInvocationWithDetails> {
    // Rust's private enabled map is initialized only with true (no mutation API).
    if (name === 'web_search' && this.webSearch !== null) {
      const started = performance.now();
      const backend = this.webSearch;
      const result = await withTimeout(
        signal => invokeWebSearchTool(backend, args, context.stage, signal), LOCAL_TOOL_TIMEOUT_MS);
      const elapsed = Math.trunc(performance.now() - started);
      if (result === null) {
        return [false, null, 'tool timeout', { elapsed_ms: elapsed }, null, null,
          ErrorDetailsBuilder.tool_timeout(name, LOCAL_TOOL_TIMEOUT_MS)];
      }
      if (result[0]) this.emitWebSearchSources(result[4], context);
      const [ok, data, error, usage, citations, inject] = result;
      return [ok, data, error, usage ?? {
        elapsed_ms: elapsed, trace_id: randomUUID(), tool_name: name, source: 'local',
      }, citations, inject, error === null ? null : localErrorDetails(name, error)];
    }
    if (context.window !== undefined && context.window !== null) {
      const resolved = resolveFrontendMcpToolName(name, this.namespacePrefix());
      if (resolved === null) {
        return [false, null, `无效的外部工具名: ${name}`, null, null, null,
          ErrorDetailsBuilder.tool_not_found(name)];
      }
      this.log?.('info', `Local tool '${name}' not found, bridging to Frontend MCP (details) with name '${resolved}'`);
      const [ok, data, error, usage, citations, inject] = await this.callFrontendMcpTool(resolved, args, context.window);
      if (isObject(usage)) {
        usage.trace_id = randomUUID();
        usage.tool_name = resolved;
        usage.source = 'mcp';
      }
      return [ok, data, error, usage, citations, inject,
        error === null ? null : frontendErrorDetails(resolved, error)];
    }
    // Rust does not consult the backend/global client on this path.
    return [false, null, `未知工具: ${name}`, null, null, null, ErrorDetailsBuilder.tool_not_found(name)];
  }

  async callTool(
    name: string, args: JsonValue, context: ToolContext,
  ): Promise<ToolInvocation> {
    // Rust `ToolRegistry::call_tool`: local tools win over the frontend MCP bridge.
    if (name === 'web_search' && this.webSearch !== null) {
      return callLocalWebSearchTool(this.webSearch, args, context.stage, citations => {
        this.emitWebSearchSources(citations, context);
      });
    }
    if (context.signal?.aborted) {
      return [false, null, 'MCP 调用已取消', null, null, null];
    }
    const resolved = resolveFrontendMcpToolName(name, this.namespacePrefix());
    if (resolved === null) {
      return [false, null, `无效的外部工具名: ${name}`, null, null, null];
    }
    if (context.window !== undefined && context.window !== null) {
      return await this.callFrontendMcpTool(resolved, args, context.window, context.signal);
    }
    const client = await this.service?.getGlobalClient() ?? null;
    if (client === null) {
      return [false, null, `未知工具: ${name}`, null, null, null];
    }
    let onAbort: (() => void) | undefined;
    try {
      const callPromise = client.callTool(resolved, args);
      const result = context.signal
        ? await Promise.race([
            callPromise,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => { reject(new Error('MCP 调用已取消')); };
              if (context.signal!.aborted) onAbort();
              else context.signal!.addEventListener('abort', onAbort, { once: true });
            }),
          ])
        : await callPromise;
      const ok = result.isError !== true;
      const data: JsonValue = {
        content: result.content as unknown as JsonValue,
        isError: result.isError,
      };
      return [
        ok, data, ok ? null : 'MCP tool returned isError',
        { source: 'mcp', tool_name: resolved }, null, null,
      ];
    } catch (error) {
      return [false, null, errorText(error), null, null, null];
    } finally {
      if (onAbort !== undefined) context.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export interface WebSearchRegistryOptions {
  /** Rust `ToolContext.db`; absent or `null` is `db: None` (no engine gate, routing or aggregation). */
  db?: WebSearchToolDb | null;
  /** Rust `window.emit` for `{stream_event}_web_search` (only when the call carries a window). */
  emitEvent?: (event: string, payload: JsonValue) => void;
  log?: WebSearchToolLog;
}

/** Rust `ToolRegistry::new_with([WebSearchTool])`: local tool only, no global MCP client. */
export function createWebSearchToolRegistry(
  webSearch: WebSearchService, options: WebSearchRegistryOptions = {},
): DetailedToolRegistry {
  return new McpToolRegistry(null, () => null, {
    service: webSearch, db: options.db ?? null, log: options.log ?? (() => undefined),
  }, options.emitEvent ?? null);
}

export class HostMcpService implements McpService {
  readonly registry: DetailedToolRegistry;
  private client: McpClient | null = null;

  private readonly options: McpServiceOptions;

  constructor(options: McpServiceOptions) {
    this.options = options;
    const webSearch = options.webSearch == null ? null : {
      service: options.webSearch, db: options.webSearchDb ?? null, log: options.webSearchLog ?? (() => undefined),
    };
    this.registry = new McpToolRegistry(
      this, options.namespacePrefix, webSearch, options.emitEvent ?? null,
      options.emitTo ?? null, options.listenWindow ?? null, options.log,
    );
  }

  async getGlobalClient(): Promise<McpClient | null> {
    return this.client;
  }

  async initializeGlobalClient(config: McpConfig): Promise<void> {
    this.logTransport(config);
    if (this.client !== null) {
      const previous = this.client;
      this.client = null;
      await previous.disconnect();
    }
    this.client = await connectMcpClient(config, this.options.log, this.options.onToolsChanged);
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await client.disconnect();
  }

  private logTransport(config: McpConfig): void {
    const transport = config.transport;
    switch (transport.type) {
      case 'stdio':
        this.options.log('info', `Creating MCP stdio transport: ${transport.command} `
          + `${JSON.stringify(transport.args)} (framing: ${transport.framing}, `
          + `env vars: ${Object.keys(transport.env).length})`);
        return;
      case 'websocket':
        this.options.log('info', `Creating MCP websocket transport: ${transport.url} `
          + `with ${Object.keys(transport.env).length} env vars`);
        return;
      case 'sse':
        this.options.log('info', `Creating MCP SSE transport: ${transport.endpoint} `
          + `(auth: ${authLabel(transport.api_key, transport.oauth)})`);
        return;
      case 'http':
        this.options.log('info', `Creating MCP HTTP transport: ${transport.url} `
          + `(auth: ${authLabel(transport.api_key, transport.oauth)})`);
        return;
      case 'streamable_http':
        this.options.log('info', `Creating MCP Streamable HTTP transport: ${transport.url} `
          + `(auth: ${authLabel(transport.api_key, transport.oauth)})`);
        return;
    }
  }
}

function authLabel(apiKey: string | null | undefined, oauth: unknown): string {
  if (apiKey !== null && apiKey !== undefined) return 'API key';
  if (oauth !== null && oauth !== undefined) return 'OAuth';
  return 'none';
}

/** tools/mod.rs:212-238: the shared inference order differs from frontend errors. */
function localErrorDetails(name: string, message: string): ErrorDetails {
  const code = infer_error_code_from_message(message);
  switch (code) {
    case 'API_KEY_MISSING': return ErrorDetailsBuilder.api_key_missing(name);
    case 'API_KEY_INVALID': return ErrorDetailsBuilder.api_key_invalid(name);
    case 'NETWORK_UNREACHABLE': return ErrorDetailsBuilder.network_error(message);
    case 'RATE_LIMIT': return ErrorDetailsBuilder.rate_limit_error(name, null);
    default: return ErrorDetails.with_suggestion(
      ErrorDetails.new(code, message, `工具'${name}'执行失败`),
      { action_type: 'retry', label: '重试', url: null, data: null },
    );
  }
}

/** tools/mod.rs:277-302: match only these English substrings, in this order. */
function frontendErrorDetails(name: string, message: string): ErrorDetails {
  const lower = message.toLowerCase();
  if (lower.includes('tool not found')) return ErrorDetailsBuilder.tool_not_found(name);
  if (lower.includes('timeout')) return ErrorDetailsBuilder.tool_timeout(name, LOCAL_TOOL_TIMEOUT_MS);
  if (lower.includes('rate limit')) return ErrorDetailsBuilder.rate_limit_error(name, null);
  if (lower.includes('connection') || lower.includes('transport') || lower.includes('network')) {
    return ErrorDetailsBuilder.network_error(message);
  }
  return ErrorDetailsBuilder.service_unavailable(name);
}

/**
 * Rust `ToolRegistry::call_tool` local-tool branch for `WebSearchTool` (tools/mod.rs:338-360):
 * `tokio::time::timeout(default_timeout_ms)` and `{"elapsed_ms"}` when the tool returns no usage.
 * `test_search_engine` uses `ToolRegistry::new_with([WebSearchTool])`, which resolves here.
 */
async function callLocalWebSearchTool(
  webSearch: WebSearchToolBackend, args: JsonValue, stage: string | null,
  onCitations: (citations: RagSourceInfo[] | null) => void = () => undefined,
): Promise<ToolInvocation> {
  const started = performance.now();
  const result = await withTimeout(
    signal => invokeWebSearchTool(webSearch, args, stage, signal), LOCAL_TOOL_TIMEOUT_MS);
  if (result === null) {
    return [false, null, 'tool timeout', { elapsed_ms: Math.trunc(performance.now() - started) }, null, null];
  }
  if (result[0]) onCitations(result[4]);
  const usage = result[3] ?? { elapsed_ms: Math.trunc(performance.now() - started) };
  return [result[0], result[1], result[2], usage, result[4], result[5]];
}
