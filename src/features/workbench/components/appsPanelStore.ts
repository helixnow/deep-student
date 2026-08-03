/**
 * Apps 面板开合状态（L4）— 轻量模块级 store
 *
 * 不进 windowStore / overlay；供 Dock、DesktopContextMenu、EmptyDesktop（日后）共用。
 * 伪 typeId `__apps__` 仅作 Dock 入口标识，**禁止**注册进 appRegistry。
 */
import { useSyncExternalStore } from 'react';
import { useWorkbenchOverlay } from '../core/shortcuts';

export const APPS_DOCK_TYPE_ID = '__apps__' as const;

type Listener = () => void;

let open = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function isAppsPanelOpen(): boolean {
  return open;
}

/** 打开全部应用面板（供 Dock / 右键菜单 / 日后 EmptyDesktop 接线） */
export function openAppsPanel(): void {
  if (open) return;
  const overlay = useWorkbenchOverlay.getState();
  overlay.closeExpose();
  overlay.closeSwitcher();
  overlay.closeCheatsheet();
  open = true;
  emit();
}

export function closeAppsPanel(): void {
  if (!open) return;
  open = false;
  emit();
}

export function toggleAppsPanel(): void {
  const next = !open;
  if (next) {
    const overlay = useWorkbenchOverlay.getState();
    overlay.closeExpose();
    overlay.closeSwitcher();
    overlay.closeCheatsheet();
  }
  open = next;
  emit();
}

export function subscribeAppsPanel(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useAppsPanelOpen(): boolean {
  return useSyncExternalStore(subscribeAppsPanel, isAppsPanelOpen, () => false);
}
