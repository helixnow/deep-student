import React, { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi, CrepeSelectionAction } from '@/components/crepe';
import { NotesChromeSlotContext, NotesChromeSlotVisibleContext } from '../notesChromeSlot';
import { publishNotesFindQuery } from '../findQueryBridge';

const mocks = vi.hoisted(() => ({
  crepeMarkdown: '# Initial\n\nBody',
  crepeSetMarkdown: vi.fn(),
  crepeFocus: vi.fn(),
  crepeFocusStart: vi.fn(),
  crepeSelectionActions: [] as CrepeSelectionAction[],
  sourceFocus: vi.fn(),
  sourceOpenSearch: vi.fn(),
  headerExitToBody: null as (() => void) | null,
  headerCharCount: undefined as number | undefined,
  selectionToolbarExtraActions: [] as Array<{ key: string; label: string; run: (text: string) => void }>,
  reviewDueDate: null as string | null,
  syncInlineCards: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'notes_state_list') return [];
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));

vi.mock('@/features/notes/NoteFormatGate', () => ({
  NoteFormatGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({ isDragging: false }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(async (path: string) => ({
      ok: true,
      value: {
        id: path.slice(1),
        path,
        type: 'note',
        name: 'Test Note',
        updatedAt: 1000,
        metadata: {
          props: mocks.reviewDueDate ? { study_review_date: mocks.reviewDueDate } : {},
        },
      },
    })),
    setMetadata: vi.fn(async () => ({ ok: true, value: null })),
    watch: () => () => {},
    list: async () => ({ ok: true, value: [] }),
  },
  updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString(),
}));

vi.mock('@/features/notes/inlineCards/inlineCardSyncService', () => ({
  syncInlineCardsForNote: (...args: unknown[]) => mocks.syncInlineCards(...args),
}));

vi.mock('@/features/notes/components/NotesEditorHeader', () => ({
  NotesEditorHeader: ({
    onExitToBody,
    charCount,
  }: {
    onExitToBody?: () => void;
    charCount?: number;
  }) => {
    mocks.headerExitToBody = onExitToBody ?? null;
    mocks.headerCharCount = charCount;
    return (
      <div className="notes-document-header" data-testid="mock-header">
        <span data-testid="header-char-count">{charCount ?? ''}</span>
        <input data-testid="header-title-input" defaultValue="Title" />
      </div>
    );
  },
}));

vi.mock('@/features/notes/components/FindReplacePanel', () => ({
  FindReplacePanel: () => <div data-testid="find-replace-panel" />,
}));

vi.mock('@/features/notes/components/NoteSourceEditor', () => ({
  NoteSourceEditor: React.forwardRef(function MockNoteSourceEditor(
    {
      value,
      onChange,
      onExitSourceMode,
    }: {
      value: string;
      onChange: (next: string) => void;
      onExitSourceMode?: () => void;
    },
    ref: React.Ref<{ focus: () => void; openSearch: () => void }>,
  ) {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => {
        mocks.sourceFocus();
        textareaRef.current?.focus();
      },
      openSearch: () => {
        mocks.sourceOpenSearch();
      },
    }));
    return (
      <div data-testid="mock-source-editor">
        <textarea
          ref={textareaRef}
          data-testid="source-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {onExitSourceMode && (
          <button type="button" data-testid="source-exit-btn" onClick={onExitSourceMode}>
            返回可视化编辑
          </button>
        )}
      </div>
    );
  }),
}));

