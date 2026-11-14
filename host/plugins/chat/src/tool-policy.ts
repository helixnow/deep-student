/** Rust chat_v2/tool_policy.rs. Execution allowlists never collapse builtin and MCP sources. */
import { rustTrim } from '../../../platform/util/index.ts';
import { is_external_mcp_tool_name } from '../../../platform/errors/api.ts';
import { SkillsExecutor } from '../../agent-skills/portable.ts';
import { isAttemptCompletion } from '../../agent-orchestration/portable.ts';

export function canonicalToolShortName(name: string): string {
  for (const prefix of ['builtin-', 'builtin:', 'mcp.tools.', 'mcp_']) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}
export function isControlTool(name: string): boolean {
  if (is_external_mcp_tool_name(name)) return false;
  return SkillsExecutor.isLoadSkillsTool(name) || isAttemptCompletion(name)
    || ['coordinator_sleep', 'builtin-coordinator_sleep', 'workspace_coordinator_sleep'].includes(name);
}
function serverId(args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const id = (args as Record<string, unknown>)._serverId;
  return typeof id === 'string' && rustTrim(id) !== '' ? rustTrim(id) : null;
}
function isMcpSourced(name: string, args: unknown): boolean {
  return is_external_mcp_tool_name(name) || (!(name.startsWith('builtin-') || name.startsWith('builtin:')) && serverId(args) !== null);
}
export function toolAllowEntryMatches(entry: string, name: string, args: unknown): boolean {
  if (entry === name && isMcpSourced(name, args) === is_external_mcp_tool_name(entry)) return true;
  const separator = entry.indexOf('::');
  if (separator >= 0) {
    const server = serverId(args);
    if (server === null || entry.slice(0, separator) !== server) return false;
    const allowedTool = entry.slice(separator + 2);
    const short = canonicalToolShortName(name); const allowedShort = canonicalToolShortName(allowedTool);
    return allowedTool === name || allowedTool === short || allowedShort === name || allowedShort === short;
  }
  if (isMcpSourced(name, args) !== is_external_mcp_tool_name(entry)) return false;
  const short = canonicalToolShortName(name); const allowedShort = canonicalToolShortName(entry);
  return entry === short || allowedShort === name || allowedShort === short;
}
export function isToolAllowedByExecutionPolicy(name: string, args: unknown, allowed: readonly string[] | null): boolean {
  if (isControlTool(name) && !isMcpSourced(name, args)) return true;
  return allowed === null || allowed.map(rustTrim).filter(entry => entry !== '').some(entry => toolAllowEntryMatches(entry, name, args));
}
