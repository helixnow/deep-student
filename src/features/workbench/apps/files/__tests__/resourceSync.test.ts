/**
 * 资源删除联动测试（P8）
 *
 * DSTU deleted/purged 事件 → 关闭 instanceKey 指向该资源的资源应用窗口；
 * 非资源应用（chat 等）与其他资源的窗口不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuWatchEvent } from '@/dstu/types';
import { VfsError, VfsErrorCode } from '@/shared/result';

type WatchCallback = (event: DstuWatchEvent) => void;

const watchState: { callbacks: WatchCallback[]; unwatchCount: number } = {
  callbacks: [],
  unwatchCount: 0,
};
const missingResourceIds = new Set<string>();
const failingResourceIds = new Set<string>();

vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(async (path: string) => {
      const id = path.split('/').filter(Boolean).pop() ?? '';
      if (failingResourceIds.has(id)) {
        return { ok: false, error: new VfsError(VfsErrorCode.UNKNOWN, 'temporary failure') };
      }
      return missingResourceIds.has(id)
        ? { ok: false, error: new VfsError(VfsErrorCode.NOT_FOUND, 'not found') }
        : { ok: true, value: { id } };
    }),
    watch: (_path: string, cb: WatchCallback) => {
      watchState.callbacks.push(cb);
      return () => {
        watchState.callbacks = watchState.callbacks.filter((fn) => fn !== cb);
        watchState.unwatchCount += 1;
      };
    },
  },
}));

import { useWindowStore } from '../../../core/windowStore';
import { appRegistry } from '../../../core/appRegistry';
import { createContentApp } from '../../content/createContentApp';
import {
  __resetContentDirtyRegistry,
  registerContentDirtyChecker,
} from '../../content/contentDirtyRegistry';
import {
  closeWindowsForDeletedResource,
  closeWorkspaceTabsForDeletedResource,
  extractResourceIdFromPath,
  reconcileDeletedResourceWindows,
  startResourceSync,
  stopResourceSync,
} from '../resourceSync';
import {
  registerWorkspaceHost,
  resetWorkspaceRegistryForTests,
  type NotesWorkspaceResourceRef,
} from '../../notes/workspaceRegistry';
import '../../notes/register';

function emit(event: DstuWatchEvent): void {
  for (const cb of [...watchState.callbacks]) cb(event);
}

function resetStore(): void {
  const state = useWindowStore.getState();
  for (const id of Object.keys(state.windows)) {
    state.closeWindow(id);
  }
}

describe('extractResourceIdFromPath', () => {
  it('取路径末段作为资源 ID', () => {
    expect(extractResourceIdFromPath('/note_1')).toBe('note_1');
    expect(extractResourceIdFromPath('/folder/sub/note_2')).toBe('note_2');
    expect(extractResourceIdFromPath('note_3')).toBe('note_3');
  });

  it('空路径返回 null', () => {
    expect(extractResourceIdFromPath(undefined)).toBeNull();
    expect(extractResourceIdFromPath('')).toBeNull();
    expect(extractResourceIdFromPath('/')).toBeNull();
  });
});

describe('resourceSync', () => {
  beforeEach(() => {
    stopResourceSync();
    watchState.callbacks = [];
    watchState.unwatchCount = 0;
    missingResourceIds.clear();
    failingResourceIds.clear();
    __resetContentDirtyRegistry();
    resetWorkspaceRegistryForTests();
    resetStore();
  });

  afterEach(() => {
    stopResourceSync();
    vi.restoreAllMocks();
    __resetContentDirtyRegistry();
    resetWorkspaceRegistryForTests();
    resetStore();
  });

  it('deleted 事件只关闭对应内部标签，Notes 单例与其他窗口保留', async () => {
    const store = useWindowStore.getState();
    const notesWin = store.openWindow({ typeId: 'notes' });
    const openResources: NotesWorkspaceResourceRef[] = [
      { type: 'note', id: 'note_1' },
      { type: 'mindmap', id: 'mm_1' },
    ];
    registerWorkspaceHost(notesWin, {
      openResource: vi.fn(),
      closeResource: (resource) => {
        const index = openResources.findIndex(
          (item) => item.type === resource.type && item.id === resource.id,
        );
        if (index >= 0) openResources.splice(index, 1);
      },
      listResources: () => openResources,
    });
    // chat 不属于资源应用群，即使 instanceKey 撞名也不应被关
    const chatWin = store.openWindow({ typeId: 'chat', instanceKey: 'note_1' });

    startResourceSync();
    emit({ type: 'deleted', path: '/folder/note_1' });
    await vi.waitFor(() => expect(openResources).toEqual([{ type: 'mindmap', id: 'mm_1' }]));

    const windows = useWindowStore.getState().windows;
    expect(windows[notesWin]).toBeDefined();
    expect(windows[chatWin]).toBeDefined();
  });

  it('purged 事件同样关闭 mindmap 标签', async () => {
    const store = useWindowStore.getState();
    const notesWin = store.openWindow({ typeId: 'notes' });
    const closeResource = vi.fn();
    registerWorkspaceHost(notesWin, { openResource: vi.fn(), closeResource });

    startResourceSync();
    emit({ type: 'purged', path: '/mm_9' });

    await vi.waitFor(() =>
      expect(closeResource).toHaveBeenCalledWith({ type: 'mindmap', id: 'mm_9' }),
    );
    expect(useWindowStore.getState().windows[notesWin]).toBeDefined();
  });

  it('updated/moved 等事件不关闭标签', async () => {
    const store = useWindowStore.getState();
    const notesWin = store.openWindow({ typeId: 'notes' });
    const closeResource = vi.fn();
    registerWorkspaceHost(notesWin, { openResource: vi.fn(), closeResource });

    startResourceSync();
    emit({ type: 'updated', path: '/note_2' });
    emit({ type: 'moved', path: '/elsewhere/note_2', oldPath: '/note_2' });

    await Promise.resolve();
    expect(closeResource).not.toHaveBeenCalled();
  });

  it('同一资源多窗（不同 typeId 撞 instanceKey）全部关闭', () => {
    const store = useWindowStore.getState();
    const a = store.openWindow({ typeId: 'image', instanceKey: 'att_1' });
    const b = store.openWindow({ typeId: 'file', instanceKey: 'att_1' });

    startResourceSync();
    expect(closeWindowsForDeletedResource('att_1')).toBe(2);
    const windows = useWindowStore.getState().windows;
    expect(windows[a]).toBeUndefined();
    expect(windows[b]).toBeUndefined();
  });

  it('路径别名按同一资源处理', () => {
    const store = useWindowStore.getState();
    const noteWin = store.openWindow({ typeId: 'image', instanceKey: '/folder/note_alias' });

    expect(closeWindowsForDeletedResource('note_alias')).toBe(1);
    expect(useWindowStore.getState().windows[noteWin]).toBeUndefined();
  });

  it('dirty checker 取消关闭时保留窗口与内存草稿', () => {
    const store = useWindowStore.getState();
    const noteWin = store.openWindow({ typeId: 'translation', instanceKey: 'note_dirty' });
    const definition = createContentApp({
      typeId: 'translation',
      nameKey: 'workbench:apps.translation',
      icon: null,
      memoryWeight: 2,
      defaultFrame: { w: 800, h: 600 },
      confirmUnsavedOnClose: true,
    });
    vi.spyOn(appRegistry, 'get').mockImplementation((typeId) =>
      typeId === 'translation' ? definition : undefined,
    );
    registerContentDirtyChecker('translation', '/folder/note_dirty', () => true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    expect(closeWindowsForDeletedResource('/note_dirty')).toBe(0);
    expect(useWindowStore.getState().windows[noteWin]).toBeDefined();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it('文件夹或批量事件通过存活性复核关闭后代资源窗', async () => {
    const store = useWindowStore.getState();
    const notesWin = store.openWindow({ typeId: 'notes' });
    const openResources: NotesWorkspaceResourceRef[] = [
      { type: 'note', id: 'note_gone' },
      { type: 'mindmap', id: 'map_gone' },
    ];
    registerWorkspaceHost(notesWin, {
      openResource: vi.fn(),
      closeResource: (resource) => {
        const index = openResources.findIndex(
          (item) => item.type === resource.type && item.id === resource.id,
        );
        if (index >= 0) openResources.splice(index, 1);
      },
      listResources: () => openResources,
    });
    missingResourceIds.add('note_gone');
    missingResourceIds.add('map_gone');

    startResourceSync();
    emit({ type: 'purged', path: '/_trash' });
    await reconcileDeletedResourceWindows();

    expect(openResources).toEqual([]);
    expect(useWindowStore.getState().windows[notesWin]).toBeDefined();
  });

  it('存活性复核遇到临时读取错误时不误关标签', async () => {
    const store = useWindowStore.getState();
    const notesWin = store.openWindow({ typeId: 'notes' });
    const closeResource = vi.fn();
    registerWorkspaceHost(notesWin, {
      openResource: vi.fn(),
      closeResource,
      listResources: () => [{ type: 'note', id: 'note_busy' }],
    });
    failingResourceIds.add('note_busy');

    await reconcileDeletedResourceWindows();

    expect(closeResource).not.toHaveBeenCalled();
    expect(useWindowStore.getState().windows[notesWin]).toBeDefined();
  });

  it('显式关闭 API 对 note/mindmap 都通知 workspace', async () => {
    const closeResource = vi.fn();
    registerWorkspaceHost('notes-host', { openResource: vi.fn(), closeResource });
    await closeWorkspaceTabsForDeletedResource('shared_1');
    expect(closeResource).toHaveBeenCalledWith({ type: 'note', id: 'shared_1' });
    expect(closeResource).toHaveBeenCalledWith({ type: 'mindmap', id: 'shared_1' });
  });

  it('start 幂等：重复调用只保持一个订阅；stop 后退订', () => {
    startResourceSync();
    startResourceSync();
    expect(watchState.callbacks).toHaveLength(1);

    stopResourceSync();
    expect(watchState.callbacks).toHaveLength(0);
    expect(watchState.unwatchCount).toBe(1);

    // stop 后可重新启动
    startResourceSync();
    expect(watchState.callbacks).toHaveLength(1);
  });
});
