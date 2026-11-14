// Port of dstu-mcp/src/mcp/test_helpers.rs connection probes.
// Transports use Node primitives (child_process, fetch, WebSocket); result shapes
// match `format_probe_outcome` field-for-field.

import type { JsonValue } from '../api.ts';
import type { McpTransportConfig } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import {
  McpEventEmitter, McpRequestManager, McpStreamManager, handleMcpMessage, type McpEvent,
} from './client-dispatch.ts';
import {
  parseMcpTool, parseMcpToolResult, serializeJsonRpcNotification, serializeJsonRpcRequest,
  type JsonRpcRequest, type JsonRpcResponse, type McpToolResultSpec, type McpToolSpec,
} from './client-protocol.ts';
import { endpointFetchPolicy } from './endpoint.ts';
import { SseEventBuffer, extractStreamDataPayload } from '../../../platform/util/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import {
  createStdioTransport, readStdioStdout,
  type StdioLog,
} from './stdio-proxy.ts';

const CONNECT_TIMEOUT_MS = 30_000;
const CLIENT_TIMEOUT_MS = 60_000;
/** client.rs:1708 `send_request`: fixed `timeout(Duration::from_secs(30), rx)`. */
const SEND_REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_DELAY_MS = 250;
const CLIENT_INFO_VERSION = '0.11.0';
const PROTOCOL_VERSION = '2025-06-18';

export interface ProbeServer {
  name: string;
  version: string;
  protocol_version: string;
  /** `client.rs::ServerInfo.capabilities`; `{}` when the server omits it. */
  capabilities: JsonValue;
}

export interface ProbeTool { name: string; description: string | null }
export interface ProbePrompt { name: string; description: string | null }
export interface ProbeResource { uri: string; name: string; description: string | null }

export interface ProbeOutcome {
  server: ProbeServer;
  tools: ProbeTool[];
  prompts: ProbePrompt[];
  resources: ProbeResource[];
  warnings: string[];
}

export type ProgressCallback = (step: string) => void;

interface TransportWaiter {
  resolve(message: string): void;
  reject(error: Error): void;
}

export interface Transport {
  readonly label: string;
  send(message: string): Promise<void>;
  receive(): Promise<string>;
  close(): Promise<void>;
  /** False once the transport is closed or its receive loop stopped. */
  isConnected?(): boolean;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMessage(raw: string): Record<string, JsonValue> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
}

export interface JsonRpcProbeOptions {
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  timeoutMs?: number;
  log?: (level: 'warn' | 'error', message: string) => void;
}

export class JsonRpcProbe {
  private nextId = 1;
  private readonly requestManager: McpRequestManager;
  private readonly eventEmitter = new McpEventEmitter();
  private readonly streamManager = new McpStreamManager();
  private receiveTask: Promise<void> | null = null;
  private closed = false;
  private serverInfo: ProbeServer | null = null;

  private readonly transport: Transport;
  private readonly options: JsonRpcProbeOptions;

  constructor(transport: Transport, options: JsonRpcProbeOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.requestManager = new McpRequestManager(options.timeoutMs ?? CLIENT_TIMEOUT_MS);
  }

  start(): void {
    this.receiveTask = this.receiveLoop();
    // Rust `McpClient::connect` emits Connected after spawning the message loop.
    this.eventEmitter.emit({ type: 'Connected' });
  }

  /** client.rs:932-968 `connect`: refuse a transport that reports not connected. */
  connect(): void {
    if (!(this.transport.isConnected?.() ?? true)) {
      throw new Error('Connection error: Transport not connected');
    }
    this.start();
  }

  /** Rust `McpClient::on_event`: subscribe to transport notifications. */
  onEvent(handler: (event: McpEvent) => void): void {
    this.eventEmitter.on(handler);
  }

  private async receiveLoop(): Promise<void> {
    for (;;) {
      let raw: string;
      try { raw = await this.transport.receive(); }
      catch (error) {
        // Rust `message_loop` emits Error before exiting on a receive failure;
        // a deliberate `close()` is not an error.
        if (!this.closed) this.eventEmitter.emit({ type: 'Error', message: errorText(error) });
        return;
      }
      await handleMcpMessage(
        raw, this.requestManager, () => undefined, this.eventEmitter, this.streamManager,
      );
    }
  }

