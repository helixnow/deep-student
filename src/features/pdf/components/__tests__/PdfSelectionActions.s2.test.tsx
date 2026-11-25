import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  saveAsNoteStart: vi.fn(),
  appendSelectionToActiveNote: vi.fn(),
  createQuickLocalCard: vi.fn(),
  sendSelectionToChatInput: vi.fn(),
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    dnd: { emitAutoExcerpt: vi.fn(), startExcerptDrag: (_e: unknown, input: unknown) => input },
  }),
}));

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: 'workbench' }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

const selectionState = {
  selectedText: 'Self-Attention: relates different positions of a single sequence',
  selectionRect: { top: 200, left: 100, width: 160, height: 20, bottom: 220 },
  isVisible: true,
  contextBefore: 'before',
  contextAfter: 'after',
  clear: vi.fn(),
};

vi.mock('@/shared/selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selection')>();
  return { ...actual, useTextSelection: () => selectionState };
});

vi.mock('@/shared/notes', async (importOriginal) => ({
  truncateNoteTitle: (await importOriginal<typeof import('@/shared/notes')>()).truncateNoteTitle,
  useSaveAsNoteFlow: () => ({
    start: mocks.saveAsNoteStart,
    isSaving: false,
    pickerProps: { open: false, onOpenChange: () => {}, onConfirm: () => {}, title: '选择保存目录', inline: false },
  }),
  SaveAsNoteFolderPicker: () => null,
}));

vi.mock('../../selectionStudyActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../selectionStudyActions')>();
  return {
    ...actual,
    appendSelectionToActiveNote: mocks.appendSelectionToActiveNote,
    createQuickLocalCard: mocks.createQuickLocalCard,
    sendSelectionToChatInput: mocks.sendSelectionToChatInput,
  };
});

import { PdfSelectionActions } from '../PdfSelectionActions';

function renderHost() {
  const Host: React.FC = () => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);
    return (
      <div ref={containerRef} style={{ position: 'relative' }}>
        <div data-page-number="5" className="textLayer">
          <span data-testid="page-text">{selectionState.selectedText}</span>
        </div>
        {mounted && (
          <PdfSelectionActions
            containerRef={containerRef}
            enabled
            isMobileLike={false}
            documentTitle="Attention.pdf"
            selectionSourceId="file_arxiv_1"
          />
        )}
      </div>
    );
  };
  return render(<Host />);
}

function selectPageText() {
  const range = document.createRange();
  range.selectNodeContents(screen.getByTestId('page-text'));
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe('Gap S2 UI: PdfSelectionActions 2-step Note Append & Quick Local Card', () => {
  it('appends to active note in 1 click and shows View + Undo feedback controls', async () => {
    const openNote = vi.fn();
    const undo = vi.fn(async () => ({ ok: true as const }));
    mocks.appendSelectionToActiveNote.mockResolvedValue({
      ok: true,
      noteId: 'note_9',
      title: 'Paper Summary',
      appendedMarkdown: '> excerpt',
      openNote,
      undo,
    });

    renderHost();
    selectPageText();

    const appendBtn = screen.getByRole('button', { name: '追加到当前笔记', hidden: true });
    fireEvent.click(appendBtn);

    const feedback = await screen.findByTestId('pdf-append-note-feedback');
    expect(feedback.textContent).toContain('Paper Summary');

    fireEvent.click(screen.getByTestId('pdf-append-note-undo'));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
  });

  it('falls back to SaveAsNoteFolderPicker when no note is open', async () => {
    mocks.appendSelectionToActiveNote.mockResolvedValue({
      ok: false,
      reason: 'no_active_note',
    });

    renderHost();
    selectPageText();

    fireEvent.click(screen.getByRole('button', { name: '追加到当前笔记', hidden: true }));

    await waitFor(() => expect(mocks.saveAsNoteStart).toHaveBeenCalledTimes(1));
    expect(mocks.saveAsNoteStart.mock.calls[0][0].content).toContain('pdfref://file_arxiv_1?page=5');
  });

  it('opens inline Quick Card (Local) popover with Basic/Cloze toggle and saves in 1 click', async () => {
    mocks.createQuickLocalCard.mockResolvedValue({
      ok: true,
      cardId: 'card_local_99',
      deckName: '划词制卡::Attention',
      pdfRefHref: 'pdfref://file_arxiv_1?page=5',
    });

    renderHost();
    selectPageText();

    fireEvent.click(screen.getByRole('button', { name: '快速闪卡', hidden: true }));

    const popover = await screen.findByTestId('pdf-quick-card-popover');
    expect(popover).toBeTruthy();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect((screen.getByTestId('pdf-quick-card-front') as HTMLTextAreaElement).value).toBe('Self-Attention');
    expect(screen.getByTestId('pdf-quick-card-origin').textContent).toContain('P.5');

    // Switch to Cloze mode and submit immediately (pre-filled valid cloze)
    fireEvent.click(screen.getByTestId('pdf-quick-card-mode-cloze'));
    const clozeInput = screen.getByTestId('pdf-quick-card-cloze') as HTMLTextAreaElement;
    expect(clozeInput.value).toContain('{{c1::');

    fireEvent.click(screen.getByTestId('pdf-quick-card-submit'));
    await waitFor(() => expect(mocks.createQuickLocalCard).toHaveBeenCalledTimes(1));
    expect(mocks.createQuickLocalCard).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'cloze',
        sourceId: 'file_arxiv_1',
        page: 5,
      }),
      expect.any(Function),
    );
    await waitFor(() => expect(screen.queryByTestId('pdf-quick-card-popover')).toBeNull());
  });
});
