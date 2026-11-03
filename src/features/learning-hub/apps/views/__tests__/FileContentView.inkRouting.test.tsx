import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

vi.mock('@/features/ink/LazyInkEditor', async () => {
  const React = await import('react');
  return {
    LazyInkEditor: ({ documentId }: { documentId: string }) =>
      React.createElement('div', { 'data-testid': 'lazy-ink-editor', 'data-document-id': documentId }),
  };
});
vi.mock('@/hooks/usePdfLoader', () => ({ usePdfLoader: () => ({
  file: null,
  filePath: null,
  loading: false,
  error: null,
  isLargeFile: false,
  retry: vi.fn(),
}) }));
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
  it('renders the lazy ink editor with the stable DSTU file ID', async () => {
    render(<FileContentView node={inkFile} />);

    expect(await screen.findByTestId('lazy-ink-editor')).toHaveAttribute('data-document-id', 'file_stable123');
  });
});
