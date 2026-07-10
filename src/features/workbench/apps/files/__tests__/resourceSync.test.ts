/**
 * 资源删除联动测试（P8）
 *
 * DSTU deleted/purged 事件 → 关闭 instanceKey 指向该资源的资源应用窗口；
 * 非资源应用（chat 等）与其他资源的窗口不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuWatchEvent } from '@/dstu/types';

type WatchCallback = (event: DstuWatchEvent) => void;

const watchState: { callbacks: WatchCallback[]; unwatchCount: number } = {
  callbacks: [],
  unwatchCount: 0,
};

vi.mock('@/dstu', () => ({
  dstu: {
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
import {
  closeWindowsForDeletedResource,
  extractResourceIdFromPath,
  startResourceSync,
  stopResourceSync,
} from '../resourceSync';

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
    resetStore();
  });

  afterEach(() => {
    stopResourceSync();
    resetStore();
  });

  it('deleted 事件关闭对应资源窗口，其他窗口保留', () => {
    const store = useWindowStore.getState();
    const noteWin = store.openWindow({ typeId: 'note', instanceKey: 'note_1' });
    const mindmapWin = store.openWindow({ typeId: 'mindmap', instanceKey: 'mm_1' });
    // chat 不属于资源应用群，即使 instanceKey 撞名也不应被关
    const chatWin = store.openWindow({ typeId: 'chat', instanceKey: 'note_1' });

    startResourceSync();
    emit({ type: 'deleted', path: '/folder/note_1' });

    const windows = useWindowStore.getState().windows;
    expect(windows[noteWin]).toBeUndefined();
    expect(windows[mindmapWin]).toBeDefined();
    expect(windows[chatWin]).toBeDefined();
  });

  it('purged 事件同样触发关窗（含 mindmap）', () => {
    const store = useWindowStore.getState();
    const mindmapWin = store.openWindow({ typeId: 'mindmap', instanceKey: 'mm_9' });

    startResourceSync();
    emit({ type: 'purged', path: '/mm_9' });

    expect(useWindowStore.getState().windows[mindmapWin]).toBeUndefined();
  });

  it('updated/moved 等事件不关窗', () => {
    const store = useWindowStore.getState();
    const noteWin = store.openWindow({ typeId: 'note', instanceKey: 'note_2' });

    startResourceSync();
    emit({ type: 'updated', path: '/note_2' });
    emit({ type: 'moved', path: '/elsewhere/note_2', oldPath: '/note_2' });

    expect(useWindowStore.getState().windows[noteWin]).toBeDefined();
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
