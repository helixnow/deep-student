import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceCreators } from '../resourceCreators';
import { createEmpty } from '@/dstu';
import { createInk } from '@/features/ink';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { InkManifest } from '@/features/ink';

vi.mock('@/features/ink', () => ({ createInk: vi.fn() }));
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
});
