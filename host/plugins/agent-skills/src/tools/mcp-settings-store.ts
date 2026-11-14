/**
 * MCP server-list secure settings helpers, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs`.
 *
 * All agent-side read-modify-write operations on `mcp.tools.list` must run
 * inside {@link withMcpListMutation}; the key has no OCC/version field, so
 * concurrent propose/update/remove would otherwise overwrite each other.
 */
import type { BackendEvents } from '../../../../kernel/api.ts';
import type { SettingsStore } from '../../../../platform/settings/api.ts';

export const MCP_TOOLS_LIST_KEY = 'mcp.tools.list';
export const MCP_ALLOW_UNAPPROVED_KEY = 'mcp.stdio.allowUnapproved';
export const SETTINGS_CHANGED_EVENT = 'chat_v2://settings_changed';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `parse_allow_unapproved_value`: trim + ASCII case-insensitive `true`. */
export function parseAllowUnapprovedValue(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const value = raw.trim();
  if (value.length !== 4) return false;
  return [...value].every((ch, index) => {
    const folded = ch >= 'A' && ch <= 'Z' ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;
    return folded === 'true'[index];
  });
}

/** Read the MCP server list from the secure store (empty array when unset). */
export async function readMcpToolsList(settings: SettingsStore): Promise<unknown[]> {
  let raw: string | null;
  try { raw = await settings.getSecret(MCP_TOOLS_LIST_KEY); }
  catch (error) {
    throw new Error(`failed to read ${MCP_TOOLS_LIST_KEY}: ${errorText(error)}`);
  }
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    throw new Error(`failed to parse ${MCP_TOOLS_LIST_KEY} JSON: ${errorText(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${MCP_TOOLS_LIST_KEY} is not a JSON array`);
  return parsed;
}

/** Persist the MCP server list through the secure store. */
export async function writeMcpToolsList(
  settings: SettingsStore,
  list: readonly unknown[],
): Promise<void> {
  let serialized: string;
  try { serialized = JSON.stringify(list); }
  catch (error) {
    throw new Error(`failed to serialize ${MCP_TOOLS_LIST_KEY}: ${errorText(error)}`);
  }
  try { await settings.saveSecret(MCP_TOOLS_LIST_KEY, serialized); }
  catch (error) {
    throw new Error(`failed to write ${MCP_TOOLS_LIST_KEY}: ${errorText(error)}`);
  }
}

/** Read the global "MCP dangerous mode" switch. Defaults to false. */
export async function readMcpAllowUnapproved(settings: SettingsStore): Promise<boolean> {
  let raw: string | null;
  try { raw = await settings.getSecret(MCP_ALLOW_UNAPPROVED_KEY); }
  catch (error) {
    throw new Error(`failed to read ${MCP_ALLOW_UNAPPROVED_KEY}: ${errorText(error)}`);
  }
  return parseAllowUnapprovedValue(raw);
}

/** Write the global "MCP dangerous mode" switch. */
export async function writeMcpAllowUnapproved(
  settings: SettingsStore,
  enabled: boolean,
): Promise<void> {
  try { await settings.saveSecret(MCP_ALLOW_UNAPPROVED_KEY, enabled ? 'true' : 'false'); }
  catch (error) {
    throw new Error(`failed to write ${MCP_ALLOW_UNAPPROVED_KEY}: ${errorText(error)}`);
  }
}

/** Restore a prior list snapshot (rollback after a failed connection test). */
export function restoreListSnapshot(snapshot: readonly unknown[]): unknown[] {
  return structuredClone(snapshot) as unknown[];
}

let mutationTail: Promise<void> = Promise.resolve();

/**
 * Serialise agent-side read-modify-write sections. Rust holds a `std::sync`
 * mutex across the whole section without awaiting; the host equivalent is a
 * FIFO promise chain because the settings store is asynchronous.
 */
export async function withMcpListMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

/**
 * Notify the front end to reload MCP connections after a config write.
 * Rust returns `emit(...).is_ok()`; emit throws become `false` here.
 */
export function emitMcpListChanged(events: BackendEvents, action: string): boolean {
  try {
    events.emit(SETTINGS_CHANGED_EVENT, { action, key: MCP_TOOLS_LIST_KEY });
    return true;
  } catch {
    return false;
  }
}
