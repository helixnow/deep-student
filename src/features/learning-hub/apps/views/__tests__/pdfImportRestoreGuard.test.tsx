import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

const mocks = vi.hoisted(() => ({
  usePdfLoader: vi.fn(),
  textbookViewerProps: vi.fn(),
  canOpenFilesExternally: vi.fn(() => true),
  openFileExternally: vi.fn(async () => 'open'),
  saveResourceToDevice: vi.fn(async () => ({ canceled: true })),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('@/hooks/usePdfLoader', () => ({
  usePdfLoader: (opts: unknown) => mocks.usePdfLoader(opts),
}));

vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({
  TextbookPdfViewer: (props: Record<string, unknown>) => {
    mocks.textbookViewerProps(props);
    return <div data-testid="mock-textbook-pdf-viewer" data-active={String(props.isActive)} />;
  },
}));

vi.mock('@/utils/systemFileOpener', () => ({
  canOpenFilesExternally: () => mocks.canOpenFilesExternally(),
  openFileExternally: (path: string) => mocks.openFileExternally(path),
}));

vi.mock('../saveResourceToDevice', () => ({
  saveFiltersForFileName: () => [],
  saveResourceToDevice: (opts: unknown) => mocks.saveResourceToDevice(opts),
}));

vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));

vi.mock('../previewPersistence', () => ({
  createPreviewPersistController: () => ({
    scheduleProgress: vi.fn(),
    scheduleBookmarks: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (p: string) => p,
}));

import FileContentView from '../FileContentView';
import { sanitizeHydratedWindowsForReload } from '@/features/workbench/components/WorkbenchDesktop';

function makePdfNode(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'pdf_1',
    sourceId: 'pdf_1',
    path: '/pdf_1',
    name: '71-stress-truncated-corrupt.pdf',
    type: 'file',
    size: 12_288,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { mimeType: 'application/pdf' },
    ...overrides,
  };
}

function makeWindow(overrides: Partial<WorkbenchWindow>): WorkbenchWindow {
  return {
    id: 'win_1',
    typeId: 'file-preview',
    instanceKey: 'pdf_1',
    title: 'PDF',
    frame: { x: 0, y: 0, w: 800, h: 600 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    lastFocusedAt: 100,
    ...overrides,
  };
}

describe('SOTA04 PDF error surfacing, background isActive gating, and reload window guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePdfLoader.mockReturnValue({
      file: null,
      filePath: undefined,
      loading: false,
      error: null,
      errorKind: null,
      isLargeFile: false,
      fileSize: 0,
      loadSource: null,
      retry: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('surfaces node.metadata.processingStatus=error immediately as an actionable error screen without loading PDF.js', () => {
    const node = makePdfNode({
      metadata: {
        mimeType: 'application/pdf',
        processingStatus: 'error',
        processingError: 'InvalidPDFException: Invalid PDF structure.',
      },
    });

    render(<FileContentView node={node} isActive />);

    expect(mocks.usePdfLoader).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByText('Corrupted or invalid PDF file')).toBeInTheDocument();
    expect(screen.getByText('InvalidPDFException: Invalid PDF structure.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'learningHub:file.saveToDevice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:openExternal' })).toBeInTheDocument();
  });

  it('defers background PDF loading when isActive=false and propagates isActive to TextbookPdfViewer once activated', () => {
    const node = makePdfNode({ id: 'pdf_cad', name: '31-cad.pdf' });
    mocks.usePdfLoader.mockImplementation((opts: { enabled?: boolean }) => ({
      file: null,
      filePath: opts.enabled ? '/tmp/31-cad.pdf' : undefined,
      loading: false,
      error: null,
      errorKind: null,
      isLargeFile: false,
      fileSize: 0,
      loadSource: opts.enabled ? 'stream' : null,
      retry: vi.fn(),
    }));

    const { rerender } = render(<FileContentView node={node} isActive={false} />);
    expect(mocks.usePdfLoader).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByTestId('pdf-background-deferred')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-textbook-pdf-viewer')).toBeNull();

    // Activate window -> usePdfLoader enables and TextbookPdfViewer receives isActive=true
    rerender(<FileContentView node={node} isActive />);
    expect(mocks.usePdfLoader).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByTestId('mock-textbook-pdf-viewer')).toHaveAttribute('data-active', 'true');

    // Move back to background -> TextbookPdfViewer stays mounted with isActive=false to pause canvas renders
    rerender(<FileContentView node={node} isActive={false} />);
    expect(screen.getByTestId('mock-textbook-pdf-viewer')).toHaveAttribute('data-active', 'false');
  });

  it('collapses stacked open heavy preview windows during reload hydration so only the topmost remains open', () => {
    const windows = [
      makeWindow({ id: 'win_files', typeId: 'files', instanceKey: null, zIndex: 10, lastFocusedAt: 100 }),
      makeWindow({ id: 'win_pdf_1', typeId: 'file-preview', instanceKey: 'a', zIndex: 11, lastFocusedAt: 200 }),
      makeWindow({ id: 'win_pdf_2', typeId: 'file-preview', instanceKey: 'b', zIndex: 13, lastFocusedAt: 400 }),
      makeWindow({ id: 'win_tb_1', typeId: 'textbook', instanceKey: 'c', zIndex: 12, lastFocusedAt: 300 }),
    ];

    const sanitized = sanitizeHydratedWindowsForReload(windows);
    expect(sanitized.find((w) => w.id === 'win_files')?.minimized).toBe(false);
    expect(sanitized.find((w) => w.id === 'win_pdf_2')?.minimized).toBe(false);
    expect(sanitized.find((w) => w.id === 'win_pdf_1')?.minimized).toBe(true);
    expect(sanitized.find((w) => w.id === 'win_tb_1')?.minimized).toBe(true);
  });
});
