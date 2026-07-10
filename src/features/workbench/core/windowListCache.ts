/**
 * 共享窗口列表缓存：同一 `windows` 引用上只排序一次，
 * 供 Desktop / Dock / DockItem / ContextMenu 等 fingerprint selector 复用，
 * 避免每次 store.set 都 O(N log N) 重复排序。
 */
import type { WorkbenchWindow } from './types';

type WindowsMap = Record<string, WorkbenchWindow>;

let cachedRef: WindowsMap | null = null;
let cachedSorted: WorkbenchWindow[] = [];

/** 按 createdAt 升序的窗口列表（与 Desktop 渲染序一致） */
export function getSortedWindows(windows: WindowsMap): WorkbenchWindow[] {
  if (windows === cachedRef) return cachedSorted;
  cachedRef = windows;
  cachedSorted = Object.values(windows).sort((a, b) => a.createdAt - b.createdAt);
  return cachedSorted;
}

/** 仅供测试：清空缓存 */
export function resetWindowListCacheForTests(): void {
  cachedRef = null;
  cachedSorted = [];
}
