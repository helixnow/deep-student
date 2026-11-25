import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  stageBlobUploadMock,
  abortStagedUploadMock,
  importNotesMock,
  importMarkdownContentMock,
  notifyMock,
} = vi.hoisted(() => ({
  stageBlobUploadMock: vi.fn(),
  abortStagedUploadMock: vi.fn(async () => {}),
  importNotesMock: vi.fn(),
  importMarkdownContentMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.defaultValue === 'string' ? opts.defaultValue : key,
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/utils/platform', () => ({
  isWebUiShell: () => true,
}));

vi.mock('@/utils/stagedUpload', () => ({
  stageBlobUpload: stageBlobUploadMock,
  abortStagedUpload: abortStagedUploadMock,
}));

vi.mock('@/utils/notesApi', () => ({
  NotesAPI: {
    exportNotes: vi.fn(),
    setPref: vi.fn(async () => {}),
    importNotes: importNotesMock,
  },
}));

vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  notesDstuAdapter: {
    importMarkdownContent: importMarkdownContentMock,
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('../content/contentDirtyRegistry', () => ({
  flushAllDirtyContent: vi.fn(async () => true),
}));

vi.mock('@/features/notes/NotesLibraryManager', () => ({
  NOTES_LIBRARY_LAST_EXPORT_PREF: 'notes_last_export',
  NotesLibraryManager: ({
    open,
    importFilePath,
    importConflictStrategy,
    onImportConflictStrategyChange,
    onConfirmImport,
  }: {
    open: boolean;
    importFilePath: string;
    importConflictStrategy: 'skip' | 'overwrite' | 'merge_keep_newer';
    onImportConflictStrategyChange: (next: 'skip' | 'overwrite' | 'merge_keep_newer') => void;
    onConfirmImport: () => void;
  }) =>
    open ? (
      <div data-testid="mock-library-manager">
        <span data-testid="selected-path">{importFilePath}</span>
        <span data-testid="selected-strategy">{importConflictStrategy}</span>
        <button
          type="button"
          data-testid="strategy-overwrite"
          onClick={() => onImportConflictStrategyChange('overwrite')}
        >
          overwrite
        </button>
        <button
          type="button"
          data-testid="confirm-import"
          disabled={!importFilePath}
          onClick={onConfirmImport}
        >
          import
        </button>
      </div>
    ) : null,
}));

import { WorkbenchNotesLibraryDialog } from '../WorkbenchNotesLibraryDialog';

describe('WorkbenchNotesLibraryDialog WebUI ZIP re-import (G06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('stages a picked .zip file via stageBlobUpload and imports it through dstu-staged:<uploadId>', async () => {
    stageBlobUploadMock.mockResolvedValueOnce('upload_zip_123');
    importNotesMock.mockResolvedValueOnce({
      subject_count: 1,
      note_count: 3,
      attachment_count: 0,
      skipped_count: 0,
      overwritten_count: 1,
    });
    const onOpenChange = vi.fn();
    const onImported = vi.fn(async () => {});

    render(
      <WorkbenchNotesLibraryDialog
        open
        initialTab="import"
        onOpenChange={onOpenChange}
        onImported={onImported}
      />,
    );

    const fileInput = screen.getByTestId('notes-library-import-input') as HTMLInputElement;
    const zipFile = new File([new Uint8Array([80, 75, 3, 4])], 'notes_export_2026.zip', {
      type: 'application/zip',
    });
    fireEvent.change(fileInput, { target: { files: [zipFile] } });

    expect(screen.getByTestId('selected-path')).toHaveTextContent('notes_export_2026.zip');
    fireEvent.click(screen.getByTestId('strategy-overwrite'));
    fireEvent.click(screen.getByTestId('confirm-import'));

    await waitFor(() => {
      expect(stageBlobUploadMock).toHaveBeenCalledWith(zipFile, { name: 'notes_export_2026.zip' });
      expect(importNotesMock).toHaveBeenCalledWith({
        filePath: 'dstu-staged:upload_zip_123',
        conflictStrategy: 'overwrite',
      });
      expect(onImported).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    expect(abortStagedUploadMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith('success', 'import.success_with_overwrite');
  });

  it('aborts the staged upload and surfaces Host CommandError.message when ZIP import fails', async () => {
    stageBlobUploadMock.mockResolvedValueOnce('upload_zip_bad');
    importNotesMock.mockRejectedValueOnce({
      error_type: 'FileSystem',
      message: '读取归档文件失败: invalid zip header',
    });
    const onOpenChange = vi.fn();
    const onImported = vi.fn();

    render(
      <WorkbenchNotesLibraryDialog
        open
        initialTab="import"
        onOpenChange={onOpenChange}
        onImported={onImported}
      />,
    );

    const fileInput = screen.getByTestId('notes-library-import-input') as HTMLInputElement;
    const badZip = new File(['not-a-zip'], 'corrupted.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [badZip] } });
    fireEvent.click(screen.getByTestId('confirm-import'));

    await waitFor(() => {
      expect(abortStagedUploadMock).toHaveBeenCalledWith('upload_zip_bad');
      expect(notifyMock).toHaveBeenCalledWith('error', '读取归档文件失败: invalid zip header');
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('rejects unsupported file extensions clearly instead of throwing bare import.failed', async () => {
    render(
      <WorkbenchNotesLibraryDialog
        open
        initialTab="import"
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    const fileInput = screen.getByTestId('notes-library-import-input') as HTMLInputElement;
    const pdfFile = new File(['%PDF-1.7'], 'slides.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });
    fireEvent.click(screen.getByTestId('confirm-import'));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith('error', '不支持的文件格式');
    });
    expect(stageBlobUploadMock).not.toHaveBeenCalled();
    expect(importNotesMock).not.toHaveBeenCalled();
  });
});
