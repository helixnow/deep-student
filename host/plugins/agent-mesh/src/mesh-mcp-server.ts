/**
 * Embedded Loopback Dual-Channel Agent Mesh Server (`dstu-mesh`).
 *
 * Binds strictly to `127.0.0.1:0` (ephemeral loopback port) and authenticates
 * every request with per-agent scoped `Authorization: Bearer <token>` credentials.
 *
 * Exposes two simultaneous protocols backed by the same 8 Mesh & Study tools:
 * 1. `POST /mcp` — Streamable HTTP / JSON-RPC 2.0 MCP server (`initialize`,
 *    `notifications/initialized`, `ping`, `tools/list`, `tools/call`);
 * 2. `POST /api/call` — Clean JSON RPC-over-REST endpoint consumed by `dstu-mesh`
 *    CLI shims (`cli-shim.ts`).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FileLeaseTable } from './file-leases.ts';

export const MESH_MCP_SERVER_NAME = 'dstu-mesh';
export const MESH_MCP_SERVER_VERSION = '1.0.0';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_MCP_PROTOCOL_VERSION = '2025-03-26';

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export type MeshSupportedAgentKind =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'agy'
  | 'dsh'
  | 'custom'
  | (string & {});

export interface MeshAgentTokenScope {
  chatSessionId: string;
  agentId: string;
  rosterName: string;
  threadId: string;
  rootPath: string;
}

export interface MeshPostBoardInput {
  text: string;
  mentions?: string[];
  channel?: string;
  replyToSeq?: number;
}

export interface MeshReadBoardInput {
  sinceSeq?: number;
  limit?: number;
}

export interface MeshAskPeerInput {
  targetAgent: string;
  question: string;
  contextPaths?: string[];
}

export interface MeshHandoffInput {
  targetAgent: string;
  summary: string;
  nextTask: string;
  changedFiles?: string[];
}

export interface MeshClaimFilesInput {
  paths: string[];
  waitMs?: number;
}

export interface MeshReleaseFilesInput {
  paths?: string[];
}

export interface MeshParkInput {
  summary?: string;
}

export interface StudyReadContextInput {
  query: string;
  resourceId?: string;
  maxChars?: number;
}

export interface MeshBridgeHostCallbacks {
  postBoard(scope: MeshAgentTokenScope, input: MeshPostBoardInput): Promise<unknown> | unknown;
  readBoard(scope: MeshAgentTokenScope, input: MeshReadBoardInput): Promise<unknown> | unknown;
  askPeer(scope: MeshAgentTokenScope, input: MeshAskPeerInput): Promise<unknown> | unknown;
  handoff(scope: MeshAgentTokenScope, input: MeshHandoffInput): Promise<unknown> | unknown;
  claimFiles?(scope: MeshAgentTokenScope, input: MeshClaimFilesInput): Promise<unknown> | unknown;
  releaseFiles?(scope: MeshAgentTokenScope, input: MeshReleaseFilesInput): Promise<unknown> | unknown;
  park(scope: MeshAgentTokenScope, input: MeshParkInput): Promise<unknown> | unknown;
  readStudyContext(scope: MeshAgentTokenScope, input: StudyReadContextInput): Promise<unknown> | unknown;
}

export interface MeshToolDefinition {
  name: MeshToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type MeshToolName =
  | 'mesh_post_board'
  | 'mesh_read_board'
  | 'mesh_ask_peer'
  | 'mesh_handoff'
  | 'mesh_claim_files'
  | 'mesh_release_files'
  | 'mesh_park'
  | 'study_read_context';

export interface McpHttpServerDescriptor {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

export interface AcpMcpServerEntry {
  name: string;
  type: 'http';
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface McpInjectionConfig {
  agentKind: string;
  serverName: string;
  baseUrl: string;
  mcpEndpointUrl: string;
  apiEndpointUrl: string;
  cliArgs: string[];
  configFilePath?: string;
  mcpServers: Record<string, McpHttpServerDescriptor>;
  acpMcpServers: AcpMcpServerEntry[];
  envVars: Record<string, string>;
}

interface StoredTokenEntry {
  tokenDigest: Buffer;
  scope: MeshAgentTokenScope;
  issuedAt: number;
  expiresAt?: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

class ToolArgumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentValidationError';
  }
}

export const MESH_MCP_TOOLS: readonly MeshToolDefinition[] = [
  {
    name: 'mesh_post_board',
    description: 'Post a concise update, question, or result to the shared Agent Mesh board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message content (supports @agent and @all mentions).' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit @rosterName targets to wake.',
        },
        channel: { type: 'string', description: 'Optional logical topic channel.' },
        replyToSeq: { type: 'integer', description: 'Optional board sequence number being answered.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_read_board',
    description: 'Read messages from the shared Agent Mesh board in monotonic sequence order.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceSeq: { type: 'integer', minimum: 0, description: 'Return messages strictly after this seq.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum messages to return.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_ask_peer',
    description: 'Consult a peer coding agent (e.g. @claude, @codex, @deepstudent) synchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgent: { type: 'string', description: 'Target peer agent id or @rosterName.' },
        question: { type: 'string', description: 'Focused technical question for the peer.' },
        contextPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative workspace file paths relevant to the question.',
        },
      },
      required: ['targetAgent', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_handoff',
    description: 'Release active file leases, record a checkpoint summary, and hand off the next task to a peer agent.',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgent: { type: 'string', description: 'Recipient peer agent id or @rosterName.' },
        summary: { type: 'string', description: 'Concise summary of completed work and invariants.' },
        nextTask: { type: 'string', description: 'Actionable instructions for the recipient agent.' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relative paths modified before handoff.',
        },
      },
      required: ['targetAgent', 'summary', 'nextTask'],
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_claim_files',
    description: 'Acquire in-place path or glob write leases before editing shared workspace files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Relative file paths or glob patterns (e.g. ["src/raft/**", "src/db.ts"]).',
        },
        waitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 60000,
          description: 'Optional milliseconds to wait if an overlapping lease is currently held.',
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_release_files',
    description: 'Release previously claimed file leases (all owned leases when paths is omitted).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of relative paths/globs to release.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mesh_park',
    description: 'Park this agent at 0 idle token cost until a new @mention or @all arrives on the board.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Optional summary of quiescent state before parking.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'study_read_context',
    description: 'Retrieve study materials (lecture PDFs, notes, flashcards, mistakes) linked to the current DeepStudent session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query or topic to retrieve from study context.' },
        resourceId: { type: 'string', description: 'Optional specific DeepStudent resource or note ID.' },
        maxChars: {
          type: 'integer',
          minimum: 100,
          maximum: 100000,
          description: 'Optional character budget for returned study context.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const KNOWN_TOOL_NAMES = new Set<string>(MESH_MCP_TOOLS.map((t) => t.name));

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgumentValidationError('Tool arguments must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ToolArgumentValidationError(`Field "${field}" must be a non-empty string`);
  }
  return val;
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const val = obj[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new ToolArgumentValidationError(`Field "${field}" must be a string`);
  }
  return val;
}

function optionalNumber(obj: Record<string, unknown>, field: string): number | undefined {
  const val = obj[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new ToolArgumentValidationError(`Field "${field}" must be a finite number`);
  }
  return val;
}

function optionalStringArray(obj: Record<string, unknown>, field: string, requireNonEmpty = false): string[] | undefined {
  const val = obj[field];
  if (val === undefined || val === null) {
    if (requireNonEmpty) {
      throw new ToolArgumentValidationError(`Field "${field}" must be a non-empty array of strings`);
    }
    return undefined;
  }
  if (!Array.isArray(val) || !val.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new ToolArgumentValidationError(`Field "${field}" must be an array of non-empty strings`);
  }
  if (requireNonEmpty && val.length === 0) {
    throw new ToolArgumentValidationError(`Field "${field}" must contain at least one item`);
  }
  return val as string[];
}

export function normalizeMeshBridgeUrls(endpointUrl: string): {
  baseUrl: string;
  mcpEndpointUrl: string;
  apiEndpointUrl: string;
} {
  const trimmed = endpointUrl.trim().replace(/\/+$/, '');
  let baseUrl = trimmed;
  if (baseUrl.endsWith('/mcp')) {
    baseUrl = baseUrl.slice(0, -'/mcp'.length);
  } else if (baseUrl.endsWith('/api/call')) {
    baseUrl = baseUrl.slice(0, -'/api/call'.length);
  }
  return {
    baseUrl,
    mcpEndpointUrl: `${baseUrl}/mcp`,
    apiEndpointUrl: `${baseUrl}/api/call`,
  };
}

/**
 * Generates ephemeral, zero-global-pollution MCP injection configs/flags for external coding CLIs:
 * - `claude`: writes `<tempDir>/dstu-claude-mcp-<id>.json` (0o600) and returns `['--mcp-config', file]`
 * - `codex`: returns `['-c', 'mcp_servers.dstu_mesh={...}']` inline TOML override (never touches `~/.codex/config.toml`)
 * - `opencode`: returns `mcpServers` map + `acpMcpServers` array + ephemeral config file
 * - `pi`: returns `mcpServers` map + ephemeral config file + env vars
 * - `agy` / `dsh` / `custom`: populates `DSTU_MESH_*` envVars + standard `mcpServers` descriptor
 */
