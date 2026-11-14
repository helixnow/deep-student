/**
 * pipeline.rs skill tool-allowlist matching.
 *
 * Entries are case-insensitive, may carry `builtin-`/`mcp_` prefixes, and may
 * be server-scoped with `server::tool` or `server/tool`.
 */

import { rustTrim } from '../../../platform/util/index.ts';

export function normalizeToolNameForSkillMatch(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export function skillAllowsTool(toolName: string, allowed: string): boolean {
  const toolRaw = toolName.toLowerCase();
  const allowedRaw = allowed.toLowerCase();
  const toolNormalized = normalizeToolNameForSkillMatch(toolRaw);
  const allowedNormalized = normalizeToolNameForSkillMatch(allowedRaw);

  return toolRaw === allowedRaw
    || toolNormalized === allowedNormalized
    || toolNormalized.startsWith(`${allowedNormalized}_`)
    || toolNormalized.startsWith(allowedNormalized);
}

export function skillAllowsToolOnServer(toolName: string, serverId: string | null | undefined,
  allowed: string): boolean {
  const trimmedServer = typeof serverId === 'string' ? rustTrim(serverId) : '';
  if (trimmedServer === '') return skillAllowsTool(toolName, allowed);

  const allowedLower = allowed.toLowerCase();
  const serverLower = trimmedServer.toLowerCase();

  const separator = allowedLower.includes('::')
    ? '::'
    : (allowedLower.includes('/') ? '/' : null);
  if (separator !== null) {
    const index = allowedLower.indexOf(separator);
    const allowedServer = allowedLower.slice(0, index);
    const allowedTool = allowedLower.slice(index + separator.length);
    return allowedServer === serverLower && skillAllowsTool(toolName, allowedTool);
  }
  return skillAllowsTool(toolName, allowed);
}
