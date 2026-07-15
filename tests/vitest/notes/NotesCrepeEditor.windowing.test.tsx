import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesCrepeEditor } from '@/features/notes/NotesCrepeEditor';
import type { CrepeEditorApi } from '@/components/crepe';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => ({
      'notes:editor.windowing.loading_more': 'Loading more lines...',
      'notes:editor.windowing.load_more_failed': 'Could not load more lines. Retry loading more lines.',
      'notes:editor.windowing.retry': 'Retry',
    }[key] ?? key),
  }),
}));

let latestViewport: HTMLDivElement | null = null;
let latestApi: CrepeEditorApi | null = null;
let currentMarkdown = 'current markdown';
let latestOnChange: ((markdown: string) => void) | null = null;
let crepeMountCount = 0;

const setMarkdown = vi.fn((markdown: string) => {
  currentMarkdown = markdown;
  latestOnChange?.(markdown);
});
const captureSelection = vi.fn(() => ({ from: 1, to: 1 }));
const restoreSelection = vi.fn();

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
  NotesEditorHeader: () => <div data-testid="header" />,
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
  CustomScrollArea: React.forwardRef<HTMLDivElement, any>(function MockCustomScrollArea(
    { children, viewportRef, viewportProps },
    ref,
  ) {
    const viewportInnerRef = React.useRef<HTMLDivElement>(null);

    React.useImperativeHandle(ref, () => viewportInnerRef.current as HTMLDivElement);

    React.useEffect(() => {
      latestViewport = viewportInnerRef.current;
      if (typeof viewportRef === 'function') {
        viewportRef(viewportInnerRef.current);
      } else if (viewportRef && 'current' in viewportRef) {
        viewportRef.current = viewportInnerRef.current;
      }
      return () => {
        latestViewport = null;
        if (typeof viewportRef === 'function') viewportRef(null);
        else if (viewportRef && 'current' in viewportRef) viewportRef.current = null;
      };
    }, [viewportRef]);

    return (
      <div>
        <div ref={viewportInnerRef} data-testid="viewport" {...viewportProps}>
          {children}
        </div>
      </div>
    );
  }),
}));

vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({ defaultValue, onReady, onChange }: any) => {
    latestOnChange = onChange;
    React.useEffect(() => {
      crepeMountCount += 1;
    }, []);

    React.useEffect(() => {
      currentMarkdown = defaultValue;
      latestApi = {
        getMarkdown: () => currentMarkdown,
        setMarkdown,
        captureSelection,
        restoreSelection,
        focus: vi.fn(),
        isReadonly: () => false,
        setReadonly: vi.fn(),
        scrollToHeading: vi.fn(),
        getCrepe: () => null,
        destroy: vi.fn(async () => undefined),
        insertAtCursor: vi.fn(),
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
      };
      onReady(latestApi);
    }, [defaultValue, onReady]);

    return <div data-testid="crepe-editor" data-default-value={defaultValue} />;
  },
}));

function configureViewportMetrics(viewport: HTMLDivElement, {
  scrollHeight = 2000,
  clientHeight = 500,
  scrollTop = 400,
} = {}) {
  let currentScrollTop = scrollTop;
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
}

describe('NotesCrepeEditor windowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestViewport = null;
    latestApi = null;
    latestOnChange = null;
    crepeMountCount = 0;
    currentMarkdown = 'current markdown';
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('requests more markdown once when the viewport nears the loaded boundary', async () => {
    const onRequestLoadMore = vi.fn(async () => null);
    render(
      <NotesCrepeEditor
        initialContent="current markdown"
        noteId="note-1"
        windowingState={{ enabled: true, loadedLineCount: 100, totalLineCount: 1000, hasMore: true }}
        onRequestLoadMore={onRequestLoadMore}
      />,
    );

    await waitFor(() => expect(latestViewport).not.toBeNull());
    await waitFor(() => expect(latestApi).not.toBeNull());
    configureViewportMetrics(latestViewport!, { scrollTop: 400, clientHeight: 500, scrollHeight: 2000 });

    fireEvent.scroll(latestViewport!);
    fireEvent.scroll(latestViewport!);

    await waitFor(() => expect(onRequestLoadMore).toHaveBeenCalledTimes(1));
    expect(onRequestLoadMore).toHaveBeenCalledWith('current markdown');
  });

  it('applies returned expansion through setMarkdown and restores selection without calling onSave', async () => {
    const onSave = vi.fn(async () => undefined);
    const onRequestLoadMore = vi.fn(async () => ({
      loadedMarkdown: 'current markdown\nnext chunk',
      loadedLineCount: 200,
      totalLineCount: 1000,
      hasMore: true,
    }));

    render(
      <NotesCrepeEditor
        initialContent="current markdown"
        noteId="note-1"
        onSave={onSave}
        windowingState={{ enabled: true, loadedLineCount: 100, totalLineCount: 1000, hasMore: true }}
        onRequestLoadMore={onRequestLoadMore}
      />,
    );

    await waitFor(() => expect(latestViewport).not.toBeNull());
    await waitFor(() => expect(latestApi).not.toBeNull());
    configureViewportMetrics(latestViewport!, { scrollTop: 400, clientHeight: 500, scrollHeight: 2000 });

    fireEvent.scroll(latestViewport!);

    await waitFor(() => expect(setMarkdown).toHaveBeenCalledWith('current markdown\nnext chunk'));
    expect(captureSelection).toHaveBeenCalled();
    expect(restoreSelection).toHaveBeenCalledWith({ from: 1, to: 1 });
    expect(onSave).not.toHaveBeenCalled();
    expect(crepeMountCount).toBe(1);
  });

  it('renders loading, failure, and retry sentinel states', async () => {
    const onRetryLoadMore = vi.fn();
    const { rerender } = render(
      <NotesCrepeEditor
        initialContent="current markdown"
        noteId="note-1"
        windowingState={{ enabled: true, loadedLineCount: 100, totalLineCount: 1000, hasMore: true, isLoadingMore: true }}
      />,
    );

    expect(await screen.findByText('Loading more lines...')).toBeInTheDocument();

    rerender(
      <NotesCrepeEditor
        initialContent="current markdown"
        noteId="note-1"
        windowingState={{
          enabled: true,
          loadedLineCount: 100,
          totalLineCount: 1000,
          hasMore: true,
          loadMoreError: 'failed',
        }}
        onRetryLoadMore={onRetryLoadMore}
      />,
    );

    expect(screen.getByText('Could not load more lines. Retry loading more lines.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryLoadMore).toHaveBeenCalledTimes(1);
  });
});
