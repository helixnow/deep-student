import { useCallback, useSyncExternalStore } from 'react';
import { appRegistry } from './appRegistry';
import { useWindowStore } from './windowStore';

const closeConfirmations = new Map<string, Promise<boolean>>();

// ---------------------------------------------------------------------------
// 窗口脏状态（未保存更改）—— 红灯圆点数据源
// ---------------------------------------------------------------------------
// canClose 是关窗时刻的一次性拦截回调；红灯圆点需要持续可订阅的脏标记，
// 因此这里补一个窗口可声明 dirty 的最小 API（声明式，未声明 = 干净）。
// 应用侧（编辑器等）在内容变脏/存盘时调用 setWindowDirty；
// WindowTitleBar 经 useWindowDirty 订阅并渲染 data-dirty 圆点。

const dirtyWindowIds = new Set<string>();
const dirtyListeners = new Set<() => void>();

function notifyDirtyListeners(): void {
  for (const listener of dirtyListeners) listener();
}

/** 声明某窗口是否有未保存更改（幂等；窗口关闭时自动清理） */
export function setWindowDirty(windowId: string, dirty: boolean): void {
  if (dirty === dirtyWindowIds.has(windowId)) return;
  if (dirty) dirtyWindowIds.add(windowId);
  else dirtyWindowIds.delete(windowId);
  notifyDirtyListeners();
}

export function isWindowDirty(windowId: string): boolean {
  return dirtyWindowIds.has(windowId);
}

/** 订阅任一窗口脏状态变化（返回注销函数） */
export function subscribeWindowDirty(listener: () => void): () => void {
  dirtyListeners.add(listener);
  return () => {
    dirtyListeners.delete(listener);
  };
}

/** React 订阅：该窗口是否有未保存更改 */
export function useWindowDirty(windowId: string): boolean {
  const getSnapshot = useCallback(() => dirtyWindowIds.has(windowId), [windowId]);
  return useSyncExternalStore(subscribeWindowDirty, getSnapshot, () => false);
}

/** 仅供单元测试：清空脏标记 */
export function __resetWindowDirtyForTests(): void {
  if (dirtyWindowIds.size === 0) return;
  dirtyWindowIds.clear();
  notifyDirtyListeners();
}

// 窗口从 store 移除时清理残留脏标记（长会话防泄漏；集合为空时零成本）
useWindowStore.subscribe((state) => {
  if (dirtyWindowIds.size === 0) return;
  let changed = false;
  for (const id of dirtyWindowIds) {
    if (!state.windows[id]) {
      dirtyWindowIds.delete(id);
      changed = true;
    }
  }
  if (changed) notifyDirtyListeners();
});

/** 同一窗口的 canClose single-flight；调用方在 await 后必须重新读取窗口状态。 */
export function confirmWindowClose(windowId: string): Promise<boolean> {
  const current = closeConfirmations.get(windowId);
  if (current) return current;
  const win = useWindowStore.getState().windows[windowId];
  if (!win) return Promise.resolve(true);
  const canClose = appRegistry.get(win.typeId)?.canClose;
  if (!canClose) return Promise.resolve(true);

  const confirmation = Promise.resolve().then(() => canClose(win.instanceKey)).then(Boolean).finally(() => {
    if (closeConfirmations.get(windowId) === confirmation) closeConfirmations.delete(windowId);
  });
  closeConfirmations.set(windowId, confirmation);
  return confirmation;
}
