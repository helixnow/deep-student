import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK_PRIORITY, handleAndroidBack, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { registerInkEditorSession } from '../editorSession';
import { flushInkWorkspace, hasInkWorkspace } from '@/services/inkWorkspaceRegistry';
import { confirmTabClose, isTabDirty, requestCloseTabs } from '@/features/learning-hub/closeTabGate';
import { createTab } from '@/features/learning-hub/types/tabs';
import { FILE_PREVIEW_APP_DEFINITION } from '@/features/workbench/apps/preview/register';
import { createContentApp } from '@/features/workbench/apps/content/createContentApp';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { DsButton } from '@/components/ui/DsButton';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/shad/Dialog';
import { useEventRegistry } from '@/hooks/useEventRegistry';

const { get, boardMounted, pagedMounted } = vi.hoisted(() => ({
  get: vi.fn(),
  boardMounted: vi.fn(),
  pagedMounted: vi.fn(),
}));

vi.mock('../api', () => ({ inkApi: { get } }));
vi.mock('../LazyInkEditorEntry', () => ({
  LazyInkEditor: ({ documentId }: { documentId: string }) => {
    React.useEffect(() => { pagedMounted(documentId); }, [documentId]);
    return <div data-testid="paged-editor" data-document-id={documentId}>
      <Popover>
        <PopoverTrigger asChild><DsButton>工具设置</DsButton></PopoverTrigger>
        <PopoverContent aria-label="笔迹设置"><DsButton>工具选项</DsButton></PopoverContent>
      </Popover>
      <Dialog>
        <DialogTrigger asChild><DsButton>导出设置</DsButton></DialogTrigger>
        <DialogContent aria-label="导出笔记"><DsButton>确认导出</DsButton></DialogContent>
      </Dialog>
    </div>;
  },
}));
vi.mock('../LazyInkBoardEditorEntry', () => ({
  LazyInkBoardEditor: ({ documentId }: { documentId: string }) => {
    React.useEffect(() => { boardMounted(documentId); }, [documentId]);
    return <div data-testid="board-editor" data-document-id={documentId} />;
  },
}));

import { InkWorkspace } from '../InkWorkspace';

