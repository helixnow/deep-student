import React, { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesCrepeEditor } from '@/features/notes/NotesCrepeEditor';
import type { CrepeEditorApi } from '@/components/crepe';

let latestOnChange: ((markdown: string) => void) | null = null;
let latestOnRetrySave: (() => Promise<void>) | undefined;

vi.mock('@/features/notes/NotesContext', () => ({
  useNotesOptional: () => undefined,
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({ isDragging: false }),
}));

vi.mock('@/features/notes/hooks/useCanvasAIEditHandler', () => ({
  useCanvasAIEditHandler: () => ({
    aiEditState: { isActive: false },
    handleAccept: vi.fn(),
    handleReject: vi.fn(),
    isLocked: false,
    checkpoint: null,
    rollbackCheckpoint: vi.fn(),
    dismissCheckpoint: vi.fn(),
  }),
}));

vi.mock('@/features/notes/components/NotesEditorHeader', () => ({
  NotesEditorHeader: ({ onRetrySave }: { onRetrySave?: () => Promise<void> }) => {
    latestOnRetrySave = onRetrySave;
    return <div data-testid="header" />;
  },
}));

vi.mock('@/features/notes/components/NotesEditorToolbar', () => ({
  NotesEditorToolbar: () => <div data-testid="toolbar" />,
}));

vi.mock('@/features/notes/components/FindReplacePanel', () => ({
  FindReplacePanel: () => <div data-testid="find-replace" />,
}));

vi.mock('@/features/notes/AIDiffPanel', () => ({
  AIDiffPanel: () => <div data-testid="ai-diff" />,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: React.forwardRef<HTMLDivElement, React.PropsWithChildren>(
    function MockCustomScrollArea({ children }, ref) {
      return <div ref={ref}>{children}</div>;
    },
  ),
}));

vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({ defaultValue, onChange, onReady }: any) => {
    latestOnChange = onChange;
    React.useEffect(() => {
      const api = {
        getMarkdown: () => defaultValue,
        setMarkdown: vi.fn(),
        focus: vi.fn(),
        isReadonly: () => false,
        setReadonly: vi.fn(),
        scrollToHeading: vi.fn(),
        getCrepe: () => null,
        destroy: vi.fn(async () => undefined),
        insertAtCursor: vi.fn(),
        agentInsert: vi.fn((_: string, pos: number) => pos),
        agentSignal: vi.fn(),
        getDocEndPos: vi.fn(() => 0),
        resolveHeadingPos: vi.fn(() => null),
        wrapSelection: vi.fn(),
        toggleLinePrefix: vi.fn(),
        insertNewLineWithPrefix: vi.fn(),
        toggleBold: vi.fn(),
        toggleItalic: vi.fn(),
        toggleStrikethrough: vi.fn(),
        toggleInlineCode: vi.fn(),
        setHeading: vi.fn(),
        toggleBulletList: vi.fn(),
        toggleOrderedList: vi.fn(),
        toggleTaskList: vi.fn(),
        toggleBlockquote: vi.fn(),
        insertHr: vi.fn(),
        insertCodeBlock: vi.fn(),
        insertLink: vi.fn(),
        insertImage: vi.fn(),
        insertTable: vi.fn(),
      } satisfies CrepeEditorApi;
      onReady(api);
    }, [defaultValue, onReady]);

    return <div data-testid="crepe-editor" />;
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('NotesCrepeEditor save queue', () => {
  beforeEach(() => {
    latestOnChange = null;
    latestOnRetrySave = undefined;
    vi.clearAllMocks();
  });

  it('drains the latest draft after unmount while an older save is in flight', async () => {
    const v1 = deferred();
    const v2 = deferred();
    const onSave = vi.fn((content: string) => content === 'V1' ? v1.promise : v2.promise);
    const { unmount } = render(
      <NotesCrepeEditor initialContent="V0" noteId="note-1" onSave={onSave} />,
    );

    await waitFor(() => expect(latestOnChange).not.toBeNull());

    act(() => {
      latestOnChange?.('V1');
      window.dispatchEvent(new CustomEvent('notes:request-save', {
        detail: { noteId: 'note-1', content: 'V1' },
      }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenLastCalledWith('V1');

    act(() => latestOnChange?.('V2'));
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      v1.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith('V2');

    await act(async () => {
      v2.resolve();
      await Promise.resolve();
    });
  });

  it('persists a draft reverted to the last snapshot after an in-flight change', async () => {
    const v1 = deferred();
    const revertedV0 = deferred();
    const onSave = vi.fn((content: string) => content === 'V1' ? v1.promise : revertedV0.promise);
    const { unmount } = render(
      <NotesCrepeEditor initialContent="V0" noteId="note-1" onSave={onSave} />,
    );

    await waitFor(() => expect(latestOnChange).not.toBeNull());

    act(() => {
      latestOnChange?.('V1');
      window.dispatchEvent(new CustomEvent('notes:request-save', {
        detail: { noteId: 'note-1', content: 'V1' },
      }));
    });
    expect(onSave).toHaveBeenLastCalledWith('V1');

    act(() => latestOnChange?.('V0'));
    unmount();

    await act(async () => {
      v1.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith('V0');

    await act(async () => {
      revertedV0.resolve();
      await Promise.resolve();
    });
  });

  it('resolves the shared drain when an old payload fails but the latest succeeds', async () => {
    const v1 = deferred();
    const v2 = deferred();
    const onSave = vi.fn((content: string) => content === 'V1' ? v1.promise : v2.promise);
    render(<NotesCrepeEditor initialContent="V0" noteId="note-1" onSave={onSave} />);

    await waitFor(() => expect(latestOnRetrySave).toBeTypeOf('function'));
    act(() => latestOnChange?.('V1'));
    const drain = latestOnRetrySave!();
    expect(onSave).toHaveBeenLastCalledWith('V1');

    act(() => latestOnChange?.('V2'));
    const latestDrain = latestOnRetrySave!();

    const oldError = Object.assign(new Error('old payload rejected'), { isNonRetryable: true });
    await act(async () => {
      v1.reject(oldError);
      await Promise.resolve();
    });
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('V2'));

    await act(async () => {
      v2.resolve();
      await Promise.all([drain, latestDrain]);
    });
    await expect(drain).resolves.toBeUndefined();
    await expect(latestDrain).resolves.toBeUndefined();
  });

  it('handles a fire-and-forget reading-mode save failure', async () => {
    const saveError = Object.assign(new Error('cannot save'), { isNonRetryable: true });
    const onSave = vi.fn(async () => {
      throw saveError;
    });
    const { unmount } = render(
      <NotesCrepeEditor initialContent="V0" noteId="note-1" onSave={onSave} />,
    );

    await waitFor(() => expect(latestOnChange).not.toBeNull());
    act(() => latestOnChange?.('V1'));
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('V1'));
    unmount();
  });
});
