/**
 * 桌面小组件（日程 / AI 学习简报）的手动折叠状态。
 *
 * 折叠只是本机的界面偏好（像空桌面 tour 的消隐位），不进设置后端与桌面快照：
 * localStorage 存一个折叠 id 数组；存储不可用时退化为本次会话内有效。
 * 「显示与否」是另一回事，走设置页 desktop.workbenchWidget* 开关。
 */
import { useCallback, useSyncExternalStore } from 'react';

export type DesktopWidgetId = 'agenda' | 'briefing';

export const DESKTOP_WIDGET_COLLAPSE_KEY = 'workbench.desktopWidgets.collapsed';

const listeners = new Set<() => void>();
let collapsed: ReadonlySet<DesktopWidgetId> = readStored();

function readStored(): ReadonlySet<DesktopWidgetId> {
  try {
    const raw = localStorage.getItem(DESKTOP_WIDGET_COLLAPSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is DesktopWidgetId => id === 'agenda' || id === 'briefing'));
  } catch {
    return new Set();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDesktopWidgetCollapsed(id: DesktopWidgetId): boolean {
  return collapsed.has(id);
}

export function setDesktopWidgetCollapsed(id: DesktopWidgetId, next: boolean): void {
  if (collapsed.has(id) === next) return;
  const updated = new Set(collapsed);
  if (next) updated.add(id);
  else updated.delete(id);
  collapsed = updated;
  try {
    localStorage.setItem(DESKTOP_WIDGET_COLLAPSE_KEY, JSON.stringify([...updated].sort()));
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
  listeners.forEach((listener) => listener());
}

/** 测试用：按当前 localStorage 重新载入 */
export function reloadDesktopWidgetCollapse(): void {
  collapsed = readStored();
  listeners.forEach((listener) => listener());
}

export function useDesktopWidgetCollapsed(id: DesktopWidgetId): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => collapsed.has(id), () => false);
  const toggle = useCallback(() => setDesktopWidgetCollapsed(id, !collapsed.has(id)), [id]);
  return [value, toggle];
}
