import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DstuNode } from '@/dstu';

const {
  addTextbooksMock,
  createMock,
  createFromStagedUploadMock,
  stagePathUploadMock,
  abortStagedUploadMock,
  notifyMock,
} = vi.hoisted(() => ({
  addTextbooksMock: vi.fn(),
  createMock: vi.fn(),
  createFromStagedUploadMock: vi.fn(),
  stagePathUploadMock: vi.fn(),
  abortStagedUploadMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({
  textbookDstuAdapter: { addTextbooks: addTextbooksMock },
}));

vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({
  attachmentDstuAdapter: {
    create: createMock,
    createFromStagedUpload: createFromStagedUploadMock,
  },
}));

vi.mock('@/utils/stagedUpload', () => ({
  stagePathUpload: stagePathUploadMock,
  stageBlobUpload: vi.fn(async () => 'staged_blob_1'),
  abortStagedUpload: abortStagedUploadMock,
  createByteBudgetLimiter: () => <T,>(_size: number, task: () => Promise<T>) => task(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  mimeTypeFromFileName: (name: string) => {
    if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (name.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return undefined;
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/features/learning-hub/textbookFileImport', () => ({
  canParseAsMobileTextbook: (ext: string) => !new Set(['xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'rtf']).has(ext),
  withStagedTextbookFile: async (file: File, run: (source: string) => Promise<unknown>) => run(`dstu-staged:${file.name}`),
}));

import { importPathsIntoLibrary, importDroppedFiles } from '../importActions';

function makeFileNode(id: string, name: string): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/${id}`,
    name,
    type: 'file',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const t = ((key: string, opts?: { defaultValue?: string; count?: number }) =>
  opts?.defaultValue ?? `${key}${opts?.count !== undefined ? `:${opts.count}` : ''}`) as never;

describe('S1-01(a) docx / xlsx import fallback & visible notifications', () => {
  beforeEach(() => {
    addTextbooksMock.mockReset();
    createMock.mockReset();
    createFromStagedUploadMock.mockReset();
    stagePathUploadMock.mockReset();
    abortStagedUploadMock.mockReset();
    notifyMock.mockReset();
  });

  it('routes .xlsx directly to VFS files and falls back skipped .docx from textbooks_add in importPathsIntoLibrary', async () => {
    addTextbooksMock.mockResolvedValueOnce({ ok: true, value: [] });
    stagePathUploadMock
      .mockResolvedValueOnce({ uploadId: 'u_xlsx', size: 1200 })
      .mockResolvedValueOnce({ uploadId: 'u_docx', size: 2400 });
    createFromStagedUploadMock
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_xlsx', '04-scores-1.xlsx') })
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_docx', '01-study-guide-1.docx') });

    const setAttachImportProgress = vi.fn();
    const handleRefresh = vi.fn(async () => {});

    await importPathsIntoLibrary({
      importProgress: { isImporting: false },
      currentPath: { viewKind: 'folder', folderId: 'fld_1', breadcrumbs: [], typeFilter: null } as never,
      t,
      currentCreatableFolderId: 'fld_1',
      importMarkdownPathNotes: vi.fn(),
      isMountedRef: { current: true },
      setImportProgress: vi.fn(),
      setAttachImportProgress,
      handleRefresh,
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    }, ['/tmp/01-study-guide-1.docx', '/tmp/04-scores-1.xlsx']);

    expect(addTextbooksMock).toHaveBeenCalledWith(['/tmp/01-study-guide-1.docx'], 'fld_1');
    expect(createFromStagedUploadMock).toHaveBeenCalledTimes(2);
    expect(createFromStagedUploadMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: '04-scores-1.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'file',
      { folderId: 'fld_1' },
    );
    expect(createFromStagedUploadMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: '01-study-guide-1.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      'file',
      { folderId: 'fld_1' },
    );
    expect(setAttachImportProgress).toHaveBeenCalledWith({ done: 0, total: 2 });
    expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String), undefined);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });

  it('imports .docx and .xlsx with empty File.type via VFS file fallback in importDroppedFiles and shows progress + notification', async () => {
    addTextbooksMock.mockResolvedValueOnce({ ok: true, value: [] });
    createMock
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_1', '01-study-guide-1.docx') })
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_2', '04-scores-1.xlsx') });

    const setAttachImportProgress = vi.fn();
    const handleRefresh = vi.fn(async () => {});
    const docx = new File(['docx-bytes'], '01-study-guide-1.docx', { type: '' });
    const xlsx = new File(['xlsx-bytes'], '04-scores-1.xlsx', { type: '' });

    await importDroppedFiles({
      pathsDropHandledRef: { current: false },
      currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
      t,
      importMarkdownFileObjects: vi.fn(),
      currentCreatableFolderId: null,
      isMountedRef: { current: true },
      setAttachImportProgress,
      handleRefresh,
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    }, [docx, xlsx], true);

    expect(setAttachImportProgress).toHaveBeenCalledWith({ done: 0, total: 2 });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenNthCalledWith(1, docx, 'file', {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(createMock).toHaveBeenNthCalledWith(2, xlsx, 'file', {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String));
    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });
});
