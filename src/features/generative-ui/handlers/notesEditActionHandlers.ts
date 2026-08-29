/**
 * Notes 写入 HITL action handlers — 经 canvas:ai-edit-request 建议通道，不直写后端。
 */

import type { CanvasEditOperation } from '@/features/notes/hooks/useAIEditState';
import type { GenerativeActionDefinition } from '../types';
import {
  createCanvasEditRequestId,
  dispatchCanvasAIEditRequest,
  type CanvasAIEditDispatchResult,
} from '../utils/dispatchCanvasAIEditRequest';

export interface NoteEditSuggestionPayload {
  noteId: string;
  operation: CanvasEditOperation;
  content?: string;
  search?: string;
  replace?: string;
  section?: string;
  targetWindowId?: string;
}

export interface NotesEditActionLabels {
  applyEdit: string;
  dismissSuggestion: string;
}

export interface NotesEditActionCallbacks {
  onApplyDispatched?: (result: CanvasAIEditDispatchResult) => void;
  onDismiss?: () => void;
  onSettled?: () => void;
}

export function createNotesEditActionHandlers(
  suggestion: NoteEditSuggestionPayload,
  labels: NotesEditActionLabels,
  callbacks?: NotesEditActionCallbacks,
): Record<string, GenerativeActionDefinition> {
  return {
    'apply-note-edit': {
      id: 'apply-note-edit',
      label: labels.applyEdit,
      riskLevel: 'high',
      handler: async () => {
        const result = dispatchCanvasAIEditRequest(
          {
            requestId: createCanvasEditRequestId('gen-ui-note'),
            noteId: suggestion.noteId,
            targetWindowId: suggestion.targetWindowId,
            operation: suggestion.operation,
            content: suggestion.content,
            search: suggestion.search,
            replace: suggestion.replace,
            section: suggestion.section,
          },
          { onSettled: callbacks?.onSettled },
        );
        callbacks?.onApplyDispatched?.(result);
      },
    },
    'dismiss-note-suggestion': {
      id: 'dismiss-note-suggestion',
      label: labels.dismissSuggestion,
      riskLevel: 'low',
      handler: async () => {
        callbacks?.onDismiss?.();
      },
    },
  };
}
