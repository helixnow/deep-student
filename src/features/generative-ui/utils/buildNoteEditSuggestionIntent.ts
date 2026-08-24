/**
 * 笔记 AI 编辑建议 — 确定性意图构建（Chat / Copilot 侧预览 + action-bar）
 */

import type { GenerativeUIIntent } from '../types';
import type { CanvasEditOperation } from '@/features/notes/hooks/useAIEditState';

export interface NoteEditSuggestionLabels {
  metaTitle: string;
  metaDescription: string;
  operationKey: string;
  previewTitle: string;
  applyEdit: string;
  dismissSuggestion: string;
}

export interface NoteEditSuggestionInput {
  operation: CanvasEditOperation;
  operationLabel: string;
  previewText: string;
  labels: NoteEditSuggestionLabels;
}

export function buildNoteEditSuggestionIntent(input: NoteEditSuggestionInput): GenerativeUIIntent {
  const previewBody =
    input.previewText.length > 240
      ? `${input.previewText.slice(0, 240)}…`
      : input.previewText;

  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description: input.labels.metaDescription,
    },
    blocks: [
      {
        type: 'key-value-grid',
        props: {
          rows: [{ key: input.labels.operationKey, value: input.operationLabel }],
        },
      },
      {
        type: 'text',
        props: {
          heading: input.labels.previewTitle,
          body: previewBody || '—',
        },
      },
      {
        type: 'action-bar',
        props: {
          actions: [
            {
              id: 'apply-note-edit',
              label: input.labels.applyEdit,
              variant: 'primary',
              riskLevel: 'high',
            },
            {
              id: 'dismiss-note-suggestion',
              label: input.labels.dismissSuggestion,
              variant: 'default',
              riskLevel: 'low',
            },
          ],
        },
      },
    ],
  };
}
