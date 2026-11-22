/**
 * 画布交互偏好（全局、localStorage 持久化、跨实例实时同步）：
 *
 * - 空白拖拽行为：框选（select）或平移（pan）
 * - 滚轮/触控板语义：滚轮直接缩放（zoom，默认）
 *   或双指平移（pan，对齐 macOS 触控板习惯）
 *
 * 实现：useSyncExternalStore + 模块级监听集合，多个画布实例（分屏/多标签）
 * 实时同步。触屏设备由调用方强制平移，偏好只影响鼠标/触控板指针。
 */

import { useCallback, useSyncExternalStore } from 'react';
import { isMacOS } from '@/utils/platform';

/** 通用的 localStorage 字符串枚举偏好（模块级单例，跨组件实例同步） */
function createStoredPreference<T extends string>(
  storageKey: string,
  defaultValue: T | (() => T),
  isValid: (raw: string) => raw is T,
) {
  const resolveDefault = (): T =>
    typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue;

  const listeners = new Set<() => void>();

  const readStored = (): T | null => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw !== null && isValid(raw) ? raw : null;
    } catch {
      return null;
    }
  };

  const initialStored = readStored();
  let hasExplicitOverride = initialStored !== null;
  let current: T = initialStored ?? resolveDefault();

  const get = (): T => {
    if (!hasExplicitOverride) {
      const stored = readStored();
      if (stored !== null) {
        hasExplicitOverride = true;
        current = stored;
        return current;
      }
      return resolveDefault();
    }
    return current;
  };

  const set = (next: T): void => {
    const prev = get();
    if (hasExplicitOverride && next === prev) return;
    hasExplicitOverride = true;
    current = next;
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // localStorage 不可用（隐私模式等）：仅内存生效
    }
    if (next !== prev) {
      listeners.forEach((listener) => listener());
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { get, set, subscribe, getDefault: resolveDefault };
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
    dragModePreference.getDefault,
  );
  const setMode = useCallback((next: CanvasDragMode) => setCanvasDragMode(next), []);
  return [mode, setMode];
}

// ============================================================================
// 滚轮/触控板语义：macOS 默认双指平移（pan），Windows/Linux 默认滚轮缩放（zoom）
// ============================================================================

/**
 * - pan（macOS 默认）：双指滑动平移画布，捏合或 Cmd/Ctrl+滚轮缩放
 *   （对齐 macOS 上 XMind / Figma / Whimsical / Heptabase 的触控板平台惯例）
 * - zoom（Windows/Linux 默认）：滚轮直接缩放画布，平移用空白拖拽 / Space / 中键
 */
export type CanvasWheelMode = 'pan' | 'zoom';

export function getDefaultCanvasWheelMode(): CanvasWheelMode {
  return isMacOS() ? 'pan' : 'zoom';
}

const wheelModePreference = createStoredPreference<CanvasWheelMode>(
  'mindmap:canvas-wheel-mode',
  getDefaultCanvasWheelMode,
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
    wheelModePreference.getDefault,
  );
  const setMode = useCallback((next: CanvasWheelMode) => setCanvasWheelMode(next), []);
  return [mode, setMode];
}

// ============================================================================
// 画布底部快捷键轻提示胶囊：展开（默认） / 收起
// ============================================================================

export type CanvasShortcutHintMode = 'expanded' | 'collapsed';

const shortcutHintModePreference = createStoredPreference<CanvasShortcutHintMode>(
  'mindmap:canvas-shortcut-hint',
  'expanded',
  (raw): raw is CanvasShortcutHintMode => raw === 'expanded' || raw === 'collapsed',
);

export function getCanvasShortcutHintMode(): CanvasShortcutHintMode {
  return shortcutHintModePreference.get();
}

export function setCanvasShortcutHintMode(mode: CanvasShortcutHintMode): void {
  shortcutHintModePreference.set(mode);
}

export function useCanvasShortcutHintMode(): [
  CanvasShortcutHintMode,
  (mode: CanvasShortcutHintMode) => void,
] {
  const mode = useSyncExternalStore(
    shortcutHintModePreference.subscribe,
    shortcutHintModePreference.get,
    shortcutHintModePreference.getDefault,
  );
  const setMode = useCallback((next: CanvasShortcutHintMode) => setCanvasShortcutHintMode(next), []);
  return [mode, setMode];
}
