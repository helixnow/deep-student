import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, inkGet, t } = vi.hoisted(() => ({
  get: vi.fn(),
  inkGet: vi.fn(),
  t: (key: string) => key,
}));

vi.mock('@/dstu', () => ({ dstu: { get } }));
vi.mock('@/features/ink/api', () => ({ inkApi: { get: inkGet } }));
vi.mock('@/dstu/editors/FileViewerWrapper', () => ({
  FileViewerWrapper: ({ path }: { path: string }) => <div data-testid="generic-file-viewer" data-path={path} />,
}));
vi.mock('@/features/ink/LazyInkEditorEntry', async () => {
  const React = await import('react');
  return {
    LazyInkEditor: ({ documentId }: { documentId: string }) =>
      React.createElement('div', { 'data-testid': 'lazy-ink-editor', 'data-document-id': documentId }),
  };
});
vi.mock('@/features/ink/LazyInkBoardEditorEntry', async () => {
  const React = await import('react');
  return {
    LazyInkBoardEditor: ({ documentId }: { documentId: string }) =>
      React.createElement('div', { 'data-testid': 'lazy-ink-board-editor', 'data-document-id': documentId }),
  };
});
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/utils/fileManager', () => ({ fileManager: { saveFromSource: vi.fn() } }));

import { loadEditorComponent } from '@/dstu/editorRegistry';
import { registerDstuFileViewer } from '@/features/ink';
import { INK_BOARD_SCHEMA_VERSION } from '@/features/ink/types';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { registerInkEditorSession } from '@/features/ink/editorSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const inkNode = {
  id: 'file_stable456',
  sourceId: 'file_stable456',
  path: '/file_stable456',
  name: 'notes.dsink',
  type: 'file',
  size: 10,
  createdAt: 1,
  updatedAt: 1,
  previewType: 'text',
  metadata: { mimeType: 'application/json' },
};

async function renderInkFile() {
  registerDstuFileViewer();
  const FileEditor = await loadEditorComponent('file');
  render(<FileEditor path="/file_stable456" />);
}

describe('DSTU file editor ink dispatch', () => {
  beforeEach(() => {
    get.mockReset();
    inkGet.mockReset();
    get.mockResolvedValue({ ok: true, value: inkNode });
  });

  it('loads the registry editor with only its path, resolves the actual Ink node, and keeps the paged route', async () => {
    inkGet.mockResolvedValue({ schema_version: 1, document_id: inkNode.id });

    await renderInkFile();

    expect(await screen.findByTestId('lazy-ink-editor')).toHaveAttribute('data-document-id', 'file_stable456');
    expect(screen.queryByTestId('lazy-ink-board-editor')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/file_stable456');
    expect(inkGet).toHaveBeenCalledWith({ document_id: 'file_stable456' });
  });

  it('routes schema-v2 documents to the board entry with the same node identity', async () => {
    inkGet.mockResolvedValue({ schema_version: INK_BOARD_SCHEMA_VERSION, document_id: inkNode.id });

    await renderInkFile();

    expect(await screen.findByTestId('lazy-ink-board-editor')).toHaveAttribute('data-document-id', 'file_stable456');
    expect(screen.queryByTestId('lazy-ink-editor')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/file_stable456');
    expect(inkGet).toHaveBeenCalledWith({ document_id: 'file_stable456' });
  });

  it('shows the manifest failure and retries the shared host without silently mounting v1', async () => {
    inkGet.mockRejectedValueOnce(new Error('manifest unavailable'));
    inkGet.mockResolvedValueOnce({ schema_version: INK_BOARD_SCHEMA_VERSION, document_id: inkNode.id });

    await renderInkFile();

    expect(await screen.findByText('manifest unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-ink-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lazy-ink-board-editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }));
    expect(await screen.findByTestId('lazy-ink-board-editor')).toHaveAttribute('data-document-id', inkNode.id);
    expect(get).toHaveBeenCalledWith('/file_stable456');
  });

  it('uses the shared fullscreen host with the loaded title rather than an embedded editor', async () => {
    inkGet.mockResolvedValue({ schema_version: 1, document_id: inkNode.id });
    await renderInkFile();
    const page = await screen.findByRole('dialog', { name: inkNode.name });
    expect(page.parentElement?.parentElement).toBe(document.body);
    expect(page).toHaveClass('ink-workspace-page');
  });

  it('hides the old Ink fullscreen page and shows loading while resolving a different non-Ink path', async () => {
    inkGet.mockResolvedValue({ schema_version: 1, document_id: inkNode.id });
    registerDstuFileViewer();
    const FileEditor = await loadEditorComponent('file');
    const view = render(<FileEditor path={inkNode.path} />);
    await screen.findByTestId('lazy-ink-editor');
    const pendingNode = deferred<{ ok: true; value: typeof inkNode }>();
    get.mockReturnValueOnce(pendingNode.promise);
    view.rerender(<FileEditor path="/file_pdf" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('preview.loading');
    expect(handleAndroidBack()).toBe(false);
    await act(async () => {
      pendingNode.resolve({ ok: true, value: { ...inkNode, id: 'file_pdf', path: '/file_pdf', name: 'book.pdf', metadata: { mimeType: 'application/pdf' } } });
    });
    expect(await screen.findByTestId('generic-file-viewer')).toHaveAttribute('data-path', '/file_pdf');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('preserves the shared Ink host and its strict flush across a resolved Ink-to-Ink file switch', async () => {
    const nextNode = { ...inkNode, id: 'file_board_next', path: '/file_board_next', name: 'board.dsink' };
    inkGet.mockImplementation(async ({ document_id }) => ({ schema_version: document_id === inkNode.id ? 1 : 2, document_id }));
    registerDstuFileViewer();
    const FileEditor = await loadEditorComponent('file');
    const view = render(<FileEditor path={inkNode.path} />);
    const oldEditor = await screen.findByTestId('lazy-ink-editor');
    const pendingFlush = deferred<void>();
    const flush = vi.fn(() => pendingFlush.promise);
    const unregister = registerInkEditorSession({
      key: { document_id: inkNode.id, page_id: 'page-1' },
      isDirty: () => true,
      flush,
      persistDraft: async () => undefined,
    });
    try {
      get.mockResolvedValueOnce({ ok: true, value: nextNode });
      view.rerender(<FileEditor path={nextNode.path} />);
      await waitFor(() => expect(flush).toHaveBeenCalled());
      expect(screen.queryByTestId('lazy-ink-board-editor')).not.toBeInTheDocument();
      expect(oldEditor).toBeInTheDocument();
      await act(async () => { pendingFlush.resolve(); });
      expect(await screen.findByTestId('lazy-ink-board-editor')).toHaveAttribute('data-document-id', nextNode.id);
    } finally {
      unregister();
    }
  });

  it('does not open fullscreen from a registry editor mounted in a hidden keep-alive view', async () => {
    inkGet.mockResolvedValue({ schema_version: 2, document_id: inkNode.id });
    registerDstuFileViewer();
    const FileEditor = await loadEditorComponent('file');
    const view = render(<div style={{ display: 'none' }}><FileEditor path={inkNode.path} /></div>);
    await screen.findByRole('button', { name: 'workspace.openFullscreen', hidden: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inkGet).not.toHaveBeenCalled();
    view.rerender(<div style={{ display: 'block' }}><FileEditor path={inkNode.path} /></div>);
    expect(await screen.findByTestId('lazy-ink-board-editor')).toHaveAttribute('data-document-id', inkNode.id);
  });
});
