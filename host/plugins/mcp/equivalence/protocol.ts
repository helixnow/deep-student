/**
 * WAVE0 deterministic MCP server behaviour (JSON-RPC 2.0), shared by the stdio child
 * (`stdio-server.ts`) and the HTTP/SSE endpoints (`mcp-service.ts`).
 *
 * The reply to a message is a pure function of (scriptId, message). No cursor, clock or
 * random value is used, so A (Tauri+Rust) and B (Electron+TS) receive identical server
 * behaviour for identical client input. This file is the single source of the tool set:
 * `tests/fixtures/mcp-test-server.mjs` (MCPBench) runs the `success` script through it.
 *
 * Plain Node TS (type-stripping safe): no enums, no parameter properties.
 */

export const SERVER_INFO = { name: 'mcp-test-server', version: '1.0.0' } as const;
export const PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC error codes used by the scripts (JSON-RPC 2.0 §5.1). */
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export const scripts = {
  'success': 'initialize, tools/list (web_search, echo_args, fail_tool, hold), tools/call, empty prompts/resources; unknown tool → ToolNotFound (-32602 "Tool not found: <name>", data.tool)',
  'initialize-error': 'initialize → JSON-RPC error -32603 "fixture initialize failure"',
  'tools-list-error': 'initialize ok; tools/list → JSON-RPC error -32603 "fixture tools/list failure"',
  'protocol-invalid-tools': 'initialize ok; tools/list → result.tools is the string "not-an-array" (client deserialisation error)',
  'protocol-garbage': 'initialize ok; tools/list → one non-JSON line/body/event, then the connection is closed',
  'disconnect-on-list': 'initialize ok; tools/list → no reply, connection closed (stdio: process exits 0)',
  'disconnect-on-call': 'as success, but tools/call → no reply, connection closed (stdio: process exits 0)',
} as const;

export type ScriptId = keyof typeof scripts;
export const SCRIPT_IDS = Object.keys(scripts) as ScriptId[];

export function isScriptId(value: string): value is ScriptId {
  return Object.prototype.hasOwnProperty.call(scripts, value);
}

export const GARBAGE_TEXT = 'mcp-fixture: this is not json-rpc';

export const TOOLS = [
  {
    name: 'web_search',
    description: 'MCPBench fixture search',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'echo_args',
    description: 'Returns the received arguments and the raw JSON-RPC message text',
    inputSchema: { type: 'object' },
  },
  {
    name: 'fail_tool',
    description: 'Returns isError=true with a fixed text chosen by kind',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['timeout', 'rate_limit', 'network', 'generic'] } },
      required: ['kind'],
    },
  },
  {
    name: 'hold',
    description: 'Never replies; ends only by notifications/cancelled plus close, or by disconnect',
    inputSchema: { type: 'object' },
  },
] as const;

const ANSWERS = new Map<string, string>([
  ['what is the capital of france?', 'Paris'],
  ['who wrote romeo and juliet?', 'William Shakespeare'],
  ['what is the speed of light?', '299,792,458 meters per second'],
]);

/**
 * fail_tool texts. They contain the substrings that Rust `tools/mod.rs:277-298`
 * (frontend MCP bridge → ErrorDetails) and `error_details::infer_error_code_from_message`
 * branch on, so every ErrorDetails builder is reachable from one tool.
 */
export const FAIL_TEXTS = {
  timeout: 'fixture failure: upstream timeout',
  rate_limit: 'fixture failure: rate limit exceeded',
  network: 'fixture failure: network connection reset',
  generic: 'fixture failure: generic',
} as const;

export type Reply =
  | { kind: 'message'; message: Record<string, unknown> }
  | { kind: 'raw'; text: string }
  | { kind: 'disconnect' };

export type Outcome =
  | 'result' | 'error' | 'notification' | 'held' | 'cancelled-notice'
  | 'garbage' | 'disconnect' | 'bad-json' | 'not-object' | 'ignored-response';

export interface Handled {
  method: string | null;
  id: unknown;
  params: unknown;
  outcome: Outcome;
  replies: Reply[];
}

function result(id: unknown, value: Record<string, unknown>): Reply {
  return { kind: 'message', message: { jsonrpc: '2.0', id, result: value } };
}

function error(id: unknown, code: number, message: string, data?: Record<string, unknown>): Reply {
  return { kind: 'message', message: { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } } };
}

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Handle one inbound JSON-RPC message.
 * `raw` is the exact text received (one JSONL line or one HTTP body); echo_args returns it
 * unchanged so number text, key order and escapes sent by each backend can be compared.
 */
