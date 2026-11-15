// Port of dstu-core/src/canonical_tools.rs name encoding used by the MCP registry.

export const CANONICAL_TOOL_NAME_PREFIX = 'ds_tool_';

function isOpenAiCompatibleToolName(name: string): boolean {
  return name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name);
}

export function encodeToolNameForApi(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (isOpenAiCompatibleToolName(trimmed) && !trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) {
    return trimmed;
  }
  const bytes = new TextEncoder().encode(trimmed);
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return CANONICAL_TOOL_NAME_PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeToolNameFromApi(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  if (!trimmed.startsWith(CANONICAL_TOOL_NAME_PREFIX)) return trimmed;
  const encoded = trimmed.slice(CANONICAL_TOOL_NAME_PREFIX.length);
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** `ToolRegistry::resolve_frontend_mcp_tool_name`. */
export function resolveFrontendMcpToolName(
  toolName: string, namespacePrefix: string | null = null,
): string | null {
  const decoded = decodeToolNameFromApi(toolName);
  if (decoded === null) return null;
  const withoutMcpPrefix = decoded.startsWith('mcp_') ? decoded.slice(4) : decoded;
  if (namespacePrefix !== null && withoutMcpPrefix.startsWith(namespacePrefix)) {
    return withoutMcpPrefix.slice(namespacePrefix.length);
  }
  return withoutMcpPrefix;
}
