/**
 * P6 测试共享工具：windowStore / overlay store 种子与重置
 */
import { useWindowStore, resetWindowStoreForTests } from '@/features/workbench/core/windowStore';
import { useWorkbenchOverlay } from '@/features/workbench/core/shortcuts';
import type { WorkbenchWindow } from '@/features/workbench/core/types';

export const DESKTOP = { w: 1600, h: 900 };

export function makeWindow(
  partial: Partial<WorkbenchWindow> & { id: string },
): WorkbenchWindow {
  return {
    typeId: 'test-app',
    instanceKey: null,
    title: partial.id,
    frame: { x: 40, y: 40, w: 640, h: 480 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 10,
    createdAt: 1,
    lastFocusedAt: 1,
    ...partial,
  };
}

/**
 * 写入窗口集合。
 *
 * windowStore（P1 完整版）的 focusStack 由 zIndex 派生（非 minimized 按 zIndex
 * 升序，后 = 最近聚焦），因此这里按 lastFocusedAt 升序分配 zIndex ≤ Z_BASE(10)，
 * 保证后续 focusWindow（++zTop，从 11 起）总能把窗口提到最顶。
 */
export function seedWindows(wins: WorkbenchWindow[]): void {
  resetWindowStoreForTests({ ...DESKTOP });
  const byFocusAsc = [...wins].sort((a, b) => a.lastFocusedAt - b.lastFocusedAt);
  const n = byFocusAsc.length;
  const windows: Record<string, WorkbenchWindow> = {};
  byFocusAsc.forEach((w, i) => {
    windows[w.id] = { ...w, zIndex: 10 - (n - 1) + i };
  });
  useWindowStore.setState({
    windows,
    focusStack: byFocusAsc.filter((w) => !w.minimized).map((w) => w.id),
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { ...DESKTOP },
  });
}

export function resetWorkbenchState(): void {
  resetWindowStoreForTests({ ...DESKTOP });
  useWorkbenchOverlay.setState({
    exposeOpen: false,
    switcherOpen: false,
    switcherIds: [],
    switcherIndex: 0,
    cheatsheetOpen: false,
    cheatsheetSticky: false,
  });
}

export function focusedWindowId(): string | undefined {
  const s = useWindowStore.getState();
  return s.focusStack[s.focusStack.length - 1];
}

export function keydown(
  init: KeyboardEventInit,
  target: EventTarget = window,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

export function keyup(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
