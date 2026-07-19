/**
 * 画布空白拖拽行为偏好：框选（select）或平移（pan）。
 *
 * - 全局偏好（非按文档），localStorage 持久化
 * - useSyncExternalStore + 模块级监听集合：多个画布实例（分屏/多标签）实时同步
 * - 触屏设备由调用方强制平移，本偏好只影响鼠标指针
 */

import { useCallback, useSyncExternalStore } from 'react';

export type CanvasDragMode = 'select' | 'pan';

const STORAGE_KEY = 'mindmap:canvas-drag-mode';
// Direct manipulation is the friendliest default for trackpads and mice.
// Marquee selection remains available with Shift + drag.
const DEFAULT_MODE: CanvasDragMode = 'pan';

let currentMode: CanvasDragMode = readInitialMode();
const listeners = new Set<() => void>();

function readInitialMode(): CanvasDragMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'pan' || raw === 'select' ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function getCanvasDragMode(): CanvasDragMode {
  return currentMode;
}

export function setCanvasDragMode(mode: CanvasDragMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用（隐私模式等）：仅内存生效
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCanvasDragMode(): [CanvasDragMode, (mode: CanvasDragMode) => void] {
  const mode = useSyncExternalStore(subscribe, getCanvasDragMode, () => DEFAULT_MODE);
  const setMode = useCallback((next: CanvasDragMode) => setCanvasDragMode(next), []);
  return [mode, setMode];
}
