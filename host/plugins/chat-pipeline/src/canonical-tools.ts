/**
 * dstu-core/src/canonical_tools.rs — lossless tool-name encoding for
 * OpenAI-compatible APIs, plus the chat-pipeline external-tool schema adapter
 * (pipeline/helpers.rs).
 */
import type { McpToolSchema } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { decodeUtf8Strict, rustTrim } from '../../../platform/util/index.ts';
import { toBase64, fromBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';

export const CANONICAL_TOOL_NAME_PREFIX = 'ds_tool_';
export const EXTERNAL_MCP_TOOL_PREFIX = 'mcp_';
export const BUILTIN_NAMESPACE = 'builtin-';

export type ApiNameSource = 'bridge_name' | 'internal_tool_name';

export interface CanonicalExternalToolConfig {
  internalPrefix?: string | null;
  preservePrefix?: string | null;
  apiNamePrefix?: string | null;
  includeServerSuffix: boolean;
  apiNameSource: ApiNameSource;
}

export interface CanonicalExternalTool {
  /** Bridge name before normalization (kept for diagnostics/tests). */
  bridgeName: string;
  internalToolName: string;
  apiName: string;
  preferredServerId: string | null;
  schema: unknown;
}

export function isOpenAiCompatibleToolName(name: string): boolean {
  return name !== '' && /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Lossless encoding: names already valid for OpenAI stay untouched, everything
 * else (including names that begin with the reserved prefix) is base64url
 * encoded behind `ds_tool_`.
 */
export function encodeToolNameForApi(name: string): string | null {
  const trimmed = rustTrim(name);
  if (trimmed === '') return null;
  if (isOpenAiCompatibleToolName(trimmed) && !trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) {
    return trimmed;
  }
  return `${CANONICAL_TOOL_NAME_PREFIX}${toBase64(utf8Encode(trimmed), { alphabet: 'url' })}`;
}

export function decodeToolNameFromApi(name: string): string | null {
  const trimmed = rustTrim(name);
  if (trimmed === '') return null;
  if (!trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) return trimmed;

  const encoded = trimmed.slice(CANONICAL_TOOL_NAME_PREFIX.length);
  // Rust URL_SAFE_NO_PAD rejects foreign alphabets and impossible lengths.
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
  try {
    return decodeUtf8Strict(fromBase64(encoded, { alphabet: 'url' }));
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFunctionParameters(parameters: unknown): Record<string, unknown> {
  const schema: Record<string, unknown> = isPlainObject(parameters)
    ? { ...parameters }
    : { type: 'object', properties: {} };
  if (!('type' in schema)) schema.type = 'object';
  if (!('properties' in schema)) schema.properties = {};
  return schema;
}

export function buildOpenAiFunctionToolSchema(apiName: string, description?: string | null,
  parameters?: unknown): unknown {
  return {
    type: 'function',
    function: {
      name: apiName,
      description: description ?? '',
      parameters: normalizeFunctionParameters(parameters),
    },
  };
}

export function prepareExternalTool(name: string, serverId: string | null | undefined,
  description: string | null | undefined, inputSchema: unknown,
  config: CanonicalExternalToolConfig): CanonicalExternalTool | null {
  const bridgeName = rustTrim(name);
  if (bridgeName === '') return null;

  let internalToolName: string;
  if (config.preservePrefix !== undefined && config.preservePrefix !== null
    && bridgeName.startsWith(config.preservePrefix)) {
    internalToolName = bridgeName;
  } else if (config.internalPrefix !== undefined && config.internalPrefix !== null) {
    internalToolName = `${config.internalPrefix}${bridgeName}`;
  } else {
    internalToolName = bridgeName;
  }

  const trimmedServerId = serverId == null ? undefined : rustTrim(serverId);
  const preferredServerId = trimmedServerId !== undefined && trimmedServerId !== ''
    ? trimmedServerId
    : null;

  let apiBaseName = config.apiNameSource === 'bridge_name' ? bridgeName : internalToolName;
  if (config.apiNamePrefix !== undefined && config.apiNamePrefix !== null) {
    apiBaseName = `${config.apiNamePrefix}${apiBaseName}`;
  }
  if (config.includeServerSuffix) {
    // Encode the whole route tuple; concatenation with a sentinel was ambiguous.
    apiBaseName = JSON.stringify(['mcp-route-v1', apiBaseName, preferredServerId]);
  }

  const apiName = encodeToolNameForApi(apiBaseName);
  if (apiName === null) return null;
  return {
    bridgeName,
    internalToolName,
    apiName,
    preferredServerId,
    schema: buildOpenAiFunctionToolSchema(apiName, description, inputSchema),
  };
}

export interface PreparedExternalToolSchema {
  apiName: string;
  rawToolName: string;
  preferredServerId: string | null;
  schema: unknown;
}

const TRUSTED_LOAD_SKILLS_NAMES = new Set([
  'load_skills', 'builtin-load_skills', 'builtin:load_skills', 'mcp_load_skills',
]);

/**
 * Chat-pipeline adapter. A server id that is present but blank is rejected; a
 * trusted local `load_skills` keeps the builtin namespace, while an external
 * server advertising the same name stays isolated behind `mcp_`.
 */
export function prepareExternalToolSchema(tool: McpToolSchema,
  includeServerSuffix: boolean): PreparedExternalToolSchema | null {
  if (tool.serverId !== undefined && tool.serverId !== null && rustTrim(tool.serverId) === '') {
    return null;
  }
  const trustedLoadSkills = (tool.serverId === undefined || tool.serverId === null)
    && TRUSTED_LOAD_SKILLS_NAMES.has(tool.name);
  const bridgeName = trustedLoadSkills ? 'load_skills' : tool.name;
  const prepared = prepareExternalTool(bridgeName, tool.serverId, tool.description,
    tool.inputSchema, {
      internalPrefix: trustedLoadSkills ? BUILTIN_NAMESPACE : EXTERNAL_MCP_TOOL_PREFIX,
      preservePrefix: tool.serverId === undefined || tool.serverId === null
        ? BUILTIN_NAMESPACE
        : null,
      apiNamePrefix: null,
      includeServerSuffix: includeServerSuffix
        && tool.serverId !== undefined && tool.serverId !== null,
      apiNameSource: 'internal_tool_name',
    });
  if (prepared === null) return null;
  return {
    apiName: prepared.apiName,
    rawToolName: prepared.internalToolName,
    preferredServerId: prepared.preferredServerId,
    schema: prepared.schema,
  };
}

/** Deny-first MCP policy: only schemas without an external server identity are trusted. */
export function isMcpToolAllowedByPolicy(tool: McpToolSchema, whitelist: readonly string[],
  blacklist: readonly string[]): boolean {
  if (blacklist.includes(tool.name)) return false;
  if ((tool.serverId === undefined || tool.serverId === null)
    && tool.name.startsWith(BUILTIN_NAMESPACE)) {
    return true;
  }
  return whitelist.length === 0 || whitelist.includes(tool.name);
}

/** helpers.rs::normalize_tool_name_for_api. */
export function normalizeToolNameForApi(name: string): string | null {
  return encodeToolNameForApi(name);
}

const EXTERNAL_MCP_DOTTED_TOOL_PREFIX = 'mcp.';

/** Core tool_names.rs: external bridge namespace detection. */
export function isExternalMcpToolName(toolName: string): boolean {
  return toolName.startsWith(EXTERNAL_MCP_TOOL_PREFIX)
    || toolName.startsWith(EXTERNAL_MCP_DOTTED_TOOL_PREFIX);
}

/** SkillsExecutor::is_load_skills_tool — strips builtin-, builtin: and mcp_. */
export function isLoadSkillsToolName(toolName: string): boolean {
  const stripped = toolName.startsWith(BUILTIN_NAMESPACE)
    ? toolName.slice(BUILTIN_NAMESPACE.length)
    : toolName.startsWith('builtin:')
      ? toolName.slice('builtin:'.length)
      : toolName.startsWith(EXTERNAL_MCP_TOOL_PREFIX)
        ? toolName.slice(EXTERNAL_MCP_TOOL_PREFIX.length)
        : toolName;
  return stripped === 'load_skills';
}
