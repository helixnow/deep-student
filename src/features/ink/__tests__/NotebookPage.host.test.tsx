import React, { useEffect, useState } from 'react';
import * as NotebookTextWorkspaceModule from '../NotebookTextWorkspace';
import { createPortal } from 'react-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { NotebookHostState } from '../NotebookHost';
import type { NoteContentViewProps } from '@/features/learning-hub';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), createInk: vi.fn(), createInkBoard: vi.fn(), createEmpty: vi.fn(),
  ready: true, textReady: true,
  textProps: null as NoteContentViewProps | null,
  inkClose: null as (() => void) | null,
}));
vi.mock('@/dstu', async () => ({
  ...(await vi.importActual('@/dstu/inkFormat')),
  dstu: { list: mocks.list }, createEmpty: mocks.createEmpty,
}));
vi.mock('@/features/ink', () => ({
  createInk: mocks.createInk, createInkBoard: mocks.createInkBoard,
  InkWorkspace: function MockInkWorkspace({ documentId, onClose }: { documentId: string; onClose: () => void }) {
    mocks.inkClose = onClose;
    const [ready, setReady] = useState(mocks.ready);
    const [closing, setClosing] = useState(false);
    const [saveState, setSaveState] = useState('saved');
    const [portalRoot] = useState(() => document.createElement('div'));
    useEffect(() => {
      document.body.appendChild(portalRoot);
      return () => { portalRoot.remove(); };
    }, [portalRoot]);
    return createPortal(<section data-ink-workspace-page={documentId}>
      <button onClick={onClose}>Return to library</button>
      <button onClick={() => setReady((value) => !value)}>Toggle editor ready</button>
      <button onClick={() => setClosing((value) => !value)}>Toggle editor exit</button>
      <button onClick={() => setSaveState((value) => value === 'saved' ? 'saving' : 'saved')}>Change save state</button>
      <div className="ink-workspace-content" {...(closing ? { inert: '' } : {})}>
        {ready ? <section data-testid="ink-editor" data-document-id={documentId}>
          <output data-testid="ink-editor-flush-state">ready</output>
          <output data-testid="ink-editor-save-state" data-state={saveState}>{saveState}</output>
        </section> : <div role="alert">Editor unavailable</div>}
      </div>
    </section>, portalRoot);
  },
}));
vi.mock('@/features/learning-hub', () => ({
  LazyNoteContentView: function MockNoteContentView(props: NoteContentViewProps) {
    mocks.textProps = props;
    const { onSaveStateChange } = props;
    useEffect(() => { if (mocks.textReady) onSaveStateChange?.('saved'); }, [onSaveStateChange]);
    return mocks.textReady ? <div className="ProseMirror">Text editor ready</div> : <div role="alert">Text editor unavailable</div>;
  },
}));
vi.mock('@/components/layout', () => ({ useMobileHeader: vi.fn(), MobileSlidingLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isSmallScreen: false }) }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('react-i18next', async () => {
  const { default: ink } = await import('@/locales/zh-CN/ink.json');
  const translate = (key: string, values?: Record<string, unknown>) => {
    let result: unknown = ink;
    for (const part of key.split('.')) result = (result as Record<string, unknown>)?.[part];
    return String(result ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  };
  return { initReactI18next: { type: '3rdParty', init: () => undefined }, useTranslation: () => ({ t: translate, i18n: { language: 'zh-CN' } }) };
});

import { NotebookPage } from '../NotebookPage';
const NotebookTextWorkspace = NotebookTextWorkspaceModule.default;
import { registerInkEditorSession } from '../editorSession';
import { registerContentDirtyChecker, registerContentSaveHandler } from '@/services/contentDirtyRegistry';

const unregisters: Array<() => void> = [];
const node = (id: string, type: 'note' | 'file' = 'file'): DstuNode => ({
  id, sourceId: id, path: `/${id}`, name: type === 'file' ? `${id}.dsink` : id,
  type, createdAt: 1, updatedAt: 2,
});
function installList(nodes = [node('file_a'), node('file_b'), node('note_a', 'note')]) {
  mocks.list.mockImplementation(async (_path, options) => ({ ok: true, value: options.offset === 0 ? nodes.filter((entry) => entry.type === options.typeFilter) : [] }));
}
function hostProbe() {
  let current: NotebookHostState | null = null;
  const callback = vi.fn((state: NotebookHostState | null) => { current = state; });
  return { callback, current: () => current! };
}
function session(id: string, dirty: () => boolean, flush: () => Promise<void>) {
  unregisters.push(registerInkEditorSession({ key: { document_id: id, page_id: 'page-1' }, isDirty: dirty, flush, persistDraft: async () => undefined }));
}
async function openInk(probe: ReturnType<typeof hostProbe>, id = 'file_a') {
  await screen.findByTestId(`notebook-card-${id}`);
  fireEvent.click(screen.getByTestId(`notebook-card-${id}`));
  await waitFor(() => expect(probe.current().writing).toBe(true));
  await waitFor(() => expect(probe.current().busy).toBe(!mocks.ready));
}

beforeEach(() => {
  expect(NotebookTextWorkspace).toBeTypeOf('function');
  installList();
  mocks.ready = true; mocks.textReady = true; mocks.textProps = null;
  mocks.createInk.mockReset().mockResolvedValue({ document_id: 'file_new', title: 'new' });
  mocks.createInkBoard.mockReset().mockResolvedValue({ document_id: 'file_new', title: 'new' });
  mocks.createEmpty.mockReset();
});
afterEach(() => { unregisters.splice(0).reverse().forEach((dispose) => dispose()); });

describe('NotebookPage host state', () => {
  it('publishes stable ready-library state and clears the exact callback on unmount', async () => {
    const probe = hostProbe();
    const view = render(<NotebookPage onHostStateChange={probe.callback} />);
    await waitFor(() => expect(probe.current().busy).toBe(false));
    const state = probe.current();
    expect(state.writing).toBe(false);
    expect(state.isDirty()).toBe(false);
    await expect(state.flush()).resolves.toBe(true);
    fireEvent.change(screen.getByTestId('notebook-search'), { target: { value: 'file' } });
    expect(probe.current()).toBe(state);
    view.unmount();
    expect(probe.callback).toHaveBeenLastCalledWith(null);
    await expect(state.flush()).resolves.toBe(false);
  });

  it('blocks during creation, including a clean previous library generation and creation rejection', async () => {
    const probe = hostProbe();
    let reject!: (error: Error) => void;
    mocks.createInkBoard.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await waitFor(() => expect(probe.current().busy).toBe(false));
    const library = probe.current();
    fireEvent.click(screen.getByTestId('notebook-create-board'));
    expect(probe.current().busy).toBe(true);
    await expect(library.flush()).resolves.toBe(false);
    await expect(probe.current().flush()).resolves.toBe(false);
    await act(async () => { reject(new Error('create failed')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('create failed');
    await waitFor(() => expect(probe.current().busy).toBe(false));
    expect(probe.current()).not.toBe(library);
  });

  it('fails closed for a missing or error editor and becomes flushable only after mounted ready output', async () => {
    mocks.ready = false;
    const flush = vi.fn(async () => undefined);
    session('file_a', () => false, flush);
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    await expect(state.flush()).resolves.toBe(false);
    expect(flush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor ready' }));
    await waitFor(() => expect(state.busy).toBe(false));
    await expect(state.flush()).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(probe.current()).toBe(state);
  });

  it('always flushes an apparently clean active stroke, awaits it, republishes save changes without replacing state identity', async () => {
    let activeStroke = true;
    let finish!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finish = () => { activeStroke = false; resolve(); }; }));
    session('file_a', () => false, flush);
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    expect(state.isDirty()).toBe(false);
    let settled = false;
    const saving = state.flush().then((result) => { settled = true; return result; });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(activeStroke).toBe(true);
    expect(settled).toBe(false);
    const publications = probe.callback.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Change save state' }));
    await waitFor(() => expect(probe.callback.mock.calls.length).toBeGreaterThan(publications));
    expect(probe.current()).toBe(state);
    await act(async () => { finish(); });
    await expect(saving).resolves.toBe(true);
    expect(activeStroke).toBe(false);
    expect(probe.current()).toBe(state);
  });

  it('flushes a clean detached ready page but rejects removed editors and detached page unmounts', async () => {
    let finish!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    session('file_a', () => false, flush);
    const probe = hostProbe();
    const view = render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    const editor = screen.getByTestId('ink-editor');
    const content = editor.parentElement!;
    const page = document.querySelector<HTMLElement>('[data-ink-workspace-page="file_a"]')!;
    const root = page.parentElement!;
    try {
      act(() => { root.remove(); });
      expect(page.isConnected).toBe(false);
      expect(state.busy).toBe(false);
      expect(state.isDirty()).toBe(false);
      let settled = false;
      const saving = state.flush().then((result) => { settled = true; return result; });
      expect(flush).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await act(async () => { finish(); });
      await expect(saving).resolves.toBe(true);
      expect(probe.current()).toBe(state);

      const editorPublications = probe.callback.mock.calls.length;
      await act(async () => { editor.remove(); });
      await waitFor(() => expect(probe.callback.mock.calls.length).toBeGreaterThan(editorPublications));
      expect(state.busy).toBe(true);
      await expect(state.flush()).resolves.toBe(false);
      expect(flush).toHaveBeenCalledTimes(1);

      await act(async () => { content.appendChild(editor); });
      await waitFor(() => expect(state.busy).toBe(false));
      const pagePublications = probe.callback.mock.calls.length;
      await act(async () => { page.remove(); });
      await waitFor(() => expect(probe.callback.mock.calls.length).toBeGreaterThan(pagePublications));
      expect(state.busy).toBe(true);
      await expect(state.flush()).resolves.toBe(false);
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      content.appendChild(editor);
      root.appendChild(page);
      view.unmount();
    }
  });

  it('rejects failed flushes and successful calls that remain dirty without dropping the selected page', async () => {
    let dirty = true;
    const flush = vi.fn().mockRejectedValueOnce(new Error('save rejected')).mockResolvedValue(undefined);
    session('file_a', () => dirty, flush);
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    await expect(state.flush()).resolves.toBe(false);
    await expect(state.flush()).resolves.toBe(false);
    expect(probe.current()).toBe(state);
    expect(state.isDirty()).toBe(true);
    dirty = false;
    await expect(state.flush()).resolves.toBe(true);
    expect(screen.queryByTestId('notebook-library')).not.toBeInTheDocument();
  });

  it('invalidates old entry flushes and close callbacks when another document is opened', async () => {
    let finish!: () => void;
    session('file_a', () => false, () => new Promise<void>((resolve) => { finish = resolve; }));
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const oldState = probe.current();
    const oldClose = mocks.inkClose!;
    const saving = oldState.flush();
    fireEvent.click(screen.getByRole('button', { name: 'Return to library' }));
    await screen.findByTestId('notebook-card-file_b');
    fireEvent.click(screen.getByTestId('notebook-card-file_b'));
    await waitFor(() => expect(probe.current()).not.toBe(oldState));
    await act(async () => { finish(); });
    await expect(saving).resolves.toBe(false);
    await expect(oldState.flush()).resolves.toBe(false);
    act(() => { oldClose(); });
    expect(document.querySelector('[data-ink-workspace-page="file_b"]')).toBeInTheDocument();
  });

  it('publishes pointer-driven dirty changes even when active input does not mutate editor DOM', async () => {
    let dirty = false;
    session('file_a', () => dirty, async () => { dirty = false; });
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    const count = probe.callback.mock.calls.length;
    dirty = true;
    fireEvent.pointerDown(screen.getByTestId('ink-editor'));
    await waitFor(() => expect(probe.callback.mock.calls.length).toBeGreaterThan(count));
    expect(probe.current()).toBe(state);
    expect(state.isDirty()).toBe(true);
    await expect(state.flush()).resolves.toBe(true);
  });

  it('publishes exit busy and preserves the selected-generation identity', async () => {
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await openInk(probe);
    const state = probe.current();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor exit' }));
    await waitFor(() => expect(state.busy).toBe(true));
    expect(probe.current()).toBe(state);
    await expect(state.flush()).resolves.toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle editor exit' }));
    await waitFor(() => expect(state.busy).toBe(false));
  });

  it('uses the real service registry for text readiness, save rejection and post-save dirty checks', async () => {
    let dirty = true;
    const save = vi.fn().mockRejectedValueOnce(new Error('text failed')).mockImplementation(async () => { dirty = false; });
    unregisters.push(registerContentDirtyChecker('note', 'note_a', () => dirty));
    unregisters.push(registerContentSaveHandler('note', 'note_a', save));
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await screen.findByTestId('notebook-card-note_a');
    fireEvent.click(screen.getByTestId('notebook-card-note_a'));
    await screen.findByText('Text editor ready');
    await waitFor(() => expect(probe.current().busy).toBe(false));
    const state = probe.current();
    expect(state.writing).toBe(true);
    expect(state.isDirty()).toBe(true);
    await expect(state.flush()).resolves.toBe(false);
    await act(async () => { mocks.textProps?.onSaveStateChange?.('saving'); });
    expect(probe.current()).toBe(state);
    await expect(state.flush()).resolves.toBe(true);
    expect(state.isDirty()).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('notebook-text-workspace')).toBeInTheDocument();
  });

  it('does not accept an unloaded text editor even when a clean save handler exists', async () => {
    mocks.textReady = false;
    const save = vi.fn(async () => undefined);
    unregisters.push(registerContentSaveHandler('note', 'note_a', save));
    const probe = hostProbe();
    render(<NotebookPage onHostStateChange={probe.callback} />);
    await screen.findByTestId('notebook-card-note_a');
    fireEvent.click(screen.getByTestId('notebook-card-note_a'));
    await screen.findByText('Text editor unavailable');
    expect(probe.current().busy).toBe(true);
    await expect(probe.current().flush()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
