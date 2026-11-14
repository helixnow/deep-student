// Rust: chatanki_executor.rs:1732–1996 tool name/sensitivity metadata.
import { stripToolNamespace } from './execution.ts';

// ============================================================================
// Tool metadata (chatanki_executor.rs:1732–1996)
// ============================================================================

const CHATANKI_TOOLS: readonly string[] = [
  'chatanki_run', 'chatanki_import_apkg', 'chatanki_start', 'chatanki_status', 'chatanki_wait',
  'chatanki_get_cards', 'chatanki_update_card', 'chatanki_batch_update_cards',
  'chatanki_delete_card', 'chatanki_delete_cards', 'chatanki_add_cards',
  'chatanki_enqueue_review', 'chatanki_review_stats', 'chatanki_undo_last_review',
  'chatanki_set_suspended', 'chatanki_list_library_cards', 'chatanki_update_library_card',
  'chatanki_enqueue_library_review', 'chatanki_set_library_suspended',
  'chatanki_undo_library_last_review', 'chatanki_delete_library_card', 'chatanki_retemplate',
  'chatanki_transform', 'chatanki_control', 'chatanki_export', 'chatanki_sync',
  'chatanki_list_templates', 'chatanki_analyze', 'chatanki_check_anki_connect',
];

export function isChatAnkiTool(toolName: string): boolean {
  return CHATANKI_TOOLS.includes(stripToolNamespace(toolName));
}

/** `sensitivity_level` 名字级基线；transform 的 script 模式另有调用级提升。 */
export function chatankiToolSensitivity(toolName: string): 'low' | 'medium' | 'high' {
  switch (stripToolNamespace(toolName)) {
    case 'chatanki_undo_last_review':
    case 'chatanki_undo_library_last_review':
    case 'chatanki_delete_library_card':
    case 'chatanki_update_library_card':
      return 'high';
    case 'chatanki_set_suspended':
    case 'chatanki_enqueue_library_review':
    case 'chatanki_set_library_suspended':
    case 'chatanki_batch_update_cards':
    case 'chatanki_delete_cards':
    case 'chatanki_transform':
    case 'chatanki_export':
    case 'chatanki_sync':
    case 'chatanki_import_apkg':
      return 'medium';
    default:
      return 'low';
  }
}

/** `sensitivity_level_for_call`：script 模式恒 High（沙箱任意脚本）。 */
export function chatankiSensitivityForCall(
  toolName: string, args: Record<string, unknown>,
): 'low' | 'medium' | 'high' {
  if (stripToolNamespace(toolName) === 'chatanki_transform') {
    const transform = args.transform;
    if (transform !== null && typeof transform === 'object' && !Array.isArray(transform)) {
      const script = (transform as Record<string, unknown>).script;
      if (script !== undefined && script !== null) return 'high';
    }
  }
  return chatankiToolSensitivity(toolName);
}

export function chatankiHasDynamicSensitivity(toolName: string): boolean {
  return stripToolNamespace(toolName) === 'chatanki_transform';
}