export function handleMessage(script: ScriptId, raw: string): Handled {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { method: null, id: null, params: null, outcome: 'bad-json', replies: [] }; }
  const message = asRecord(parsed);
  if (message === null) return { method: null, id: null, params: null, outcome: 'not-object', replies: [] };
  const method = typeof message.method === 'string' ? message.method : null;
  const id = message.id;
  const params = message.params ?? null;
  const base = { method, id: id ?? null, params };
  if (method === null) return { ...base, outcome: 'ignored-response', replies: [] };
  const isRequest = id !== undefined && id !== null;

  if (!isRequest) {
    return { ...base, outcome: method === 'notifications/cancelled' ? 'cancelled-notice' : 'notification', replies: [] };
  }

  if (method === 'initialize') {
    if (script === 'initialize-error') return { ...base, outcome: 'error', replies: [error(id, INTERNAL_ERROR, 'fixture initialize failure', { script })] };
    return {
      ...base, outcome: 'result',
      replies: [result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { ...SERVER_INFO } })],
    };
  }

  if (method === 'tools/list') {
    if (script === 'tools-list-error') return { ...base, outcome: 'error', replies: [error(id, INTERNAL_ERROR, 'fixture tools/list failure', { script })] };
    if (script === 'protocol-invalid-tools') return { ...base, outcome: 'result', replies: [result(id, { tools: 'not-an-array' })] };
    if (script === 'protocol-garbage') return { ...base, outcome: 'garbage', replies: [{ kind: 'raw', text: GARBAGE_TEXT }, { kind: 'disconnect' }] };
    if (script === 'disconnect-on-list') return { ...base, outcome: 'disconnect', replies: [{ kind: 'disconnect' }] };
    return { ...base, outcome: 'result', replies: [result(id, { tools: TOOLS.map(tool => structuredClone(tool)) })] };
  }

  if (method === 'tools/call') {
    if (script === 'disconnect-on-call') return { ...base, outcome: 'disconnect', replies: [{ kind: 'disconnect' }] };
    const call = asRecord(params);
    const name = call?.name;
    const args = call?.arguments;
    if (name === 'web_search') {
      const query = typeof asRecord(args)?.query === 'string' ? asRecord(args)?.query as string : '';
      const answer = ANSWERS.get(query.trim().toLowerCase());
      return { ...base, outcome: 'result', replies: [result(id, { content: [text(answer ?? 'No answer')], isError: false })] };
    }
    if (name === 'echo_args') {
      return {
        ...base, outcome: 'result',
        replies: [result(id, { content: [text(JSON.stringify(args === undefined ? null : args)), text(raw)], isError: false })],
      };
    }
    if (name === 'fail_tool') {
      const kind = asRecord(args)?.kind;
      const message = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(FAIL_TEXTS, kind)
        ? FAIL_TEXTS[kind as keyof typeof FAIL_TEXTS]
        : FAIL_TEXTS.generic;
      return { ...base, outcome: 'result', replies: [result(id, { content: [text(message)], isError: true })] };
    }
    if (name === 'hold') return { ...base, outcome: 'held', replies: [] };
    return {
      ...base, outcome: 'error',
      replies: [error(id, INVALID_PARAMS, `Tool not found: ${String(name)}`, { tool: name === undefined ? null : name, script })],
    };
  }

  if (method === 'prompts/list') return { ...base, outcome: 'result', replies: [result(id, { prompts: [] })] };
  if (method === 'resources/list') return { ...base, outcome: 'result', replies: [result(id, { resources: [] })] };
  if (method === 'ping') return { ...base, outcome: 'result', replies: [result(id, {})] };
  return { ...base, outcome: 'error', replies: [error(id, METHOD_NOT_FOUND, `Method not found: ${method}`)] };
}

export function replyText(reply: Reply): string | null {
  if (reply.kind === 'message') return JSON.stringify(reply.message);
  if (reply.kind === 'raw') return reply.text;
  return null;
}

/** One logged inbound message. Stdio records come from the child's log file, HTTP/SSE from the service. */
export interface MessageRecord {
  kind: 'message';
  transport: 'stdio' | 'sse' | 'http' | 'websocket';
  script: string;
  /** stdio: child pid; sse: fixture session id (`s1`, `s2`, … per reset); http: Mcp-Session-Id or null; websocket: `ws1`, `ws2`, … per reset. */
  session: string | number | null;
  method: string | null;
  id: unknown;
  params: unknown;
  raw: string;
  outcome: Outcome;
  /** Exact reply texts written, in order (`null` entries are disconnects). */
  replies: (string | null)[];
  /** HTTP/SSE request headers (lower-case keys, sorted); null for stdio and websocket (upgrade headers are on `stream-open`). */
  headers: Record<string, string> | null;
}

export interface LifecycleRecord {
  kind: 'lifecycle';
  transport: 'stdio' | 'sse' | 'http' | 'websocket';
  script: string;
  session: string | number | null;
  event: 'start' | 'exit' | 'stream-open' | 'stream-close' | 'session-delete' | 'not-found' | 'config-error';
  /** stdin-end, sigterm, sigint, disconnect-script, client-closed, client-close-frame, server-reset, server-stopped, … */
  reason: string | null;
  detail: Record<string, unknown> | null;
}

export type FixtureRecord = MessageRecord | LifecycleRecord;
