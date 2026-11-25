import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const {
  createEmptyMock,
  createFolderMock,
  renameFolderMock,
  dialogOpenMock,
  pickWebViewFilesMock,
  notifyMock,
  listenMock,
  addTextbooksMock,
  createAttachmentMock,
  stagePathUploadMock,
  createFromStagedUploadMock,
} = vi.hoisted(() => ({
  createEmptyMock: vi.fn(),
  createFolderMock: vi.fn(),
  renameFolderMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  pickWebViewFilesMock: vi.fn(),
  notifyMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  addTextbooksMock: vi.fn(),
  createAttachmentMock: vi.fn(),
  stagePathUploadMock: vi.fn(),
  createFromStagedUploadMock: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  createEmpty: createEmptyMock,
  folderApi: {
    createFolder: createFolderMock,
    renameFolder: renameFolderMock,
  },
  dstu: {
    rename: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpenMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/utils/pickWebViewFiles', () => ({ pickWebViewFiles: pickWebViewFilesMock }));
vi.mock('@/utils/platform', () => ({
  isAndroidMobileShell: () => false,
  isWebUiShell: () => false,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: notifyMock }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));
vi.mock('@/dstu/adapters/textbookDstuAdapter', () => ({
  textbookDstuAdapter: { addTextbooks: addTextbooksMock },
}));
vi.mock('@/dstu/adapters/attachmentDstuAdapter', () => ({
  attachmentDstuAdapter: {
    create: createAttachmentMock,
    createFromStagedUpload: createFromStagedUploadMock,
  },
}));
vi.mock('@/utils/stagedUpload', () => ({
  stagePathUpload: stagePathUploadMock,
  abortStagedUpload: vi.fn(async () => {}),
  createByteBudgetLimiter: () => <T,>(_size: number, task: () => Promise<T>) => task(),
}));
vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  mimeTypeFromFileName: () => 'text/plain',
}));
vi.mock('@/features/learning-hub/textbookFileImport', () => ({
  canParseAsMobileTextbook: () => true,
  withStagedTextbookFile: async (file: File, run: (source: string) => Promise<unknown>) =>
    run(`dstu-staged:${file.name}`),
}));

import { createResourceCreators } from '../resourceCreators';
import { beginPendingFolderDraft, confirmInlineEdit } from '../inlineEditActions';
import {
  importDroppedFiles,
  importPathsIntoLibrary,
  isImportActionInFlight,
} from '../importActions';
import { PENDING_FOLDER_ID_PREFIX, type PendingFolderDraft } from '../sidebarConstants';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeNode(id: string, name: string, type: DstuNode['type'] = 'note'): DstuNode {
  return {
    id,
    sourceId: id,
    path: `/${id}`,
    name,
    type,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as never;

describe('U03 Learning Hub sidebar rapid-click idempotency & busy-state reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockResolvedValue(() => {});
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('prevents rapid double-click on Create Note across re-renders and always releases lock on error', async () => {
    const slowCreate = deferred<{ ok: true; value: DstuNode }>();
    createEmptyMock.mockReturnValueOnce(slowCreate.promise);

    const isMountedRef = { current: true };
    const handleRefresh = vi.fn(async () => {});
    const onOpenApp = vi.fn();
    const baseCtx = {
      ensureCreatableView: () => true,
      currentCreatableFolderId: 'fld_1',
      isMountedRef,
      t,
      handleRefresh,
      onOpenApp,
      setSelectedIds: vi.fn(),
      importProgress: { isImporting: false, fileName: '', stage: 'hashing', progress: 0 } as never,
      importPaths: vi.fn(async () => {}),
      importFiles: vi.fn(async () => {}),
    };

    const creatorsRender1 = createResourceCreators(baseCtx);
    // Simulate component re-render rebuilding handlers with the same isMountedRef
    const creatorsRender2 = createResourceCreators(baseCtx);

    const p1 = creatorsRender1.handleNewNote();
    const p2 = creatorsRender2.handleNewNote();

    expect(createEmptyMock).toHaveBeenCalledTimes(1);

    slowCreate.resolve({ ok: true, value: makeNode('note_1', '无标题笔记', 'note') });
    await Promise.all([p1, p2]);
    expect(handleRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledTimes(1);

    // Rejecting IPC must release lock in finally so user can retry immediately
    createEmptyMock.mockRejectedValueOnce(new Error('network error'));
    await creatorsRender1.handleNewNote();
    expect(notifyMock).toHaveBeenCalledWith('error', 'network error');

    createEmptyMock.mockResolvedValueOnce({ ok: true, value: makeNode('note_2', '重试笔记', 'note') });
    await creatorsRender1.handleNewNote();
    expect(createEmptyMock).toHaveBeenCalledTimes(3);
  });

  it('prevents rapid double-click on Create Folder draft and deduplicates identical in-flight folder creation', async () => {
    const isMountedRef = { current: true };
    const pendingFolderSequenceRef = { current: 0 };
    const pendingFolderDraftRef: { current: PendingFolderDraft | null } = { current: null };
    const setPendingFolderDraft = vi.fn();
    const startInlineEdit = vi.fn();
    const cancelInlineEdit = vi.fn();
    const clearSelection = vi.fn();

    const draftCtx = {
      ensureCreatableView: () => true,
      isMountedRef,
      cancelInlineEdit,
      clearSelection,
      pendingFolderSequenceRef,
      currentCreatableFolderId: 'fld_parent',
      pendingFolderDraftRef,
      setPendingFolderDraft,
      startInlineEdit,
    };

    // Rapid double-click on "新建文件夹" opens only 1 draft
    beginPendingFolderDraft(draftCtx);
    beginPendingFolderDraft(draftCtx);
    expect(startInlineEdit).toHaveBeenCalledTimes(1);
    expect(pendingFolderSequenceRef.current).toBe(1);

    // Concurrent identical folder creation under weak network latency fires IPC only once
    const slowFolder = deferred<{ ok: true; value: DstuNode }>();
    createFolderMock.mockReturnValueOnce(slowFolder.promise);
    const handleRefresh = vi.fn(async () => {});

    const draft1Id = `${PENDING_FOLDER_ID_PREFIX}1`;
    const p1 = confirmInlineEdit(
      {
        cancelInlineEdit,
        pendingFolderDraftRef,
        setPendingFolderDraft,
        isMountedRef,
        t,
        handleRefresh,
        items: [],
        inlineEdit: { editingType: 'folder' },
        mode: 'fullscreen',
      },
      draft1Id,
      '微积分资料',
    );

    // Simulate a second draft attempting the exact same folder creation while first IPC is in flight
    const draft2Id = `${PENDING_FOLDER_ID_PREFIX}2`;
    pendingFolderDraftRef.current = {
      node: makeNode(draft2Id, '', 'folder'),
      parentFolderId: 'fld_parent',
    };
    const p2 = confirmInlineEdit(
      {
        cancelInlineEdit,
        pendingFolderDraftRef,
        setPendingFolderDraft,
        isMountedRef,
        t,
        handleRefresh,
        items: [],
        inlineEdit: { editingType: 'folder' },
        mode: 'fullscreen',
      },
      draft2Id,
      '微积分资料',
    );

    expect(createFolderMock).toHaveBeenCalledTimes(1);
    slowFolder.resolve({ ok: true, value: makeNode('fld_new', '微积分资料', 'folder') });
    await Promise.all([p1, p2]);

    // Failure releases lock in finally so user can retry creating the same folder name
    createFolderMock.mockRejectedValueOnce(new Error('ipc timeout'));
    const draft3Id = `${PENDING_FOLDER_ID_PREFIX}3`;
    pendingFolderDraftRef.current = {
      node: makeNode(draft3Id, '', 'folder'),
      parentFolderId: 'fld_parent',
    };
    await confirmInlineEdit(
      {
        cancelInlineEdit,
        pendingFolderDraftRef,
        setPendingFolderDraft,
        isMountedRef,
        t,
        handleRefresh,
        items: [],
        inlineEdit: { editingType: 'folder' },
        mode: 'fullscreen',
      },
      draft3Id,
      '微积分资料',
    );
    expect(notifyMock).toHaveBeenCalledWith('error', 'ipc timeout');

    createFolderMock.mockResolvedValueOnce({ ok: true, value: makeNode('fld_retry', '微积分资料', 'folder') });
    const draft4Id = `${PENDING_FOLDER_ID_PREFIX}4`;
    pendingFolderDraftRef.current = {
      node: makeNode(draft4Id, '', 'folder'),
      parentFolderId: 'fld_parent',
    };
    await confirmInlineEdit(
      {
        cancelInlineEdit,
        pendingFolderDraftRef,
        setPendingFolderDraft,
        isMountedRef,
        t,
        handleRefresh,
        items: [],
        inlineEdit: { editingType: 'folder' },
        mode: 'fullscreen',
      },
      draft4Id,
      '微积分资料',
    );
    expect(createFolderMock).toHaveBeenCalledTimes(3);
  });

  it('blocks duplicate concurrent importPathsIntoLibrary calls and always resets busy progress in finally on error', async () => {
    const isMountedRef = { current: true };
    const setImportProgress = vi.fn();
    const setAttachImportProgress = vi.fn();
    const slowAdd = deferred<{ ok: true; value: DstuNode[] }>();
    addTextbooksMock.mockReturnValueOnce(slowAdd.promise);

    const ctx = {
      importProgress: { isImporting: false },
      currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
      t,
      currentCreatableFolderId: null,
      importMarkdownPathNotes: vi.fn(),
      isMountedRef,
      setImportProgress,
      setAttachImportProgress,
      handleRefresh: vi.fn(async () => {}),
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    };

    // Rapid double call before React state flips importProgress.isImporting
    const p1 = importPathsIntoLibrary(ctx, ['/tmp/notes.pdf']);
    const p2 = importPathsIntoLibrary(ctx, ['/tmp/notes.pdf']);
    expect(isImportActionInFlight(isMountedRef)).toBe(true);

    slowAdd.resolve({ ok: true, value: [makeNode('tb_1', 'notes.pdf', 'textbook')] });
    await Promise.all([p1, p2]);
    expect(addTextbooksMock).toHaveBeenCalledTimes(1);
    expect(isImportActionInFlight(isMountedRef)).toBe(false);

    // Abort / error during listen() must STILL reset importProgress.isImporting and release lock in finally
    setImportProgress.mockClear();
    listenMock.mockRejectedValueOnce(new Error('event bridge aborted'));
    await importPathsIntoLibrary(ctx, ['/tmp/aborted.pdf']);

    expect(isImportActionInFlight(isMountedRef)).toBe(false);
    expect(setImportProgress).toHaveBeenCalled();
    const lastUpdater = setImportProgress.mock.calls[setImportProgress.mock.calls.length - 1]?.[0];
    expect(typeof lastUpdater).toBe('function');
    expect(lastUpdater({ isImporting: true, fileName: 'aborted.pdf', stage: 'hashing', progress: 0 })).toEqual(
      expect.objectContaining({ isImporting: false }),
    );
  });

  it('deduplicates concurrent importDroppedFiles, blocks handleNewTextbook while importing, and resets attach progress on error', async () => {
    const isMountedRef = { current: true };
    const setAttachImportProgress = vi.fn();
    const slowCreate = deferred<{ ok: true; value: DstuNode }>();
    createAttachmentMock.mockReturnValueOnce(slowCreate.promise);

    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const dropCtx = {
      pathsDropHandledRef: { current: false },
      currentPath: { viewKind: 'folder', folderId: null, breadcrumbs: [], typeFilter: null } as never,
      t,
      importMarkdownFileObjects: vi.fn(),
      currentCreatableFolderId: null,
      isMountedRef,
      setAttachImportProgress,
      handleRefresh: vi.fn(async () => {}),
      openImportedMarkdownNote: vi.fn(),
      onOpenApp: vi.fn(),
    };

    const p1 = importDroppedFiles(dropCtx, [file], true);
    const p2 = importDroppedFiles(dropCtx, [file], true);

    // While importDroppedFiles is in flight, clicking "导入" via handleNewTextbook must be blocked cleanly
    const creators = createResourceCreators({
      ensureCreatableView: () => true,
      currentCreatableFolderId: null,
      isMountedRef,
      t,
      handleRefresh: async () => {},
      onOpenApp: undefined,
      setSelectedIds: vi.fn(),
      importProgress: { isImporting: false, fileName: '', stage: 'hashing', progress: 0 } as never,
      importPaths: vi.fn(async () => {}),
      importFiles: vi.fn(async () => {}),
    });
    await creators.handleNewTextbook();
    expect(pickWebViewFilesMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith('info', '正在导入中，请稍候…');

    slowCreate.resolve({ ok: true, value: makeNode('file_1', 'notes.txt', 'file') });
    await Promise.all([p1, p2]);
    expect(createAttachmentMock).toHaveBeenCalledTimes(1);
    expect(isImportActionInFlight(isMountedRef)).toBe(false);
    expect(setAttachImportProgress).toHaveBeenLastCalledWith(null);

    // If handleRefresh throws after import, finally must still release lock & ensure progress is cleared
    createAttachmentMock.mockResolvedValueOnce({ ok: true, value: makeNode('file_2', 'notes2.txt', 'file') });
    const throwingRefresh = vi.fn(async () => {
      throw new Error('refresh aborted');
    });
    await expect(
      importDroppedFiles({ ...dropCtx, handleRefresh: throwingRefresh }, [file], true),
    ).rejects.toThrow('refresh aborted');
    expect(isImportActionInFlight(isMountedRef)).toBe(false);
    expect(setAttachImportProgress).toHaveBeenLastCalledWith(null);
  });
});
