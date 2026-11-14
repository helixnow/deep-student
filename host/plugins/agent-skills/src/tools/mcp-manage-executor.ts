/**
 * MCP server management tools (`mcp_server_update`, `mcp_server_set_enabled`,
 * `mcp_server_remove`), ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs`.
 *
 * All three are governance front doors sharing the propose credential rules:
 * plaintext `env` is rejected, `env_required` accepts variable names only, and
 * every read-modify-write runs inside the shared MCP list mutation lock.
 * Remove requires the transport and entry revision the approval card showed.
 */
import { createHasherSync } from '../../../../platform/crypto/sync.ts';
import { compareUtf8 } from '../../../../platform/util/portable.ts';
import {
  ENV_PLACEHOLDER, parseRequiredString, parseStringArray, parseTransport,
  redactSensitiveJson, sanitizeTestError, validateHttpsUrl,
  type McpTransport,
} from './mcp-propose-executor.ts';
import { MCP_TOOLS_LIST_KEY, withMcpListMutation } from './mcp-settings-store.ts';
import { MCP_SERVER_UPDATE, MCP_SERVER_SET_ENABLED, MCP_SERVER_REMOVE } from '../../../../kernel/agent-tool-descriptors.ts';

export { MCP_SERVER_UPDATE, MCP_SERVER_SET_ENABLED, MCP_SERVER_REMOVE };

export const UPDATE_ALLOWED_KEYS = [
  'server_id', 'name', 'transport', 'command', 'args', 'env_required', 'url', 'reason',
];
export const SET_ENABLED_ALLOWED_KEYS = ['server_id', 'enabled', 'reason'];
export const REMOVE_ALLOWED_KEYS = [
  'server_id', 'expected_transport', 'expected_entry_revision', 'reason',
];

export const MANAGE_PROVENANCE_PREFIX = 'mcp.manage.provenance.';
export const PROPOSE_PROVENANCE_PREFIX = 'mcp.propose.provenance.';

const MCP_ENTRY_REVISION_KEY = globalThis.crypto.getRandomValues(new Uint8Array(32));

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function asciiEqualsIgnoreCase(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    const foldedA = a >= 65 && a <= 90 ? a + 32 : a;
    const foldedB = b >= 65 && b <= 90 ? b + 32 : b;
    if (foldedA !== foldedB) return false;
  }
  return true;
}

/** Process-scoped entry revision, salted like Rust's `OnceLock` random key. */
export function mcpEntryRevision(entry: unknown): string {
  const hasher = createHasherSync('SHA-256');
  hasher.update(MCP_ENTRY_REVISION_KEY);
  hasher.update(JSON.stringify(entry));
  return hasher.digestHex();
}

export interface UpdateInput {
  serverId: string;
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  envRequired?: string[];
  url?: string;
}

export interface UpdateOutcome {
  entry: Record<string, unknown>;
  transport: McpTransport;
  needsSecrets: boolean;
  enabled: boolean;
  changedFields: string[];
  envRequired: string[];
}

