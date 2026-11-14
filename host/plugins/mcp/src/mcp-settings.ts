// Port of dstu-agent/src/chat_v2/tools/mcp_settings_store.rs (settings helpers only).
import type { JsonValue } from '../api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';

export const MCP_TOOLS_LIST_KEY = 'mcp.tools.list';
export const MCP_ALLOW_UNAPPROVED_KEY = 'mcp.stdio.allowUnapproved';

export function parseAllowUnapprovedValue(raw: string | null): boolean {
  return raw !== null && raw.trim().toLowerCase() === 'true';
}
export async function readMcpToolsList(settings: SettingsStore): Promise<JsonValue[]> {
  let raw: string | null;
  try { raw = await settings.getSecret(MCP_TOOLS_LIST_KEY); }
  catch (e) { throw new Error(`failed to read ${MCP_TOOLS_LIST_KEY}: ${e instanceof Error ? e.message : String(e)}`); }
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`failed to parse ${MCP_TOOLS_LIST_KEY} JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!Array.isArray(parsed)) throw new Error(`${MCP_TOOLS_LIST_KEY} is not a JSON array`);
  return parsed as JsonValue[];
}
export async function readMcpAllowUnapproved(settings: SettingsStore): Promise<boolean> {
  try { return parseAllowUnapprovedValue(await settings.getSecret(MCP_ALLOW_UNAPPROVED_KEY)); }
  catch (e) { throw new Error(`failed to read ${MCP_ALLOW_UNAPPROVED_KEY}: ${e instanceof Error ? e.message : String(e)}`); }
}
export async function writeMcpAllowUnapproved(settings: SettingsStore, enabled: boolean): Promise<void> {
  try { await settings.saveSecret(MCP_ALLOW_UNAPPROVED_KEY, enabled ? 'true' : 'false'); }
  catch (e) { throw new Error(`failed to write ${MCP_ALLOW_UNAPPROVED_KEY}: ${e instanceof Error ? e.message : String(e)}`); }
}
