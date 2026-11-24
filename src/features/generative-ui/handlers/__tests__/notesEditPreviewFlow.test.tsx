import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionBarBlock } from '../../components/ActionBarBlock';
import { resolveGenerativeUIChatActionHandlers } from '../../bridge/resolveGenerativeUIChatActionHandlers';
import { registerNoteAIEditControl } from '@/features/notes/aiEditControlRegistry';
import { AIDiffPanel } from '@/features/notes/AIDiffPanel';
import type { GenerativeUIIntent } from '../../types';

describe('Notes AI co-write preview flow & target binding (W8B-02)', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens note Diff preview directly on click without generic irreversible confirm modal even when model declares high risk', async () => {
    const unregister = registerNoteAIEditControl('note-42', {
      hasPendingSuggestion: () => false,
      rejectPendingSuggestion: async () => {},
      rollbackLatestCheckpoint: async () => false,
      getNoteTitle: () => 'Linear Algebra Notes',
    });

    const dispatched: Array<Record<string, unknown>> = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      dispatched.push(detail);
      const onLocalDisposition = detail.onLocalDisposition as
        | ((disposition: { accepted: boolean }) => void)
        | undefined;
      onLocalDisposition?.({ accepted: true });
    };
    window.addEventListener('canvas:ai-edit-request', listener);

    try {
      const intent: GenerativeUIIntent = {
        version: '1',
        blocks: [
          {
            type: 'action-bar',
            props: {
              actions: [
                {
                  id: 'apply-note-edit',
                  label: '应用到笔记',
                  variant: 'primary',
                  riskLevel: 'high',
                },
                {
                  id: 'dismiss-note-suggestion',
                  label: '忽略建议',
                  variant: 'default',
                  riskLevel: 'low',
                },
              ],
            },
          },
        ],
      };

      const handlers = resolveGenerativeUIChatActionHandlers({
        canvasNoteId: 'note-42',
        intent,
        toolInput: {
          noteEdit: {
            operation: 'append',
            content: '## Eigenvalues\nAv = λv',
          },
        },
      });

      render(
        <ActionBarBlock
          actions={[
            { id: 'apply-note-edit', label: '应用到笔记', variant: 'primary', riskLevel: 'high' },
            { id: 'dismiss-note-suggestion', label: '忽略建议', variant: 'default', riskLevel: 'low' },
          ]}
          actionHandlers={handlers}
        />,
      );

      // Button label binds the target note title cleanly
      const applyBtn = screen.getByRole('button', { name: /Linear Algebra Notes/ });
      fireEvent.click(applyBtn);

      // Must NOT show the generic irreversible alertdialog before viewing Diff
      expect(screen.queryByRole('alertdialog')).toBeNull();

      await waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      expect(dispatched[0]).toMatchObject({
        noteId: 'note-42',
        operation: 'append',
        content: '## Eigenvalues\nAv = λv',
      });
    } finally {
      window.removeEventListener('canvas:ai-edit-request', listener);
      unregister();
    }
  });

  it('still requires alertdialog confirmation for genuine high-risk actions and surfaces confirmDescription', () => {
    const destructiveHandler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'purge-note', label: 'Purge', variant: 'destructive', riskLevel: 'high' }]}
        actionHandlers={{
          'purge-note': {
            id: 'purge-note',
            label: 'Purge',
            riskLevel: 'high',
            confirmDescription: 'Will permanently delete "Linear Algebra Notes".',
            handler: destructiveHandler,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Purge' }));
    expect(destructiveHandler).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Linear Algebra Notes');
  });

  it('displays target noteTitle in AIDiffPanel header alongside diff stats', () => {
    render(
      <AIDiffPanel
        noteTitle="Calculus Review"
        state={{
          isActive: true,
          request: { requestId: 'req-1', noteId: 'note-1', operation: 'append', content: 'New line' },
          originalContent: 'Old line',
          proposedContent: 'Old line\nNew line',
          diffLines: [
            { type: 'unchanged', content: 'Old line', lineNumber: 1 },
            { type: 'added', content: 'New line', lineNumber: 2 },
          ],
        }}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onSuspend={vi.fn()}
      />,
    );

    expect(screen.getByTestId('ai-diff-target-note')).toHaveTextContent('Calculus Review');
  });
});
