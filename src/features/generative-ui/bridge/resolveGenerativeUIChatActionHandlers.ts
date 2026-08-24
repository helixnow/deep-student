/**
 * Chat generative_ui 块 — 按 modeState + toolInput 解析 actionHandlers
 */

import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import { workbenchLearningHandlers } from '../handlers/workbenchLearningHandlers';
import {
  createNotesEditActionHandlers,
  type NotesEditActionLabels,
} from '../handlers/notesEditActionHandlers';
import { extractNoteEditPayload } from '../utils/extractNoteEditPayload';

export const NOTE_EDIT_ACTION_IDS = ['apply-note-edit', 'dismiss-note-suggestion'] as const;

export function collectGenerativeUIActionIds(intent: GenerativeUIIntent): string[] {
  return intent.blocks
    .filter((b) => b.type === 'action-bar')
    .flatMap((b) => {
      const actions = (b.props as { actions?: Array<{ id: string }> })?.actions ?? [];
      return actions.map((a) => a.id);
    });
}

export interface ResolveGenerativeUIChatActionHandlersInput {
  canvasNoteId?: string;
  intent: GenerativeUIIntent;
  toolInput?: unknown;
  toolOutput?: unknown;
  noteEditLabels?: NotesEditActionLabels;
}

/**
 * 合并 workbench + Notes HITL handlers。
 * Chat 块应始终传入返回值（含 workbench 基线），以启用 ActionBar 注册表安全模式。
 */
export function resolveGenerativeUIChatActionHandlers(
  input: ResolveGenerativeUIChatActionHandlersInput,
): Record<string, GenerativeActionDefinition> {
  const actionIds = new Set(collectGenerativeUIActionIds(input.intent));
  const handlers: Record<string, GenerativeActionDefinition> = {};

  for (const id of actionIds) {
    if (workbenchLearningHandlers[id]) {
      handlers[id] = workbenchLearningHandlers[id];
    }
  }

  const needsNoteHandlers = NOTE_EDIT_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsNoteHandlers && input.canvasNoteId) {
    const noteEdit = extractNoteEditPayload(input.toolInput, input.toolOutput);
    if (noteEdit) {
      Object.assign(
        handlers,
        createNotesEditActionHandlers(
          { noteId: input.canvasNoteId, ...noteEdit },
          input.noteEditLabels ?? {
            applyEdit: '应用到笔记',
            dismissSuggestion: '忽略建议',
          },
        ),
      );
    }
  }

  return handlers;
}
