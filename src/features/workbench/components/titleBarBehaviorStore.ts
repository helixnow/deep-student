/**
 * titleBarBehaviorStore — 双击标题栏行为设置（对标 macOS 系统设置
 * 「双击窗口标题栏以…」：缩放 / 最小化 / 不做任何事）。
 *
 * 存取模式与 menuBarAutohideStore 同款：设置项落库走 get_setting /
 * save_setting（键与 WorkbenchSettingsSection 的 WORKBENCH_SETTING_KEYS
 * 同值），运行时经本 store 分发；首个 WindowTitleBar 挂载时懒加载一次 +
 * 订阅 workbench:settings-changed 热更新，避免每个标题栏各自 invoke。
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/** 设置键：与 WorkbenchSettingsSection 的 WORKBENCH_SETTING_KEYS.titleBarDoubleClick 同值 */
export const TITLEBAR_DOUBLE_CLICK_SETTING_KEY = 'desktop.workbenchTitleBarDoubleClick';

export type TitleBarDoubleClickAction = 'zoom' | 'minimize' | 'none';

export function parseTitleBarDoubleClickAction(raw: unknown): TitleBarDoubleClickAction {
  const value = String(raw ?? '').trim();
  return value === 'minimize' || value === 'none' ? value : 'zoom';
}

interface TitleBarBehaviorState {
  doubleClickAction: TitleBarDoubleClickAction;
  setDoubleClickAction: (action: TitleBarDoubleClickAction) => void;
}

export const useTitleBarBehaviorStore = create<TitleBarBehaviorState>((set) => ({
  doubleClickAction: 'zoom',
  setDoubleClickAction: (action) => set({ doubleClickAction: action }),
}));

let loadStarted = false;

function handleSettingsChanged(event: Event): void {
  const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
  if (!detail || detail.key !== TITLEBAR_DOUBLE_CLICK_SETTING_KEY) return;
  useTitleBarBehaviorStore
    .getState()
    .setDoubleClickAction(parseTitleBarDoubleClickAction(detail.value));
}

/** 懒加载单例：首次调用读设置 + 挂热更新监听（幂等） */
export function ensureTitleBarBehaviorLoaded(): void {
  if (loadStarted || typeof window === 'undefined') return;
  loadStarted = true;
  window.addEventListener('workbench:settings-changed', handleSettingsChanged);
  void (tauriInvoke('get_setting', { key: TITLEBAR_DOUBLE_CLICK_SETTING_KEY }) as Promise<
    string | null
  >)
    .then((raw) => {
      // 缺失键保持默认 zoom；只有显式设置过才覆盖
      if (raw != null) {
        useTitleBarBehaviorStore
          .getState()
          .setDoubleClickAction(parseTitleBarDoubleClickAction(raw));
      }
    })
    .catch(() => {
      /* 非 Tauri 环境（测试等）按默认 zoom */
    });
}

/** React hook：订阅双击标题栏行为（挂载时触发懒加载） */
export function useTitleBarDoubleClickAction(): TitleBarDoubleClickAction {
  useEffect(() => {
    ensureTitleBarBehaviorLoaded();
  }, []);
  return useTitleBarBehaviorStore((s) => s.doubleClickAction);
}

/** 仅供单元测试：恢复初始状态并卸下监听 */
export function resetTitleBarBehaviorForTests(): void {
  if (loadStarted && typeof window !== 'undefined') {
    window.removeEventListener('workbench:settings-changed', handleSettingsChanged);
  }
  loadStarted = false;
  useTitleBarBehaviorStore.setState({ doubleClickAction: 'zoom' });
}
