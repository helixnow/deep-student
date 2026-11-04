import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';

const { get, usePdfLoader, loadTextPreviewContent } = vi.hoisted(() => ({
  get: vi.fn(),
  usePdfLoader: vi.fn(() => ({ file: null, filePath: null, loading: false, error: null, isLargeFile: false, retry: vi.fn() })),
  loadTextPreviewContent: vi.fn(),
}));
vi.mock('@/features/ink/api', () => ({ inkApi: { get } }));
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
vi.mock('@/hooks/usePdfLoader', () => ({ usePdfLoader }));
vi.mock('../textPreviewLoader', () => ({ loadTextPreviewContent }));
vi.mock('../usePdfFocusListener', () => ({ usePdfFocusListener: () => [null, vi.fn()] }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({ useReferenceToChat: () => ({ referenceToChat: vi.fn() }) }));
vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({ TextbookPdfViewer: () => null }));
vi.mock('../RichDocumentPreview', () => ({ RichDocumentPreview: () => null }));
vi.mock('../TextFilePreview', () => ({ TextFilePreview: () => null }));
vi.mock('../EpubPreview', () => ({ default: () => null }));
vi.mock('../PreviewStatus', () => ({ PreviewStatus: () => null }));
vi.mock('../media/MediaStudyView', () => ({ MediaStudyView: () => null }));
vi.mock('../saveResourceToDevice', () => ({ saveFiltersForFileName: vi.fn(), saveResourceToDevice: vi.fn() }));
vi.mock('../previewPersistence', () => ({ createPreviewPersistController: () => ({
  dispose: vi.fn(),
  scheduleProgress: vi.fn(),
  scheduleBookmarks: vi.fn(),
}) }));

import FileContentView from '../FileContentView';

const inkFile: DstuNode = {
  id: 'file_stable123',
  sourceId: 'file_stable123',
  name: 'notes.dsink',
  type: 'file',
  path: '/file_stable123',
  createdAt: 1,
  updatedAt: 1,
  previewType: 'text',
  metadata: { mimeType: 'application/json' },
};

describe('FileContentView ink dispatch', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ schema_version: 1, document_id: inkFile.id, title: '笔记' });
    usePdfLoader.mockClear();
    loadTextPreviewContent.mockClear();
  });

  it('opens the shared fullscreen host before initializing text or PDF preview hooks', async () => {
    const view = render(<FileContentView node={inkFile} />);

    expect(await screen.findByTestId('lazy-ink-editor')).toHaveAttribute('data-document-id', 'file_stable123');
    const page = screen.getByRole('dialog', { name: inkFile.name });
    expect(page.parentElement?.parentElement).toBe(document.body);
    expect(view.container).not.toContainElement(page);
    expect(usePdfLoader).not.toHaveBeenCalled();
    expect(loadTextPreviewContent).not.toHaveBeenCalled();
  });

  it('routes a real schema-v2 manifest to the board entry, never the paged entry', async () => {
    get.mockResolvedValue({ schema_version: 2, document_id: inkFile.id });
    render(<FileContentView node={inkFile} />);
    expect(await screen.findByTestId('lazy-ink-board-editor')).toHaveAttribute('data-document-id', inkFile.id);
    expect(screen.queryByTestId('lazy-ink-editor')).not.toBeInTheDocument();
  });

  it('also detects canonical Ink MIME when the old previewType and extension disagree', async () => {
    render(<FileContentView node={{ ...inkFile, name: 'untyped-note', metadata: { mimeType: 'application/octet-stream', canonicalMime: 'application/vnd.deepstudent.ink+json' } }} />);
    expect(await screen.findByTestId('lazy-ink-editor')).toHaveAttribute('data-document-id', inkFile.id);
    expect(usePdfLoader).not.toHaveBeenCalled();
  });

  it('passes inactive state through the real host so background tabs cannot cover the current page or consume back', async () => {
    const onClose = vi.fn();
    const view = render(<FileContentView node={inkFile} isActive={false} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(handleAndroidBack()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    view.rerender(<FileContentView node={inkFile} isActive onClose={onClose} />);
    await screen.findByTestId('lazy-ink-editor');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await act(async () => { await Promise.resolve(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable manifest error instead of showing a paged canvas', async () => {
    get.mockRejectedValueOnce(new Error('manifest unavailable'));
    get.mockResolvedValueOnce({ schema_version: 2, document_id: inkFile.id });
    render(<FileContentView node={inkFile} />);
    expect(await screen.findByText('manifest unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-ink-editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('lazy-ink-board-editor')).toBeInTheDocument();
  });
});
