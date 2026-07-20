/**
 * menuBarAutohideStore — 菜单栏自动隐藏状态（用户设置 + 外部强制）
 *
 * 与 Dock autohide 的差别：Dock 由 WorkbenchDesktop 读设置后走 prop，
 * 菜单栏自读设置（StatusBar 挂载时 get_setting + workbench:settings-changed 热更新）。
 * `forceAutohide` 是给外部状态（如后续沉浸模式）预留的强制通道：
 * 任一为 true 即生效（derived 见 useMenuBarAutohide）。
 */
import { create } from 'zustand';

/** 设置键：与 WorkbenchSettingsSection 的 WORKBENCH_SETTING_KEYS.menuBarAutohide 同值 */
export const MENUBAR_AUTOHIDE_SETTING_KEY = 'desktop.workbenchMenuBarAutohide';

interface MenuBarAutohideState {
  /** 用户设置项（desktop.workbenchMenuBarAutohide） */
  settingEnabled: boolean;
  /** 外部强制（沉浸模式等场景复用；与设置项取或） */
  forceAutohide: boolean;
  setSettingEnabled: (value: boolean) => void;
  setForceAutohide: (value: boolean) => void;
}

export const useMenuBarAutohideStore = create<MenuBarAutohideState>((set) => ({
  settingEnabled: false,
  forceAutohide: false,
  setSettingEnabled: (value) => set({ settingEnabled: value }),
  setForceAutohide: (value) => set({ forceAutohide: value }),
}));

/** derived：设置项或外部强制任一开启即自动隐藏 */
export function useMenuBarAutohide(): boolean {
  return useMenuBarAutohideStore((s) => s.settingEnabled || s.forceAutohide);
}

/** 供非 React 调用方（如沉浸模式控制器）强制菜单栏 autohide */
export function setMenuBarForceAutohide(value: boolean): void {
  useMenuBarAutohideStore.getState().setForceAutohide(value);
}

/** 仅供单元测试：恢复初始状态 */
export function resetMenuBarAutohideForTests(): void {
  useMenuBarAutohideStore.setState({ settingEnabled: false, forceAutohide: false });
}
