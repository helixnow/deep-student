/**
 * 画布交互偏好（全局、localStorage 持久化、跨实例实时同步）：
 *
 * - 空白拖拽行为：框选（select）或平移（pan）
 * - 滚轮/触控板语义：双指平移（pan，默认，对齐 XMind/MindNode/macOS 习惯）
 *   或旧「滚轮直接缩放」（zoom）
 *
 * 实现：useSyncExternalStore + 模块级监听集合，多个画布实例（分屏/多标签）
 * 实时同步。触屏设备由调用方强制平移，偏好只影响鼠标/触控板指针。
 */

import { useCallback, useSyncExternalStore } from 'react';

/** 通用的 localStorage 字符串枚举偏好（模块级单例，跨组件实例同步） */
function createStoredPreference<T extends string>(
  storageKey: string,
  defaultValue: T,
  isValid: (raw: string) => raw is T,
) {
  const listeners = new Set<() => void>();

  const readInitial = (): T => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw !== null && isValid(raw) ? raw : defaultValue;
    } catch {
      return defaultValue;
    }
  };

  let current: T = readInitial();

  const get = (): T => current;

  const set = (next: T): void => {
    if (next === current) return;
    current = next;
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // localStorage 不可用（隐私模式等）：仅内存生效
    }
    listeners.forEach((listener) => listener());
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { get, set, subscribe, defaultValue };
}

// ============================================================================
// 空白拖拽：框选 / 平移
// ============================================================================

export type CanvasDragMode = 'select' | 'pan';

// Direct manipulation is the friendliest default for trackpads and mice.
// Marquee selection remains available with Shift + drag.
const dragModePreference = createStoredPreference<CanvasDragMode>(
  'mindmap:canvas-drag-mode',
  'pan',
  (raw): raw is CanvasDragMode => raw === 'pan' || raw === 'select',
);

export function getCanvasDragMode(): CanvasDragMode {
  return dragModePreference.get();
}

export function setCanvasDragMode(mode: CanvasDragMode): void {
  dragModePreference.set(mode);
}

export function useCanvasDragMode(): [CanvasDragMode, (mode: CanvasDragMode) => void] {
  const mode = useSyncExternalStore(
    dragModePreference.subscribe,
    dragModePreference.get,
    () => dragModePreference.defaultValue,
  );
  const setMode = useCallback((next: CanvasDragMode) => setCanvasDragMode(next), []);
  return [mode, setMode];
}

// ============================================================================
// 滚轮/触控板语义：双指平移（默认） / 旧滚轮缩放
// ============================================================================

/**
 * - pan（默认）：滚轮/双指滑动平移画布，pinch 或 Cmd/Ctrl+滚轮缩放
 *   （对齐 macOS 上 XMind / MindNode / Miro 的平台习惯）
 * - zoom（旧行为）：滚轮直接缩放画布，平移用空白拖拽 / Space / 中键
 */
export type CanvasWheelMode = 'pan' | 'zoom';

const wheelModePreference = createStoredPreference<CanvasWheelMode>(
  'mindmap:canvas-wheel-mode',
  'pan',
  (raw): raw is CanvasWheelMode => raw === 'pan' || raw === 'zoom',
);

export function getCanvasWheelMode(): CanvasWheelMode {
  return wheelModePreference.get();
}

export function setCanvasWheelMode(mode: CanvasWheelMode): void {
  wheelModePreference.set(mode);
}

export function useCanvasWheelMode(): [CanvasWheelMode, (mode: CanvasWheelMode) => void] {
  const mode = useSyncExternalStore(
    wheelModePreference.subscribe,
    wheelModePreference.get,
    () => wheelModePreference.defaultValue,
  );
  const setMode = useCallback((next: CanvasWheelMode) => setCanvasWheelMode(next), []);
  return [mode, setMode];
}
