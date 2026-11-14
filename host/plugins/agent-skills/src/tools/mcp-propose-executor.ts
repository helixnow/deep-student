/**
 * `mcp_server_propose`, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs`.
 *
 * High sensitivity: the approved request writes `mcp.tools.list` in the secure
 * store, optionally runs a connection test, and rolls back only the entry this
 * proposal added if the test fails. Secret values never pass through the agent;
 * `env_required` accepts variable names only and stores `<REQUIRED>` placeholders
 * until the user fills them in Settings.
 */
import { isLoopbackHost } from '../../../../platform/net-policy/index.ts';
import { MCP_TOOLS_LIST_KEY, withMcpListMutation } from './mcp-settings-store.ts';
import { MCP_SERVER_PROPOSE } from '../../../../kernel/agent-tool-descriptors.ts';

export { MCP_SERVER_PROPOSE };

export const ENV_PLACEHOLDER = '<REQUIRED>';
export const STDIO_TEST_TIMEOUT_SECS = 15;
export const REMOTE_TEST_TIMEOUT_SECS = 30;

const ALLOWED_TOP_LEVEL_KEYS = [
  'name', 'transport', 'command', 'args', 'env_required', 'url', 'purpose',
] as const;

export type McpTransport = 'stdio' | 'sse' | 'http' | 'websocket' | 'streamable_http';

export function parseTransport(raw: string): McpTransport {
  switch (raw.trim().toLowerCase()) {
    case 'stdio': return 'stdio';
    case 'sse': return 'sse';
    case 'http': return 'http';
    case 'websocket': case 'ws': return 'websocket';
    case 'streamable_http': case 'streamable-http': case 'streamablehttp':
      return 'streamable_http';
    default:
      throw new Error(
        `Unsupported transport '${raw}'. Allowed: stdio, sse, http, websocket, streamable_http`,
      );
  }
}

/** Truncate credential-looking fragments and cap the length at 500 chars. */
export function sanitizeTestError(raw: string): string {
  let out = raw;
  for (const token of ['Bearer ', 'api_key=', 'apiKey=', 'token=', 'password=']) {
    const index = out.toLowerCase().indexOf(token.toLowerCase());
    if (index >= 0) {
      out = `${out.slice(0, index + token.length)}<redacted>`;
    }
  }
  if (out.length > 500) out = `${out.slice(0, 500)}…`;
  return out;
}

export interface ProposeInput {
  name: string;
  transport: McpTransport;
  purpose: string;
  command?: string;
  args: string[];
  envRequired: string[];
  url?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function rejectUnknownFields(args: unknown): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Arguments must be a JSON object');
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown field '${key}'. Allowed fields: ${ALLOWED_TOP_LEVEL_KEYS.join(', ')}`,
      );
    }
  }
  if ('env' in record) {
    throw new Error(
      "Field 'env' is not allowed: secrets are not handled by the agent. Use env_required "
      + '(variable names only); the user fills values in Settings.',
    );
  }
}

export function parseRequiredString(args: unknown, key: string): string {
  const raw = asRecord(args)[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return raw.trim();
}

export function parseStringArray(args: unknown, key: string, required: boolean): string[] {
  const record = asRecord(args);
  if (!(key in record)) {
    if (required) throw new Error(`'${key}' is required`);
    return [];
  }
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`'${key}' must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`'${key}[${index}]' must be a non-empty string`);
    }
    const name = item.trim();
    if (name.includes('=')) {
      throw new Error(
        `'${key}[${index}]' looks like an env assignment; only variable names are allowed `
        + '(secrets are filled by the user in Settings)',
      );
    }
    return name;
  });
}

function urlHostIsLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return isLoopbackHost(host);
  } catch { return false; }
}

/** Remote URLs need https; loopback hosts additionally allow http. */
export function validateHttpsUrl(url: string): void {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('https://')) return;
  if (lower.startsWith('http://') && urlHostIsLoopback(trimmed)) return;
  throw new Error(
    'Remote MCP url must use https:// (http:// is allowed only for loopback hosts such as '
    + 'localhost or 127.0.0.1)',
  );
}

