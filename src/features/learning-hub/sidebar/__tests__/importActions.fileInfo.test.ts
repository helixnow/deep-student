import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A1 导入分流回归夹具（RED）
 *
 * 失败的业务断言：Android SAF 的 opaque document ID 不含扩展名时，
 * importPathsIntoLibrary 仍按 URI 末段分到普通附件通道，导致 PDF/图片/
 * DOCX/PPTX 以 octet-stream + 无意义名称落库并无法预览。
 *
 * 期望契约（A2 最小接口）：
 *   invoke('resolve_import_file_info', { path }) -> {
 *     displayName: string,
 *     extension: string | null,
 *     mimeType: string,
 *     kind: 'document' | 'image' | 'media' | 'file',
 *   }
 * 分类必须使用该描述，而不是仅看 URI 最后一段。
 */

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { log: vi.fn(), error: vi.fn() } }));
vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({
  textbookDstuAdapter: { addTextbooks: vi.fn() },
}));
vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({
  attachmentDstuAdapter: { createFromStagedUpload: vi.fn() },
}));

import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { importPathsIntoLibrary } from '../importActions';

type ResolvedImportInfo = {
  displayName: string;
  extension: string | null;
  mimeType: string;
  kind: 'document' | 'image' | 'media' | 'file';
};

const PDF_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000045';
const PNG_OPAQUE =
  'content://com.android.providers.media.documents/document/image%3A1000000046';
const DOCX_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000047';
const PPTX_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000048';
const UNKNOWN_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000049';
const MARKDOWN_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000050';
const BROKEN_OPAQUE =
  'content://com.android.providers.downloads.documents/document/msf%3A1000000099';
const ENCODED_CHINESE_URI =
  'content://com.android.externalstorage.documents/document/primary%3ADownload%2F%E6%95%B0%E5%AD%A6%20%E8%AE%B2%E4%B9%89.pdf';
const NORMAL_LOCAL_PDF = '/home/student/Downloads/course-notes.pdf';
const LEGACY_NAMED_PDF = '/home/student/Downloads/legacy-named.pdf';

const STAGED_SIZE = 4096;

/** 手写的完整 native 描述；不使用被测代码推导 */
const RESOLVED_INFO = new Map<string, ResolvedImportInfo>([
  [PDF_OPAQUE, {
    displayName: 'course-notes.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    kind: 'document',
  }],
  [PNG_OPAQUE, {
    displayName: 'diagram.png',
    extension: 'png',
    mimeType: 'image/png',
    kind: 'image',
  }],
  [DOCX_OPAQUE, {
    displayName: 'lecture.docx',
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  }],
  [PPTX_OPAQUE, {
    displayName: 'slides.pptx',
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  }],
  [UNKNOWN_OPAQUE, {
    displayName: 'blob-7741.bin',
    extension: null,
    mimeType: 'application/octet-stream',
    kind: 'file',
  }],
  [MARKDOWN_OPAQUE, {
    displayName: 'lecture-note.md',
    extension: 'md',
    mimeType: 'text/markdown',
    kind: 'document',
  }],
  [ENCODED_CHINESE_URI, {
    displayName: '数学 讲义.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    kind: 'document',
  }],
  [NORMAL_LOCAL_PDF, {
    displayName: 'course-notes.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    kind: 'document',
  }],
]);

function makeNode(name: string, type: 'textbook' | 'image' | 'file') {
  const now = Date.now();
  return {
    id: `id-${name}`,
    sourceId: `id-${name}`,
    path: `/${name}`,
    name,
    type,
    size: STAGED_SIZE,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

function createContext() {
  return {
    importProgress: { isImporting: false },
    t: ((key: string, options?: unknown) =>
      options ? `${key}:${JSON.stringify(options)}` : key) as never,
    currentCreatableFolderId: 'folder-1',
    importMarkdownPathNotes: vi.fn(async () => ({
      importedNodes: [],
      failedCount: 0,
      firstError: undefined,
    })) as never,
    isMountedRef: { current: true },
    setImportProgress: vi.fn() as never,
    setAttachImportProgress: vi.fn() as never,
    handleRefresh: vi.fn(async () => undefined),
    openImportedMarkdownNote: vi.fn() as never,
    onOpenApp: vi.fn() as never,
  };
}

async function importPaths(paths: string[]) {
  const context = createContext();
  await importPathsIntoLibrary(context, paths);
  return context;
}

const addTextbooksMock = vi.mocked(textbookDstuAdapter.addTextbooks);
const createFromStagedMock = vi.mocked(attachmentDstuAdapter.createFromStagedUpload);

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockReset();

  invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === 'resolve_import_file_info') {
      const info = RESOLVED_INFO.get(args?.path ?? '');
      if (!info) throw new Error(`no native fixture for ${args?.path}`);
      return info;
    }
    if (command === 'staged_upload_from_path') {
      return { uploadId: 'staged-upload-1', size: STAGED_SIZE };
    }
    return null;
  });

  addTextbooksMock.mockResolvedValue({
    ok: true,
    value: [makeNode('course-notes.pdf', 'textbook')],
  } as never);
  createFromStagedMock.mockResolvedValue({
    ok: true,
    value: makeNode('created', 'file'),
  } as never);
});

