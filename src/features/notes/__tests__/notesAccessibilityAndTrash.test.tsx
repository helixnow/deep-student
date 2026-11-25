import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import zhNotes from '@/locales/zh-CN/notes.json';
import enNotes from '@/locales/en-US/notes.json';
import type { DstuNode } from '@/dstu';

const mocks = vi.hoisted(() => ({
  dstuDelete: vi.fn(),
  trashRestoreItem: vi.fn(),
  finderUndoPush: vi.fn(),
  closeWorkspaceResource: vi.fn(),
  showGlobalNotification: vi.fn(),
  dstuUpdateProps: vi.fn(),
  dstuRename: vi.fn(),
  dstuGet: vi.fn(),
  dstuList: vi.fn(),
  dstuWatch: vi.fn(() => () => {}),
  tauriInvoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'notes_get_format') {
      return {
        note_id: String(args?.noteId ?? ''),
        content_format: 'markdown-legacy',
        format_version: 1,
        serializer_version: 'markdown-v1',
        required_capabilities: [],
        updated_at: '2026-01-01T00:00:00Z',
      };
    }
    if (cmd === 'notes_state_list') {
      return [];
    }
    return null;
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: [string, Record<string, unknown>?]) => mocks.tauriInvoke(...args),
}));

vi.mock('@/dstu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dstu')>();
  return {
    ...actual,
    dstu: {
      ...actual.dstu,
      delete: (...args: unknown[]) => mocks.dstuDelete(...args),
      updateProps: (...args: unknown[]) => mocks.dstuUpdateProps(...args),
      rename: (...args: unknown[]) => mocks.dstuRename(...args),
      get: (...args: unknown[]) => mocks.dstuGet(...args),
      list: (...args: unknown[]) => mocks.dstuList(...args),
      watch: (...args: unknown[]) => mocks.dstuWatch(...args),
    },
    trashApi: {
      ...actual.trashApi,
      restoreItem: (...args: unknown[]) => mocks.trashRestoreItem(...args),
    },
  };
});

vi.mock('@/features/learning-hub', () => ({
  finderUndoStack: {
    push: (...args: unknown[]) => mocks.finderUndoPush(...args),
  },
}));