export function parseProposeInput(args: unknown): ProposeInput {
  rejectUnknownFields(args);
  const record = asRecord(args);
  const name = parseRequiredString(args, 'name');
  const purpose = parseRequiredString(args, 'purpose');
  const transport = parseTransport(parseRequiredString(args, 'transport'));

  if (transport === 'stdio') {
    const command = parseRequiredString(args, 'command');
    const argsList = parseStringArray(args, 'args', false);
    const envRequired = parseStringArray(args, 'env_required', false);
    if ('url' in record) throw new Error("'url' is not valid for stdio transport");
    return { name, transport, purpose, command, args: argsList, envRequired };
  }

  if ('command' in record || 'args' in record) {
    throw new Error(
      `'command' and 'args' are only valid for stdio transport (got transport=${transport})`,
    );
  }
  const url = parseRequiredString(args, 'url');
  validateHttpsUrl(url);
  const envRequired = parseStringArray(args, 'env_required', false);
  if (envRequired.length > 0) {
    throw new Error(
      'env_required is only supported for stdio transport; remote transports use Settings '
      + 'for api keys',
    );
  }
  return { name, transport, purpose, args: [], envRequired: [], url };
}

export function serverName(entry: unknown): string | undefined {
  const raw = asRecord(entry).name;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function serverId(entry: unknown): string | undefined {
  const raw = asRecord(entry).id;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

function serverCommandArgs(entry: unknown): [string, string[]] | undefined {
  const record = asRecord(entry);
  const rawCommand = record.command;
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return undefined;
  const command = rawCommand.trim();
  const rawArgs = record.args;
  let args: string[] = [];
  if (Array.isArray(rawArgs)) {
    args = rawArgs
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(value => value !== '');
  } else if (typeof rawArgs === 'string') {
    args = rawArgs.split(',').map(part => part.trim()).filter(part => part !== '');
  }
  return [command, args];
}

export function findDuplicate(existing: readonly unknown[], input: ProposeInput): string | undefined {
  for (const entry of existing) {
    for (const identity of [serverId(entry), serverName(entry)]) {
      if (identity !== undefined && identity.toLowerCase() === input.name.toLowerCase()) {
        return `MCP server identity '${identity}' is already configured`;
      }
    }
    if (input.transport === 'stdio' && input.command !== undefined) {
      const existingCommand = serverCommandArgs(entry);
      if (existingCommand !== undefined
        && existingCommand[0] === input.command
        && existingCommand[1].length === input.args.length
        && existingCommand[1].every((value, index) => value === input.args[index])) {
        return `MCP server '${serverName(entry) ?? 'existing server'}' already uses the same `
          + 'command and args';
      }
    }
  }
  return undefined;
}

export function buildServerEntry(input: ProposeInput): [Record<string, unknown>, boolean] {
  const needsSecrets = input.envRequired.length > 0;
  const enabled = !needsSecrets;
  const entry: Record<string, unknown> = {
    id: input.name,
    name: input.name,
    transportType: input.transport,
    enabled,
  };
  if (input.transport === 'stdio') {
    entry.command = input.command ?? '';
    entry.args = [...input.args];
    if (needsSecrets) {
      entry.env = Object.fromEntries(input.envRequired.map(key => [key, ENV_PLACEHOLDER]));
    } else {
      entry.env = {};
    }
  } else if (input.transport === 'websocket' || input.transport === 'http') {
    entry.url = input.url ?? '';
  } else {
    const url = input.url ?? '';
    entry.url = url;
    entry.fetch = { type: input.transport, url };
  }
  return [entry, enabled];
}

/** Remove only this proposal's stable id; duplicate ids are corruption → fail closed. */
export function removeProposedEntry(list: unknown[], stableId: string): boolean {
  const matches: number[] = [];
  list.forEach((entry, index) => {
    if (serverId(entry) === stableId) matches.push(index);
  });
  if (matches.length === 0) return false;
  if (matches.length > 1) {
    throw new Error(
      `cannot safely roll back MCP server '${stableId}': multiple entries share the stable id`,
    );
  }
  list.splice(matches[0]!, 1);
  return true;
}

export function mcpProposeProvenanceKey(stableId: string): string {
  return `mcp.propose.provenance.${stableId}`;
}

const SENSITIVE_JSON_KEY_PATTERNS = [
  'api_key', 'apikey', 'token', 'secret', 'password', 'credential', 'private_key',
];

/** Recursively redact values whose key smells like a credential. */
export function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    out[key] = SENSITIVE_JSON_KEY_PATTERNS.some(pattern => lower.includes(pattern))
      ? '<redacted>' : redactSensitiveJson(child);
  }
  return out;
}

export function serverSummary(entry: unknown, input: ProposeInput): unknown {
  const record = asRecord(entry);
  const summary: Record<string, unknown> = {};
  const id = serverId(entry);
  if (id !== undefined) summary.id = id;
  summary.name = input.name;
  summary.transport = input.transport;
  summary.enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
  if (input.transport === 'stdio') {
    summary.command = typeof record.command === 'string' ? record.command : '';
    summary.args = record.args ?? [];
    if (input.envRequired.length > 0) summary.env_required = [...input.envRequired];
  } else {
    summary.url = '<remote-endpoint>';
  }
  return redactSensitiveJson(summary);
}

