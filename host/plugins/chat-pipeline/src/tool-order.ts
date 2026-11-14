/**
 * pipeline/tool_loop.rs — dependency-safe execution ordering.
 *
 * Chat-anki and document tools touch shared state (cards, workbook files), so a
 * batch is reordered by action priority while preserving relative order inside
 * one priority. Non-domain batches keep their original order byte-for-byte.
 */
import { BUILTIN_NAMESPACE } from './canonical-tools.ts';

export interface ExecutableToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

function stripToolPrefix(toolName: string): string {
  if (toolName.startsWith(BUILTIN_NAMESPACE)) return toolName.slice(BUILTIN_NAMESPACE.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  if (toolName.startsWith('mcp.tools.')) return toolName.slice('mcp.tools.'.length);
  return toolName;
}

function chatankiPriority(shortName: string): number | null {
  if (!shortName.startsWith('chatanki_')) return null;
  switch (shortName) {
    case 'chatanki_run':
    case 'chatanki_start': return 0;
    case 'chatanki_control': return 1;
    case 'chatanki_status':
    case 'chatanki_list_templates':
    case 'chatanki_analyze':
    case 'chatanki_check_anki_connect': return 2;
    case 'chatanki_wait': return 3;
    case 'chatanki_get_cards':
    case 'chatanki_update_card':
    case 'chatanki_delete_card':
    case 'chatanki_add_cards':
    case 'chatanki_retemplate': return 4;
    case 'chatanki_enqueue_review': return 5;
    case 'chatanki_export':
    case 'chatanki_sync': return 6;
    default: return 2;
  }
}

function documentToolPriority(shortName: string): number | null {
  const prefix = ['pptx_', 'xlsx_', 'docx_'].find(candidate => shortName.startsWith(candidate));
  if (prefix === undefined) return null;
  switch (shortName.slice(prefix.length)) {
    case 'create': return 0;
    case 'read_structured':
    case 'get_metadata':
    case 'extract_tables': return 1;
    case 'edit_cells':
    case 'replace_text': return 2;
    case 'to_spec': return 3;
    default: return 1;
  }
}

/** `(group, action)`: chat-anki before document tools, then action priority. */
function toolPriority(toolName: string): [number, number] {
  const shortName = stripToolPrefix(toolName);
  const chatanki = chatankiPriority(shortName);
  if (chatanki !== null) return [0, chatanki];
  const document = documentToolPriority(shortName);
  if (document !== null) return [1, document];
  return [99, 0];
}

/**
 * Stable sort by `(group, action, original index)`. A batch without any domain
 * tool is returned unchanged, which keeps the wire prefix byte-identical.
 */
export function orderToolCallsForExecution<T extends ExecutableToolCall>(
  toolCalls: readonly T[]): T[] {
  const needsSort = toolCalls.some(call => {
    const shortName = stripToolPrefix(call.name);
    return chatankiPriority(shortName) !== null || documentToolPriority(shortName) !== null;
  });
  if (!needsSort) return [...toolCalls];

  return toolCalls
    .map((call, index) => ({
      index,
      call,
      priority: toolPriority(call.name),
    }))
    .sort((left, right) => {
      if (left.priority[0] !== right.priority[0]) return left.priority[0] - right.priority[0];
      if (left.priority[1] !== right.priority[1]) return left.priority[1] - right.priority[1];
      return left.index - right.index;
    })
    .map(entry => entry.call);
}

/** types::ToolCall::new. */
export function createToolCall(id: string, name: string, args: unknown): ExecutableToolCall {
  return { id, name, arguments: args };
}
