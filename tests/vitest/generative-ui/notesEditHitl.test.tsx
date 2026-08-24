import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import {
  dispatchCanvasAIEditRequest,
  createCanvasEditRequestId,
} from '@/features/generative-ui/utils/dispatchCanvasAIEditRequest';
import { createNotesEditActionHandlers } from '@/features/generative-ui/handlers/notesEditActionHandlers';
import { MarkdownBlock, markdownPropsSchema } from '@/features/generative-ui/components/MarkdownBlock';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  computeProposedContent,
  MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES,
} from '@/features/notes/hooks/useAIEditState';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'action.confirm_title') return `确认：${params?.label ?? ''}`;
      if (key === 'action.confirm_desc') return '确认描述';
      if (key === 'action.confirm_execute') return '确认执行';
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import '@/features/generative-ui/blocks';

generativeUIRegistry.register({
  type: 'markdown',
  component: MarkdownBlock,
  propsSchema: markdownPropsSchema,
  description: 'Markdown 正文：title + body，复用 Chat MarkdownRenderer',
  allowPartialRender: true,
});

describe('dispatchCanvasAIEditRequest', () => {
  it('returns unclaimed when no editor acknowledges the event', () => {
    const result = dispatchCanvasAIEditRequest({
      requestId: 'req-1',
      noteId: 'note-1',
      operation: 'append',
      content: 'new paragraph',
    });
    expect(result.claimed).toBe(false);
    expect(result.reason).toContain('没有匹配');
  });

  it('returns claimed when editor accepts via onLocalDisposition', () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        onLocalDisposition?: (d: { accepted: boolean }) => void;
      };
      detail.onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', listener);

    const result = dispatchCanvasAIEditRequest({
      requestId: 'req-2',
      noteId: 'note-1',
      operation: 'replace',
      search: 'old',
      replace: 'new',
    });

    window.removeEventListener('canvas:ai-edit-request', listener);
    expect(result.claimed).toBe(true);
  });

  it('createCanvasEditRequestId produces unique ids', () => {
    const a = createCanvasEditRequestId();
    const b = createCanvasEditRequestId();
    expect(a).not.toBe(b);
    expect(a.startsWith('gen-ui-')).toBe(true);
  });

  it('does not dispatch model-controlled regex replacement', () => {
    const listener = vi.fn();
    window.addEventListener('canvas:ai-edit-request', listener);

    const result = dispatchCanvasAIEditRequest({
      requestId: 'req-regex',
      noteId: 'note-1',
      operation: 'replace',
      search: '(a+)+$',
      replace: 'x',
      isRegex: true,
    });

    window.removeEventListener('canvas:ai-edit-request', listener);
    expect(result).toMatchObject({ claimed: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it('never forwards isRegex on a successful dispatch', () => {
    let detail: Record<string, unknown> | undefined;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail as Record<string, unknown>;
      const onLocalDisposition = detail.onLocalDisposition as
        | ((d: { accepted: boolean }) => void)
        | undefined;
      onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', listener);

    const result = dispatchCanvasAIEditRequest({
      requestId: 'req-no-regex-field',
      noteId: 'note-1',
      operation: 'replace',
      search: 'old',
      replace: 'new',
      isRegex: false,
    });

    window.removeEventListener('canvas:ai-edit-request', listener);
    expect(result.claimed).toBe(true);
    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty('isRegex');
  });
});

describe('Generative UI note edit size safety', () => {
  it('rejects a literal replacement whose projected output exceeds the note limit', () => {
    const result = computeProposedContent(
      {
        requestId: 'req-large-output',
        noteId: 'note-1',
        operation: 'replace',
        search: 'a',
        replace: 'x'.repeat(2048),
      },
      'a'.repeat(1024),
    );

    expect(result.error).toContain(String(MAX_AI_EDIT_PROJECTED_OUTPUT_BYTES));
    expect(result.content).toBe('a'.repeat(1024));
  });

  it('keeps legitimate append and literal replace edits working', () => {
    expect(computeProposedContent(
      {
        requestId: 'req-append',
        noteId: 'note-1',
        operation: 'append',
        content: 'Next',
      },
      'Start',
    )).toMatchObject({ content: 'Start\n\nNext' });

    expect(computeProposedContent(
      {
        requestId: 'req-replace',
        noteId: 'note-1',
        operation: 'replace',
        search: 'old',
        replace: 'new',
      },
      'old and old',
    )).toMatchObject({ content: 'new and new', replaceCount: 2 });
  });
});

describe('Notes HITL action handlers', () => {
  it('buildNoteEditSuggestionIntent includes action-bar with apply + dismiss', () => {
    const intent = buildNoteEditSuggestionIntent({
      operation: 'append',
      operationLabel: '追加',
      previewText: '## 小结\n\n今日学习要点…',
      labels: {
        metaTitle: '笔记编辑建议',
        metaDescription: '请在编辑器中确认后落盘',
        operationKey: '操作',
        previewTitle: '预览',
        applyEdit: '应用到笔记',
        dismissSuggestion: '忽略',
      },
    });

    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    expect(actionBar).toBeDefined();
    const actions = (actionBar!.props as { actions: Array<{ id: string }> }).actions;
    expect(actions.map((a) => a.id)).toEqual(['apply-note-edit', 'dismiss-note-suggestion']);
  });

  it('apply-note-edit dispatches canvas:ai-edit-request with payload', async () => {
    const user = userEvent.setup();
    const captured: unknown[] = [];
    const listener = (event: Event) => {
      captured.push((event as CustomEvent).detail);
      const detail = (event as CustomEvent).detail as {
        onLocalDisposition?: (d: { accepted: boolean }) => void;
      };
      detail.onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', listener);

    const onApplyDispatched = vi.fn();
    const handlers = createNotesEditActionHandlers(
      {
        noteId: 'note-abc',
        operation: 'set',
        content: '# 新标题\n\n正文',
      },
      { applyEdit: '应用到笔记', dismissSuggestion: '忽略' },
      { onApplyDispatched },
    );

    const intent = buildNoteEditSuggestionIntent({
      operation: 'set',
      operationLabel: '全文替换',
      previewText: '# 新标题',
      labels: {
        metaTitle: '建议',
        metaDescription: '确认后写入',
        operationKey: '操作',
        previewTitle: '预览',
        applyEdit: '应用到笔记',
        dismissSuggestion: '忽略',
      },
    });

    render(
      <GenerativeUIRenderer intent={intent} showChrome={false} actionHandlers={handlers} />,
    );

    await user.click(screen.getByRole('button', { name: '应用到笔记' }));
    expect(screen.getByText('确认：应用到笔记')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认执行' }));

    window.removeEventListener('canvas:ai-edit-request', listener);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      noteId: 'note-abc',
      operation: 'set',
      content: '# 新标题\n\n正文',
    });
    expect(onApplyDispatched).toHaveBeenCalledWith({ claimed: true });
  });
});