export interface McpProposeDependencies {
  readList(): Promise<unknown[]>;
  writeList(list: readonly unknown[]): Promise<void>;
  saveSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  runConnectionTest(
    transport: McpTransport,
    entry: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  emitListChanged(action: string): void;
  /** Rust `warn!` sink; failures in best-effort cleanup continue. */
  warn?(message: string): void;
}

export interface McpProposeContext {
  sessionId: string;
}

export class McpProposeExecutor {
  static stripNamespace(toolName: string): string {
    if (toolName.startsWith('builtin-')) return toolName.slice(8);
    if (toolName.startsWith('mcp_')) return toolName.slice(4);
    return toolName;
  }

  canHandle(toolName: string): boolean {
    return toolName === MCP_SERVER_PROPOSE
      || McpProposeExecutor.stripNamespace(toolName) === MCP_SERVER_PROPOSE;
  }

  sensitivityLevel(_toolName: string): 'high' { return 'high'; }
  name(): string { return 'McpProposeExecutor'; }

  async executeProposal(
    input: ProposeInput,
    context: McpProposeContext,
    deps: McpProposeDependencies,
  ): Promise<Record<string, unknown>> {
    const { entry, stableId, shouldTest } = await withMcpListMutation(async () => {
      const existing = await deps.readList();
      const duplicate = findDuplicate(existing, input);
      if (duplicate !== undefined) throw new Error(duplicate);
      const [built, shouldTestValue] = buildServerEntry(input);
      const stableIdValue = serverId(built);
      if (stableIdValue === undefined) {
        throw new Error('new MCP server entry is missing its stable id');
      }
      const updated = [...existing, built];
      await deps.writeList(updated);
      return { entry: built, stableId: stableIdValue, shouldTest: shouldTestValue };
    });

    try {
      await deps.saveSetting(mcpProposeProvenanceKey(stableId), JSON.stringify({
        server_id: stableId,
        purpose: input.purpose,
        session_id: context.sessionId,
        proposed_at: new Date().toISOString().replace('Z', '+00:00'),
        transport: input.transport,
        enabled_on_install: shouldTest,
      }));
    } catch (provenanceError) {
      const removed = await withMcpListMutation(async () => {
        const latest = await deps.readList();
        const wasRemoved = removeProposedEntry(latest, stableId);
        if (wasRemoved) await deps.writeList(latest);
        return wasRemoved;
      });
      throw new Error(
        `${errorText(provenanceError)}; newly added configuration `
        + (removed ? 'was removed' : 'was already absent'),
      );
    }

    if (shouldTest) {
      const testResult = await deps.runConnectionTest(input.transport, entry);
      const success = testResult.success === true;
      if (!success) {
        const removed = await withMcpListMutation(async () => {
          const latest = await deps.readList();
          const wasRemoved = removeProposedEntry(latest, stableId);
          if (wasRemoved) await deps.writeList(latest);
          return wasRemoved;
        });
        try { await deps.deleteSetting(mcpProposeProvenanceKey(stableId)); }
        catch (error) {
          deps.warn?.(
            `[McpProposeExecutor] Failed to clean provenance after rollback: ${errorText(error)}`,
          );
        }
        const rawError = typeof testResult.error === 'string' ? testResult.error
          : typeof testResult.message === 'string' ? testResult.message
            : 'connection test failed';
        throw new Error(
          `MCP connection test failed: ${sanitizeTestError(rawError)}. Configuration `
          + (removed
            ? 'has been rolled back without changing concurrent MCP entries'
            : 'was already absent when rollback re-read the latest list') + '.',
        );
      }
      const toolsCount = Array.isArray(testResult.tools) ? testResult.tools.length : 0;
      deps.emitListChanged('mcp_server_propose');
      return redactSensitiveJson({
        status: 'installed_and_tested',
        message: `MCP server '${input.name}' added and connection test succeeded `
          + `(${toolsCount} tools discovered).`,
        server: serverSummary(entry, input),
        test: { success: true, transport: input.transport, tools_count: toolsCount },
        settings_key: MCP_TOOLS_LIST_KEY,
      }) as Record<string, unknown>;
    }

    deps.emitListChanged('mcp_server_propose');
    return redactSensitiveJson({
      status: 'pending_secrets',
      message: 'Configuration written (disabled). Open Settings > MCP Tools, fill env variables '
        + `[${input.envRequired.join(', ')}], then enable the server.`,
      server: serverSummary(entry, input),
      env_required: [...input.envRequired],
      settings_key: MCP_TOOLS_LIST_KEY,
    }) as Record<string, unknown>;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
