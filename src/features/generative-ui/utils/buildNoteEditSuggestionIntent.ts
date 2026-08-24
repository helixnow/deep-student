/**
 * 笔记 AI 编辑建议 — 确定性意图构建（Chat / Copilot 侧预览 + action-bar）
 */

import type { GenerativeUIIntent } from '../types';
import type { CanvasEditOperation } from '@/features/notes/hooks/useAIEditState';
import { buildMarkdownIntent } from './buildMarkdownIntent';

export interface NoteEditSuggestionLabels {
  metaTitle: string;
  metaDescription: string;
  operationKey: string;
  previewTitle: string;
  applyEdit: string;
  dismissSuggestion: string;
  suggestionMarkdownTitle?: string;
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

  const suggestionBody = [
    input.labels.metaDescription.trim(),
    `**${input.labels.operationKey}:** ${input.operationLabel}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');

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
      ...buildMarkdownIntent({
        title: input.labels.suggestionMarkdownTitle ?? input.labels.metaTitle,
        body: suggestionBody,
        variant: 'compact',
      }).blocks,
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