  private async request(method: string, params?: JsonValue): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const response = this.requestManager.registerRequest(String(id));
    // HTTP send() may keep reading an SSE body after delivering the response. Observe the
    // waiter immediately, and do not let a slow send bypass the request deadline or close().
    void response.catch(() => undefined);
    const payload: JsonRpcRequest = { jsonrpc: '2.0', method, id };
    if (params !== undefined) payload.params = params;
    // client.rs:1708-1732: the waiter settles after 30s even when the receive loop has
    // already stopped (child exited / garbage then EOF); the pending entry is cancelled.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Settle first: Rust returns TimeoutError("Request timeout") after dropping rx, so the
        // cancel_request rejection below must not win the race.
        reject(new Error('Timeout error: Request timeout'));
        this.requestManager.cancelRequest(String(id));
        this.options.log?.('error', `MCP send_request timeout: method=${method}, id=${id}, transport=${this.transport.label}`);
      }, SEND_REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        response,
        this.transport.send(serializeJsonRpcRequest(payload)).then(() => response),
        expired,
      ]);
    } catch (error) {
      this.requestManager.cancelRequest(String(id));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private notify(method: string, params?: JsonValue): Promise<void> {
    return this.transport.send(serializeJsonRpcNotification(
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params },
    ));
  }

  async initialize(): Promise<ProbeServer> {
    const response = await this.request('initialize', {
      protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: {
        roots: { listChanged: true },
        sampling: { enabled: true },
      },
      clientInfo: {
        name: this.options.clientName ?? `dstu-mcp-tester-${this.transport.label}`,
        version: this.options.clientVersion ?? CLIENT_INFO_VERSION,
      },
    });
    // client.rs:1196/1275-1287: only a missing/null result is a failure; the JSON-RPC
    // error is rendered as `code=<code> message=<message>`.
    const result = response.result;
    if (result === undefined || result === null) {
      const detail = response.error !== undefined
        ? `code=${response.error.code} message=${response.error.message}`
        : 'response contained no result';
      this.options.log?.('error', `[McpClient] initialize rejected by server: ${detail}`);
      throw new Error(`Protocol error: Initialize failed: ${detail}`);
    }
    const resultObject = isObject(result) ? result : {};
    const serverInfo = isObject(resultObject.serverInfo) ? resultObject.serverInfo : {};
    this.serverInfo = {
      name: typeof serverInfo.name === 'string' ? serverInfo.name : '',
      version: typeof serverInfo.version === 'string' ? serverInfo.version : '',
      protocol_version: typeof resultObject.protocolVersion === 'string' ? resultObject.protocolVersion : '',
      capabilities: isObject(resultObject.capabilities) ? resultObject.capabilities : {},
    };
    // Rust `initialize` emits ServerInfoReceived after storing the session info
    // and before sending the initialized notification.
    this.eventEmitter.emit({ type: 'ServerInfoReceived', server: this.serverInfo });
    await this.notify('initialized');
    return this.serverInfo;
  }

  async listTools(): Promise<ProbeTool[]> {
    const response = await this.request('tools/list');
    // client.rs:1314/1325-1327: a missing result fails without the server's error text.
    if (response.result === undefined || response.result === null) {
      throw new Error('Protocol error: Failed to list tools');
    }
    const result = isObject(response.result) ? response.result : {};
    if (!Array.isArray(result.tools)) return [];
    return result.tools.flatMap((tool): ProbeTool[] => {
      const spec = parseMcpTool(tool);
      return spec === null ? [] : [{ name: spec.name, description: spec.description }];
    });
  }

  /** Rust `McpClient::list_tools`: follows `nextCursor` for at most 100 pages. */
  async listToolSpecs(): Promise<McpToolSpec[]> {
    const all: McpToolSpec[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(
        'tools/list', cursor === null ? undefined : { cursor },
      );
      if (response.error !== undefined) {
        if (all.length === 0) throw new Error(`Failed to list tools: ${response.error.message}`);
        break;
      }
      const result = isObject(response.result) ? response.result : null;
      if (result === null || !Array.isArray(result.tools)) {
        if (all.length === 0) throw new Error('Failed to list tools');
        break;
      }
      for (const raw of result.tools) {
        const spec = parseMcpTool(raw);
        if (spec === null) throw new Error('Failed to list tools: invalid tool spec');
        all.push(spec);
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
      if (cursor === null) break;
    }
    return all;
  }

  /** Rust `McpClient::call_tool`. */
  async callTool(name: string, arguments_: JsonValue | null): Promise<McpToolResultSpec> {
    const response = await this.request('tools/call', { name, arguments: arguments_ });
    // client.rs:1345-1372 checks result first, then server error, then missing result.
    if (response.result !== undefined && response.result !== null) {
      const parsed = parseMcpToolResult(response.result);
      if (parsed === null) throw new Error(`Tool '${name}' execution failed: invalid result`);
      if (parsed.isError === true) {
        const errorMessage = parsed.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('; ');
        this.options.log?.('warn', `Tool '${name}' execution failed: ${errorMessage}`);
        throw new Error(`Tool execution error: ${errorMessage === '' ? 'Tool execution failed' : errorMessage}`);
      }
      return parsed;
    }
    if (response.error !== undefined) {
      throw new Error(`Server error: ${response.error.message}`);
    }
    throw new Error('Protocol error: Tool call failed');
  }

  async listPrompts(): Promise<ProbePrompt[]> {
    const response = await this.request('prompts/list');
    // client.rs:1538/1549-1553.
    if (response.result === undefined || response.result === null) {
      throw new Error('Protocol error: Failed to list prompts');
    }
    const result = isObject(response.result) ? response.result : {};
    if (!Array.isArray(result.prompts)) return [];
    return result.prompts.flatMap((prompt): ProbePrompt[] => {
      if (!isObject(prompt) || typeof prompt.name !== 'string') return [];
      return [{ name: prompt.name, description: typeof prompt.description === 'string' ? prompt.description : null }];
    });
  }

  async listResources(): Promise<ProbeResource[]> {
    const response = await this.request('resources/list');
    // client.rs:1390/1401-1405.
    if (response.result === undefined || response.result === null) {
      throw new Error('Protocol error: Failed to list resources');
    }
    const result = isObject(response.result) ? response.result : {};
    if (!Array.isArray(result.resources)) return [];
    return result.resources.flatMap((resource): ProbeResource[] => {
      if (!isObject(resource) || typeof resource.uri !== 'string' || typeof resource.name !== 'string') return [];
      return [{
        uri: resource.uri, name: resource.name,
        description: typeof resource.description === 'string' ? resource.description : null,
      }];
    });
  }

  get server(): ProbeServer {
    if (this.serverInfo === null) throw new Error('initialize has not completed');
    return this.serverInfo;
  }

  isConnected(): boolean {
    if (this.closed) return false;
    return this.transport.isConnected?.() ?? true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.requestManager.cancelAll('MCP client closed');
    await this.transport.close();
    if (this.receiveTask !== null) await this.receiveTask.catch(() => undefined);
    // Rust `McpClient::disconnect` emits Disconnected after closing the transport.
    this.eventEmitter.emit({ type: 'Disconnected' });
  }
}

