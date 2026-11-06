import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceCreators } from '../resourceCreators';
import { createEmpty } from '@/dstu';
import { createInk, createInkBoard } from '@/features/ink';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { InkManifest } from '@/features/ink';
import type { InkBoardManifest } from '@/features/ink/types';

const inkMocks = vi.hoisted(() => ({
  createInk: vi.fn(),
  createInkBoard: vi.fn(),
}));

vi.mock('@/features/ink', () => ({
  createInk: inkMocks.createInk,
  createInkBoard: inkMocks.createInkBoard,
}));
vi.mock('@/dstu', async () => {
  const actual = await vi.importActual<typeof import('@/dstu')>('@/dstu');
  return { ...actual, createEmpty: vi.fn() };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { error: vi.fn() } }));

const manifest: InkManifest = {
  schema_version: 1,
  document_id: 'stable-ink-file-id',
  revision: 'revision-1',
  title: '手写笔记',
  source: { kind: 'blank' },
  pages: [],
};

const boardManifest: InkBoardManifest = {
  schema_version: 2,
  document_id: 'stable-board-file-id',
  revision: 'revision-board-1',
  title: '手写画板',
  source: { kind: 'blank' },
  pages: [],
  surface: {
    kind: 'board',
    page_id: 'board-page-1',
    ruling: 'blank',
    bounds: { x: -1000, y: -1000, width: 2000, height: 2000 },
  },
  chunks: [],
};

type InkWay = (folderId?: string | null, mode?: string) => Promise<void>;

function createInkWithMode(creators: ReturnType<typeof createCreators>['creators'], mode: string) {
  return (creators.handleNewInk as unknown as InkWay)(undefined, mode);
}

function boardCreateCalls() {
  return inkMocks.createInkBoard.mock.calls;
}

function resolveBoardCreate() {
  inkMocks.createInkBoard.mockResolvedValue(boardManifest);
}

function rejectBoardCreate(error: Error) {
  inkMocks.createInkBoard.mockRejectedValue(error);
}

function createCreators(overrides: { onOpenApp?: (item: any) => void } = {}) {
  const refresh = vi.fn(async () => undefined);
  const openApp = overrides.onOpenApp ?? vi.fn();
  const creators = createResourceCreators({
    ensureCreatableView: () => true,
    currentCreatableFolderId: 'folder-42',
    isMountedRef: { current: true },
    t: ((key: string) => key === 'finder.toolbar.newInk' ? '手写笔记' : key === 'finder.create.inkSuccess' ? '手写笔记创建成功' : key === 'finder.create.inkError' ? '手写笔记创建失败' : key) as never,
    handleRefresh: refresh,
    onOpenApp: openApp,
    setSelectedIds: vi.fn(),
    importProgress: { isImporting: false } as never,
    importPaths: vi.fn(async () => undefined),
  });
  return { creators, refresh, openApp };
}

describe('createResourceCreators handwriting note', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates through inkApi and opens the resource using its stable file ID', async () => {
    vi.mocked(createInk).mockResolvedValue(manifest);
    const { creators, refresh, openApp } = createCreators();

    await creators.handleNewInk();

    expect(createInk).toHaveBeenCalledWith({
      title: '手写笔记',
      ruling: 'blank',
      width: 794,
      height: 1123,
      operation_id: expect.any(String),
      folder_id: 'folder-42',
    });
    expect(vi.mocked(createInk).mock.calls[0][0].operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(createEmpty).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(openApp).toHaveBeenCalledWith(expect.objectContaining({
      id: 'stable-ink-file-id',
      title: '手写笔记',
      type: 'file',
      previewType: 'ink',
    }));
  });

  it('reports creation failures without opening a resource', async () => {
    vi.mocked(createInk).mockRejectedValue(new Error('ink service unavailable'));
    const { creators, openApp } = createCreators();

    await creators.handleNewInk();

    expect(openApp).not.toHaveBeenCalled();
  });

  it('creates an explicit board mode document through createInkBoard and opens the same VFS document', async () => {
    resolveBoardCreate();
    const { creators, refresh, openApp } = createCreators();

    await createInkWithMode(creators, 'board');

    expect(boardCreateCalls()).toHaveLength(1);
    expect(createInkBoard).toHaveBeenCalledTimes(1);
    expect(boardCreateCalls()[0][0]).toEqual({
      title: '手写笔记',
      ruling: 'blank',
      operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      folder_id: 'folder-42',
    });
    expect(boardCreateCalls()[0][0]).not.toHaveProperty('width');
    expect(boardCreateCalls()[0][0]).not.toHaveProperty('height');
    expect(createInk).not.toHaveBeenCalled();
    expect(createEmpty).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(openApp).toHaveBeenCalledWith(expect.objectContaining({
      id: 'stable-board-file-id',
      title: '手写画板',
      type: 'file',
      previewType: 'ink',
    }));
  });

  it('fails closed for an unknown mode and a board creation error without falling back to paged create', async () => {
    const unknown = createCreators();
    await createInkWithMode(unknown.creators, 'future-mode');
    expect(createInk).not.toHaveBeenCalled();
    expect(boardCreateCalls()).toHaveLength(0);
    expect(unknown.openApp).not.toHaveBeenCalled();

    vi.clearAllMocks();
    rejectBoardCreate(new Error('board service unavailable'));
    const failed = createCreators();
    await createInkWithMode(failed.creators, 'board');

    expect(createInk).not.toHaveBeenCalled();
    expect(boardCreateCalls()).toHaveLength(1);
    expect(createInkBoard).toHaveBeenCalledTimes(1);
    expect(failed.openApp).not.toHaveBeenCalled();
    expect(showGlobalNotification).toHaveBeenCalledWith('error', '手写笔记创建失败');
  });
});