describe('importPathsIntoLibrary resolved import info', () => {
  it('routes an opaque SAF PDF identified by native metadata to the document channel', async () => {
    const context = await importPaths([PDF_OPAQUE]);

    // 业务断言：如果仍按 URI 末段分类，PDF 会落进 attachment 通道。
    expect(addTextbooksMock).toHaveBeenCalledTimes(1);
    expect(addTextbooksMock).toHaveBeenCalledWith([PDF_OPAQUE], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
    // 进度横幅也必须使用 native 显示名，而不是 opaque ID/占位名。
    expect(context.setImportProgress).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'course-notes.pdf' }),
    );
  });

  it('routes an opaque SAF PNG identified by native metadata to the image channel', async () => {
    await importPaths([PNG_OPAQUE]);

    expect(addTextbooksMock).not.toHaveBeenCalled();
    expect(createFromStagedMock).toHaveBeenCalledTimes(1);
    expect(createFromStagedMock).toHaveBeenCalledWith(
      {
        uploadId: 'staged-upload-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: STAGED_SIZE,
      },
      'image',
      { folderId: 'folder-1' },
    );
  });

  it('routes an opaque SAF DOCX identified by native metadata to the document channel', async () => {
    addTextbooksMock.mockResolvedValue({
      ok: true,
      value: [makeNode('lecture.docx', 'textbook')],
    } as never);

    await importPaths([DOCX_OPAQUE]);

    expect(addTextbooksMock).toHaveBeenCalledTimes(1);
    expect(addTextbooksMock).toHaveBeenCalledWith([DOCX_OPAQUE], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });

  it('routes an opaque SAF PPTX identified by native metadata to the document channel', async () => {
    addTextbooksMock.mockResolvedValue({
      ok: true,
      value: [makeNode('slides.pptx', 'textbook')],
    } as never);

    await importPaths([PPTX_OPAQUE]);

    expect(addTextbooksMock).toHaveBeenCalledTimes(1);
    expect(addTextbooksMock).toHaveBeenCalledWith([PPTX_OPAQUE], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });

  it('keeps an unknown opaque binary as a file attachment with native display name and MIME', async () => {
    await importPaths([UNKNOWN_OPAQUE]);

    expect(addTextbooksMock).not.toHaveBeenCalled();
    expect(createFromStagedMock).toHaveBeenCalledWith(
      {
        uploadId: 'staged-upload-1',
        name: 'blob-7741.bin',
        mimeType: 'application/octet-stream',
        size: STAGED_SIZE,
      },
      'file',
      { folderId: 'folder-1' },
    );
  });

  it('routes an opaque SAF markdown file through resolved display name into the note importer', async () => {
    const context = await importPaths([MARKDOWN_OPAQUE]);

    expect(context.importMarkdownPathNotes).toHaveBeenCalledWith([MARKDOWN_OPAQUE], 'folder-1');
    expect(addTextbooksMock).not.toHaveBeenCalled();
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });

  it('fails an opaque URI explicitly when native resolution fails instead of importing octet-stream', async () => {
    await importPaths([BROKEN_OPAQUE]);

    expect(addTextbooksMock).not.toHaveBeenCalled();
    expect(createFromStagedMock).not.toHaveBeenCalled();
    expect(showGlobalNotification).toHaveBeenCalledWith(
      'error',
      'finder.dragDrop.importFailed',
      expect.stringContaining('finder.dragDrop.readFileFailed'),
    );
  });

  it('asks native for the resolved descriptor before classifying a path', async () => {
    await importPaths([PDF_OPAQUE]);

    expect(invokeMock).toHaveBeenCalledWith('resolve_import_file_info', { path: PDF_OPAQUE });
  });
});

describe('importPathsIntoLibrary preserved extension behavior', () => {
  it('keeps a normal local PDF path in the document channel', async () => {
    await importPaths([NORMAL_LOCAL_PDF]);

    expect(addTextbooksMock).toHaveBeenCalledWith([NORMAL_LOCAL_PDF], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });

  it('falls back to the named extension when native resolution fails', async () => {
    await importPaths([LEGACY_NAMED_PDF]);

    expect(addTextbooksMock).toHaveBeenCalledWith([LEGACY_NAMED_PDF], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });

  it('keeps a percent-encoded Chinese filename with spaces in the document channel', async () => {
    await importPaths([ENCODED_CHINESE_URI]);

    expect(addTextbooksMock).toHaveBeenCalledWith([ENCODED_CHINESE_URI], 'folder-1');
    expect(createFromStagedMock).not.toHaveBeenCalled();
  });
});
