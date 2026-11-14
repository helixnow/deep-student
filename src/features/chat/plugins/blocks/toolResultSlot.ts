/**
 * `chat.toolResults` lookup for the mcp_tool block: tool name → result view, `builtin-` prefix tolerated.
 */
import type { SlotContribution, SlotEntry } from '@/ui-kernel/slots';
import type { ChatToolResultContribution, ChatToolResultProps } from '@/ui-kernel/contracts/chat';

type ToolResultEntries = readonly (SlotEntry<ChatToolResultContribution> | SlotContribution<ChatToolResultContribution>)[];

/** Strips `builtin-` / `builtin:`, `mcp_`, `mcp.tools.` and any `<namespace>.` prefix. */
export function qualifiedToolBaseName(name: string): string {
  return name
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
}

const indexCache = new WeakMap<ToolResultEntries, Map<string, ChatToolResultContribution>>();

function indexOf(entries: ToolResultEntries): Map<string, ChatToolResultContribution> {
  let index = indexCache.get(entries);
  if (!index) {
    index = new Map();
    for (const entry of entries) if (entry.key && !index.has(entry.key)) index.set(entry.key, entry.value);
    indexCache.set(entries, index);
  }
  return index;
}

/** The contribution whose key matches `toolName`, ignoring `when`. */
export function findToolResult(entries: ToolResultEntries, toolName: string): ChatToolResultContribution | undefined {
  const index = indexOf(entries);
  const exact = index.get(toolName) ?? (toolName.startsWith('builtin-') ? index.get(toolName.slice('builtin-'.length)) : undefined);
  if (exact) return exact;
  const qualified = index.get(qualifiedToolBaseName(toolName));
  return qualified?.match === 'qualified' ? qualified : undefined;
}

/** Contributions from the kernel slot win over the built-in table; `when: false` falls back to the generic view. */
export function resolveToolResult(
  layers: readonly (ToolResultEntries | undefined)[],
  props: ChatToolResultProps,
): ChatToolResultContribution | undefined {
  for (const entries of layers) {
    if (!entries) continue;
    const found = findToolResult(entries, props.toolName);
    if (found) return !found.when || found.when(props) ? found : undefined;
  }
  return undefined;
}