export function buildMcpInjectionConfig(
  agentKind: MeshSupportedAgentKind,
  endpointUrl: string,
  token: string,
  tempDir: string,
): McpInjectionConfig {
  if (!token || token.trim().length === 0) {
    throw new Error('Bearer token is required for buildMcpInjectionConfig');
  }
  const normalizedKind = agentKind.trim().toLowerCase();
  const { baseUrl, mcpEndpointUrl, apiEndpointUrl } = normalizeMeshBridgeUrls(endpointUrl);
  const authHeaderValue = `Bearer ${token}`;
  const serverKey = 'dstu_mesh';

  const mcpServers: Record<string, McpHttpServerDescriptor> = {
    [serverKey]: {
      type: 'http',
      url: mcpEndpointUrl,
      headers: {
        Authorization: authHeaderValue,
      },
    },
  };

  const acpMcpServers: AcpMcpServerEntry[] = [
    {
      name: serverKey,
      type: 'http',
      url: mcpEndpointUrl,
      headers: [{ name: 'Authorization', value: authHeaderValue }],
    },
  ];

  const envVars: Record<string, string> = {
    DSTU_MESH_URL: baseUrl,
    DSTU_MESH_MCP_URL: mcpEndpointUrl,
    DSTU_MESH_API_URL: apiEndpointUrl,
    DSTU_MESH_TOKEN: token,
  };

  fs.mkdirSync(tempDir, { recursive: true });
  const shortId = randomUUID().slice(0, 8);

  if (normalizedKind === 'claude') {
    const configFilePath = path.join(tempDir, `dstu-claude-mcp-${shortId}.json`);
    const payload = JSON.stringify({ mcpServers }, null, 2);
    fs.writeFileSync(configFilePath, payload, { encoding: 'utf8', mode: 0o600 });
    return {
      agentKind: normalizedKind,
      serverName: serverKey,
      baseUrl,
      mcpEndpointUrl,
      apiEndpointUrl,
      cliArgs: ['--mcp-config', configFilePath],
      configFilePath,
      mcpServers,
      acpMcpServers,
      envVars,
    };
  }

  if (normalizedKind === 'codex') {
    // Valid TOML inline table passed via `-c` so user's `~/.codex/config.toml` is never modified.
    const tomlInline =
      `mcp_servers.${serverKey}={url=${JSON.stringify(mcpEndpointUrl)},` +
      `http_headers={Authorization=${JSON.stringify(authHeaderValue)}}}`;
    return {
      agentKind: normalizedKind,
      serverName: serverKey,
      baseUrl,
      mcpEndpointUrl,
      apiEndpointUrl,
      cliArgs: ['-c', tomlInline],
      mcpServers,
      acpMcpServers,
      envVars,
    };
  }

  if (normalizedKind === 'opencode') {
    const configFilePath = path.join(tempDir, `dstu-opencode-mcp-${shortId}.json`);
    const opencodePayload = JSON.stringify(
      {
        mcpServers,
        mcp: {
          [serverKey]: {
            type: 'remote',
            url: mcpEndpointUrl,
            headers: { Authorization: authHeaderValue },
            enabled: true,
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(configFilePath, opencodePayload, { encoding: 'utf8', mode: 0o600 });
    return {
      agentKind: normalizedKind,
      serverName: serverKey,
      baseUrl,
      mcpEndpointUrl,
      apiEndpointUrl,
      cliArgs: [],
      configFilePath,
      mcpServers,
      acpMcpServers,
      envVars: {
        ...envVars,
        OPENCODE_CONFIG: configFilePath,
      },
    };
  }

  if (normalizedKind === 'pi') {
    const configFilePath = path.join(tempDir, `dstu-pi-mcp-${shortId}.json`);
    fs.writeFileSync(configFilePath, JSON.stringify({ mcpServers }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return {
      agentKind: normalizedKind,
      serverName: serverKey,
      baseUrl,
      mcpEndpointUrl,
      apiEndpointUrl,
      cliArgs: [],
      configFilePath,
      mcpServers,
      acpMcpServers,
      envVars: {
        ...envVars,
        DSTU_PI_MCP_CONFIG: configFilePath,
      },
    };
  }

  return {
    agentKind: normalizedKind,
    serverName: serverKey,
    baseUrl,
    mcpEndpointUrl,
    apiEndpointUrl,
    cliArgs: [],
    mcpServers,
    acpMcpServers,
    envVars,
  };
}

export interface MeshMcpServerOptions {
  callbacks: MeshBridgeHostCallbacks;
  fileLeaseTable?: FileLeaseTable;
}

export class MeshMcpServer {
  readonly #callbacks: MeshBridgeHostCallbacks;
  readonly #fileLeaseTable: FileLeaseTable | undefined;
  readonly #tokens = new Map<string, StoredTokenEntry>();
  readonly #activeSockets = new Set<import('node:stream').Duplex>();
  #server: http.Server | null = null;
  #port = 0;

  constructor(options: MeshMcpServerOptions) {
    this.#callbacks = options.callbacks;
    this.#fileLeaseTable = options.fileLeaseTable;
  }

  get isListening(): boolean {
    return this.#server !== null && this.#port > 0;
  }

  get port(): number {
    if (!this.isListening) {
      throw new Error('MeshMcpServer is not listening; call start() first');
    }
    return this.#port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  get apiCallUrl(): string {
    return `${this.baseUrl}/api/call`;
  }

  /**
   * Issues a cryptographically random Bearer token bound strictly to a single agent thread scope.
   */
  issueAgentToken(scope: MeshAgentTokenScope, options?: { ttlMs?: number }): string {
    const token = randomBytes(32).toString('hex');
    const tokenId = token.slice(0, 16);
    const now = Date.now();
    this.#tokens.set(tokenId, {
      tokenDigest: digestToken(token),
      scope: { ...scope },
      issuedAt: now,
      ...(options?.ttlMs !== undefined && options.ttlMs > 0 ? { expiresAt: now + options.ttlMs } : {}),
    });
    return token;
  }

  /**
   * Registers an externally generated Bearer token (>= 16 chars) for deterministic or resumed scopes.
   */
  registerAgentToken(token: string, scope: MeshAgentTokenScope, options?: { ttlMs?: number }): void {
    if (token.length < 16) {
      throw new Error('Mesh Bearer token must be at least 16 characters long');
    }
    const tokenId = token.slice(0, 16);
    const now = Date.now();
    this.#tokens.set(tokenId, {
      tokenDigest: digestToken(token),
      scope: { ...scope },
      issuedAt: now,
      ...(options?.ttlMs !== undefined && options.ttlMs > 0 ? { expiresAt: now + options.ttlMs } : {}),
    });
  }

  revokeToken(token: string): boolean {
    if (token.length < 16) return false;
    return this.#tokens.delete(token.slice(0, 16));
  }

  revokeThreadTokens(threadId: string): number {
    let count = 0;
    for (const [key, entry] of this.#tokens.entries()) {
      if (entry.scope.threadId === threadId) {
        this.#tokens.delete(key);
        count++;
      }
    }
    return count;
  }

  revokeSessionTokens(chatSessionId: string): number {
    let count = 0;
    for (const [key, entry] of this.#tokens.entries()) {
      if (entry.scope.chatSessionId === chatSessionId) {
        this.#tokens.delete(key);
        count++;
      }
    }
    return count;
  }

  #authenticateRequest(req: http.IncomingMessage): MeshAgentTokenScope | null {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return null;
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match) return null;
    const candidate = match[1]!;
    if (candidate.length < 16) return null;

    const entry = this.#tokens.get(candidate.slice(0, 16));
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.#tokens.delete(candidate.slice(0, 16));
      return null;
    }

    const candidateDigest = digestToken(candidate);
    if (
      candidateDigest.length !== entry.tokenDigest.length ||
      !timingSafeEqual(candidateDigest, entry.tokenDigest)
    ) {
      return null;
    }

    return { ...entry.scope };
  }

  async start(): Promise<{ port: number; baseUrl: string; mcpUrl: string; apiCallUrl: string }> {
    if (this.#server !== null) {
      return {
        port: this.#port,
        baseUrl: this.baseUrl,
        mcpUrl: this.mcpUrl,
        apiCallUrl: this.apiCallUrl,
      };
    }

    const server = http.createServer((req, res) => {
      void this.#handleHttpRequest(req, res);
    });

    server.on('connection', (socket) => {
      this.#activeSockets.add(socket);
      socket.on('close', () => {
        this.#activeSockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const addr = server.address() as AddressInfo | null;
    if (!addr || typeof addr.port !== 'number' || addr.address !== '127.0.0.1') {
      server.close();
      throw new Error('Failed to bind MeshMcpServer strictly to 127.0.0.1');
    }

    this.#server = server;
    this.#port = addr.port;
    return {
      port: this.#port,
      baseUrl: this.baseUrl,
      mcpUrl: this.mcpUrl,
      apiCallUrl: this.apiCallUrl,
    };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    if (!server) return;

    for (const socket of this.#activeSockets) {
      socket.destroy();
    }
    this.#activeSockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  async #readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buf.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        return { ok: false, status: 413, message: 'Payload exceeds maximum allowed size' };
      }
      chunks.push(buf);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      return { ok: false, status: 400, message: 'Empty JSON request body' };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, status: 400, message: 'Malformed JSON body' };
    }
  }

  #sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  async #dispatchTool(scope: MeshAgentTokenScope, toolName: string, rawArgs: unknown): Promise<unknown> {
    if (!KNOWN_TOOL_NAMES.has(toolName)) {
      throw new ToolArgumentValidationError(`Unknown mesh tool: "${toolName}"`);
    }
    const args = asPlainObject(rawArgs);

    switch (toolName as MeshToolName) {
      case 'mesh_post_board': {
        const text = requireNonEmptyString(args, 'text');
        const mentions = optionalStringArray(args, 'mentions');
        const channel = optionalString(args, 'channel');
        const replyToSeq = optionalNumber(args, 'replyToSeq');
        return await this.#callbacks.postBoard(scope, {
          text,
          ...(mentions ? { mentions } : {}),
          ...(channel !== undefined ? { channel } : {}),
          ...(replyToSeq !== undefined ? { replyToSeq } : {}),
        });
      }

      case 'mesh_read_board': {
        const sinceSeq = optionalNumber(args, 'sinceSeq');
        const limit = optionalNumber(args, 'limit');
        return await this.#callbacks.readBoard(scope, {
          ...(sinceSeq !== undefined ? { sinceSeq } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      }

      case 'mesh_ask_peer': {
        const targetAgent = requireNonEmptyString(args, 'targetAgent');
        const question = requireNonEmptyString(args, 'question');
        const contextPaths = optionalStringArray(args, 'contextPaths');
        return await this.#callbacks.askPeer(scope, {
          targetAgent,
          question,
          ...(contextPaths ? { contextPaths } : {}),
        });
      }

      case 'mesh_handoff': {
        const targetAgent = requireNonEmptyString(args, 'targetAgent');
        const summary = requireNonEmptyString(args, 'summary');
        const nextTask = requireNonEmptyString(args, 'nextTask');
        const changedFiles = optionalStringArray(args, 'changedFiles');
        return await this.#callbacks.handoff(scope, {
          targetAgent,
          summary,
          nextTask,
          ...(changedFiles ? { changedFiles } : {}),
        });
      }

      case 'mesh_claim_files': {
        const paths = optionalStringArray(args, 'paths', true)!;
        const waitMs = optionalNumber(args, 'waitMs');
        const input: MeshClaimFilesInput = {
          paths,
          ...(waitMs !== undefined ? { waitMs } : {}),
        };
        if (this.#callbacks.claimFiles) {
          return await this.#callbacks.claimFiles(scope, input);
        }
        if (this.#fileLeaseTable) {
          return await this.#fileLeaseTable.acquireLease({
            rootPath: scope.rootPath,
            patterns: paths,
            holderAgentId: scope.rosterName || scope.agentId,
            threadId: scope.threadId,
            ...(waitMs !== undefined ? { waitMs } : {}),
          });
        }
        throw new Error('No claimFiles handler or FileLeaseTable configured on MeshMcpServer');
      }

      case 'mesh_release_files': {
        const paths = optionalStringArray(args, 'paths');
        const input: MeshReleaseFilesInput = {
          ...(paths ? { paths } : {}),
        };
        if (this.#callbacks.releaseFiles) {
          return await this.#callbacks.releaseFiles(scope, input);
        }
        if (this.#fileLeaseTable) {
          const releasedCount = this.#fileLeaseTable.releaseAgentLeases(
            scope.rosterName || scope.agentId,
            scope.threadId || undefined,
            {
              rootPath: scope.rootPath,
              ...(paths ? { patterns: paths } : {}),
            },
          );
          return { released: true, releasedCount };
        }
        throw new Error('No releaseFiles handler or FileLeaseTable configured on MeshMcpServer');
      }

      case 'mesh_park': {
        const summary = optionalString(args, 'summary');
        return await this.#callbacks.park(scope, {
          ...(summary !== undefined ? { summary } : {}),
        });
      }

      case 'study_read_context': {
        const query = requireNonEmptyString(args, 'query');
        const resourceId = optionalString(args, 'resourceId');
        const maxChars = optionalNumber(args, 'maxChars');
        return await this.#callbacks.readStudyContext(scope, {
          query,
          ...(resourceId !== undefined ? { resourceId } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
      }
    }
  }

  async #handleSingleJsonRpc(
    scope: MeshAgentTokenScope,
    rpc: JsonRpcRequest,
  ): Promise<{ response: JsonRpcResponse | null; sessionHeader?: string }> {
    const hasId = Object.prototype.hasOwnProperty.call(rpc, 'id') && rpc.id !== undefined;
    const id = rpc.id ?? null;

    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return {
        response: {
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
        },
      };
    }

    switch (rpc.method) {
      case 'initialize': {
        const paramsObj = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
          ? (rpc.params as Record<string, unknown>)
          : {};
        const clientVersion = typeof paramsObj.protocolVersion === 'string'
          ? paramsObj.protocolVersion
          : '';
        const negotiated = (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
          ? clientVersion
          : DEFAULT_MCP_PROTOCOL_VERSION;
        const mcpSessionId = `${scope.chatSessionId}:${scope.threadId || scope.agentId}`;
        return {
          sessionHeader: mcpSessionId,
          response: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: negotiated,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: MESH_MCP_SERVER_NAME,
                version: MESH_MCP_SERVER_VERSION,
              },
            },
          },
        };
      }

      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled': {
        if (!hasId) {
          return { response: null };
        }
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {},
          },
        };
      }

      case 'ping': {
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {},
          },
        };
      }

      case 'tools/list': {
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {
              tools: MESH_MCP_TOOLS,
            },
          },
        };
      }

      case 'tools/call': {
        const paramsObj = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
          ? (rpc.params as Record<string, unknown>)
          : null;
        const toolName = paramsObj && typeof paramsObj.name === 'string' ? paramsObj.name : '';
        if (!toolName || !KNOWN_TOOL_NAMES.has(toolName)) {
          return {
            response: {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Unknown tool "${toolName}"`,
              },
            },
          };
        }

        try {
          const toolResult = await this.#dispatchTool(scope, toolName, paramsObj?.arguments ?? {});
          const serialized = typeof toolResult === 'string'
            ? toolResult
            : JSON.stringify(toolResult ?? null);
          const structured = toolResult !== null && typeof toolResult === 'object' && !Array.isArray(toolResult)
            ? toolResult
            : { value: toolResult };
          return {
            response: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: serialized }],
                structuredContent: structured,
                isError: false,
              },
            },
          };
        } catch (err) {
          if (err instanceof ToolArgumentValidationError) {
            return {
              response: {
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32602,
                  message: err.message,
                },
              },
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          return {
            response: {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: message }],
                isError: true,
              },
            },
          };
        }
      }

      default: {
        if (!hasId) {
          return { response: null };
        }
        return {
          response: {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${rpc.method}`,
            },
          },
        };
      }
    }
  }

  async #handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const scope = this.#authenticateRequest(req);
      if (!scope) {
        this.#sendJson(
          res,
          401,
          { ok: false, error: 'Unauthorized: valid Bearer token required' },
          { 'WWW-Authenticate': 'Bearer realm="dstu-mesh"' },
        );
        return;
      }

      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;

      if (pathname === '/mcp') {
        if (req.method === 'GET') {
          res.writeHead(405, { Allow: 'POST, DELETE' });
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST, DELETE' });
          res.end();
          return;
        }

        const bodyResult = await this.#readJsonBody(req);
        if (!bodyResult.ok) {
          this.#sendJson(res, bodyResult.status, {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: bodyResult.status === 400 ? -32700 : -32600,
              message: bodyResult.message,
            },
          });
          return;
        }

        if (Array.isArray(bodyResult.value)) {
          if (bodyResult.value.length === 0) {
            this.#sendJson(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Empty JSON-RPC batch' },
            });
            return;
          }
          const responses: JsonRpcResponse[] = [];
          let sessionHeader: string | undefined;
          for (const item of bodyResult.value) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              responses.push({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Invalid JSON-RPC batch item' },
              });
              continue;
            }
            const out = await this.#handleSingleJsonRpc(scope, item as JsonRpcRequest);
            if (out.sessionHeader) sessionHeader = out.sessionHeader;
            if (out.response) responses.push(out.response);
          }
          if (responses.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          this.#sendJson(
            res,
            200,
            responses,
            sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : undefined,
          );
          return;
        }

        if (!bodyResult.value || typeof bodyResult.value !== 'object') {
          this.#sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'JSON-RPC payload must be an object' },
          });
          return;
        }

        const singleOut = await this.#handleSingleJsonRpc(scope, bodyResult.value as JsonRpcRequest);
        if (singleOut.response === null) {
          res.writeHead(202);
          res.end();
          return;
        }
        this.#sendJson(
          res,
          200,
          singleOut.response,
          singleOut.sessionHeader ? { 'Mcp-Session-Id': singleOut.sessionHeader } : undefined,
        );
        return;
      }

      if (pathname === '/api/call') {
        if (req.method !== 'POST') {
          this.#sendJson(res, 405, { ok: false, error: 'Method not allowed; use POST' }, { Allow: 'POST' });
          return;
        }
        const bodyResult = await this.#readJsonBody(req);
        if (!bodyResult.ok) {
          this.#sendJson(res, bodyResult.status, { ok: false, error: bodyResult.message });
          return;
        }
        if (!bodyResult.value || typeof bodyResult.value !== 'object' || Array.isArray(bodyResult.value)) {
          this.#sendJson(res, 400, { ok: false, error: 'Request body must be a JSON object { tool, args }' });
          return;
        }
        const payload = bodyResult.value as Record<string, unknown>;
        const toolName = typeof payload.tool === 'string'
          ? payload.tool
          : typeof payload.name === 'string'
            ? payload.name
            : '';
        const rawArgs = payload.args !== undefined ? payload.args : payload.arguments ?? {};

        if (!toolName) {
          this.#sendJson(res, 400, { ok: false, error: 'Missing required "tool" field' });
          return;
        }

        try {
          const result = await this.#dispatchTool(scope, toolName, rawArgs);
          this.#sendJson(res, 200, { ok: true, tool: toolName, result });
        } catch (err) {
          if (err instanceof ToolArgumentValidationError) {
            this.#sendJson(res, 400, { ok: false, error: err.message });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.#sendJson(res, 500, { ok: false, error: message });
        }
        return;
      }

      this.#sendJson(res, 404, { ok: false, error: `Route not found: ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        this.#sendJson(res, 500, { ok: false, error: message });
      } else {
        res.end();
      }
    }
  }
}