export function rejectUnknownFields(args: unknown, allowed: readonly string[]): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Arguments must be a JSON object');
  }
  const record = args as Record<string, unknown>;
  if ('env' in record) {
    throw new Error(
      "Field 'env' is not allowed: secrets are not handled by the agent. Use env_required "
      + '(variable names only); the user fills values in Settings.',
    );
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown field '${key}'. Allowed fields: ${allowed.join(', ')}`);
    }
  }
}

export function entryId(entry: unknown): string | undefined {
  const raw = asRecord(entry).id;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function entryName(entry: unknown): string | undefined {
  const raw = asRecord(entry).name;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

export function entryTransportRaw(entry: unknown): string {
  const record = asRecord(entry);
  const raw = record.transportType ?? record.transport;
  if (typeof raw !== 'string') return 'sse';
  const trimmed = raw.trim();
  return trimmed === '' ? 'sse' : trimmed;
}

export function entryEnabled(entry: unknown): boolean {
  const raw = asRecord(entry).enabled;
  return typeof raw === 'boolean' ? raw : true;
}

/** Exact stable id first, then case-insensitive name; duplicates fail closed. */
export function findServerIndex(list: readonly unknown[], serverId: string): number | undefined {
  const needle = serverId.trim();
  const idMatches: number[] = [];
  list.forEach((entry, index) => { if (entryId(entry) === needle) idMatches.push(index); });
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) {
    throw new Error(
      `MCP server identity '${needle}' is ambiguous: multiple entries share this stable id`,
    );
  }
  const nameMatches: number[] = [];
  list.forEach((entry, index) => {
    const name = entryName(entry);
    if (name !== undefined && asciiEqualsIgnoreCase(name, needle)) nameMatches.push(index);
  });
  if (nameMatches.length === 0) return undefined;
  if (nameMatches.length === 1) return nameMatches[0];
  throw new Error(
    `MCP server name '${needle}' is ambiguous. Re-run self_inspect and address the duplicate `
    + 'stable ids before retrying.',
  );
}

export function serverNotFound(serverId: string): string {
  return `MCP server '${serverId}' was not found in ${MCP_TOOLS_LIST_KEY}. Use self_inspect `
    + '(section=mcp) to list configured servers.';
}

/** Missing or still-placeholder env variable names (blocks enabling). */
export function missingEnvVars(entry: unknown): string[] {
  const env = asRecord(entry).env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return [];
  return Object.entries(env as Record<string, unknown>)
    .filter(([, value]) => typeof value !== 'string'
      || value.trim() === '' || value === ENV_PLACEHOLDER)
    .map(([key]) => key);
}

export function entrySummary(entry: unknown): Record<string, unknown> {
  const record = asRecord(entry);
  const summary: Record<string, unknown> = {};
  const id = entryId(entry);
  if (id !== undefined) summary.id = id;
  const name = entryName(entry);
  if (name !== undefined) summary.name = name;
  summary.transport = entryTransportRaw(entry);
  summary.enabled = entryEnabled(entry);
  if (typeof record.command === 'string') {
    summary.command = record.command;
    summary.args = record.args ?? [];
  }
  if ('url' in record) summary.url = '<remote-endpoint>';
  const env = record.env;
  if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
    const keys = Object.keys(env as Record<string, unknown>);
    if (keys.length > 0) summary.env_keys = keys;
  }
  return redactSensitiveJson(summary) as Record<string, unknown>;
}

export function provenanceCleanupKeys(entryIdValue: string, entryNameValue: string): string[] {
  return [...new Set([
    `${PROPOSE_PROVENANCE_PREFIX}${entryIdValue}`,
    `${MANAGE_PROVENANCE_PREFIX}${entryIdValue}`,
    `${PROPOSE_PROVENANCE_PREFIX}${entryNameValue}`,
  ])].sort(compareUtf8);
}

export function parseUpdateInput(args: unknown): UpdateInput {
  rejectUnknownFields(args, UPDATE_ALLOWED_KEYS);
  const record = asRecord(args);
  const serverId = parseRequiredString(args, 'server_id');
  const name = 'name' in record ? parseRequiredString(args, 'name') : undefined;
  const transport = 'transport' in record
    ? parseTransport(parseRequiredString(args, 'transport')) : undefined;
  const command = 'command' in record ? parseRequiredString(args, 'command') : undefined;
  const argsList = 'args' in record ? parseStringArray(args, 'args', true) : undefined;
  const envRequired = 'env_required' in record
    ? parseStringArray(args, 'env_required', true) : undefined;
  let url: string | undefined;
  if ('url' in record) {
    url = parseRequiredString(args, 'url');
    validateHttpsUrl(url);
  }
  const input: UpdateInput = {
    serverId,
    ...(name === undefined ? {} : { name }),
    ...(transport === undefined ? {} : { transport }),
    ...(command === undefined ? {} : { command }),
    ...(argsList === undefined ? {} : { args: argsList }),
    ...(envRequired === undefined ? {} : { envRequired }),
    ...(url === undefined ? {} : { url }),
  };
  if (name === undefined && transport === undefined && command === undefined
    && argsList === undefined && envRequired === undefined && url === undefined) {
    throw new Error(
      'At least one field to change is required (name, transport, command, args, '
      + 'env_required, url)',
    );
  }
  return input;
}

/** Apply an update to an existing entry; name-conflict checks need the whole list. */
export function applyUpdate(existing: unknown, input: UpdateInput): UpdateOutcome {
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    throw new Error('existing MCP server entry is not a JSON object');
  }
  const entry: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  const changed: string[] = [];
  let oldTransport: McpTransport | undefined;
  try { oldTransport = parseTransport(entryTransportRaw(existing)); }
  catch { oldTransport = undefined; }
  let transport: McpTransport;
  if (input.transport !== undefined) transport = input.transport;
  else if (oldTransport !== undefined) transport = oldTransport;
  else {
    throw new Error(
      `Existing entry has unrecognized transport '${entryTransportRaw(existing)}'; pass `
      + "'transport' explicitly to normalize it.",
    );
  }
  const transportChanged = oldTransport !== transport;
  if (transportChanged) changed.push('transport');
  entry.transportType = transport;

  if (input.name !== undefined) {
    if (entryName(existing) !== input.name) changed.push('name');
    entry.name = input.name;
  }

  if (transport === 'stdio') {
    if (input.url !== undefined) throw new Error("'url' is not valid for stdio transport");
    const existingCommand = typeof entry.command === 'string' && entry.command.trim() !== ''
      ? entry.command.trim() : undefined;
    const command = input.command ?? existingCommand;
    if (command === undefined) {
      throw new Error("'command' is required when switching to stdio transport");
    }
    if (input.command !== undefined
      && (typeof entry.command !== 'string' || entry.command !== command)) {
      changed.push('command');
    }
    entry.command = command;
    if (input.args !== undefined) {
      changed.push('args');
      entry.args = [...input.args];
    } else if (!('args' in entry)) {
      entry.args = [];
    }
    if (input.envRequired !== undefined) {
      changed.push('env_required');
      const oldEnv = typeof entry.env === 'object' && entry.env !== null
        && !Array.isArray(entry.env) ? entry.env as Record<string, unknown> : {};
      const env: Record<string, unknown> = {};
      for (const key of input.envRequired) {
        const old = oldEnv[key];
        const kept = typeof old === 'string' && old.trim() !== '' ? old : undefined;
        env[key] = kept ?? ENV_PLACEHOLDER;
      }
      entry.env = env;
    } else if (transportChanged) {
      entry.env = {};
    }
    delete entry.url;
    delete entry.fetch;
    delete entry.endpoint;
  } else {
    if (input.command !== undefined || input.args !== undefined) {
      throw new Error(
        `'command' and 'args' are only valid for stdio transport (got transport=${transport})`,
      );
    }
    if (input.envRequired !== undefined && input.envRequired.length > 0) {
      throw new Error(
        'env_required is only supported for stdio transport; remote transports use Settings '
        + 'for api keys',
      );
    }
    const existingUrl = typeof entry.url === 'string' && entry.url.trim() !== ''
      ? entry.url.trim() : undefined;
    const url = input.url ?? (transportChanged ? undefined : existingUrl);
    if (url === undefined) throw new Error("'url' is required for remote transports");
    if (input.url !== undefined) changed.push('url');
    entry.url = url;
    if (transport === 'sse' || transport === 'streamable_http') {
      entry.fetch = { type: transport, url };
    } else {
      delete entry.fetch;
    }
    delete entry.command;
    delete entry.args;
    delete entry.env;
    delete entry.endpoint;
  }

  if (changed.length === 0) {
    throw new Error(
      'No effective change: the provided values match the current configuration',
    );
  }

  const missing = missingEnvVars(entry);
  const needsSecrets = missing.length > 0;
  const enabled = needsSecrets ? false : entryEnabled(existing);
  entry.enabled = enabled;
  return {
    entry,
    transport,
    needsSecrets,
    enabled,
    changedFields: changed,
    envRequired: missing,
  };
}

export function findNameConflict(
  list: readonly unknown[],
  selfIndex: number,
  newName: string,
): string | undefined {
  for (let index = 0; index < list.length; index += 1) {
    if (index === selfIndex) continue;
    const name = entryName(list[index]);
    const id = entryId(list[index]);
    const hit = (name !== undefined && asciiEqualsIgnoreCase(name, newName))
      || (id !== undefined && asciiEqualsIgnoreCase(id, newName));
    if (hit) return `MCP server with name '${newName}' is already configured`;
  }
  return undefined;
}

export interface McpManageDependencies {
  readList(): Promise<unknown[]>;
  writeList(list: readonly unknown[]): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  saveSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  runConnectionTest(
    transport: McpTransport,
    entry: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  emitListChanged(action: string): void;
  /** Rust `warn!` sink; failures in best-effort bookkeeping continue. */
  warn?(message: string): void;
}

export interface McpManageContext {
  sessionId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class McpManageExecutor {
  /** Only `builtin-` is stripped: `mcp_server_*` is the bare tool name. */
  static shortName(toolName: string): string {
    return toolName.startsWith('builtin-') ? toolName.slice(8) : toolName;
  }

  canHandle(toolName: string): boolean {
    const short = McpManageExecutor.shortName(toolName);
    return short === MCP_SERVER_UPDATE
      || short === MCP_SERVER_SET_ENABLED
      || short === MCP_SERVER_REMOVE;
  }

  sensitivityLevel(toolName: string): 'medium' | 'high' {
    return McpManageExecutor.shortName(toolName) === MCP_SERVER_SET_ENABLED
      ? 'medium' : 'high';
  }

  name(): string { return 'McpManageExecutor'; }

  async executeUpdate(
    args: unknown,
    context: McpManageContext,
    deps: McpManageDependencies,
  ): Promise<Record<string, unknown>> {
    const input = parseUpdateInput(args);
    const { oldEntry, outcome, entryIdValue } = await withMcpListMutation(async () => {
      const list = await deps.readList();
      const index = findServerIndex(list, input.serverId);
      if (index === undefined) throw new Error(serverNotFound(input.serverId));
      if (input.name !== undefined) {
        const conflict = findNameConflict(list, index, input.name);
        if (conflict !== undefined) throw new Error(conflict);
      }
      const previous = list[index];
      const applied = applyUpdate(previous, input);
      const stableId = entryId(previous) ?? input.serverId;
      list[index] = applied.entry;
      await deps.writeList(list);
      return { oldEntry: previous, outcome: applied, entryIdValue: stableId };
    });

    try {
      await deps.saveSetting(
        `${MANAGE_PROVENANCE_PREFIX}${entryIdValue}`,
        JSON.stringify({
          action: 'updated',
          session_id: context.sessionId,
          at: new Date().toISOString().replace('Z', '+00:00'),
          detail: { changed_fields: outcome.changedFields },
        }),
      );
    } catch (error) {
      deps.warn?.(`[McpManageExecutor] provenance write failed: ${errorText(error)}`);
    }
    const oldName = entryName(oldEntry);
    if (oldName !== undefined) {
      await migrateLegacyProposeProvenance(deps, entryIdValue, oldName);
    }

    if (outcome.enabled && !outcome.needsSecrets) {
      const testResult = await deps.runConnectionTest(outcome.transport, outcome.entry);
      if (testResult.success !== true) {
        const restored = await withMcpListMutation(async () => {
          const list = await deps.readList();
          const index = findServerIndex(list, entryIdValue);
          if (index === undefined) return false;
          if (JSON.stringify(list[index]) !== JSON.stringify(outcome.entry)) return false;
          list[index] = oldEntry;
          await deps.writeList(list);
          return true;
        });
        const rawError = typeof testResult.error === 'string' ? testResult.error
          : typeof testResult.message === 'string' ? testResult.message
            : 'connection test failed';
        throw new Error(restored
          ? `MCP connection test failed after update: ${sanitizeTestError(rawError)}. `
            + 'The previous configuration has been restored.'
          : `MCP connection test failed after update: ${sanitizeTestError(rawError)}. `
            + 'The entry changed concurrently, so its newer value was preserved instead of '
            + 'rolling it back.');
      }
      const toolsCount = Array.isArray(testResult.tools) ? testResult.tools.length : 0;
      deps.emitListChanged(MCP_SERVER_UPDATE);
      return redactSensitiveJson({
        status: 'updated_and_tested',
        server_id: entryIdValue,
        changed_fields: outcome.changedFields,
        server: entrySummary(outcome.entry),
        test: { success: true, transport: outcome.transport, tools_count: toolsCount },
        settings_key: MCP_TOOLS_LIST_KEY,
      }) as Record<string, unknown>;
    }

    deps.emitListChanged(MCP_SERVER_UPDATE);
    if (outcome.needsSecrets) {
      return redactSensitiveJson({
        status: 'pending_secrets',
        server_id: entryIdValue,
        changed_fields: outcome.changedFields,
        message: 'Configuration updated (disabled). Open Settings > MCP Tools, fill env '
          + `variables [${outcome.envRequired.join(', ')}], then enable the server.`,
        env_required: outcome.envRequired,
        server: entrySummary(outcome.entry),
        settings_key: MCP_TOOLS_LIST_KEY,
      }) as Record<string, unknown>;
    }
    return redactSensitiveJson({
      status: 'updated_disabled',
      server_id: entryIdValue,
      changed_fields: outcome.changedFields,
      message: 'Configuration updated. The server is currently disabled, so no connection '
        + 'test was run; enable it with mcp_server_set_enabled to connect.',
      server: entrySummary(outcome.entry),
      settings_key: MCP_TOOLS_LIST_KEY,
    }) as Record<string, unknown>;
  }

  async executeSetEnabled(
    args: unknown,
    _context: McpManageContext,
    deps: McpManageDependencies,
  ): Promise<Record<string, unknown>> {
    rejectUnknownFields(args, SET_ENABLED_ALLOWED_KEYS);
    const record = asRecord(args);
    const serverId = parseRequiredString(args, 'server_id');
    if (typeof record.enabled !== 'boolean') {
      throw new Error("'enabled' is required (true = 启用, false = 停用)");
    }
    const enabled = record.enabled;
    const { entryIdValue, previousEnabled, summary } = await withMcpListMutation(async () => {
      const list = await deps.readList();
      const index = findServerIndex(list, serverId);
      if (index === undefined) throw new Error(serverNotFound(serverId));
      const entry = list[index];
      const stableId = entryId(entry) ?? serverId;
      const previous = entryEnabled(entry);
      if (enabled) {
        const missing = missingEnvVars(entry);
        if (missing.length > 0) {
          throw new Error(
            `Cannot enable '${stableId}': env variables [${missing.join(', ')}] are not filled `
            + 'yet. Ask the user to fill them in Settings > MCP Tools first.',
          );
        }
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error('MCP server entry is not a JSON object');
      }
      (entry as Record<string, unknown>).enabled = enabled;
      await deps.writeList(list);
      return {
        entryIdValue: stableId,
        previousEnabled: previous,
        summary: entrySummary(entry),
      };
    });

    deps.emitListChanged(MCP_SERVER_SET_ENABLED);
    return redactSensitiveJson({
      server_id: entryIdValue,
      enabled,
      previous_enabled: previousEnabled,
      server: summary,
      message: enabled
        ? 'Server enabled. The frontend MCP client will reconnect and advertise its tools shortly.'
        : 'Server disabled. The frontend MCP client will drop the connection; configuration '
          + 'and filled env values are kept.',
      settings_key: MCP_TOOLS_LIST_KEY,
    }) as Record<string, unknown>;
  }

  async executeRemove(
    args: unknown,
    _context: McpManageContext,
    deps: McpManageDependencies,
  ): Promise<Record<string, unknown>> {
    rejectUnknownFields(args, REMOVE_ALLOWED_KEYS);
    const serverId = parseRequiredString(args, 'server_id');
    const expectedTransportRaw = parseRequiredString(args, 'expected_transport');
    const expectedTransport = parseTransport(expectedTransportRaw);
    const expectedEntryRevision = parseRequiredString(args, 'expected_entry_revision');
    if (!/^[0-9a-fA-F]{64}$/.test(expectedEntryRevision)) {
      throw new Error('expected_entry_revision must be a 64-character SHA-256 hex string');
    }

    const { entryIdValue, entryNameValue, transportRaw, summary } = await withMcpListMutation(
      async () => {
        const list = await deps.readList();
        const index = findServerIndex(list, serverId);
        if (index === undefined) throw new Error(serverNotFound(serverId));
        const entry = list[index];
        const actualRaw = entryTransportRaw(entry);
        let matches: boolean;
        try { matches = parseTransport(actualRaw) === expectedTransport; }
        catch { matches = asciiEqualsIgnoreCase(actualRaw, expectedTransportRaw); }
        if (!matches) {
          throw new Error(
            `expected_transport '${expectedTransportRaw}' does not match the stored transport `
            + `'${actualRaw}' for server '${serverId}'. Re-run self_inspect (section=mcp) and `
            + 'retry with the actual transport.',
          );
        }
        if (!asciiEqualsIgnoreCase(mcpEntryRevision(entry), expectedEntryRevision)) {
          throw new Error(
            `MCP server '${serverId}' changed after removal approval. Re-run self_inspect `
            + '(section=mcp) and retry with the current entry_revision.',
          );
        }
        const stableId = entryId(entry) ?? serverId;
        const displayName = entryName(entry) ?? stableId;
        const entrySummaryValue = entrySummary(entry);
        list.splice(index, 1);
        await deps.writeList(list);
        return {
          entryIdValue: stableId,
          entryNameValue: displayName,
          transportRaw: actualRaw,
          summary: entrySummaryValue,
        };
      },
    );

    const cleanupWarnings: string[] = [];
    for (const key of provenanceCleanupKeys(entryIdValue, entryNameValue)) {
      try { await deps.deleteSetting(key); }
      catch (error) {
        cleanupWarnings.push(`failed to delete provenance '${key}': ${errorText(error)}`);
      }
    }

    deps.emitListChanged(MCP_SERVER_REMOVE);
    const output: Record<string, unknown> = {
      removed: true,
      server_id: entryIdValue,
      name: entryNameValue,
      transport: transportRaw,
      entry_revision: expectedEntryRevision,
      server: summary,
      message: 'MCP server configuration removed. The frontend MCP client will drop the '
        + 'connection; this cannot be undone (filled env values are deleted with the entry).',
      settings_key: MCP_TOOLS_LIST_KEY,
    };
    if (cleanupWarnings.length > 0) output.cleanup_warnings = cleanupWarnings;
    return redactSensitiveJson(output) as Record<string, unknown>;
  }
}

async function migrateLegacyProposeProvenance(
  deps: McpManageDependencies,
  stableId: string,
  legacyName: string,
): Promise<void> {
  const stableKey = `${PROPOSE_PROVENANCE_PREFIX}${stableId}`;
  const legacyKey = `${PROPOSE_PROVENANCE_PREFIX}${legacyName}`;
  if (stableKey === legacyKey) return;
  try {
    const legacy = await deps.getSetting(legacyKey);
    if (legacy === null) return;
    const stableExists = (await deps.getSetting(stableKey)) !== null;
    if (!stableExists) await deps.saveSetting(stableKey, legacy);
    await deps.deleteSetting(legacyKey);
  } catch (error) {
    deps.warn?.(
      `[McpManageExecutor] legacy proposal provenance migration failed: ${errorText(error)}`,
    );
  }
}
