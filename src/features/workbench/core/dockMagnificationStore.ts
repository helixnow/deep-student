/**
 * dockMagnificationStore — Dock 波浪放大偏好设置（持久化 localStorage）
 *
 * - 对标 macOS 默认行为：**默认关闭**（纯静态 Liquid Glass Dock），保留可选开关与倍率（[1.0, 1.75]）；
 * - 系统 `prefers-reduced-motion: reduce`、粗指针 `(pointer: coarse)` 或
 *   `minimal` 材质档位下自动禁用（不改写用户偏好，环境恢复后自动生效）。
 */
import React from 'react';
import { create } from 'zustand';
import { useMaterialTier } from './materialTier';
import {
  DEFAULT_MAG_MAX_SCALE,
  MIN_MAG_MAX_SCALE,
  MAX_MAG_MAX_SCALE,
  clampMagnificationScale,
} from '../components/dockMagnification';

export const DOCK_MAGNIFICATION_STORAGE_KEY = 'workbench.dock.magnification.v2';
export const DEFAULT_DOCK_MAGNIFICATION_ENABLED = false;
export const DEFAULT_DOCK_MAGNIFICATION_SCALE = DEFAULT_MAG_MAX_SCALE;

export interface DockMagnificationPreferences {
  enabled: boolean;
  maxScale: number;
}

interface DockMagnificationState extends DockMagnificationPreferences {
  setEnabled: (enabled: boolean) => void;
  toggleEnabled: () => void;
  setMaxScale: (maxScale: number) => void;
  reset: () => void;
}

function readPersistedPreferences(): DockMagnificationPreferences {
  const fallback: DockMagnificationPreferences = {
    enabled: DEFAULT_DOCK_MAGNIFICATION_ENABLED,
    maxScale: DEFAULT_DOCK_MAGNIFICATION_SCALE,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(DOCK_MAGNIFICATION_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DockMagnificationPreferences> | null;
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
      maxScale:
        typeof parsed.maxScale === 'number'
          ? clampMagnificationScale(parsed.maxScale)
          : fallback.maxScale,
    };
  } catch {
    return fallback;
  }
}

function writePersistedPreferences(prefs: DockMagnificationPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      DOCK_MAGNIFICATION_STORAGE_KEY,
      JSON.stringify({
        enabled: prefs.enabled,
        maxScale: clampMagnificationScale(prefs.maxScale),
      }),
    );
  } catch {
    // 存储受限环境（如隐私模式/沙箱）忽略持久化失败
  }
}

const initialPreferences = readPersistedPreferences();

export const useDockMagnificationStore = create<DockMagnificationState>((set, get) => ({
  enabled: initialPreferences.enabled,
  maxScale: initialPreferences.maxScale,

  setEnabled: (enabled) => {
    const next = Boolean(enabled);
    if (get().enabled === next) return;
    set({ enabled: next });
    writePersistedPreferences({ enabled: next, maxScale: get().maxScale });
  },

  toggleEnabled: () => {
    const next = !get().enabled;
    set({ enabled: next });
    writePersistedPreferences({ enabled: next, maxScale: get().maxScale });
  },

  setMaxScale: (maxScale) => {
    const clamped = clampMagnificationScale(maxScale);
    if (get().maxScale === clamped) return;
    set({ maxScale: clamped });
    writePersistedPreferences({ enabled: get().enabled, maxScale: clamped });
  },

  reset: () => {
    const defaults: DockMagnificationPreferences = {
      enabled: DEFAULT_DOCK_MAGNIFICATION_ENABLED,
      maxScale: DEFAULT_DOCK_MAGNIFICATION_SCALE,
    };
    set(defaults);
    writePersistedPreferences(defaults);
  },
}));

function useMediaQueryMatches(query: string): boolean {
  const subscribe = React.useCallback(
    (notify: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const media = window.matchMedia(query);
      if (typeof media?.addEventListener === 'function') {
        media.addEventListener('change', notify);
        return () => media.removeEventListener('change', notify);
      }
      return () => {};
    },
    [query],
  );

  const getSnapshot = React.useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return Boolean(window.matchMedia(query)?.matches);
  }, [query]);

  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export interface DockMagnificationEffective {
  enabled: boolean;
  maxScale: number;
  effectiveEnabled: boolean;
  prefersReducedMotion: boolean;
  isCoarsePointer: boolean;
}

/**
 * 综合用户设置、材质档位、系统减弱动态效果与指针精度后的实时生效状态。
 */
export function useDockMagnificationEffective(): DockMagnificationEffective {
  const enabled = useDockMagnificationStore((s) => s.enabled);
  const maxScale = useDockMagnificationStore((s) => s.maxScale);
  const tier = useMaterialTier();
  const prefersReducedMotion = useMediaQueryMatches('(prefers-reduced-motion: reduce)');
  const isCoarsePointer = useMediaQueryMatches('(pointer: coarse)');

  const effectiveEnabled =
    enabled &&
    maxScale > MIN_MAG_MAX_SCALE &&
    tier !== 'minimal' &&
    !prefersReducedMotion &&
    !isCoarsePointer;

  return {
    enabled,
    maxScale,
    effectiveEnabled,
    prefersReducedMotion,
    isCoarsePointer,
  };
}

export function getDockMagnificationPreferences(): DockMagnificationPreferences {
  const { enabled, maxScale } = useDockMagnificationStore.getState();
  return { enabled, maxScale };
}

export function setDockMagnificationEnabled(enabled: boolean): void {
  useDockMagnificationStore.getState().setEnabled(enabled);
}

export function setDockMagnificationScale(maxScale: number): void {
  useDockMagnificationStore.getState().setMaxScale(maxScale);
}

export { MIN_MAG_MAX_SCALE, MAX_MAG_MAX_SCALE };

/** 仅供单元测试：恢复默认状态并清理 localStorage */
export function resetDockMagnificationForTests(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DOCK_MAGNIFICATION_STORAGE_KEY);
    } catch {
      // noop
    }
  }
  useDockMagnificationStore.setState({
    enabled: DEFAULT_DOCK_MAGNIFICATION_ENABLED,
    maxScale: DEFAULT_DOCK_MAGNIFICATION_SCALE,
  });
}
