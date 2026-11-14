/** tool_approval_policy.rs:18–143; assigned to L05 for the ChatToolRuntime gate. */
import type { JsonValue } from '../api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { ignoresBroadApprovalBypassForArgs, jsonField, toolSourceNamespace } from './approval-scope/portable.ts';
import type { ToolSensitivity } from './approval-scope/portable.ts';

export const GLOBAL_TOOL_APPROVAL_BYPASS_KEY = 'tool_approval.global_bypass';
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, c => c.toLowerCase());

function serverId(args: JsonValue): string | null {
  const id = jsonField(args, '_serverId');
  return typeof id === 'string' ? rustTrim(id) || null : null;
}

export function isExternalMcpCall(toolName: string, args: JsonValue): boolean {
  if (toolName.startsWith('mcp_') || toolName.startsWith('mcp.tools.')) return true;
  return !toolName.startsWith('builtin-') && !toolName.startsWith('builtin:') && serverId(args) !== null;
}

export function toolApprovalSource(toolName: string, args: JsonValue): string {
  return serverId(args) ?? (toolName.startsWith('mcp_') || toolName.startsWith('mcp.tools.') ? 'mcp' : 'builtin');
}

export function toolApprovalDomain(toolName: string): string {
  const [, short] = toolSourceNamespace(toolName, null);
  return asciiLower(short.split('_').find(segment => segment !== '') ?? 'other');
}

export function resolveEffectiveSensitivity(
  base: ToolSensitivity | null,
  toolName: string,
  args: JsonValue,
  getSetting: (key: string) => string | null,
): ToolSensitivity | null {
  const source = toolApprovalSource(toolName, args);
  const keys = [
    `tool_approval.override.${source}::${toolName}`,
    `tool_approval.override.${toolName}`,
    `tool_approval.source.${source}`,
    `tool_approval.domain.${toolApprovalDomain(toolName)}`,
  ];
  let configured: ToolSensitivity | null = null;
  for (const key of keys) {
    const raw = getSetting(key);
    const value = raw === null ? null : asciiLower(rustTrim(raw));
    if (value === 'low' || value === 'medium' || value === 'high') { configured = value; break; }
  }
  if (configured === null) {
    const bypass = getSetting(GLOBAL_TOOL_APPROVAL_BYPASS_KEY);
    if (bypass !== null && asciiLower(rustTrim(bypass)) === 'true') configured = 'low';
  }
  const resolved = configured ?? base;
  return resolved === 'low' && ignoresBroadApprovalBypassForArgs(toolName, args) ? base : resolved;
}
