/**
 * finderStore.enterFolder — 乐观导航 + 面包屑回填测试
 *
 * P0 契约：
 * 1. 点击文件夹立即导航（不等 getBreadcrumbs 网络往返），面包屑先用乐观值；
 * 2. 后端真实 ID 链到达后原地回填 currentPath 与对应历史栈条目；
 * 3. 回填到达前用户已导航去别处 → 丢弃回填（不污染新路径）；
 * 4. 后端失败（空面包屑）→ 保留乐观面包屑，标题不闪回根目录。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBreadcrumbsMock } = vi.hoisted(() => ({
  getBreadcrumbsMock: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  folderApi: { getBreadcrumbs: getBreadcrumbsMock },
  trashApi: { listTrash: vi.fn(async () => ({ ok: true, value: [] })) },
}));

vi.mock('@/dstu/api', () => ({
  dstu: {
    list: vi.fn(async () => ({ ok: true, value: [] })),
    search: vi.fn(async () => ({ ok: true, value: [] })),
    searchInFolder: vi.fn(async () => ({ ok: true, value: [] })),
    listDeleted: vi.fn(async () => ({ ok: true, value: [] })),
    get: vi.fn(async () => ({ ok: true, value: null })),
  },
}));

vi.mock('@/i18n', () => ({ default: { language: 'en-US' } }));

import { useFinderStore } from '../finderStore';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('finderStore.enterFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFinderStore.getState().reset();
  });

  it('先乐观导航：await 面包屑前 currentPath 即已切换', async () => {
    const backend = deferred<{ ok: true; value: Array<{ id: string; name: string }> }>();
    getBreadcrumbsMock.mockReturnValue(backend.promise);

    const enterPromise = useFinderStore.getState().enterFolder('fld_child', '子文件夹');

    // 未 resolve 后端请求，导航已生效（乐观面包屑 = 当前面包屑 + 该文件夹）
    const state = useFinderStore.getState();
    expect(state.currentPath.viewKind).toBe('folder');
    expect(state.currentPath.folderId).toBe('fld_child');
    expect(state.currentPath.breadcrumbs).toEqual([
      { id: 'fld_child', name: '子文件夹', dstuPath: '/子文件夹' },
    ]);
    // 历史栈已推入新条目
    expect(state.historyIndex).toBe(1);

    backend.resolve({
      ok: true,
      value: [
        { id: 'fld_parent', name: '父文件夹' },
        { id: 'fld_child', name: '子文件夹（真名）' },
      ],
    });
    await enterPromise;

    // 真实 ID 链回填 currentPath 与历史栈当前条目
    const after = useFinderStore.getState();
    expect(after.currentPath.breadcrumbs).toEqual([
      { id: 'fld_parent', name: '父文件夹', dstuPath: '/父文件夹' },
      { id: 'fld_child', name: '子文件夹（真名）', dstuPath: '/父文件夹/子文件夹（真名）' },
    ]);
    expect(after.history[after.historyIndex]).toBe(after.currentPath);
  });

  it('从子文件夹继续进入时，乐观面包屑基于当前面包屑追加', async () => {
    getBreadcrumbsMock.mockResolvedValueOnce({
      ok: true,
      value: [{ id: 'fld_a', name: 'A' }],
    });
    await useFinderStore.getState().enterFolder('fld_a', 'A');

    const backend = deferred<{ ok: true; value: Array<{ id: string; name: string }> }>();
    getBreadcrumbsMock.mockReturnValue(backend.promise);
    const enterPromise = useFinderStore.getState().enterFolder('fld_b', 'B');

    expect(useFinderStore.getState().currentPath.breadcrumbs).toEqual([
      { id: 'fld_a', name: 'A', dstuPath: '/A' },
      { id: 'fld_b', name: 'B', dstuPath: '/A/B' },
    ]);

    backend.resolve({ ok: true, value: [{ id: 'fld_a', name: 'A' }, { id: 'fld_b', name: 'B' }] });
    await enterPromise;
  });

  it('回填到达前已导航去别处 → 丢弃过期回填', async () => {
    const backend = deferred<{ ok: true; value: Array<{ id: string; name: string }> }>();
    getBreadcrumbsMock.mockReturnValue(backend.promise);

    const enterPromise = useFinderStore.getState().enterFolder('fld_slow', '慢文件夹');

    // 用户等不及，跳回根目录
    useFinderStore.getState().jumpToBreadcrumb(-1);
    expect(useFinderStore.getState().currentPath.folderId).toBeNull();

    backend.resolve({ ok: true, value: [{ id: 'fld_slow', name: '慢文件夹' }] });
    await enterPromise;

    // 过期回填被丢弃：当前仍在根目录，面包屑为空
    const state = useFinderStore.getState();
    expect(state.currentPath.folderId).toBeNull();
    expect(state.currentPath.breadcrumbs).toEqual([]);
  });

  it('后端面包屑失败（空结果）→ 保留乐观面包屑', async () => {
    getBreadcrumbsMock.mockResolvedValueOnce({ ok: true, value: [] });

    await useFinderStore.getState().enterFolder('fld_x', 'X');

    const state = useFinderStore.getState();
    expect(state.currentPath.folderId).toBe('fld_x');
    expect(state.currentPath.breadcrumbs).toEqual([
      { id: 'fld_x', name: 'X', dstuPath: '/X' },
    ]);
  });

  it('未提供 folderName 时以 folderId 占位，回填后替换为真名', async () => {
    const backend = deferred<{ ok: true; value: Array<{ id: string; name: string }> }>();
    getBreadcrumbsMock.mockReturnValue(backend.promise);

    const enterPromise = useFinderStore.getState().enterFolder('fld_anon');
    expect(useFinderStore.getState().currentPath.breadcrumbs[0]?.name).toBe('fld_anon');

    backend.resolve({ ok: true, value: [{ id: 'fld_anon', name: '真实名称' }] });
    await enterPromise;
    expect(useFinderStore.getState().currentPath.breadcrumbs[0]?.name).toBe('真实名称');
  });
});
