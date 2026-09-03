/**
 * immersiveMode（P2 绿灯沉浸模式）— 窗口内 OS 的"全屏 Space"等价物。
 *
 * 进入 = maximize + 菜单栏强制 autohide（menuBarAutohideStore.forceAutohide，
 * StatusBar 已实现顶缘热区 reveal/conceal）+ Dock 强制 autohide（免费获得：
 * WorkbenchDesktop 的 dockForceAutohide 由 hasDockObstructedWindow 派生，
 * 窗口进入 maximized 即触发，无需额外通道）。
 *
 * 退出路径：Esc（跳过可编辑焦点，复用 core/shortcuts 的 isEditableTarget）、
 * 再点绿灯（toggleImmersive）、或窗口自行离开 maximized（关闭 / 最小化 /
 * tear-out / 平铺菜单）时自动清理。退出时恢复 maximize 前的 displayMode——
 * 回 floating 的 frame 由 windowStore 既有 restoreFrame 记忆机制还原。
 *
 * 独立小 store（不写入 windowStore）：沉浸态是纯派生 UI 状态，绝不持久化，
 * 且 windowStore 的 WorkbenchStoreState 为冻结契约，独立 store 耦合最小。
 * 全局同一时刻最多一个沉浸窗口（对齐 macOS 单 Space 前台语义）。
 */
import { create } from 'zustand';
import i18n from 'i18next';
import type { DisplayMode } from './types';
import { useWindowStore } from './windowStore';
import { recomputeLifecycles } from './scheduler';
import { isEditableTarget, resolveShortcutEventTarget } from './shortcuts';
import { setMenuBarForceAutohide } from '../components/menuBarAutohideStore';
import { announceWorkbench } from '../hooks/useWorkbenchA11y';

interface ImmersiveModeState {
  /** 当前沉浸窗口（同一时刻最多一个） */
  windowId: string | null;
  /** 进入沉浸前的 displayMode（退出时恢复；floating frame 走 restoreFrame） */
  previousMode: DisplayMode | null;
}

const useImmersiveStore = create<ImmersiveModeState>(() => ({
  windowId: null,
  previousMode: null,
}));

let escListener: ((e: KeyboardEvent) => void) | null = null;
let storeUnsubscribe: (() => void) | null = null;

function removeGuards(): void {
  if (escListener && typeof window !== 'undefined') {
    window.removeEventListener('keydown', escListener);
  }
  escListener = null;
  storeUnsubscribe?.();
  storeUnsubscribe = null;
}

/** 只清沉浸标记与菜单栏强制，不回写 displayMode（窗口已自行离开 maximized 时用） */
function clearImmersiveState(): void {
  useImmersiveStore.setState({ windowId: null, previousMode: null });
  removeGuards();
  setMenuBarForceAutohide(false);
}

function installGuards(windowId: string): void {
  removeGuards();
  if (typeof window !== 'undefined') {
    escListener = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // 不抢输入框 / 富文本焦点的 Esc（与快捷键系统同一判定）
      if (isEditableTarget(resolveShortcutEventTarget(e))) return;
      exitImmersive();
    };
    // 非捕获监听：WindowShell 拖拽取消等捕获期 stopPropagation 的 Esc 优先
    window.addEventListener('keydown', escListener);
  }
  // 沉浸窗被关闭 / 最小化 / tear-out / 平铺菜单改模式 → 自动退出（不再回写模式）
  storeUnsubscribe = useWindowStore.subscribe((state) => {
    if (useImmersiveStore.getState().windowId !== windowId) return;
    const win = state.windows[windowId];
    if (!win || win.minimized || win.displayMode !== 'maximized') {
      clearImmersiveState();
    }
  });
}

/** 进入沉浸模式；已有其他沉浸窗时先退出旧窗（单沉浸语义） */
export function enterImmersive(windowId: string): void {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win || win.minimized) return;
  const active = useImmersiveStore.getState().windowId;
  if (active === windowId) return;
  if (active) exitImmersive();
  useImmersiveStore.setState({ windowId, previousMode: win.displayMode });
  if (win.displayMode !== 'maximized') {
    // 首次离开 floating 时 applyDisplayModeTransition 会记录 restoreFrame
    store.setDisplayMode(windowId, 'maximized');
  }
  store.focusWindow(windowId);
  setMenuBarForceAutohide(true);
  installGuards(windowId);
  recomputeLifecycles();
  announceWorkbench(i18n.t('workbench:a11y.immersiveEntered', { title: win.title }));
}

/** 退出沉浸模式：恢复进入前的 displayMode（floating 的 frame 由 restoreFrame 还原） */
export function exitImmersive(): void {
  const { windowId, previousMode } = useImmersiveStore.getState();
  if (!windowId) return;
  clearImmersiveState();
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (
    win &&
    !win.minimized &&
    win.displayMode === 'maximized' &&
    previousMode &&
    previousMode !== 'maximized'
  ) {
    // managed → floating 的 FLIP settle 由 WindowShell 的 store 订阅补播
    store.setDisplayMode(windowId, previousMode);
  }
  recomputeLifecycles();
  if (win) {
    announceWorkbench(i18n.t('workbench:a11y.immersiveExited', { title: win.title }));
  }
}

export function toggleImmersive(windowId: string): void {
  if (useImmersiveStore.getState().windowId === windowId) {
    exitImmersive();
  } else {
    enterImmersive(windowId);
  }
}

export function isWindowImmersive(windowId: string): boolean {
  return useImmersiveStore.getState().windowId === windowId;
}

/** React hook：订阅单窗沉浸状态 */
export function useWindowImmersive(windowId: string): boolean {
  return useImmersiveStore((s) => s.windowId === windowId);
}

/**
 * React hook：当前沉浸窗口 id（无则 null）。
 * 供壳层的沉浸退出提示（ImmersiveHint）订阅——Esc 是隐性知识，
 * 进入沉浸必须给一条可见的退出指引。
 */
export function useImmersiveWindowId(): string | null {
  return useImmersiveStore((s) => s.windowId);
}

/** 仅供单元测试：清空沉浸状态与监听 */
export function resetImmersiveModeForTests(): void {
  clearImmersiveState();
}
