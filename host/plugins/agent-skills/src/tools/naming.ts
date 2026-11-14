/**
 * Tool-name namespacing helpers shared by the tool executors, ported from
 * `crates/dstu-core/src/tool_names.rs`, `chat_v2/tools/mod.rs` (canvas name
 * list) and `chat_v2/approval_scope.rs` (source namespace + high-risk set).
 *
 * These helpers are intentionally source-preserving: executors must decide
 * whether a call is external MCP before stripping its namespace, otherwise
 * `mcp_workspace_file_read` can collide with a builtin executor.
 */
export const EXTERNAL_MCP_TOOL_PREFIX = 'mcp_';
export const EXTERNAL_MCP_DOTTED_TOOL_PREFIX = 'mcp.tools.';

export const CANVAS_TOOL_NAMES = [
  'note_read',
  'note_append',
  'note_replace',
  'note_set',
  'note_list',
  'note_search',
  'note_create',
  'note_delete',
  'note_update_tags',
] as const;

/** `is_external_mcp_tool_name` (dstu-core/tool_names.rs:16–19). */
export function isExternalMcpToolName(toolName: string): boolean {
  return toolName.startsWith(EXTERNAL_MCP_TOOL_PREFIX)
    || toolName.startsWith(EXTERNAL_MCP_DOTTED_TOOL_PREFIX);
}

/** Remove the `builtin-` / `mcp_` prefix (dstu-core/tool_names.rs:26–31). */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

/** `is_canvas_tool`: unprefixed, `builtin-` and `mcp_` spellings (tools/mod.rs:186–205). */
export function isCanvasTool(toolName: string): boolean {
  const stripped = stripToolNamespace(toolName);
  return (CANVAS_TOOL_NAMES as readonly string[]).includes(stripped);
}

export interface ToolSourceNamespace {
  /** `builtin` / `local` / `mcp` / `mcp:<serverId>`. */
  source: string;
  /** Tool name after the source prefix. */
  shortName: string;
}

/**
 * `tool_source_namespace`: approve one server's `file_write` without approving
 * another server's same-named tool (approval_scope.rs:55–99).
 */
export function toolSourceNamespace(toolName: string, args: unknown): ToolSourceNamespace {
  if (toolName.startsWith('builtin-')) {
    return { source: 'builtin', shortName: toolName.slice('builtin-'.length) };
  }
  if (toolName.startsWith('builtin:')) {
    return { source: 'builtin', shortName: toolName.slice('builtin:'.length) };
  }
  const serverId = readServerId(args);
  if (toolName.startsWith(EXTERNAL_MCP_DOTTED_TOOL_PREFIX)) {
    return {
      source: serverId === undefined ? 'mcp' : `mcp:${serverId}`,
      shortName: toolName.slice(EXTERNAL_MCP_DOTTED_TOOL_PREFIX.length),
    };
  }
  if (toolName.startsWith(EXTERNAL_MCP_TOOL_PREFIX)) {
    return {
      source: serverId === undefined ? 'mcp' : `mcp:${serverId}`,
      shortName: toolName.slice(EXTERNAL_MCP_TOOL_PREFIX.length),
    };
  }
  return { source: 'local', shortName: toolName };
}

function readServerId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['_serverId', 'serverId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** `semantic_tool_short_name`: short name with a second `builtin-` layer removed. */
export function semanticToolShortName(toolName: string): string {
  const { shortName } = toolSourceNamespace(toolName, null);
  if (shortName.startsWith('builtin-')) return shortName.slice('builtin-'.length);
  if (shortName.startsWith('builtin:')) return shortName.slice('builtin:'.length);
  return shortName;
}

const HIGH_RISK_SEMANTIC_NAMES = [
  'execute_command',
  'bash',
  'shell',
  'shell_execute',
  'local_shell_execute',
  'file_write',
  'file_delete',
  'file_patch',
  'file_append',
  'file_create',
] as const;

/** `is_high_risk_external_mcp_tool` (approval_scope.rs:147–165). */
export function isHighRiskExternalMcpTool(toolName: string): boolean {
  const { source } = toolSourceNamespace(toolName, null);
  if (!source.startsWith('mcp')) return false;
  return (HIGH_RISK_SEMANTIC_NAMES as readonly string[]).includes(semanticToolShortName(toolName));
}