vi.mock('@/shared/selection', () => ({
  useTextSelection: () => ({
    selectedText: 'selected sample',
    selectionRect: new DOMRect(10, 10, 80, 20),
    isVisible: true,
    clear: vi.fn(),
  }),
  SelectionToolbar: ({
    extraActions,
  }: {
    extraActions?: Array<{ key: string; label: string; run: (text: string) => void }>;
  }) => {
    mocks.selectionToolbarExtraActions = extraActions ?? [];
    return (
      <div data-testid="readonly-selection-toolbar">
        {(extraActions ?? []).map((action) => (
          <button key={action.key} type="button" onClick={() => action.run('selected sample')}>
            {action.label}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: React.forwardRef<
    HTMLDivElement,
    React.PropsWithChildren<{
      className?: string;
      viewportRef?: React.Ref<HTMLDivElement>;
      viewportProps?: React.HTMLAttributes<HTMLDivElement>;
    }>
  >(
    function MockCustomScrollArea({ children, className, viewportRef, viewportProps }, ref) {
      return (
        <div ref={ref} className={className}>
          <div ref={viewportRef} className="scroll-area__viewport" {...viewportProps}>
            {children}
          </div>
        </div>
      );
    },
  ),
}));

vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({
    defaultValue,
    onReady,
    selectionActions,
  }: {
    defaultValue: string;
    onReady: (api: CrepeEditorApi) => void;
    selectionActions?: CrepeSelectionAction[];
  }) => {
    mocks.crepeSelectionActions = selectionActions ?? [];
    React.useEffect(() => {
      mocks.crepeMarkdown = defaultValue;
      const api = {
        getMarkdown: () => mocks.crepeMarkdown,
        setMarkdown: (md: string) => {
          mocks.crepeSetMarkdown(md);
          mocks.crepeMarkdown = md;
          return true;
        },
        focus: mocks.crepeFocus,
        focusStart: mocks.crepeFocusStart,
        isReadonly: () => false,
        setReadonly: vi.fn(),
        scrollToHeading: vi.fn(),
        // Return mock crepe supporting materializeMarkdownView and flushNoteDraft checks
        getCrepe: () => ({
          editor: {
            ctx: { get: () => null },
            action: (fn: (ctx: { get: (key: unknown) => any }) => unknown) => {
              let currentDocText = mocks.crepeMarkdown;
              const mockView = {
                state: {
                  doc: {
                    content: {
                      findDiffStart: () => 0,
                      findDiffEnd: () => ({ a: currentDocText.length, b: 0 }),
                    },
                  },
                  tr: {
                    replace: (_start: number, _end: number, slice: { text: string }) => {
                      currentDocText = slice.text;
                      mocks.crepeMarkdown = slice.text;
                      return { setMeta: () => ({}) };
                    },
                  },
                },
                dispatch: () => {},
              };
              const ctx = {
                get: (key: { key?: string; id?: string }) => {
                  const keyName = String(key?.key ?? key?.id ?? key ?? '');
                  if (keyName.includes('parser')) {
                    return (md: string) => ({ content: md, slice: () => ({ text: md }) });
                  }
                  if (keyName.includes('serializer')) {
                    return () => currentDocText;
                  }
                  return mockView;
                },
              };
              return fn(ctx);
            },
          },
        } as any),
        destroy: vi.fn(async () => undefined),
        insertAtCursor: vi.fn(),
        agentInsert: vi.fn(() => null),
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

    return (
      <div className="crepe-editor-wrapper" data-testid="mock-crepe-editor">
        <div className="ProseMirror" tabIndex={0} data-testid="mock-prosemirror">
          <p>Body paragraph text</p>
        </div>
      </div>
    );
  },
}));

import { NotesCrepeEditor } from '../NotesCrepeEditor';

class IntersectionObserverStub implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const desktopMatchMedia = (query: string): MediaQueryList => ({
  matches: /min-width|prefers-reduced-motion/.test(query),
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(() => true),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.crepeMarkdown = '# Initial\n\nBody';
  mocks.crepeSelectionActions = [];
  mocks.selectionToolbarExtraActions = [];
  mocks.headerExitToBody = null;
  mocks.headerCharCount = undefined;
  mocks.reviewDueDate = null;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
  vi.mocked(window.matchMedia).mockImplementation(desktopMatchMedia);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{ width: 1024, height: 768 }] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1024, 768));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotesCrepeEditor P0/P1/P2 state machine & interaction fixes', () => {
  it('hides Crepe with Tailwind hidden class in source mode, preserves sourceDraft authority on save/flush, and routes search/exit-to-body to CodeMirror', async () => {
    const onSave = vi.fn(async () => undefined);
    let readyApi: CrepeEditorApi | null = null;
    const contentChangedEvents: string[] = [];
    const onContentChanged = (e: Event) => {
      contentChangedEvents.push((e as CustomEvent<{ content: string }>).detail.content);
    };
    window.addEventListener('notes:content-changed', onContentChanged);

    try {
      const { container } = render(
        <NotesCrepeEditor
          noteId="note-src"
          initialContent="# Initial"
          onSave={onSave}
          onEditorReady={(api) => {
            readyApi = api;
          }}
        />,
      );

      const proseMirror = await screen.findByTestId('mock-prosemirror');
      const crepeWrapper = screen.getByTestId('mock-crepe-editor').parentElement!;
      expect(crepeWrapper.className).toContain('flex');
      expect(crepeWrapper.className).not.toContain('hidden');

      // Enter source mode via Cmd/Ctrl+Shift+M
      act(() => proseMirror.focus());
      fireEvent.keyDown(proseMirror, { key: 'm', ctrlKey: true, shiftKey: true });

      const sourceTextarea = await screen.findByTestId('source-textarea');
      expect(sourceTextarea).toHaveValue('# Initial');
      expect(crepeWrapper).toHaveAttribute('hidden');
      expect(crepeWrapper.className).toContain('hidden');
      expect(crepeWrapper.className.split(/\s+/)).not.toContain('flex');
      expect(mocks.sourceFocus).toHaveBeenCalled();

      // Title onExitToBody focuses source editor while in source mode
      mocks.sourceFocus.mockClear();
      act(() => mocks.headerExitToBody?.());
      expect(mocks.sourceFocus).toHaveBeenCalledTimes(1);
      expect(mocks.crepeFocusStart).not.toHaveBeenCalled();

      // Edit in source mode while hidden Crepe still holds stale '# Initial'
      fireEvent.change(sourceTextarea, { target: { value: '# Updated In Source Mode' } });
      expect(screen.getByTestId('header-char-count')).toHaveTextContent(
        String('# Updated In Source Mode'.replace(/\s/g, '').length),
      );

      // flushPendingSave must save authoritative sourceDraft, NOT stale Crepe '# Initial'
      await act(async () => {
        await readyApi!.flushPendingSave!();
      });
      expect(onSave).toHaveBeenLastCalledWith('# Updated In Source Mode');

      // Cmd/Ctrl+F and NOTES_FIND_QUERY_EVENT in source mode open CodeMirror search, not FindReplacePanel
      act(() => sourceTextarea.focus());
      fireEvent.keyDown(sourceTextarea, { key: 'f', ctrlKey: true });
      expect(mocks.sourceOpenSearch).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('find-replace-panel')).toBeNull();

      act(() => {
        publishNotesFindQuery({ noteId: 'note-src', query: 'Updated' });
      });
      expect(mocks.sourceOpenSearch).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('find-replace-panel')).toBeNull();

      // External update syncs cleanly into sourceDraft
      act(() => {
        window.dispatchEvent(
          new CustomEvent('notes:external-updated', {
            detail: { noteId: 'note-src', content: '# External Synced', force: true },
          }),
        );
      });
      expect(sourceTextarea).toHaveValue('# External Synced');

      // Exit source mode via inline bar button
      fireEvent.click(screen.getByTestId('source-exit-btn'));
      await waitFor(() => expect(screen.queryByTestId('mock-source-editor')).toBeNull());
      expect(crepeWrapper.className).toContain('flex');
      expect(mocks.crepeFocus).toHaveBeenCalled();
    } finally {
      window.removeEventListener('notes:content-changed', onContentChanged);
    }
  });

  it('materializes a windowed document before entering source mode so large notes are never truncated', async () => {
    let windowed = true;
    const materializeSpy = vi.fn();
    const extendEditorApi = (api: CrepeEditorApi) => ({
      ...api,
      isDocumentWindowed: () => windowed,
      getFullMarkdown: () => '# Prefix Only\n\n## Full Tail Content',
      acceptFullDocumentView: (md: string) => {
        materializeSpy(md);
        windowed = false;
        api.setMarkdown(md);
      },
    });
    render(
      <NotesCrepeEditor
        noteId="note-win"
        initialContent="# Prefix Only"
        windowingState={{ enabled: true, loadedLineCount: 1, totalLineCount: 100, hasMore: true }}
        extendEditorApi={extendEditorApi}
      />,
    );

    const proseMirror = await screen.findByTestId('mock-prosemirror');
    act(() => proseMirror.focus());
    fireEvent.keyDown(proseMirror, { key: 'm', ctrlKey: true, shiftKey: true });

    const sourceTextarea = await screen.findByTestId('source-textarea');
    expect(materializeSpy).toHaveBeenCalledWith('# Prefix Only\n\n## Full Tail Content');
    expect(sourceTextarea).toHaveValue('# Prefix Only\n\n## Full Tail Content');
  });

  it('wires review-due into the banner arbitrator, avoids collapsing a single extra banner, and suppresses non-critical banners in focus mode', async () => {
    mocks.reviewDueDate = '2020-01-01';
    render(<NotesCrepeEditor noteId="note-rev" initialContent="# Review" onSave={async () => undefined} />);

    // Due review banner renders when no higher-priority banner exists
    expect(await screen.findByTestId('notes-review-checkin-bar')).toBeInTheDocument();

    // Add 1 higher-priority banner (agent-write): hiddenCount is 0 because agent-write is primary and review-due is queued (hiddenCount=1)
    // With shouldCollapseQueue = hiddenCount >= 2, both render directly without a "还有 1 条通知" toggle!
    act(() => {
      window.dispatchEvent(
        new CustomEvent('notes:agent-applied', {
          detail: { noteId: 'note-rev', before: '# Review', after: '# Review AI' },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('AI 刚修改了这篇笔记')).toBeInTheDocument();
      expect(screen.getByTestId('notes-review-checkin-bar')).toBeInTheDocument();
    });
    expect(screen.queryByText(/还有 .* 条通知/)).toBeNull();

    // Enter focus mode: non-critical banners (review-due, agent-write) are suppressed cleanly
    const proseMirror = screen.getByTestId('mock-prosemirror');
    act(() => proseMirror.focus());
    fireEvent.keyDown(proseMirror, { key: 'u', ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId('notes-review-checkin-bar')).toBeNull();
    expect(screen.queryByText('AI 刚修改了这篇笔记')).toBeNull();
  });

  it('always registers highlight & cloze selectionActions with active callbacks even in readOnly mode, and exposes Ask AI in read-only SelectionToolbar', async () => {
    render(<NotesCrepeEditor noteId="note-ro" initialContent="# ReadOnly" readOnly />);
    await screen.findByTestId('mock-prosemirror');

    const keys = mocks.crepeSelectionActions.map((a) => a.key);
    expect(keys).toContain('highlight');
    expect(keys).toContain('cloze');
    const highlightAction = mocks.crepeSelectionActions.find((a) => a.key === 'highlight') as CrepeSelectionAction & {
      active?: () => boolean;
    };
    const clozeAction = mocks.crepeSelectionActions.find((a) => a.key === 'cloze') as CrepeSelectionAction & {
      active?: () => boolean;
    };
    expect(typeof highlightAction.active).toBe('function');
    expect(typeof clozeAction.active).toBe('function');

    // Read-only SelectionToolbar includes Ask AI
    expect(mocks.selectionToolbarExtraActions.map((a) => a.key)).toContain('ask-ai');
  });

  it('counts only selections strictly inside .ProseMirror and clears on focusout outside shell or visibility hidden', async () => {
    const { container } = render(<NotesCrepeEditor noteId="note-sel" initialContent="# Sel" />);
    const proseMirror = await screen.findByTestId('mock-prosemirror');
    const textNode = proseMirror.querySelector('p')!.firstChild!;
    const headerNode = screen.getByTestId('mock-header');

    // Selection inside .ProseMirror updates counter
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.getByTestId('notes-selection-counter')).toHaveTextContent('已选 4 字');

    // Selection spanning into header is rejected (cleared)
    const crossRange = document.createRange();
    crossRange.setStart(headerNode, 0);
    crossRange.setEnd(textNode, 4);
    sel.removeAllRanges();
    sel.addRange(crossRange);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByTestId('notes-selection-counter')).toBeNull();

    // Restore valid selection inside .ProseMirror, then blur outside shell
    sel.removeAllRanges();
    sel.addRange(range);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.getByTestId('notes-selection-counter')).toBeInTheDocument();

    const shell = container.querySelector('.notes-crepe-shell')!;
    fireEvent.focusOut(shell, { relatedTarget: document.body });
    expect(screen.queryByTestId('notes-selection-counter')).toBeNull();
  });

  it('does not fall back to rendering inline .notes-editor-chrome-row when entering focus mode with a portaled chrome slot', async () => {
    const slotEl = document.createElement('div');
    document.body.appendChild(slotEl);
    try {
      const { container } = render(
        <NotesChromeSlotContext.Provider value={slotEl}>
          <NotesCrepeEditor noteId="note-portal" initialContent="# Portal" />
        </NotesChromeSlotContext.Provider>,
      );

      const proseMirror = await screen.findByTestId('mock-prosemirror');
      expect(container.querySelector('.notes-editor-chrome-row')).toBeNull();
      expect(slotEl.childElementCount).toBeGreaterThan(0);

      // Enter focus mode: inline chrome row must STILL not appear (prevents 36px jump)
      act(() => proseMirror.focus());
      fireEvent.keyDown(proseMirror, { key: 'u', ctrlKey: true, shiftKey: true });
      expect(container.querySelector('.notes-editor-chrome-row')).toBeNull();
      expect(slotEl.childElementCount).toBe(0);
    } finally {
      slotEl.remove();
    }
  });

  it('keeps chrome portaled when window blurs (isActive=false) while tab remains visible via NotesChromeSlotVisibleContext', async () => {
    const slotEl = document.createElement('div');
    document.body.appendChild(slotEl);
    try {
      const { container } = render(
        <NotesChromeSlotContext.Provider value={slotEl}>
          <NotesChromeSlotVisibleContext.Provider value={true}>
            <NotesCrepeEditor noteId="note-portal-blur" initialContent="# Blur" isActive={false} />
          </NotesChromeSlotVisibleContext.Provider>
        </NotesChromeSlotContext.Provider>,
      );

      await screen.findByTestId('mock-prosemirror');
      expect(container.querySelector('.notes-editor-chrome-row')).toBeNull();
      expect(slotEl.childElementCount).toBeGreaterThan(0);
    } finally {
      slotEl.remove();
    }
  });

  it('intercepts pdfref citation clicks preserving page/highlightId and restores note scrollTop on focus return', async () => {
    const openDetails: Array<Record<string, unknown>> = [];
    const focusDetails: Array<Record<string, unknown>> = [];
    const onOpen = (e: Event) => openDetails.push((e as CustomEvent).detail);
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      focusDetails.push(detail);
      detail.acknowledge?.(true);
    };
    document.addEventListener('pdf-ref:open', onOpen);
    document.addEventListener('pdf-ref:focus', onFocus);

    try {
      const { container, rerender } = render(
        <NotesCrepeEditor
          noteId="note-pdf-scroll"
          initialContent="# Citations"
          acrWindowId="win_notes_split"
          isActive
        />,
      );

      const proseMirror = await screen.findByTestId('mock-prosemirror');
      const viewport = container.querySelector<HTMLElement>('.notes-editor-content-scroll .scroll-area__viewport')
        ?? container.querySelector<HTMLElement>('.notes-editor-content-scroll');
      expect(viewport).toBeTruthy();

      // Simulate user scrolling deep into the note before clicking a PDF highlight citation
      Object.defineProperty(viewport!, 'scrollTop', { configurable: true, writable: true, value: 640 });
      fireEvent.scroll(viewport!);

      const link = document.createElement('a');
      link.setAttribute('href', 'pdfref://tb_linalg?page=18&highlight=hl_42&quote=Eigenvalues');
      link.textContent = '第 18 页';
      proseMirror.appendChild(link);

      fireEvent.click(link);

      expect(openDetails).toHaveLength(1);
      expect(openDetails[0]).toMatchObject({
        sourceId: 'tb_linalg',
        pageNumber: 18,
        highlightId: 'hl_42',
        annotationId: 'hl_42',
        quote: 'Eigenvalues',
        sourceWindowId: 'win_notes_split',
      });
      expect(focusDetails[0]).toMatchObject({
        sourceId: 'tb_linalg',
        pageNumber: 18,
        highlightId: 'hl_42',
      });

      // Focus shifts to PDF window (Notes becomes inactive), then browser/focus resets scrollTop to 0
      rerender(
        <NotesCrepeEditor
          noteId="note-pdf-scroll"
          initialContent="# Citations"
          acrWindowId="win_notes_split"
          isActive={false}
        />,
      );
      viewport!.scrollTop = 0;

      // Returning focus to Notes restores exact saved scrollTop (640)
      rerender(
        <NotesCrepeEditor
          noteId="note-pdf-scroll"
          initialContent="# Citations"
          acrWindowId="win_notes_split"
          isActive
        />,
      );

      await waitFor(() => {
        expect(viewport!.scrollTop).toBe(640);
      });
    } finally {
      document.removeEventListener('pdf-ref:open', onOpen);
      document.removeEventListener('pdf-ref:focus', onFocus);
    }
  });
});