function TestEscapeListener({ onEscape }: { onEscape: (event: KeyboardEvent) => void }) {
  useEventRegistry([{ target: 'document', type: 'keydown', listener: onEscape }], [onEscape]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const unregisters: Array<() => void> = [];
function editorSession(documentId: string, flush = vi.fn(async () => undefined)) {
  const persistDraft = vi.fn(async () => undefined);
  const isDirty = vi.fn(() => true);
  unregisters.push(registerInkEditorSession({
    key: { document_id: documentId, page_id: 'page-1' },
    isDirty,
    flush: async () => {
      await flush();
      isDirty.mockReturnValue(false);
    },
    persistDraft,
  }));
  return { flush, persistDraft, isDirty };
}

describe('InkWorkspace fullscreen host', () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(async ({ document_id }) => ({ schema_version: 1, document_id, title: '笔记' }));
    boardMounted.mockClear();
    pagedMounted.mockClear();
  });

  afterEach(() => {
    unregisters.splice(0).forEach((unregister) => unregister());
    document.body.style.overflow = '';
    document.body.style.pointerEvents = '';
  });

  it('opens a full-viewport body portal and selects schema-v2 without mounting the paged editor', async () => {
    get.mockResolvedValue({ schema_version: 2, document_id: 'board-1', title: '自由画布' });
    const view = render(<InkWorkspace documentId="board-1" title="我的画布" />);

    const page = await screen.findByRole('dialog', { name: '我的画布' });
    expect(page).toHaveClass('ink-workspace-page');
    expect(page.parentElement?.parentElement).toBe(document.body);
    expect(view.container).not.toContainElement(page);
    expect(await screen.findByTestId('board-editor')).toHaveAttribute('data-document-id', 'board-1');
    expect(pagedMounted).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('shows a manifest error and retries the real schema probe instead of falling back to v1', async () => {
    get.mockRejectedValueOnce(new Error('manifest unavailable'));
    get.mockResolvedValueOnce({ schema_version: 2, document_id: 'board-1', title: '自由画布' });
    render(<InkWorkspace documentId="board-1" />);

    expect(await screen.findByText('manifest unavailable')).toBeInTheDocument();
    expect(boardMounted).not.toHaveBeenCalled();
    expect(pagedMounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('board-editor')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
    expect(pagedMounted).not.toHaveBeenCalled();
  });

  it.each([
    { schema_version: 3, document_id: 'note-1', error: /不支持此手写笔记版本/ },
    { schema_version: 2, document_id: 'wrong-note', error: /当前文件不一致/ },
  ])('rejects unsupported or mismatched manifests: $schema_version / $document_id', async ({ error, ...manifest }) => {
    get.mockResolvedValue(manifest);
    render(<InkWorkspace documentId="note-1" />);

    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(pagedMounted).not.toHaveBeenCalled();
    expect(boardMounted).not.toHaveBeenCalled();
  });

  it('strictly awaits the registered editor flush before invoking onClose', async () => {
    const pending = deferred<void>();
    const session = editorSession('note-1', vi.fn(() => pending.promise));
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" title="课堂笔记" onClose={onClose} />);
    await screen.findByTestId('paged-editor');

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: '课堂笔记' })).toBeInTheDocument();
    await act(async () => { pending.resolve(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('retains the editor and draft on flush failure, then retries without remounting it', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const session = editorSession('note-1', flush);
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" title="课堂笔记" onClose={onClose} />);
    const editor = await screen.findByTestId('paged-editor');

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
    expect(onClose).not.toHaveBeenCalled();
    expect(session.persistDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it.each(['android', 'escape'] as const)('keeps %s back inside the editor after failure and awaits the next save before closing', async (source) => {
    const pending = deferred<void>();
    const flush = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => pending.promise);
    editorSession('note-1', flush);
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    const editor = await screen.findByTestId('paged-editor');
    const back = () => {
      if (source === 'android') expect(handleAndroidBack()).toBe(true);
      else fireEvent.keyDown(window, { key: 'Escape' });
    };
    await act(async () => { back(); });
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
    expect(onClose).not.toHaveBeenCalled();
    act(back);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    act(back);
    expect(flush).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks a nominally successful flush that leaves dirty edits behind', async () => {
    const flush = vi.fn(async () => undefined);
    unregisters.push(registerInkEditorSession({
      key: { document_id: 'note-1', page_id: 'page-1' },
      isDirty: () => true, flush, persistDraft: async () => undefined,
    }));
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    const editor = await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
    expect(onClose).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it.each(['hub', 'preview', 'file'] as const)('routes %s host close through the real workspace and retains the editor on failure', async (host) => {
    const pending = deferred<void>();
    const flush = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => pending.promise);
    editorSession('note-1', flush);
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    const editor = await screen.findByTestId('paged-editor');
    const tab = createTab({ type: 'file', resourceId: 'note-1', dstuPath: '/note-1', title: 'Ink' });
    const fileApp = createContentApp({ typeId: 'file', nameKey: 'file', icon: null, memoryWeight: 1, defaultFrame: { w: 800, h: 600 } });
    const closeHost = () => host === 'hub' ? confirmTabClose(tab)
      : Promise.resolve((host === 'preview' ? FILE_PREVIEW_APP_DEFINITION : fileApp).canClose!('/folder/note-1'));
    expect(isTabDirty(tab)).toBe(true);
    expect(hasInkWorkspace('note-1')).toBe(true);
    expect(FILE_PREVIEW_APP_DEFINITION.canSuspend!('note-1')).toBe(false);
    let rejected!: boolean;
    await act(async () => { rejected = await closeHost(); });
    expect(rejected).toBe(false);
    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
    let closing!: ReturnType<typeof closeHost>;
    act(() => { closing = closeHost(); });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled();
    await act(async () => { pending.resolve(); });
    await expect(closing).resolves.toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
  });

  it('retains a failed Ink tab while allowing an unrelated clean tab in a batch close', async () => {
    editorSession('note-1', vi.fn(async () => { throw new Error('offline'); }));
    render(<InkWorkspace documentId="note-1" />);
    await screen.findByTestId('paged-editor');
    const ink = createTab({ type: 'file', resourceId: 'note-1', dstuPath: '/note-1', title: 'Ink' });
    const pdf = createTab({ type: 'file', resourceId: 'file_pdf', dstuPath: '/file_pdf', title: 'PDF' });
    let result!: Awaited<ReturnType<typeof requestCloseTabs>>;
    await act(async () => { result = await requestCloseTabs([ink, pdf]); });
    expect(result).toEqual({ approved: [pdf.tabId], cancelled: true });
    expect(screen.getByTestId('paged-editor')).toBeInTheDocument();
  });

  it('provides an explicit fullscreen reopen entry after returning without an onClose host', async () => {
    render(<InkWorkspace documentId="note-1" title="课堂笔记" />);
    await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    const reopen = await screen.findByRole('button', { name: '重新打开全屏书写' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(reopen);
    expect(await screen.findByRole('dialog', { name: '课堂笔记' })).toBeInTheDocument();
    expect(await screen.findByTestId('paged-editor')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never opens a portal or probes editors for an inactive tab and does not consume back', async () => {
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId="note-1" isActive={false} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(handleAndroidBack()).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    view.rerender(<InkWorkspace documentId="note-1" isActive onClose={onClose} />);
    const editor = await screen.findByTestId('paged-editor');
    view.rerender(<InkWorkspace documentId="note-1" isActive={false} onClose={onClose} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(editor).not.toBeInTheDocument();
    expect(handleAndroidBack()).toBe(false);
    view.rerender(<InkWorkspace documentId="note-1" isActive onClose={onClose} />);
    expect(await screen.findByTestId('paged-editor')).toBe(editor);
    expect(pagedMounted).toHaveBeenCalledTimes(1);
  });

  it('does not escape a CSS-hidden keep-alive ancestor even when isActive is omitted', async () => {
    const view = render(<div style={{ display: 'none' }}><InkWorkspace documentId="note-1" /></div>);
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(handleAndroidBack()).toBe(false);
    view.rerender(<div style={{ display: 'block' }}><InkWorkspace documentId="note-1" /></div>);
    await screen.findByTestId('paged-editor');
    view.rerender(<div style={{ visibility: 'hidden' }}><InkWorkspace documentId="note-1" /></div>);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(handleAndroidBack()).toBe(false);
  });

  it('presents only the foreground workspace when multiple canvas instances are mounted', async () => {
    render(<>
      <InkWorkspace documentId="note-1" title="前一页" />
      <InkWorkspace documentId="note-2" title="当前页" />
    </>);
    expect(await screen.findByRole('dialog', { name: '当前页' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '前一页' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByRole('dialog', { name: '前一页' })).toBeInTheDocument();
  });

  it('can explicitly foreground an already-open workspace without remounting its draft editor', async () => {
    render(<InkWorkspace documentId="note-1" title="前一页" />);
    const firstEditor = await screen.findByTestId('paged-editor');
    render(<InkWorkspace documentId="note-2" title="当前页" />);
    await screen.findByRole('dialog', { name: '当前页' });
    fireEvent.click(screen.getByRole('button', { name: '重新打开全屏书写' }));
    expect(await screen.findByRole('dialog', { name: '前一页' })).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(firstEditor);
    expect(get.mock.calls.filter(([request]) => request.document_id === 'note-1')).toHaveLength(1);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await screen.findByRole('dialog', { name: '当前页' });
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
  });

  it('dismisses the real tool popover before leaving on Escape', async () => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" title="课堂笔记" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '工具设置' }));
    const settings = await screen.findByRole('dialog', { name: '笔迹设置' });
    expect(screen.getByRole('dialog', { name: '课堂笔记' })).toContainElement(settings);
    fireEvent.keyDown(settings, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '笔迹设置' })).not.toBeInTheDocument());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('dismisses detached tool overlays when becoming inactive and leaves the editor mounted', async () => {
    const view = render(<InkWorkspace documentId="note-1" title="课堂笔记" />);
    const editor = await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '工具设置' }));
    await screen.findByRole('dialog', { name: '笔迹设置' });
    view.rerender(<InkWorkspace documentId="note-1" title="课堂笔记" isActive={false} />);
    await waitFor(() => expect(handleAndroidBack()).toBe(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<InkWorkspace documentId="note-1" title="课堂笔记" isActive />);
    expect(await screen.findByTestId('paged-editor')).toBe(editor);
    expect(screen.queryByRole('dialog', { name: '笔迹设置' })).not.toBeInTheDocument();
  });

  it('closes an owned body-portal export dialog when its keep-alive host becomes inactive', async () => {
    const view = render(<InkWorkspace documentId="note-1" title="课堂笔记" />);
    await screen.findByTestId('paged-editor');
    const trigger = screen.getByRole('button', { name: '导出设置' });
    trigger.focus();
    fireEvent.click(trigger);
    const exportDialog = await screen.findByRole('dialog', { name: '导出笔记' });
    expect(screen.getByRole('dialog', { name: '课堂笔记' })).not.toContainElement(exportDialog);
    view.rerender(<InkWorkspace documentId="note-1" title="课堂笔记" isActive={false} />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument());
    expect(handleAndroidBack()).toBe(false);
  });

  it('does not leave on the Escape that closes a body-portal export dialog', async () => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" title="课堂笔记" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '导出设置' }));
    const exportDialog = await screen.findByRole('dialog', { name: '导出笔记' });
    fireEvent.keyDown(exportDialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导出笔记' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '课堂笔记' }), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('lets a tool overlay handle Escape and Android back before leaving the page', async () => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" title="课堂笔记" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('data-state', 'open');
    overlay.style.zIndex = '3000';
    document.body.appendChild(overlay);
    const closeOverlay = vi.fn(() => { overlay.remove(); return true; });
    const unregister = registerBackHandler(closeOverlay, BACK_PRIORITY.overlay);
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
      expect(handleAndroidBack()).toBe(true);
      expect(closeOverlay).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      unregister();
      overlay.remove();
    }
    await act(async () => { expect(handleAndroidBack()).toBe(true); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes Android back before an older underlying mobile panel handler', async () => {
    const underlyingPanel = vi.fn(() => true);
    const unregister = registerBackHandler(underlyingPanel, BACK_PRIORITY.overlay);
    const onClose = vi.fn();
    try {
      render(<InkWorkspace documentId="note-1" onClose={onClose} />);
      await screen.findByTestId('paged-editor');
      await act(async () => { expect(handleAndroidBack()).toBe(true); });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(underlyingPanel).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('yields Android back to a Radix tool sheet without dismissing the workspace itself', async () => {
    const onClose = vi.fn();
    render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('data-state', 'open');
    overlay.style.zIndex = '4000';
    document.body.appendChild(overlay);
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      overlay.remove();
    };
    const listener = render(<TestEscapeListener onEscape={closeOverlay} />);
    try {
      expect(handleAndroidBack()).toBe(true);
      expect(overlay).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      listener.unmount();
      overlay.remove();
    }
  });

  it('does not hide the workspace when a Radix tool sheet temporarily aria-hides the host', async () => {
    const view = render(<InkWorkspace documentId="note-1" />);
    await screen.findByTestId('paged-editor');
    await act(async () => {
      view.container.setAttribute('aria-hidden', 'true');
      view.container.setAttribute('data-aria-hidden', 'true');
      document.body.style.pointerEvents = 'none';
    });
    expect(document.querySelector('[data-ink-workspace-portal]')).toBeInTheDocument();
  });

  it('keeps the old document mounted during a blocked file switch and retries before loading the new manifest', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    editorSession('note-1', flush);
    const view = render(<InkWorkspace documentId="note-1" title="原笔记" />);
    const editor = await screen.findByTestId('paged-editor');
    view.rerender(<InkWorkspace documentId="note-2" title="新笔记" />);

    expect(await screen.findByText(/保存未完成/)).toBeInTheDocument();
    expect(screen.getByTestId('paged-editor')).toBe(editor);
    expect(screen.getByRole('dialog', { name: '原笔记' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith({ document_id: 'note-2' });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('paged-editor')).toHaveAttribute('data-document-id', 'note-2'));
    expect(screen.getByRole('dialog', { name: '新笔记' })).toBeInTheDocument();
  });

  it('does not run a stale close callback after switching files while flush is pending', async () => {
    const pending = deferred<void>();
    editorSession('note-1', vi.fn(() => pending.promise));
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    view.rerender(<InkWorkspace documentId="note-2" onClose={onClose} />);
    await act(async () => { pending.resolve(); });
    await waitFor(() => expect(screen.getByTestId('paged-editor')).toHaveAttribute('data-document-id', 'note-2'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects a stale host-close approval and completes a requested document switch after its save', async () => {
    const pending = deferred<void>();
    editorSession('note-1', vi.fn(() => pending.promise));
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    let closing!: Promise<boolean>;
    act(() => { closing = flushInkWorkspace('note-1'); });
    view.rerender(<InkWorkspace documentId="note-2" onClose={onClose} />);
    await act(async () => { pending.resolve(); });
    await expect(closing).resolves.toBe(false);
    await waitFor(() => expect(screen.getByTestId('paged-editor')).toHaveAttribute('data-document-id', 'note-2'));
    expect(onClose).not.toHaveBeenCalled();
    expect(hasInkWorkspace('note-1')).toBe(false);
    expect(hasInkWorkspace('note-2')).toBe(true);
  });

  it('ignores a late v1 manifest after changing to a v2 document', async () => {
    const oldManifest = deferred<{ schema_version: number; document_id: string }>();
    get.mockImplementation(({ document_id }) => document_id === 'note-1'
      ? oldManifest.promise
      : Promise.resolve({ schema_version: 2, document_id }));
    const view = render(<InkWorkspace documentId="note-1" />);
    await waitFor(() => expect(get).toHaveBeenCalledWith({ document_id: 'note-1' }));
    view.rerender(<InkWorkspace documentId="board-2" />);
    expect(await screen.findByTestId('board-editor')).toHaveAttribute('data-document-id', 'board-2');
    await act(async () => { oldManifest.resolve({ schema_version: 1, document_id: 'note-1' }); });
    expect(screen.getByTestId('board-editor')).toHaveAttribute('data-document-id', 'board-2');
    expect(pagedMounted).not.toHaveBeenCalled();
  });

  it('ignores a pending close result after becoming inactive', async () => {
    const pending = deferred<void>();
    editorSession('note-1', vi.fn(() => pending.promise));
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    view.rerender(<InkWorkspace documentId="note-1" onClose={onClose} isActive={false} />);
    await act(async () => { pending.resolve(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('flushes the dirty session once when its host hides and preserves recovery on failure', async () => {
    const session = editorSession('note-1', vi.fn(async () => { throw new Error('offline'); }));
    const view = render(<InkWorkspace documentId="note-1" />);
    const editor = await screen.findByTestId('paged-editor');
    view.rerender(<InkWorkspace documentId="note-1" isActive={false} />);
    await waitFor(() => expect(session.persistDraft).toHaveBeenCalledTimes(1));
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(handleAndroidBack()).toBe(false);
    view.rerender(<InkWorkspace documentId="note-1" isActive />);
    expect(await screen.findByTestId('paged-editor')).toBe(editor);
  });

  it('shares a pending hidden-host flush with a later host close without duplicate saves', async () => {
    const pending = deferred<void>();
    const session = editorSession('note-1', vi.fn(() => pending.promise));
    const view = render(<InkWorkspace documentId="note-1" />);
    await screen.findByTestId('paged-editor');
    view.rerender(<InkWorkspace documentId="note-1" isActive={false} />);
    expect(session.flush).toHaveBeenCalledTimes(1);
    let settled = false;
    const closing = flushInkWorkspace('note-1').then((saved) => { settled = true; return saved; });
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await act(async () => { pending.resolve(); });
    await expect(closing).resolves.toBe(true);
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(session.persistDraft).not.toHaveBeenCalled();
  });

  it('persists a recovery draft on forced unmount without canonical saving', async () => {
    const session = editorSession('note-1', vi.fn(async () => { throw new Error('offline'); }));
    const onClose = vi.fn();
    const view = render(<InkWorkspace documentId="note-1" onClose={onClose} />);
    await screen.findByTestId('paged-editor');
    view.unmount();
    await waitFor(() => expect(session.persistDraft).toHaveBeenCalledTimes(1));
    expect(session.flush).not.toHaveBeenCalled();
    expect(hasInkWorkspace('note-1')).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ink-workspace-portal]')).not.toBeInTheDocument();
    expect(handleAndroidBack()).toBe(false);
  });
});