vi.mock('@/features/workbench', () => ({
  closeWorkspaceResource: (...args: unknown[]) => mocks.closeWorkspaceResource(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mocks.showGlobalNotification(...args),
}));

vi.mock('@/components/crepe/features/imageUpload', () => ({
  createImageBlockConfig: () => ({}),
  createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(),
  validateImageFile: vi.fn(),
}));
vi.mock('@/components/crepe/features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({
  emitOutlineDebugLog: vi.fn(),
  emitOutlineDebugSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import i18n from '@/i18n';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu';
import { moveNoteToTrash } from '../moveNoteToTrash';
import { NotesPageActionsMenu, type NotesPageActionsMenuProps } from '../components/NotesPageActionsMenu';
import { NoteLearningViews } from '../components/NoteLearningViews';
import { NotesEditorHeader } from '../components/NotesEditorHeader';
import { NoteSourceEditor, type NoteSourceEditorHandle } from '../components/NoteSourceEditor';
import { NotesCrepeEditor } from '../NotesCrepeEditor';

function makePageMenuProps(overrides: Partial<NotesPageActionsMenuProps> = {}): NotesPageActionsMenuProps {
  return {
    noteId: 'note-1',
    noteTitle: 'Sample Note',
    readOnly: false,
    effectiveReadOnly: false,
    editorReady: true,
    hasMobileResourceMenu: false,
    isTouchEditingSurface: false,
    templateMenuOpen: false,
    templatePanelId: 'tpl-panel',
    onToggleTemplateMenu: vi.fn(),
    generatingCards: false,
    onGenerateCards: vi.fn(),
    generatingMindmap: false,
    onGenerateMindmap: vi.fn(),
    syncingHandout: false,
    onSyncHandoutToMindmap: vi.fn(),
    onOpenHistory: vi.fn(),
    isFindReplaceOpen: false,
    onToggleFindReplace: vi.fn(),
    focusMode: false,
    onToggleFocusMode: vi.fn(),
    hostBusy: false,
    onMaterializeFullDocument: vi.fn(),
    ...overrides,
  };
}

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(360);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dstuDelete.mockResolvedValue({ ok: true, value: undefined });
  mocks.trashRestoreItem.mockResolvedValue({ ok: true, value: undefined });
  mocks.closeWorkspaceResource.mockResolvedValue(true);
  mocks.dstuUpdateProps.mockResolvedValue({ ok: true, value: undefined });
  mocks.dstuRename.mockResolvedValue({ ok: true, value: undefined });
  mocks.dstuGet.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', toUserMessage: () => 'Not found' } });
  mocks.dstuList.mockResolvedValue({ ok: true, value: [] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Notes locale parity for Stage 5 fixes', () => {
  it('defines matching zh-CN and en-US keys for trash, manage group, and editor body aria label', () => {
    expect(zhNotes.chrome.manage).toBeTruthy();
    expect(enNotes.chrome.manage).toBeTruthy();
    expect(zhNotes.editor.body_aria_label).toBe('笔记正文');
    expect(enNotes.editor.body_aria_label).toBe('Note body');
    expect(zhNotes.actions.move_to_trash).toBe('移至回收站');
    expect(enNotes.actions.move_to_trash).toBe('Move to Trash');
    expect(zhNotes.actions.move_to_trash_item).toBeTruthy();
    expect(enNotes.actions.move_to_trash_item).toBeTruthy();
    expect(zhNotes.actions.moved_to_trash).toBeTruthy();
    expect(enNotes.actions.moved_to_trash).toBeTruthy();
    expect(zhNotes.actions.restored_from_trash).toBeTruthy();
    expect(enNotes.actions.restored_from_trash).toBeTruthy();
    expect(zhNotes.actions.undo).toBeTruthy();
    expect(enNotes.actions.undo).toBeTruthy();
  });
});

describe('NotesPageActionsMenu Move to Trash', () => {
  it('renders Move to Trash in the Manage group and invokes onMoveToTrash callback', () => {
    const onMoveToTrash = vi.fn();
    render(<NotesPageActionsMenu {...makePageMenuProps({ onMoveToTrash })} />);

    expect(screen.getByText(i18n.t('notes:chrome.manage', '管理'))).toBeInTheDocument();
    const trashBtn = screen.getByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') });
    expect(trashBtn).toBeEnabled();

    fireEvent.click(trashBtn);
    expect(onMoveToTrash).toHaveBeenCalledTimes(1);
  });

  it('keeps Move to Trash enabled on newly created notes even when effectiveReadOnly is true, disables on missing noteId or hostBusy, and hides when readOnly', () => {
    const { rerender } = render(<NotesPageActionsMenu {...makePageMenuProps({ noteId: undefined })} />);
    expect(screen.getByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') })).toBeDisabled();

    // Newly created notes in reading mode or awaiting format/lease refresh (effectiveReadOnly=true, readOnly=false) MUST still allow Move to Trash
    rerender(<NotesPageActionsMenu {...makePageMenuProps({ noteId: 'note_new_1', noteTitle: '未命名', effectiveReadOnly: true, editorReady: false })} />);
    expect(screen.getByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') })).toBeEnabled();

    rerender(<NotesPageActionsMenu {...makePageMenuProps({ hostBusy: true })} />);
    expect(screen.getByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') })).toBeDisabled();

    rerender(<NotesPageActionsMenu {...makePageMenuProps({ readOnly: true, effectiveReadOnly: true })} />);
    expect(screen.queryByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') })).not.toBeInTheDocument();
  });

  it('soft-deletes, closes tab, pushes undo entry, and wires Undo restore when no custom callback is passed', async () => {
    render(<NotesPageActionsMenu {...makePageMenuProps({ noteId: 'note-9', noteTitle: 'Calc' })} />);

    fireEvent.click(screen.getByRole('button', { name: i18n.t('notes:actions.move_to_trash', '移至回收站') }));

    await waitFor(() => {
      expect(mocks.dstuDelete).toHaveBeenCalledWith('/note-9');
      expect(mocks.closeWorkspaceResource).toHaveBeenCalledWith({ type: 'note', id: 'note-9' });
    });

    expect(mocks.finderUndoPush).toHaveBeenCalledWith({
      kind: 'soft-delete',
      targets: [{ id: 'note-9', type: 'note', name: 'Calc' }],
    });
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith(
      'success',
      `${zhNotes.actions.moved_to_trash} · Calc`,
      undefined,
      expect.objectContaining({
        action: expect.objectContaining({ label: zhNotes.actions.undo }),
      }),
    );

    const toastOpts = mocks.showGlobalNotification.mock.calls[0][3] as { action: { onClick: () => Promise<void> } };
    await toastOpts.action.onClick();
    expect(mocks.trashRestoreItem).toHaveBeenCalledWith('note-9', 'note');
    expect(mocks.showGlobalNotification).toHaveBeenLastCalledWith(
      'success',
      `${zhNotes.actions.restored_from_trash} · Calc`,
    );
  });
});

describe('NoteLearningViews inline Move to Trash and Delete key', () => {
  const sampleNote = {
    id: 'n1',
    sourceId: 'n1',
    path: '/n1',
    name: 'Linear Algebra',
    type: 'note',
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  } as unknown as DstuNode;

  it('invokes onMoveToTrash from inline trash button without calling onOpen', async () => {
    const onOpen = vi.fn();
    const onMoveToTrash = vi.fn();

    render(<NoteLearningViews notes={[sampleNote]} view="list" onOpen={onOpen} onMoveToTrash={onMoveToTrash} />);

    const trashBtn = screen.getByRole('button', { name: zhNotes.actions.move_to_trash });
    fireEvent.click(trashBtn);

    await waitFor(() => expect(onMoveToTrash).toHaveBeenCalledWith(sampleNote));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('invokes onMoveToTrash on Delete key press and ignores IME composing Delete', async () => {
    const onMoveToTrash = vi.fn();
    render(<NoteLearningViews notes={[sampleNote]} view="list" onOpen={vi.fn()} onMoveToTrash={onMoveToTrash} />);

    const rowBtn = screen.getByRole('button', { name: /Linear Algebra/ });
    rowBtn.focus();

    fireEvent.keyDown(rowBtn, { key: 'Delete', isComposing: true });
    expect(onMoveToTrash).not.toHaveBeenCalled();

    fireEvent.keyDown(rowBtn, { key: 'Delete' });
    await waitFor(() => expect(onMoveToTrash).toHaveBeenCalledWith(sampleNote));
  });

  it('invokes onMoveToTrash on Backspace and Cmd+Backspace, while ignoring Ctrl/Alt+Backspace and IME composing', async () => {
    const onMoveToTrash = vi.fn();
    render(<NoteLearningViews notes={[sampleNote]} view="list" onOpen={vi.fn()} onMoveToTrash={onMoveToTrash} />);

    const rowBtn = screen.getByRole('button', { name: /Linear Algebra/ });
    rowBtn.focus();

    fireEvent.keyDown(rowBtn, { key: 'Backspace', isComposing: true });
    fireEvent.keyDown(rowBtn, { key: 'Backspace', ctrlKey: true });
    fireEvent.keyDown(rowBtn, { key: 'Backspace', altKey: true });
    expect(onMoveToTrash).not.toHaveBeenCalled();

    fireEvent.keyDown(rowBtn, { key: 'Backspace' });
    await waitFor(() => expect(onMoveToTrash).toHaveBeenCalledTimes(1));
    expect(onMoveToTrash).toHaveBeenLastCalledWith(sampleNote);

    fireEvent.keyDown(rowBtn, { key: 'Backspace', metaKey: true });
    await waitFor(() => expect(onMoveToTrash).toHaveBeenCalledTimes(2));
    expect(onMoveToTrash).toHaveBeenLastCalledWith(sampleNote);
  });

  it('awaits Undo restore, refreshes notes list via DSTU folder event + onRestored, and includes truncated noteTitle (U07)', async () => {
    const longTitle = 'Linear Algebra Chapter 04 Eigenvalues and Eigenvectors Deep Dive';
    const longNote = { ...sampleNote, id: 'n-undo', name: longTitle } as unknown as DstuNode;
    const onRestored = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    try {
      render(<NoteLearningViews notes={[longNote]} view="list" onOpen={vi.fn()} onRestored={onRestored} />);

      fireEvent.click(screen.getByRole('button', { name: zhNotes.actions.move_to_trash }));

      await waitFor(() => {
        expect(mocks.dstuDelete).toHaveBeenCalledWith('/n-undo');
        expect(mocks.showGlobalNotification).toHaveBeenCalledTimes(1);
      });

      const movedMsg = mocks.showGlobalNotification.mock.calls[0][1] as string;
      expect(movedMsg).toContain(zhNotes.actions.moved_to_trash);
      expect(movedMsg).toContain('…');
      expect(movedMsg.length).toBeLessThan(zhNotes.actions.moved_to_trash.length + longTitle.length);

      const toastOpts = mocks.showGlobalNotification.mock.calls[0][3] as {
        action: { label: string; onClick: () => Promise<void> };
      };
      expect(toastOpts.action.label).toBe(zhNotes.actions.undo);

      await toastOpts.action.onClick();

      expect(mocks.trashRestoreItem).toHaveBeenCalledTimes(1);
      expect(mocks.trashRestoreItem).toHaveBeenCalledWith('n-undo', 'note');
      expect(onRestored).toHaveBeenCalledTimes(1);
      expect(onRestored).toHaveBeenCalledWith(longNote);
      const folderEvents = dispatchSpy.mock.calls
        .map(([ev]) => ev)
        .filter((ev): ev is CustomEvent => ev instanceof CustomEvent && ev.type === DSTU_FOLDER_CHANGE_EVENT);
      expect(folderEvents).toHaveLength(1);
      expect(folderEvents[0].detail).toEqual({
        kind: 'item-added',
        itemId: 'n-undo',
        itemType: 'note',
      });
      expect(mocks.showGlobalNotification).toHaveBeenLastCalledWith(
        'success',
        expect.stringContaining(zhNotes.actions.restored_from_trash),
      );
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('surfaces restore errors in moveNoteToTrash without triggering false refresh callbacks (U07)', async () => {
    const afterRestore = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    mocks.trashRestoreItem.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IO_ERROR', toUserMessage: () => '恢复失败：数据库只读' },
    });

    try {
      const ok = await moveNoteToTrash({
        noteId: 'n-fail',
        noteTitle: 'Fail Note',
        afterRestore,
      });
      expect(ok).toBe(true);

      const toastOpts = mocks.showGlobalNotification.mock.calls[0][3] as {
        action: { onClick: () => Promise<void> };
      };
      await toastOpts.action.onClick();

      expect(mocks.trashRestoreItem).toHaveBeenCalledWith('n-fail', 'note');
      expect(afterRestore).not.toHaveBeenCalled();
      const folderEvents = dispatchSpy.mock.calls
        .map(([ev]) => ev)
        .filter((ev): ev is CustomEvent => ev instanceof CustomEvent && ev.type === DSTU_FOLDER_CHANGE_EVENT);
      expect(folderEvents).toHaveLength(0);
      expect(mocks.showGlobalNotification).toHaveBeenLastCalledWith('error', '恢复失败：数据库只读');
    } finally {
      dispatchSpy.mockRestore();
    }
  });
});

describe('NotesEditorHeader debounced live title sync and keyboard exit', () => {
  it('propagates title change before blur (~120ms debounce), keeps cursor intact, and skips redundant blur commit', async () => {
    vi.useFakeTimers();
    const onTitleChange = vi.fn(async () => {});

    render(
      <NotesEditorHeader
        noteId="note-title-live"
        initialTitle="Old Title"
        lastSaved={null}
        onTitleChange={onTitleChange}
      />,
    );

    const title = screen.getByRole('textbox', { name: zhNotes.header.documentTitle }) as HTMLTextAreaElement;
    title.focus();
    fireEvent.change(title, { target: { value: 'Live Tab Title', selectionStart: 4, selectionEnd: 4 } });
    title.setSelectionRange(4, 4);

    // Must not fire synchronously on keystroke or during Escape tests
    expect(onTitleChange).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(onTitleChange).toHaveBeenCalledTimes(1);
    expect(onTitleChange).toHaveBeenCalledWith('Live Tab Title');
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(4);

    // Blur after live commit should not trigger a duplicate save for the same value
    fireEvent.blur(title);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onTitleChange).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping rapid title edits cleanly and moves focus on Enter / Tab', async () => {
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const calls: string[] = [];
    const onTitleChange = vi.fn((next: string) => {
      calls.push(next);
      return calls.length === 1 ? firstGate : Promise.resolve();
    });
    const onExitToBody = vi.fn();

    vi.useFakeTimers();
    render(
      <NotesEditorHeader
        noteId="note-title-nav"
        initialTitle="Start"
        lastSaved={null}
        onTitleChange={onTitleChange}
        onExitToBody={onExitToBody}
      />,
    );

    const title = screen.getByRole('textbox', { name: zhNotes.header.documentTitle });
    fireEvent.change(title, { target: { value: 'Step 1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(calls).toEqual(['Step 1']);

    // Edit again before Step 1 settles; Step 2 waits sequentially behind Step 1
    fireEvent.change(title, { target: { value: 'Step 2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(calls).toEqual(['Step 1']);

    resolveFirst();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(calls).toEqual(['Step 1', 'Step 2']);

    // Tab without Shift calls onExitToBody; Shift+Tab does not
    fireEvent.keyDown(title, { key: 'Tab', shiftKey: true });
    expect(onExitToBody).not.toHaveBeenCalled();

    fireEvent.keyDown(title, { key: 'Tab' });
    expect(onExitToBody).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(title, { key: 'Enter' });
    expect(onExitToBody).toHaveBeenCalledTimes(2);
  });
});

describe('NoteSourceEditor accessibility & focus', () => {
  it('exposes role="textbox", aria-multiline="true", aria-label, and tabindex="0" on .cm-content and focuses on body click', () => {
    const sourceRef = React.createRef<NoteSourceEditorHandle>();
    const { container, rerender } = render(
      <NoteSourceEditor
        ref={sourceRef}
        value="# Heading"
        onChange={vi.fn()}
        onExitSourceMode={vi.fn()}
      />,
    );

    const textbox = screen.getByRole('textbox', { name: zhNotes.sourceMode.aria_label });
    expect(textbox).toHaveClass('cm-content');
    expect(textbox).toHaveAttribute('aria-multiline', 'true');
    expect(textbox).toHaveAttribute('tabindex', '0');
    expect(textbox).not.toHaveAttribute('aria-readonly');

    const bodyWrapper = container.querySelector('.notes-source-editor-body') as HTMLElement;
    expect(bodyWrapper).not.toBeNull();
    fireEvent.mouseDown(bodyWrapper, { button: 0 });
    expect(textbox.contains(document.activeElement) || document.activeElement === textbox).toBe(true);

    rerender(
      <NoteSourceEditor
        ref={sourceRef}
        value="# Heading"
        readOnly
        onChange={vi.fn()}
        onExitSourceMode={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: zhNotes.sourceMode.aria_label })).toHaveAttribute('aria-readonly', 'true');
  });
});

describe('NotesCrepeEditor keyboard navigation, source mode focus, and Move to Trash integration', () => {
  it('focuses .ProseMirror from Title Enter/Tab and container click, keeps focus in Source Mode .cm-content, and wires Move to Trash', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const onTitleChange = vi.fn().mockResolvedValue(undefined);

    const { container, unmount } = render(
      <NotesCrepeEditor
        noteId="note-trash"
        initialTitle="Integration Title"
        initialContent="Initial paragraph"
        onSave={onSave}
        onTitleChange={onTitleChange}
        autoSave={false}
      />,
    );

    // Wait for CrepeEditor .ProseMirror body textbox to mount
    const bodyTextbox = await waitFor(
      () => screen.getByRole('textbox', { name: zhNotes.editor.body_aria_label }),
      { timeout: 5000 },
    );
    const titleTextbox = screen.getByRole('textbox', { name: zhNotes.header.documentTitle });

    // Tab from Title focuses .ProseMirror body
    titleTextbox.focus();
    fireEvent.keyDown(titleTextbox, { key: 'Tab' });
    await waitFor(() => {
      expect(document.activeElement).toBe(bodyTextbox);
    });

    // Enter from Title focuses .ProseMirror body
    titleTextbox.focus();
    fireEvent.keyDown(titleTextbox, { key: 'Enter' });
    await waitFor(() => {
      expect(document.activeElement).toBe(bodyTextbox);
    });

    // Clicking below .ProseMirror focuses Crepe
    titleTextbox.focus();
    vi.spyOn(bodyTextbox, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));
    const editorContentContainer = container.querySelector('.notes-editor-content') as HTMLElement;
    fireEvent.mouseDown(editorContentContainer, { button: 0, clientY: 200 });
    await waitFor(() => {
      expect(document.activeElement).toBe(bodyTextbox);
    });

    // Open More note actions menu and switch to Markdown Source Mode
    const pageActionsBtn = screen.getByRole('button', { name: /更多笔记操作|More note actions/ });
    fireEvent.click(pageActionsBtn);

    const sourceModeBtn = await screen.findByRole('button', { name: new RegExp(zhNotes.sourceMode.toggle) });
    fireEvent.click(sourceModeBtn);

    const sourceTextbox = await waitFor(
      () => screen.getByRole('textbox', { name: zhNotes.sourceMode.aria_label }),
      { timeout: 5000 },
    );
    expect(sourceTextbox).toHaveAttribute('aria-multiline', 'true');
    await waitFor(() => {
      expect(sourceTextbox.contains(document.activeElement) || document.activeElement === sourceTextbox).toBe(true);
    });

    // Tab in Title while in Source Mode focuses Source Mode .cm-content
    titleTextbox.focus();
    fireEvent.keyDown(titleTextbox, { key: 'Tab' });
    await waitFor(() => {
      expect(sourceTextbox.contains(document.activeElement) || document.activeElement === sourceTextbox).toBe(true);
    });

    // Open More note actions menu and click Move to Trash (unmount must not flush draft to deleted note)
    fireEvent.click(pageActionsBtn);
    const moveToTrashBtn = await screen.findByRole('button', { name: zhNotes.actions.move_to_trash });
    fireEvent.click(moveToTrashBtn);

    await waitFor(() => {
      expect(mocks.dstuDelete).toHaveBeenCalledWith('/note-trash');
      expect(mocks.closeWorkspaceResource).toHaveBeenCalledWith({ type: 'note', id: 'note-trash' });
    });
    unmount();
    expect(onSave).not.toHaveBeenCalled();
  }, 15000);

  it('enables Move to Trash immediately on a newly created empty note even when lease registration triggers hostRefreshError or another tab is inactive', async () => {
    // Simulate lease registration failing on a brand-new note so hostRefreshError -> effectiveReadOnly=true
    mocks.tauriInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'notes_get_format') {
        return {
          note_id: String(args?.noteId ?? ''),
          content_format: 'markdown-legacy',
          format_version: 1,
          serializer_version: 'markdown-v1',
          required_capabilities: [],
          updated_at: '2026-01-01T00:00:00Z',
        };
      }
      if (cmd === 'notes_editor_register') {
        throw new Error('transient lease registration race');
      }
      if (cmd === 'notes_state_list') {
        return [];
      }
      return null;
    });

    render(
      <NotesCrepeEditor
        noteId="note_brand_new"
        initialTitle="未命名"
        initialContent=""
        onSave={vi.fn()}
        onTitleChange={vi.fn()}
        isActive
      />,
    );

    const pageActionsBtn = await screen.findByRole('button', { name: /更多笔记操作|More note actions/ });
    fireEvent.click(pageActionsBtn);

    const moveToTrashBtn = await screen.findByRole('button', { name: zhNotes.actions.move_to_trash });
    expect(moveToTrashBtn).toBeEnabled();

    fireEvent.click(moveToTrashBtn);
    await waitFor(() => {
      expect(mocks.dstuDelete).toHaveBeenCalledWith('/note_brand_new');
      expect(mocks.closeWorkspaceResource).toHaveBeenCalledWith({ type: 'note', id: 'note_brand_new' });
    });
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith(
      'success',
      `${zhNotes.actions.moved_to_trash} · 未命名`,
      undefined,
      expect.objectContaining({
        action: expect.objectContaining({ label: zhNotes.actions.undo }),
      }),
    );
  }, 15000);
});
