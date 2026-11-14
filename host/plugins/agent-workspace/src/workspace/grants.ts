// chat_v2/grants.rs（本 lane 需要的子集）——ToolScope 推导与匹配。
//
// Rust 依据：`ToolScopeExt::allows` 复用 `tool_policy::tool_allow_entry_matches`
// （含 builtin/MCP 源隔离与 `server::tool` 显式源限定）；`from_allow_entry` 在字符串
// 规则之后查 `tool_descriptors::grants_scope_hint`；`DelegatedGrant::effective_tools`
// 求 profile.allowed_tools ∩ tool_scopes（保序去重）。
import type { JsonValue } from '../../api.ts';
import { grantsScopeHint } from './tool-registry.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';

export const DELEGATED_GRANT_SCHEMA_VERSION = 1;

export type ToolScope =
  | { kind: 'builtin'; name: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'shell'; prefixes: string[] };

const BUILTIN_NAMESPACE = 'builtin-';

/** `tool_policy::canonical_tool_short_name`。 */
export function canonicalToolShortName(toolName: string): string {
  for (const prefix of [BUILTIN_NAMESPACE, 'builtin:', 'mcp.tools.', 'mcp_']) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

function isMcpNamespaced(name: string): boolean {
  return name.startsWith('mcp.tools.') || name.startsWith('mcp_');
}

function isBuiltinNamespaced(name: string): boolean {
  return name.startsWith(BUILTIN_NAMESPACE) || name.startsWith('builtin:');
}

/** `tool_policy::server_id_from_args`：pipeline reverse-map 注入的 MCP 服务器 id。 */
function serverIdFromArgs(argumentsValue: JsonValue): string | null {
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return null;
  }
  const raw = argumentsValue['_serverId'];
  if (typeof raw !== 'string') return null;
  const trimmed = rustTrim(raw);
  return trimmed.length === 0 ? null : trimmed;
}

function toolCallIsMcpSourced(toolName: string, argumentsValue: JsonValue): boolean {
  if (isMcpNamespaced(toolName)) return true;
  return !isBuiltinNamespaced(toolName) && serverIdFromArgs(argumentsValue) !== null;
}

function splitOnce(value: string, separator: string): [string, string] | null {
  const index = value.indexOf(separator);
  if (index < 0) return null;
  return [value.slice(0, index), value.slice(index + separator.length)];
}

/** `tool_policy::tool_allow_entry_matches`（逐分支照抄，含源隔离）。 */
export function toolAllowEntryMatches(
  allowedEntry: string,
  toolName: string,
  argumentsValue: JsonValue,
): boolean {
  // 1. 完整原始名精确匹配，但裸名仍需经过来源隔离。
  if (allowedEntry === toolName && toolCallIsMcpSourced(toolName, argumentsValue) === isMcpNamespaced(allowedEntry)) {
    return true;
  }

  // 2. `server::tool` 显式源限定条目。
  const explicit = splitOnce(allowedEntry, '::');
  if (explicit) {
    const [allowedServer, allowedTool] = explicit;
    const serverId = serverIdFromArgs(argumentsValue);
    if (serverId === null || allowedServer !== serverId) return false;
    const toolShort = canonicalToolShortName(toolName);
    const allowedToolShort = canonicalToolShortName(allowedTool);
    return allowedTool === toolName
      || allowedTool === toolShort
      || allowedToolShort === toolName
      || allowedToolShort === toolShort;
  }

  // 3. 短名匹配：仅限同源命名空间（builtin↔builtin/裸名、mcp↔mcp）。
  if (toolCallIsMcpSourced(toolName, argumentsValue) !== isMcpNamespaced(allowedEntry)) return false;
  const toolShort = canonicalToolShortName(toolName);
  const allowedShort = canonicalToolShortName(allowedEntry);
  return allowedEntry === toolShort || allowedShort === toolName || allowedShort === toolShort;
}

/** `ToolScope::allows`。 */
export function scopeAllows(scope: ToolScope, toolName: string, argumentsValue: JsonValue): boolean {
  switch (scope.kind) {
    case 'builtin':
      return toolAllowEntryMatches(scope.name, toolName, argumentsValue);
    case 'mcp':
      return scope.server.length === 0
        ? toolAllowEntryMatches(scope.tool, toolName, argumentsValue)
        : toolAllowEntryMatches(`${scope.server}::${scope.tool}`, toolName, argumentsValue);
    case 'shell':
      // P1 fail-closed：shell 前缀授权尚未接线。
      return false;
  }
}

/** `ToolScope::from_allow_entry`。 */
export function scopeFromAllowEntry(entry: string): ToolScope {
  const trimmed = rustTrim(entry);
  const explicit = splitOnce(trimmed, '::');
  if (explicit) return { kind: 'mcp', server: explicit[0], tool: explicit[1] };
  if (trimmed.startsWith('mcp.tools.') || trimmed.startsWith('mcp_')) {
    return { kind: 'mcp', server: '', tool: trimmed };
  }
  return grantsScopeHint(trimmed) === 'shell'
    ? { kind: 'shell', prefixes: [] }
    : { kind: 'builtin', name: trimmed };
}

/** `ToolScope::scopes_from_allowed_tools`（保序、不去重）。 */
export function scopesFromAllowedTools(allowedTools: readonly string[]): ToolScope[] {
  return allowedTools.map(scopeFromAllowEntry);
}

/** `DelegatedGrant::effective_tools`（按 profile 顺序去重）。 */
export function effectiveTools(
  scopes: readonly ToolScope[],
  profileAllowedTools: readonly string[],
): string[] {
  const effective: string[] = [];
  for (const raw of profileAllowedTools) {
    const entry = rustTrim(raw);
    if (entry.length === 0) continue;
    if (scopes.some(scope => scopeAllows(scope, entry, null)) && !effective.includes(entry)) {
      effective.push(entry);
    }
  }
  return effective;
}