/** Production transport factory for `initialize_global_mcp_client`. */
export async function createTransportForConfig(config: McpTransportConfig, log?: StdioLog): Promise<Transport> {
  switch (config.type) {
    case 'stdio':
      return stdioTransport(
        config.command, config.args, config.env, config.working_dir ?? null, config.framing, log,
      );
    case 'websocket':
      return websocketTransport(config.url);
    case 'sse':
      return sseTransport(config.endpoint, config.api_key ?? null, config.headers);
    case 'http':
      return httpTransport({
        endpoint: config.url, apiKey: config.api_key ?? null,
        headers: config.headers, label: 'http',
      });
    case 'streamable_http':
      return httpTransport({
        endpoint: config.url, apiKey: config.api_key ?? null,
        headers: config.headers, label: 'streamable-http-rmcp',
      });
    default: {
      const exhaustive: never = config;
      throw new Error(`unsupported MCP transport: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------- stdio

async function stdioTransport(
  command: string, args: string[], env: Record<string, string>, cwd: string | null,
  framing: 'jsonl' | 'content_length',
  log?: StdioLog,
): Promise<Transport> {
  const transport = await createStdioTransport(command, args, framing, env, cwd, { log });
  const pending: string[] = [];
  const waiters: TransportWaiter[] = [];
  let ended = false;
  const push = (message: string): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else pending.push(message);
  };
  const finish = (): void => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Transport error: Channel closed'));
  };
  void readStdioStdout(transport.child.stdout, framing, transport.command, push, log).then(finish, error => {
    log?.('error', `Error reading from MCP stdout: ${errorText(error)}`);
    finish();
  });
  return {
    label: 'stdio',
    async send(message: string): Promise<void> { transport.send(message); },
    receive(): Promise<string> {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (ended) return Promise.reject(new Error('Transport error: Channel closed'));
      return new Promise<string>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    async close(): Promise<void> {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('Transport error: Channel closed'));
      await transport.close();
    },
  };
}

// ---------------------------------------------------------------- HTTP

export interface HttpProbeConfig {
  endpoint: string;
  apiKey: string | null;
  headers: Record<string, string> | null;
  timeoutMs: number;
}

/** `HttpConfig` used by `test_http`: endpoint/key/header/timeout wiring. */
export function httpProbeConfig(
  endpoint: string, apiKey: string | null, headers: Record<string, string> | null,
  timeoutMs: number = CLIENT_TIMEOUT_MS,
): HttpProbeConfig {
  return { endpoint, apiKey, headers, timeoutMs };
}

interface HttpTransportOptions {
  endpoint: string;
  apiKey: string | null;
  headers: Record<string, string> | null;
  label: 'http' | 'streamable-http-rmcp';
}

type ProbeHeaderLog = (level: 'warn' | 'error', message: string) => void;

/** test_helpers.rs:151-172 `map_env_to_headers`, before transport construction. */
function mapEnvToHeaders(headers: Record<string, string> | null, log?: ProbeHeaderLog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = rustTrim(key);
    // http::HeaderName token alphabet; names are case-insensitive in HeaderMap.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      log?.('warn', `忽略无法解析的头部键: ${key}`);
      continue;
    }
    const trimmed = rustTrim(value);
    // HeaderValue accepts visible bytes, obs-text, and HTAB, but not DEL or other controls.
    if (/[\x00-\x08\x0a-\x1f\x7f]/u.test(trimmed)) {
      log?.('warn', `忽略无法解析的头部值 ${key} = ${value}`);
      continue;
    }
    Object.defineProperty(out, name.toLowerCase(), { value: trimmed, writable: true, configurable: true, enumerable: true });
  }
  return out;
}

/** HeaderValue::from_str stores UTF-8 bytes; fetch's Headers values are byte strings. */
function wireHeaders(headers: Record<string, string> | null): Record<string, string> {
  return Object.fromEntries(Object.entries(mapEnvToHeaders(headers))
    .map(([name, value]) => [name, Buffer.from(value, 'utf8').toString('latin1')]));
}

function headerRecord(apiKey: string | null, headers: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {
    ...wireHeaders(headers),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  // http_transport.rs:64-99: API-key auth and the required Accept override custom headers.
  if (apiKey !== null) out.authorization = Buffer.from(`Bearer ${apiKey}`, 'utf8').toString('latin1');
  return out;
}

function sseBlockPayload(block: string): string | null {
  const data = extractStreamDataPayload(block);
  return data === null || data === '' ? null : data;
}

function httpTransport(options: HttpTransportOptions): Transport {
  const headers = headerRecord(options.apiKey, options.headers);
  const pending: string[] = [];
  const waiters: TransportWaiter[] = [];
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let closed = false;
  const controller = new AbortController();

  const push = (message: string): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else pending.push(message);
  };

  return {
    label: options.label,
    async send(message: string): Promise<void> {
      if (closed) throw new Error('HTTP 连接已关闭');
      const parsedMessage: unknown = JSON.parse(message);
      const payload = isObject(parsedMessage) ? parsedMessage : null;
      const requestHeaders: Record<string, string> = { ...headers };
      if (sessionId !== null) requestHeaders['mcp-session-id'] = sessionId;
      if (protocolVersion !== null) requestHeaders['mcp-protocol-version'] = protocolVersion;
      const response = await fetch(endpointFetchPolicy(options.endpoint).url, {
        method: 'POST', headers: requestHeaders, body: message,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CLIENT_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      const responseSession = response.headers.get('mcp-session-id');
      if (responseSession !== null) sessionId = responseSession;
      const acceptMessage = (message: string): void => {
        const parsed = parseMessage(message);
        if (payload !== null && parsed !== null && payload.method === 'initialize' && parsed.id === payload.id && isObject(parsed.result)
          && typeof parsed.result.protocolVersion === 'string') {
          protocolVersion = parsed.result.protocolVersion;
        }
        push(message);
      };
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && response.body !== null) {
        const reader = response.body.getReader();
        const buffer = new SseEventBuffer();
        const accept = (block: string): void => {
          const data = sseBlockPayload(block);
          if (data !== null && parseMessage(data) !== null) acceptMessage(data);
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const block of buffer.processBytes(value)) accept(block);
          }
          for (const block of buffer.flush()) accept(block);
        } finally {
          reader.releaseLock();
        }
      } else {
        const body = await response.text();
        const buffer = new SseEventBuffer();
        let accepted = 0;
        const accept = (block: string): void => {
          const data = sseBlockPayload(block);
          if (data === null || parseMessage(data) === null) return;
          accepted += 1;
          acceptMessage(data);
        };
        for (const block of buffer.processBytes(Buffer.from(body, 'utf8'))) accept(block);
        for (const block of buffer.flush()) accept(block);
        if (body.trim() !== '' && accepted === 0) acceptMessage(body);
      }
    },
    receive(): Promise<string> {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.reject(new Error('HTTP 连接已关闭'));
      return new Promise<string>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    async close(): Promise<void> {
      closed = true;
      controller.abort();
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('HTTP 连接已关闭'));
    },
    isConnected(): boolean { return !closed; },
  };
}

// ---------------------------------------------------------------- SSE

export interface SseProbeConfig {
  endpoint: string;
  apiKey: string | null;
  timeoutMs: number;
}

/** `SSEConfig` used by `test_sse`: endpoint/key/timeout wiring. */
export function sseProbeConfig(
  endpoint: string, apiKey: string | null, timeoutMs: number = CLIENT_TIMEOUT_MS,
): SseProbeConfig {
  return { endpoint, apiKey, timeoutMs };
}

interface SseTransportState {
  postUrl: string | null;
  messages: string[];
  waiters: TransportWaiter[];
  controller: AbortController;
  closed: boolean;
  connected: boolean;
  receiving: boolean;
}

function sseTransport(
  endpoint: string, apiKey: string | null, extraHeaders: Record<string, string> | null = null,
): Transport & { ready(): Promise<void> } {
  let settlePostUrl!: { resolve(url: string): void; reject(error: Error): void };
  const postUrlReady = new Promise<string>((resolve, reject) => {
    settlePostUrl = { resolve, reject };
  });
  // A failed connection may settle before any request waits on the endpoint event.
  void postUrlReady.catch(() => undefined);
  const state: SseTransportState = {
    postUrl: null, messages: [], waiters: [], controller: new AbortController(),
    closed: false, connected: false, receiving: true,
  };
  const fail = (error: Error): void => {
    settlePostUrl.reject(error);
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  };
  const push = (message: string): void => {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else state.messages.push(message);
  };
  const headers: Record<string, string> = wireHeaders(extraHeaders);
  if (apiKey !== null) headers.authorization = Buffer.from(`Bearer ${apiKey}`, 'utf8').toString('latin1');
  void (async () => {
    try {
      const response = await fetch(endpoint, {
        headers: { ...headers, accept: 'text/event-stream' }, signal: state.controller.signal,
      });
      if (!response.ok || response.body === null) {
        const message = `SSE ${response.status}`;
        push(JSON.stringify({ error: { message } }));
        fail(new Error(message));
        return;
      }
      state.connected = true;
      const reader = response.body.getReader();
      const buffer = new SseEventBuffer();
      const accept = (block: string): void => {
        const eventLine = block.split('\n').find(line => line.startsWith('event:'));
        const data = sseBlockPayload(block);
        if (data === null) return;
        if (eventLine?.slice(6).trim() === 'endpoint') {
          const postUrl = new URL(data, endpoint).toString();
          state.postUrl = postUrl;
          settlePostUrl.resolve(postUrl);
        } else {
          push(data);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const block of buffer.processBytes(value)) accept(block);
      }
      for (const block of buffer.flush()) accept(block);
      if (!state.closed && state.postUrl === null) fail(new Error('SSE endpoint event not received'));
    } catch (error) {
      if (!state.closed) {
        const message = errorText(error);
        push(JSON.stringify({ error: { message } }));
        fail(new Error(message));
      }
    } finally {
      state.receiving = false;
      if (!state.closed && state.postUrl !== null) fail(new Error('SSE 连接已关闭'));
    }
  })();
  const waitPostUrl = async (): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        postUrlReady,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => { reject(new Error('SSE endpoint event not received')); },
            CLIENT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return {
    label: 'sse',
    async send(message: string): Promise<void> {
      if (state.closed || !state.receiving) throw new Error('SSE 连接已关闭');
      const postUrl = await waitPostUrl();
      if (state.closed || !state.receiving) throw new Error('SSE 连接已关闭');
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: message,
        signal: AbortSignal.any([AbortSignal.timeout(CLIENT_TIMEOUT_MS), state.controller.signal]),
      });
      if (!response.ok) throw new Error(`SSE POST ${response.status}: ${await response.text()}`);
    },
    receive(): Promise<string> {
      const next = state.messages.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (state.closed || !state.receiving) return Promise.reject(new Error('SSE 连接已关闭'));
      return new Promise<string>((resolve, reject) => { state.waiters.push({ resolve, reject }); });
    },
    async close(): Promise<void> {
      state.closed = true;
      state.controller.abort();
      fail(new Error('SSE 连接已关闭'));
    },
    isConnected(): boolean { return !state.closed && state.connected && state.receiving; },
    /** Mirrors `SSETransport::new` waiting for the stream before the probe starts. */
    async ready(): Promise<void> { await waitPostUrl(); },
  };
}

/** Test/transport seam for `sse_receive_task_stops_after_transport_drop`. */
export function createSseProbeTransport(endpoint: string, apiKey: string | null): Transport {
  return sseTransport(endpoint, apiKey);
}

// ---------------------------------------------------------------- WebSocket

function websocketTransport(url: string): Transport {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  const waiters: TransportWaiter[] = [];
  let closed = false;
  let openError: string | null = null;
  const finish = (): void => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('WebSocket 连接已关闭'));
  };
  const push = (message: string): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else messages.push(message);
  };
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') push(event.data);
    else if (event.data instanceof ArrayBuffer) push(new TextDecoder().decode(event.data));
  });
  socket.addEventListener('close', finish);
  socket.addEventListener('error', () => {
    openError = 'WebSocket connection error';
    finish();
  });
  return {
    label: 'websocket',
    async send(message: string): Promise<void> {
      const deadline = performance.now() + CONNECT_TIMEOUT_MS;
      while (socket.readyState !== WebSocket.OPEN) {
        if (openError !== null) throw new Error(openError);
        if (closed) throw new Error('WebSocket 连接已关闭');
        if (performance.now() > deadline) throw new Error('WebSocket connection timeout');
        await new Promise(resolve => { setTimeout(resolve, 10); });
      }
      socket.send(message);
    },
    receive(): Promise<string> {
      const next = messages.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.reject(new Error('WebSocket 连接已关闭'));
      return new Promise<string>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    async close(): Promise<void> {
      finish();
      // boundary-allow empty-catch: WebSocket 已关闭时再次 close 抛错无副作用
      try { socket.close(); } catch { /* already closed */ }
    },
    isConnected(): boolean { return !closed && socket.readyState === WebSocket.OPEN; },
  };
}

// ---------------------------------------------------------------- probe

type ProbeLog = (level: 'warn' | 'error', message: string) => void;

/** test_helpers.rs:356-376 `connect_with_retry`. */
async function connectWithRetry(client: JsonRpcProbe, timeoutMs: number): Promise<void> {
  const start = performance.now();
  for (;;) {
    try {
      client.connect();
      return;
    } catch (error) {
      const lastError = errorText(error);
      if (performance.now() - start >= timeoutMs) {
        throw new Error(`Connection error: 连接超时: ${lastError}`);
      }
      await new Promise(resolve => { setTimeout(resolve, CONNECT_RETRY_DELAY_MS); });
    }
  }
}

/** test_helpers.rs:300/308/317 `let _ = client.disconnect().await` before returning Err. */
async function disconnectAfterFailure(client: JsonRpcProbe): Promise<void> {
  // boundary-allow empty-catch: Rust `let _ = client.disconnect().await` 丢弃断开错误后返回阶段错误
  try { await client.close(); } catch { /* discarded like Rust */ }
}

type ProbeResult =
  | { ok: true; outcome: ProbeOutcome }
  /** `error` is the Rust stage-prefixed string; `cause` is the bare McpError Display. */
  | { ok: false; error: string; cause: string };

/** test_helpers.rs:270-354 `gather_probe_with_progress`. */
async function gatherProbe(
  transport: Transport, onProgress: ProgressCallback, log?: ProbeLog,
): Promise<ProbeResult> {
  const client = new JsonRpcProbe(transport, { log });
  const fail = async (prefix: string, error: unknown): Promise<ProbeResult> => {
    await disconnectAfterFailure(client);
    const cause = errorText(error);
    return { ok: false, error: `${prefix}: ${cause}`, cause };
  };

  onProgress('connecting');
  try { await connectWithRetry(client, CONNECT_TIMEOUT_MS); }
  catch (error) { return fail('连接失败', error); }

  onProgress('initializing');
  let server: ProbeServer;
  try { server = await client.initialize(); }
  catch (error) { return fail('初始化失败', error); }

  onProgress('listing_tools');
  let tools: ProbeTool[];
  try { tools = await client.listTools(); }
  catch (error) { return fail('tools/list 调用失败', error); }

  const warnings: string[] = [];
  onProgress('listing_prompts');
  let prompts: ProbePrompt[] = [];
  try { prompts = await client.listPrompts(); }
  catch (error) { warnings.push(`prompts/list 调用失败: ${errorText(error)}`); }
  onProgress('listing_resources');
  let resources: ProbeResource[] = [];
  try { resources = await client.listResources(); }
  catch (error) { warnings.push(`resources/list 调用失败: ${errorText(error)}`); }
  onProgress('disconnecting');
  try { await client.close(); }
  catch (error) { warnings.push(`断开连接时出现问题: ${errorText(error)}`); }
  return { ok: true, outcome: { server, tools, prompts, resources, warnings } };
}

/**
 * test_helpers.rs:175-205 `probe_transport_with_progress` / `probe_transport`: stage errors
 * are returned as-is (no transport-creation prefix); `done` follows a successful gather.
 */
export async function probeTransport(
  transport: Transport, transportLabel: string, onProgress: ProgressCallback = () => undefined,
  log?: ProbeLog,
): Promise<JsonValue> {
  const result = await gatherProbe(transport, onProgress, log);
  if (result.ok === false) return failure(transportLabel, result.error);
  onProgress('done');
  return formatProbeOutcome(result.outcome, transportLabel);
}

export function formatProbeOutcome(outcome: ProbeOutcome, transportLabel: string): JsonValue {
  const toolsPreview = outcome.tools.slice(0, 8).map(tool => ({
    name: tool.name, description: tool.description ?? '',
  }));
  const promptsPreview = outcome.prompts.slice(0, 8).map(prompt => ({
    name: prompt.name, description: prompt.description ?? '',
  }));
  const resourcesPreview = outcome.resources.slice(0, 8).map(resource => ({
    uri: resource.uri, name: resource.name, description: resource.description ?? '',
  }));
  return {
    success: true,
    transport: transportLabel,
    server: {
      name: outcome.server.name,
      version: outcome.server.version,
      protocol_version: outcome.server.protocol_version,
    },
    tools_count: outcome.tools.length,
    prompts_count: outcome.prompts.length,
    resources_count: outcome.resources.length,
    tools_preview: toolsPreview,
    prompts_preview: promptsPreview,
    resources_preview: resourcesPreview,
    warnings: outcome.warnings,
  };
}

function failure(transportLabel: string, error: string): JsonValue {
  return { success: false, transport: transportLabel, error };
}

export async function testStdio(
  command: string, args: string[], env: Record<string, string>, cwd: string | null,
  framing: string | null, onProgress: ProgressCallback, log?: StdioLog,
): Promise<JsonValue> {
  onProgress('spawn_process');
  const normalizedArgs = args.map(value => value.trim()).filter(value => value !== '');
  const mode = ['content_length', 'content-length', 'contentlength'].includes(framing ?? '')
    ? 'content_length' : 'jsonl';
  let transport: Transport;
  try {
    transport = await stdioTransport(command, normalizedArgs, env, cwd, mode, log);
  } catch (error) {
    return failure('stdio', `无法启动进程: ${errorText(error)}`);
  }
  return probeTransport(transport, 'stdio', onProgress, log);
}

export async function testHttp(
  endpoint: string, apiKey: string | null, headers: Record<string, string> | null,
  log?: ProbeHeaderLog,
): Promise<JsonValue> {
  const config = httpProbeConfig(endpoint, apiKey, mapEnvToHeaders(headers, log));
  let transport: Transport;
  try {
    transport = httpTransport({
      endpoint: config.endpoint, apiKey: config.apiKey, headers: config.headers, label: 'http',
    });
  } catch (error) {
    return failure('http', `HTTP 初始化失败: ${errorText(error)}`);
  }
  return probeTransport(transport, 'http', () => undefined, log);
}

export async function testSse(
  endpoint: string, apiKey: string | null, headers: Record<string, string> | null,
  log?: ProbeHeaderLog,
): Promise<JsonValue> {
  const mappedHeaders = mapEnvToHeaders(headers, log);
  const config = sseProbeConfig(endpoint, apiKey);
  let transport: ReturnType<typeof sseTransport> | null = null;
  try {
    transport = sseTransport(config.endpoint, config.apiKey, mappedHeaders);
    await transport.ready();
  } catch (error) {
    // SSETransport::new failed: its stop path runs on drop before the Err is returned.
    if (transport !== null) await transport.close();
    return failure('sse', `SSE 初始化失败: ${errorText(error)}`);
  }
  return probeTransport(transport, 'sse', () => undefined, log);
}

export async function testWebSocket(url: string): Promise<JsonValue> {
  let transport: Transport;
  try {
    transport = websocketTransport(url);
  } catch (error) {
    return failure('websocket', `无法建立 WebSocket 连接: ${errorText(error)}`);
  }
  const result = await gatherProbe(transport, () => undefined);
  // Unchanged pre-WP-118 shape for post-construction failures (WebSocket is not in this scope).
  if (result.ok === false) return failure('websocket', `无法建立 WebSocket 连接: ${result.cause}`);
  return formatProbeOutcome(result.outcome, 'websocket');
}

export async function testStreamableHttpRmcp(url: string, apiKey: string | null): Promise<JsonValue> {
  let transport: Transport;
  try {
    transport = httpTransport({ endpoint: url, apiKey, headers: null, label: 'streamable-http-rmcp' });
  } catch (error) {
    return { success: false, error: errorText(error) };
  }
  const result = await gatherProbe(transport, () => undefined);
  if (result.ok === false) return { success: false, error: result.cause };
  return { success: true, step: 'completed', message: `tools=${result.outcome.tools.length}` };
}

export { CONNECT_RETRY_DELAY_MS };
