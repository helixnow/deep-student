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

import { importPathsIntoLibrary, importDroppedFiles, resolveUploadMimeType } from '../importActions';

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

  it('persists browser File objects (.pdf, .txt, .csv) without OS .path, falls back PDF when textbook staging fails, awaits refresh, and emits toast even if unmounted mid-flight', async () => {
    addTextbooksMock.mockResolvedValueOnce({
      ok: false,
      error: { toUserMessage: () => 'browser runtime cannot parse textbook directly' },
    });
    createMock
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_pdf', 'lecture.pdf') })
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_txt', 'notes.txt') })
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_csv', 'grades.csv') });

    let refreshSettled = false;
    const handleRefresh = vi.fn(async () => {
      await Promise.resolve();
      refreshSettled = true;
    });
    const isMountedRef = { current: true };

    const validPdfBytes = new TextEncoder().encode('%PDF-1.7\n' + '0'.repeat(120));
    const pdf = new File([validPdfBytes], 'lecture.pdf', { type: '' });
    const txt = new File(['plain study notes'], 'notes.txt', { type: '' });
    const csv = new File(['name,score\nAlice,98\n'], 'grades.csv', { type: '' });

    // Simulate view remount during async VFS persistence: toast + Finder refresh must NOT be swallowed
    createMock.mockImplementationOnce(async () => {
      isMountedRef.current = false;
      return { ok: true, value: makeFileNode('file_pdf', 'lecture.pdf') };
    });

    await importDroppedFiles({
      pathsDropHandledRef: { current: false },
      currentPath: { viewKind: 'folder', folderId: 'fld_course', breadcrumbs: [], typeFilter: null } as never,
      t,
      importMarkdownFileObjects: vi.fn(),
      currentCreatableFolderId: 'fld_course',
      isMountedRef,
      setAttachImportProgress: vi.fn(),
      handleRefresh,
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    }, [pdf, txt, csv], true);

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock).toHaveBeenNthCalledWith(1, pdf, 'file', {
      folderId: 'fld_course',
      mimeType: 'application/pdf',
    });
    expect(createMock).toHaveBeenNthCalledWith(2, txt, 'file', {
      folderId: 'fld_course',
      mimeType: 'text/plain',
    });
    expect(createMock).toHaveBeenNthCalledWith(3, csv, 'file', {
      folderId: 'fld_course',
      mimeType: 'text/csv',
    });
    expect(refreshSettled).toBe(true);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith('success', 'finder.dragDrop.importSuccess:3');
  });

  it('normalizes generic browser MIME types (octet-stream / zip / empty) to canonical Office & document MIMEs', () => {
    expect(resolveUploadMimeType('guide.docx', '')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveUploadMimeType('guide.docx', 'application/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveUploadMimeType('guide.docx', 'application/zip')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolveUploadMimeType('scores.xlsx', 'application/x-zip-compressed')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(resolveUploadMimeType('slides.pptx', 'binary/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(resolveUploadMimeType('sheet.ods', 'application/octet-stream')).toBe(
      'application/vnd.oasis.opendocument.spreadsheet',
    );
    expect(resolveUploadMimeType('captions.vtt', 'application/octet-stream')).toBe('text/vtt');
    expect(resolveUploadMimeType('mindmap.xmind', 'application/zip')).toBe('application/vnd.xmind.workbook');
  });

  it('imports .docx (application/zip) and .xlsx (application/octet-stream) cleanly via importDroppedFiles and reports errors visibly without silent drop', async () => {
    createMock
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_docx_zip', '01-study-guide.docx') })
      .mockResolvedValueOnce({ ok: true, value: makeFileNode('file_xlsx_bin', '04-scores.xlsx') });

    const setAttachImportProgress = vi.fn();
    const handleRefresh = vi.fn(async () => {});
    const docx = new File(['PK\x03\x04docx'], '01-study-guide.docx', { type: 'application/zip' });
    const xlsx = new File(['PK\x03\x04xlsx'], '04-scores.xlsx', { type: 'application/octet-stream' });

    await importDroppedFiles({
      pathsDropHandledRef: { current: false },
      currentPath: { viewKind: 'folder', folderId: 'fld_2', breadcrumbs: [], typeFilter: 'file' } as never,
      t,
      importMarkdownFileObjects: vi.fn(),
      currentCreatableFolderId: 'fld_2',
      isMountedRef: { current: true },
      setAttachImportProgress,
      handleRefresh,
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    }, [docx, xlsx], true);

    expect(createMock).toHaveBeenNthCalledWith(1, docx, 'file', {
      folderId: 'fld_2',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(createMock).toHaveBeenNthCalledWith(2, xlsx, 'file', {
      folderId: 'fld_2',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(setAttachImportProgress).toHaveBeenCalledWith({ done: 0, total: 2 });
    expect(setAttachImportProgress).toHaveBeenLastCalledWith(null);
    expect(notifyMock).toHaveBeenCalledWith('success', 'finder.dragDrop.importSuccess:2');
    expect(handleRefresh).toHaveBeenCalledTimes(1);

    // Failure case must surface visible error notification and clear progress
    notifyMock.mockReset();
    setAttachImportProgress.mockReset();
    createMock.mockRejectedValueOnce(new Error('storage write failed'));
    const badDocx = new File(['PK\x03\x04broken'], 'broken.docx', { type: 'application/octet-stream' });

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
    }, [badDocx], true);

    expect(setAttachImportProgress).toHaveBeenLastCalledWith(null);
    expect(notifyMock).toHaveBeenCalledWith('error', 'finder.dragDrop.importFailed', expect.any(String));
  });

  it('falls back .docx to VFS files even when textbookDstuAdapter.addTextbooks throws unexpectedly', async () => {
    addTextbooksMock.mockRejectedValueOnce(new Error('native parser crashed'));
    stagePathUploadMock.mockResolvedValueOnce({ uploadId: 'u_docx_throw', size: 1024 });
    createFromStagedUploadMock.mockResolvedValueOnce({
      ok: true,
      value: makeFileNode('file_docx_fb', 'syllabus.docx'),
    });

    const handleRefresh = vi.fn(async () => {});
    await importPathsIntoLibrary({
      importProgress: { isImporting: false },
      currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
      t,
      currentCreatableFolderId: null,
      importMarkdownPathNotes: vi.fn(),
      isMountedRef: { current: true },
      setImportProgress: vi.fn(),
      setAttachImportProgress: vi.fn(),
      handleRefresh,
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    }, ['/tmp/syllabus.docx']);

    expect(createFromStagedUploadMock).toHaveBeenCalledTimes(1);
    expect(createFromStagedUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'syllabus.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      'file',
      undefined,
    );
    expect(notifyMock).toHaveBeenCalledWith('success', 'finder.dragDrop.importSuccess:1', undefined);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });
});
