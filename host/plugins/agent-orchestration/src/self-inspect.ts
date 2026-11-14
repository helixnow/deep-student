/**
 * self_inspect 工具的纯逻辑：section 解析、白名单提取与敏感值脱敏
 * （self_inspect_executor.rs:29–119, 304–345, 442–526）。
 */
import { stripToolNamespace } from './automation-tool-args.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const SELF_INSPECT_TOOL_NAME = 'self_inspect';

export type InspectSection = 'all' | 'roots' | 'skills' | 'mcp' | 'search';

const SENSITIVE_JSON_KEY_PATTERNS = ['api_key', 'apikey', 'token', 'secret', 'password',
  'credential', 'private_key'] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** self_inspect_executor.rs:87–110. */
export function parseInspectSection(args: unknown): InspectSection {
  const object = asObject(args) ?? {};
  const rawValue = object.section;
  const raw = typeof rawValue === 'string' && rawValue.trim() !== '' ? rawValue.trim() : 'all';
  switch (raw.toLowerCase()) {
    case 'all': return 'all';
    case 'roots': return 'roots';
    case 'skills': return 'skills';
    case 'mcp': return 'mcp';
    case 'search': return 'search';
    default:
      throw new Error(`Unsupported section '${raw.toLowerCase()}'. Allowed values: roots, skills, mcp, search, all`);
  }
}

/** self_inspect_executor.rs:521–526. */
export function isSensitiveJsonKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_JSON_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** self_inspect_executor.rs:504–519. */
export function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  const object = asObject(value);
  if (object === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    out[key] = isSensitiveJsonKey(key) ? '<redacted>' : redactSensitiveJson(child);
  }
  return out;
}

// mcp_entry_revision is process-keyed (mcp_manage_executor.rs:69–81): the hash
// identifies an entry revision within this host process without exposing it.
const MCP_ENTRY_REVISION_KEY = globalThis.crypto.getRandomValues(new Uint8Array(32));

export function mcpEntryRevision(entry: unknown): string {
  const encoded = JSON.stringify(entry) ?? '';
  return createHasherSync('SHA-256').update(MCP_ENTRY_REVISION_KEY).update(encoded).digestHex();
}

/** self_inspect_executor.rs:304–345. */
export function sanitizeMcpServerEntry(value: unknown,
  revision: (entry: unknown) => string = mcpEntryRevision): Record<string, unknown> | null {
  const entry = asObject(value);
  if (entry === null) return null;
  const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : null;
  if (name === null) return null;
  const stableId = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : null;
  const id = stableId ?? name;
  const transportRaw = entry.transportType ?? entry.transport ?? entry.type;
  const transport = typeof transportRaw === 'string' && transportRaw.trim() !== ''
    ? transportRaw.trim() : 'unknown';
  const enabled = typeof entry.enabled === 'boolean' ? entry.enabled
    : typeof entry.disabled === 'boolean' ? !entry.disabled : true;
  return {
    id,
    name,
    transport,
    enabled,
    has_stable_id: stableId !== null,
    entry_revision: revision(entry),
  };
}

export interface SelfInspectPayloadParts {
  roots?: unknown;
  skills?: unknown;
  mcp?: unknown;
  search?: unknown;
  limitations?: readonly string[];
}

/** self_inspect_executor.rs:442–468. */
export function assembleSelfInspectPayload(
  section: InspectSection, parts: SelfInspectPayloadParts,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { section };
  if (parts.roots !== undefined) payload.roots = parts.roots;
  if (parts.skills !== undefined) payload.skills = parts.skills;
  if (parts.mcp !== undefined) payload.mcp = parts.mcp;
  if (parts.search !== undefined) payload.search = parts.search;
  if (parts.limitations !== undefined && parts.limitations.length > 0) {
    payload.limitations = parts.limitations;
  }
  return payload;
}

export function canHandleSelfInspectTool(toolName: string): boolean {
  return stripToolNamespace(toolName) === SELF_INSPECT_TOOL_NAME;
}

/** self_inspect_executor.rs:575–577: always read-only / Low. */
export function selfInspectSensitivityLevel(): 'Low' {
  return 'Low';
}
