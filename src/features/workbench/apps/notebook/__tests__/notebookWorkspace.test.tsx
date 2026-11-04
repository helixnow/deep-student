import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), createText: vi.fn(), get: vi.fn() }));
const editor = vi.hoisted(() => ({ dirty: false, flush: vi.fn<() => Promise<void>>(), saveText: vi.fn<() => Promise<void>>() }));

vi.mock('@/dstu', async () => ({
  ...(await vi.importActual('@/dstu/inkFormat')),
  dstu: { list: api.list },
  createEmpty: api.createText,
}));
vi.mock('@/features/ink/api', () => ({
  createInk: api.create,
  createInkBoard: api.create,
  inkApi: { get: api.get },
}));
vi.mock('@/features/ink/LazyInkEditorEntry', async () => {
  const { useEffect } = await import('react');
  const { registerInkEditorSession } = await import('@/features/ink/editorSession');
  return {
    LazyInkEditor: ({ documentId }: { documentId: string }) => {
      useEffect(() => registerInkEditorSession({
        key: { document_id: documentId, page_id: 'os-page' },
        isDirty: () => editor.dirty,
        flush: () => editor.flush(),
        persistDraft: async () => undefined,
      }), [documentId]);
      return <div data-testid="ink-editor" data-document-id={documentId}>
        <output data-testid="ink-editor-flush-state">ready</output>
      </div>;
    },
  };
});
vi.mock('@/features/ink/LazyInkBoardEditorEntry', async () => {
  const { useEffect } = await import('react');
  const { registerInkEditorSession } = await import('@/features/ink/editorSession');
  return {
    LazyInkBoardEditor: ({ documentId }: { documentId: string }) => {
      useEffect(() => registerInkEditorSession({
        key: { document_id: documentId, page_id: 'os-board' },
        isDirty: () => editor.dirty,
        flush: () => editor.flush(),
        persistDraft: async () => undefined,
      }), [documentId]);
      return <div data-testid="ink-board-editor" data-document-id={documentId} />;
    },
  };
});
vi.mock('@/features/learning-hub', async () => {
  const { useEffect } = await import('react');
  const { registerContentDirtyChecker, registerContentSaveHandler } = await import('@/services/contentDirtyRegistry');
  return {
    LazyNoteContentView: ({ node, onSaveStateChange }: { node: { id: string }; onSaveStateChange: (state: string) => void }) => {
      useEffect(() => {
        const stopDirty = registerContentDirtyChecker('note', node.id, () => editor.dirty);
        const stopSave = registerContentSaveHandler('note', node.id, () => editor.saveText());
        onSaveStateChange('saved');
        return () => { stopSave(); stopDirty(); };
      }, [node.id, onSaveStateChange]);
      return <div className="ProseMirror" data-testid="text-editor" />;
    },
  };
});
vi.mock('@/features/notes', async () => {
  const { createContext } = await import('react');
  return { NotesChromeSlotContext: createContext(null) };
});
vi.mock('@/components/layout', () => ({
  useMobileHeader: vi.fn(),
  MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('react-i18next', async () => {
  const { default: ink } = await import('@/locales/zh-CN/ink.json');
  const translate = (key: string, values?: Record<string, unknown>) => {
    if (key === 'workbench:apps.notebook') return '手写笔记';
    if (key === 'common:back') return '返回';
    let result: unknown = ink;
    for (const part of key.split('.')) result = (result as Record<string, unknown>)?.[part];
    return String(result ?? values?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({ t: translate, i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' } }),
  };
});

import { notebookAppDefinition } from '../register';
import { workbenchBus } from '../../../core/workbenchBus';
import { resetWindowStoreForTests, useWindowStore } from '../../../core/windowStore';
import { WindowBody } from '../../../components/WindowBody';
import { confirmWindowClose } from '../../../core/windowCloseGuard';
import { canSuspendNotebook } from '../hostLifecycle';
import { __resetContentDirtyRegistry } from '@/services/contentDirtyRegistry';
import { recomputeLifecycles, resetSchedulerTransientsForTests, setFreezeGraceOverride, setMemoryBudgetOverride } from '../../../core/scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function openLibrary() {
  const windowId = workbenchBus.launch({ typeId: notebookAppDefinition.typeId, reason: 'api' });
  expect(windowId).toBeTruthy();
  const view = render(<WindowBody windowId={windowId!} />);
  await screen.findByTestId('notebook-library');
  await waitFor(() => expect(canSuspendNotebook()).toBe(true));
  return { windowId: windowId!, view };
}

async function openWriting(mode: 'paged' | 'board' | 'text') {
  const result = await openLibrary();
  api.get.mockImplementation(async ({ document_id }) => ({
    document_id, schema_version: mode === 'board' ? 2 : 1, title: 'OS 手写笔记',
  }));
  fireEvent.click(screen.getByTestId(`notebook-create-${mode}`));
  await screen.findByTestId(mode === 'text' ? 'text-editor' : mode === 'board' ? 'ink-board-editor' : 'ink-editor');
  return result;
}

async function attemptClose(windowId: string) {
  const approved = await confirmWindowClose(windowId);
  if (approved) act(() => useWindowStore.getState().closeWindow(windowId));
  return approved;
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1600, h: 900 });
  resetSchedulerTransientsForTests();
  __resetContentDirtyRegistry();
  workbenchBus.setEnabled(true);
  editor.dirty = false;
  editor.flush.mockReset().mockImplementation(async () => { editor.dirty = false; });
  editor.saveText.mockReset().mockImplementation(async () => { editor.dirty = false; });
  api.list.mockReset().mockResolvedValue({ ok: true, value: [] });
  api.create.mockReset().mockImplementation(async ({ title }) => ({ document_id: 'file_os_notebook', title }));
  api.createText.mockReset().mockResolvedValue({ ok: true, value: {
    id: 'note_os_text', sourceId: 'note_os_text', path: '/note_os_text', name: '文字笔记', type: 'note', createdAt: 1, updatedAt: 2,
  } });
  api.get.mockReset();
});
afterEach(() => {
  editor.dirty = false;
  cleanup();
  workbenchBus.setEnabled(false);
  setMemoryBudgetOverride(null);
  setFreezeGraceOverride(null);
  document.body.style.overflow = '';
});

describe('workbench notebook library to full-screen writing', () => {
  it.each(['paged', 'board'] as const)('opens the real library in an OS window and creates a full-screen %s note', async (mode) => {
    const { windowId, view } = await openWriting(mode);
    const editorElement = screen.getByTestId(mode === 'board' ? 'ink-board-editor' : 'ink-editor');
    expect(editorElement).toHaveAttribute('data-document-id', 'file_os_notebook');
    expect(api.get).toHaveBeenCalledWith({ document_id: 'file_os_notebook' });
    const fullscreen = screen.getByRole('dialog');
    expect(fullscreen).toHaveAttribute('data-ink-workspace-page', 'file_os_notebook');
    expect(fullscreen.parentElement?.parentElement).toBe(document.body);
    expect(view.container).not.toContainElement(fullscreen);

    act(() => useWindowStore.getState().minimizeWindow(windowId));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    act(() => useWindowStore.getState().focusWindow(windowId));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '返回', exact: true }));
    await screen.findByTestId('notebook-library');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('allows a fully loaded clean library window to close', async () => {
    const { windowId } = await openLibrary();
    await expect(attemptClose(windowId)).resolves.toBe(true);
    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
    expect(screen.queryByTestId('notebook-library')).not.toBeInTheDocument();
    expect(editor.flush).not.toHaveBeenCalled();
  });

  it('rejects close during creation and manifest loading, before any ready editor can flush', async () => {
    const { windowId } = await openLibrary();
    const creation = deferred<{ document_id: string; title: string }>();
    const manifest = deferred<{ document_id: string; schema_version: number; title: string }>();
    api.create.mockReturnValueOnce(creation.promise);
    api.get.mockReturnValueOnce(manifest.promise);
    fireEvent.click(screen.getByTestId('notebook-create-paged'));
    await expect(attemptClose(windowId)).resolves.toBe(false);
    expect(canSuspendNotebook()).toBe(false);
    await act(async () => { creation.resolve({ document_id: 'file_os_notebook', title: '创建中' }); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await expect(attemptClose(windowId)).resolves.toBe(false);
    expect(editor.flush).not.toHaveBeenCalled();
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    await act(async () => { manifest.resolve({ document_id: 'file_os_notebook', schema_version: 1, title: '就绪' }); });
    await screen.findByTestId('ink-editor');
  });

  it.each(['paged', 'board'] as const)('awaits the real %s editor session flush before allowing the window to close', async (mode) => {
    const { windowId } = await openWriting(mode);
    editor.dirty = true;
    const saving = deferred<void>();
    editor.flush.mockImplementationOnce(async () => { await saving.promise; editor.dirty = false; });
    let settled = false;
    const closing = attemptClose(windowId).then((approved) => { settled = true; return approved; });
    await waitFor(() => expect(editor.flush).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    expect(canSuspendNotebook()).toBe(false);
    await act(async () => { saving.resolve(); });
    await expect(closing).resolves.toBe(true);
    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
  });

  it('retains the active editor and OS window after a flush failure, allowing a later retry', async () => {
    const { windowId } = await openWriting('paged');
    editor.dirty = true;
    editor.flush.mockRejectedValueOnce(new Error('disk save failed'));
    await expect(attemptClose(windowId)).resolves.toBe(false);
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    expect(screen.getByTestId('ink-editor')).toBeInTheDocument();
    expect(canSuspendNotebook()).toBe(false);
    await expect(attemptClose(windowId)).resolves.toBe(true);
    expect(editor.flush).toHaveBeenCalledTimes(2);
  });

  it('still flushes a ready writing session whose dirty query is clean, including an uncommitted active stroke', async () => {
    const { windowId } = await openWriting('paged');
    expect(editor.dirty).toBe(false);
    const activeStroke = deferred<void>();
    editor.flush.mockImplementationOnce(() => activeStroke.promise);
    const closing = attemptClose(windowId);
    await waitFor(() => expect(editor.flush).toHaveBeenCalledTimes(1));
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    await act(async () => { activeStroke.resolve(); });
    await expect(closing).resolves.toBe(true);
  });

  it('awaits the real registered text save handler through the real NotebookTextWorkspace', async () => {
    const { windowId } = await openWriting('text');
    await waitFor(() => expect(screen.getByTestId('notebook-text-workspace')).toHaveAttribute('data-notebook-save-state', 'saved'));
    editor.dirty = true;
    const saving = deferred<void>();
    editor.saveText.mockImplementationOnce(async () => { await saving.promise; editor.dirty = false; });
    const closing = attemptClose(windowId);
    await waitFor(() => expect(editor.saveText).toHaveBeenCalledTimes(1));
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
    expect(canSuspendNotebook()).toBe(false);
    await act(async () => { saving.resolve(); });
    await expect(closing).resolves.toBe(true);
    expect(editor.flush).not.toHaveBeenCalled();
  });

  it('keeps a clean writing window mounted under memory pressure instead of freezing it', async () => {
    const { windowId } = await openWriting('board');
    setMemoryBudgetOverride(0);
    setFreezeGraceOverride(0);
    act(() => {
      useWindowStore.getState().minimizeWindow(windowId);
      recomputeLifecycles();
    });
    expect(useWindowStore.getState().lifecycles[windowId]).toBe('background');
    expect(canSuspendNotebook()).toBe(false);
    expect(document.querySelector('[data-wb-frozen-placeholder]')).toBeNull();
  });

  it('can safely flush and close a minimized writing window without first restoring its portal', async () => {
    const { windowId } = await openWriting('paged');
    act(() => useWindowStore.getState().minimizeWindow(windowId));
    await waitFor(() => expect(document.querySelector('[data-ink-workspace-page]')).toBeNull());
    const approved = await attemptClose(windowId);
    const outcome = () => ({
      approved,
      flushCalls: editor.flush.mock.calls.length,
      retained: Boolean(useWindowStore.getState().windows[windowId]),
    });
    expect.soft(outcome()).toEqual({ approved: true, flushCalls: 1, retained: false });
    if (!approved) {
      expect(outcome()).toEqual({ approved: false, flushCalls: 0, retained: true });
      act(() => useWindowStore.getState().focusWindow(windowId));
      await screen.findByTestId('ink-editor');
      await expect(attemptClose(windowId)).resolves.toBe(true);
      expect(editor.flush).toHaveBeenCalledTimes(1);
    }
  });
});
