/**
 * useWorkbenchShortcuts（主责 P6 → O12 深化）
 *
 * 在 WorkbenchDesktop 根部挂载一次（P11 接线）。实现设计文档 §6.4 全部快捷键
 * 及 O12 补齐的 WM 级快捷键（下表为 Ctrl 基底写法；macOS 上经
 * core/shortcuts 的平台映射整体换到 ⌘ 基底：Ctrl→⌘、Ctrl+Alt→⌘⌥、
 * Ctrl+Alt+Shift→⌘⌥⇧，原 Ctrl 通道在 macOS 上仍作为兜底保留）：
 *
 * - Ctrl+Alt+←/→        平铺左/右半屏
 * - Ctrl+Alt+T/B        平铺上/下半屏
 * - Ctrl+Alt+U/I/J/K    平铺到四角
 * - Ctrl+Alt+↑          最大化
 * - Ctrl+Alt+↓          恢复原尺寸（非 floating 时）/ 最小化（floating 时）
 * - Ctrl+Alt+C          居中
 * - Ctrl+Alt+Shift+方向 贴靠到桌面边缘（保持尺寸）
 * - Ctrl+Tab / Ctrl+Shift+Tab  窗口循环切换（按住循环，松开 Ctrl 聚焦）
 * - Ctrl+` / Ctrl+Shift+`      同应用窗口循环（对标 macOS Cmd+`）
 * - Ctrl+Alt+E          窗口俯瞰
 * - Ctrl+Alt+Shift+E    App Exposé（只俯瞰当前焦点应用的窗口）
 * - Ctrl+Alt+M          最小化焦点窗口
 * - Ctrl+Alt+D          显示桌面（stash 语义：最小化可见窗 / 再按恢复暂存）
 * - Ctrl+W              关闭焦点窗口（走 requestClose/canClose，可通过选项关闭）
 * - Ctrl+Alt+Shift+W    关闭所有窗口（逐窗走 canClose 拦截）
 * - ?                   快捷键速查表（长按 Ctrl+Alt 700ms 临时显示，松开即收）
 *
 * 输入守卫：焦点在 input/textarea/select/contenteditable/role=textbox
 * （含 shadow DOM 内，经 composedPath 还原真实目标）或 IME 组合会话中
 * （isComposing / keyCode 229）时全部不触发。
 *
 * 视觉反馈（O12）：平铺/贴边/居中/最大化类动作触发时，在桌面上短暂显示
 * 目标区域高亮（imperative DOM + 仅 opacity 过渡，不进 React state，
 * 不侵入他人组件；reduced-motion / minimal 材质档下跳过）；同时在 window
 * 上派发 `workbench:shortcut-feedback` 事件供 ShortcutCheatsheet 行高亮等消费。
 */
import { useEffect, useRef } from 'react';
import i18n from 'i18next';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import {
  computeCenteredFrame,
  computeEdgeMovedFrame,
  isMacShortcutPlatform,
  isShortcutGuardedEvent,
  matchWorkbenchShortcut,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_FEEDBACK_EVENT,
  type EdgeDirection,
  type WorkbenchShortcutFeedbackDetail,
  type WorkbenchShortcutId,
} from '../core/shortcuts';
import { MENU_CLOSE_WINDOW_EVENT } from '@/menu/menuEvents';
import {
  requestCloseAnimated,
  requestMinimizeAnimated,
} from './useWindowLifecycleAnim';
import { announceWorkbench } from './useWorkbenchA11y';
import { toggleShowDesktop } from './showDesktop';
import { computeTiledFrame, DEFAULT_TILE_MARGIN } from '../core/tiling';
import type { DisplayMode, Frame } from '../core/types';
import { closeAppsPanel } from '../components/appsPanelStore';

export interface UseWorkbenchShortcutsOptions {
  /** workbench 桌面是否激活；false 时不监听任何按键 */
  enabled?: boolean;
  /** Ctrl+W 关闭焦点窗口（设置项，默认开启） */
  enableCloseWindow?: boolean;
}

/** 长按 Ctrl+Alt 触发速查表的时长（ms） */
export const CHEATSHEET_HOLD_MS = 700;

// ---------------------------------------------------------------------------
// 视觉反馈（imperative DOM，不进 React）
// ---------------------------------------------------------------------------

const FLASH_FADE_IN_MS = 90;
const FLASH_HOLD_MS = 160;
const FLASH_FADE_OUT_MS = 200;

function isMotionDisabled(): boolean {
  if (typeof document !== 'undefined') {
    if (document.documentElement.getAttribute('data-wb-material') === 'minimal') return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch {
      /* jsdom 等环境的 matchMedia 兼容性兜底 */
    }
  }
  return false;
}

function dispatchShortcutFeedback(detail: WorkbenchShortcutFeedbackDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKBENCH_SHORTCUT_FEEDBACK_EVENT, { detail }));
}

/**
 * 在桌面坐标系 frame 处闪现目标区高亮（吸附预览同款描边/填充 token）。
 * 全程仅 opacity 过渡；元素自建自清，不依赖任何组件挂载。
 */
function flashTargetRegion(frame: Frame): void {
  if (typeof document === 'undefined' || isMotionDisabled()) return;
  const host = document.querySelector<HTMLElement>('[data-wb-desktop]') ?? document.body;
  if (!host) return;

  const el = document.createElement('div');
  el.setAttribute('data-wb-cheat-flash', '');
  el.setAttribute('aria-hidden', 'true');
  const s = el.style;
  s.position = 'absolute';
  s.left = `${frame.x}px`;
  s.top = `${frame.y}px`;
  s.width = `${frame.w}px`;
  s.height = `${frame.h}px`;
  s.boxSizing = 'border-box';
  s.pointerEvents = 'none';
  s.border = '1.5px solid var(--wb-snap-stroke)';
  s.background = 'var(--wb-snap-fill)';
  s.borderRadius = 'var(--wb-snap-radius, 12px)';
  s.opacity = '0';
  s.transition = `opacity ${FLASH_FADE_IN_MS}ms var(--wb-motion-ease-out, var(--wb-ease-out, ease-out))`;
  s.setProperty('z-index', 'var(--wb-cheat-z-flash, 8600)');
  host.appendChild(el);

  // 双 rAF 保证初始 opacity:0 先提交再过渡（rAF 缺失的测试环境直接可见）
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
  raf(() => {
    raf(() => {
      el.style.opacity = '1';
    });
  });
  window.setTimeout(() => {
    el.style.transition = `opacity ${FLASH_FADE_OUT_MS}ms var(--wb-motion-ease-out, var(--wb-ease-out, ease-out))`;
    el.style.opacity = '0';
  }, FLASH_FADE_IN_MS + FLASH_HOLD_MS);
  window.setTimeout(() => {
    el.remove();
  }, FLASH_FADE_IN_MS + FLASH_HOLD_MS + FLASH_FADE_OUT_MS + 40);
}

/** 平铺/最大化目标区（flash 用；margin 取默认值，与实际设置的偏差 ≤8px 可接受） */
function tiledFlashFrame(mode: DisplayMode): Frame | null {
  const desktopSize = useWindowStore.getState().desktopSize;
  return computeTiledFrame(mode, {
    desktopSize,
    margin: mode === 'maximized' ? 0 : DEFAULT_TILE_MARGIN,
  });
}

// ---------------------------------------------------------------------------
// 窗口辅助
// ---------------------------------------------------------------------------

/** 焦点栈顶（最近聚焦且未最小化）的窗口 id */
function getFocusedWindowId(): string | null {
  const s = useWindowStore.getState();
  for (let i = s.focusStack.length - 1; i >= 0; i--) {
    const id = s.focusStack[i];
    const win = s.windows[id];
    if (win && !win.minimized) return id;
  }
  return null;
}

/** Tabbed apps may reserve Ctrl+W for their active internal tab. */
function focusedAppHandlesCloseShortcut(): boolean {
  const focusedId = getFocusedWindowId();
  if (!focusedId) return false;
  const focused = useWindowStore.getState().windows[focusedId];
  return Boolean(focused && appRegistry.get(focused.typeId)?.handlesCloseShortcut);
}

/** Tabbed apps may claim Ctrl+Tab / Ctrl+Shift+Tab for internal tab cycling. */
function focusedAppHandlesTabCycleShortcut(): boolean {
  const focusedId = getFocusedWindowId();
  if (!focusedId) return false;
  const focused = useWindowStore.getState().windows[focusedId];
  return Boolean(focused && appRegistry.get(focused.typeId)?.handlesTabCycleShortcut);
}

/** 按 lastFocusedAt 降序（最近使用在前）的全部窗口 id，含最小化窗口 */
function getSwitcherOrder(): string[] {
  return Object.values(useWindowStore.getState().windows)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
    .map((w) => w.id);
}

function startOrStepSwitcher(backwards: boolean): void {
  const overlay = useWorkbenchOverlay.getState();
  if (!overlay.switcherOpen) {
    const ids = getSwitcherOrder();
    if (ids.length === 0) return;
    // 初始选中：下一个最近使用（反向则队尾）；单窗时选自身
    const initial = ids.length === 1 ? 0 : backwards ? ids.length - 1 : 1;
    overlay.openSwitcher(ids, initial);
  } else {
    overlay.stepSwitcher(backwards ? -1 : 1);
  }
}

function commitSwitcher(): void {
  const overlay = useWorkbenchOverlay.getState();
  if (!overlay.switcherOpen) return;
  const selectedId = overlay.switcherIds[overlay.switcherIndex];
  const targetAlive = Boolean(
    selectedId && useWindowStore.getState().windows[selectedId],
  );
  // 选中窗已被关闭 → 无操作提交，按 cancel 退出（避免误播提交脉冲）
  overlay.closeSwitcher(targetAlive ? 'commit' : 'cancel');
  if (targetAlive && selectedId) {
    useWindowStore.getState().focusWindow(selectedId);
  }
}

/**
 * 同应用窗口循环（Ctrl+` / Ctrl+Shift+`）：
 * 在焦点窗口同 typeId 的窗口间按 createdAt 稳定序循环（含最小化，聚焦即恢复）。
 */
function cycleSameAppWindows(backwards: boolean): void {
  const store = useWindowStore.getState();
  const focusedId = getFocusedWindowId();
  if (!focusedId) return;
  const focused = store.windows[focusedId];
  if (!focused) return;
  const peers = Object.values(store.windows)
    .filter((w) => w.typeId === focused.typeId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (peers.length < 2) return;
  const index = peers.findIndex((w) => w.id === focusedId);
  const n = peers.length;
  const next = peers[(((index + (backwards ? -1 : 1)) % n) + n) % n];
  store.focusWindow(next.id);
}

/** 关闭所有窗口（逐窗经 requestCloseAnimated 走 canClose 拦截） */
function closeAllWindows(): void {
  const ids = Object.keys(useWindowStore.getState().windows);
  for (const id of ids) void requestCloseAnimated(id);
}

const TILE_ZONE_I18N_KEY: Partial<Record<DisplayMode, string>> = {
  'tiled-left': 'workbench:tile.zone.left',
  'tiled-right': 'workbench:tile.zone.right',
  'tiled-tl': 'workbench:tile.zone.topLeft',
  'tiled-tr': 'workbench:tile.zone.topRight',
  'tiled-bl': 'workbench:tile.zone.bottomLeft',
  'tiled-br': 'workbench:tile.zone.bottomRight',
  'tiled-top': 'workbench:tile.zone.top',
  'tiled-bottom': 'workbench:tile.zone.bottom',
};

// ---------------------------------------------------------------------------
// 动作执行
// ---------------------------------------------------------------------------

const TILE_MODE_BY_ID: Partial<Record<WorkbenchShortcutId, DisplayMode>> = {
  'tile-left': 'tiled-left',
  'tile-right': 'tiled-right',
  'tile-tl': 'tiled-tl',
  'tile-tr': 'tiled-tr',
  'tile-bl': 'tiled-bl',
  'tile-br': 'tiled-br',
  'tile-top': 'tiled-top',
  'tile-bottom': 'tiled-bottom',
  maximize: 'maximized',
};

const EDGE_BY_ID: Partial<Record<WorkbenchShortcutId, EdgeDirection>> = {
  'move-left': 'left',
  'move-right': 'right',
  'move-up': 'up',
  'move-down': 'down',
};

/** 平铺态先恢复 floating（restoreFrame 语义），返回恢复后的最新窗口 frame */
function ensureFloating(windowId: string): Frame | null {
  const store = useWindowStore.getState();
  const win = store.windows[windowId];
  if (!win) return null;
  if (win.displayMode !== 'floating') {
    store.setDisplayMode(windowId, 'floating');
  }
  return useWindowStore.getState().windows[windowId]?.frame ?? null;
}

function runShortcut(id: WorkbenchShortcutId): void {
  const overlay = useWorkbenchOverlay.getState();

  // 俯瞰激活期间只响应俯瞰开关与速查表（其余交互由 ExposeOverlay 处理）
  if (overlay.exposeOpen && id !== 'expose' && id !== 'expose-app' && id !== 'cheatsheet') {
    return;
  }

  switch (id) {
    case 'cycle-next':
      startOrStepSwitcher(false);
      return;
    case 'cycle-prev':
      startOrStepSwitcher(true);
      return;
    case 'cycle-app-next':
      cycleSameAppWindows(false);
      dispatchShortcutFeedback({ shortcutId: id });
      return;
    case 'cycle-app-prev':
      cycleSameAppWindows(true);
      dispatchShortcutFeedback({ shortcutId: id });
      return;
    case 'expose':
      // 进入/退出的 aria-live 播报统一由 ExposeOverlay 承担（所有入口共用）
      overlay.toggleExpose();
      return;
    case 'expose-app': {
      // App Exposé（Ctrl+Alt+Shift+E）：以焦点窗口的应用为过滤俯瞰其全部窗口。
      // 俯瞰已开时按 toggle 语义关闭（与 macOS ⌃↓ 再按退出一致）。
      if (overlay.exposeOpen) {
        overlay.closeExpose();
        return;
      }
      const appFocusedId = getFocusedWindowId();
      if (!appFocusedId) return; // 无焦点窗口时不动作
      const appFocused = useWindowStore.getState().windows[appFocusedId];
      if (!appFocused) return;
      overlay.openExpose({ appTypeId: appFocused.typeId });
      return;
    }
    case 'cheatsheet':
      closeAppsPanel();
      overlay.toggleCheatsheet();
      return;
    case 'show-desktop':
      toggleShowDesktop();
      dispatchShortcutFeedback({ shortcutId: id });
      return;
    case 'close-all':
      closeAllWindows();
      dispatchShortcutFeedback({ shortcutId: id });
      return;
    default:
      break;
  }

  const focusedId = getFocusedWindowId();
  if (!focusedId) return;
  const store = useWindowStore.getState();
  const win = store.windows[focusedId];
  if (!win) return;

  // 平铺 / 最大化族
  const tileMode = TILE_MODE_BY_ID[id];
  if (tileMode) {
    store.setDisplayMode(focusedId, tileMode);
    const frame = tiledFlashFrame(tileMode);
    if (frame) flashTargetRegion(frame);
    dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId, frame: frame ?? undefined });
    if (tileMode === 'maximized') {
      announceWorkbench(
        i18n.t('workbench:a11y.zoomed', {
          title: win.title,
        }),
      );
    } else {
      const zoneKey = TILE_ZONE_I18N_KEY[tileMode];
      if (zoneKey) {
        announceWorkbench(
          i18n.t('workbench:a11y.windowTiled', {
            title: win.title,
            zone: i18n.t(zoneKey),
          }),
        );
      }
    }
    return;
  }

  // 贴边移动族（保持尺寸；平铺态先恢复 floating）
  const edge = EDGE_BY_ID[id];
  if (edge) {
    const current = ensureFloating(focusedId);
    if (!current) return;
    const fresh = useWindowStore.getState();
    const moved = computeEdgeMovedFrame(current, fresh.desktopSize, edge);
    fresh.moveWindow(focusedId, moved);
    flashTargetRegion(moved);
    dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId, frame: moved });
    return;
  }

  switch (id) {
    case 'restore-or-minimize':
      if (win.displayMode !== 'floating') {
        store.setDisplayMode(focusedId, 'floating');
        announceWorkbench(
          i18n.t('workbench:a11y.restored', {
            title: win.title,
          }),
        );
      } else {
        requestMinimizeAnimated(focusedId);
      }
      dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId });
      return;
    case 'minimize':
      requestMinimizeAnimated(focusedId);
      dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId });
      return;
    case 'center': {
      const current = ensureFloating(focusedId);
      if (!current) return;
      const fresh = useWindowStore.getState();
      const centered = computeCenteredFrame(current, fresh.desktopSize);
      fresh.moveWindow(focusedId, centered);
      flashTargetRegion(centered);
      dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId, frame: centered });
      return;
    }
    case 'close-window':
      void requestCloseAnimated(focusedId);
      dispatchShortcutFeedback({ shortcutId: id, windowId: focusedId });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkbenchShortcuts(options?: UseWorkbenchShortcutsOptions): void {
  const enabled = options?.enabled ?? true;
  const enableCloseWindow = options?.enableCloseWindow ?? true;

  // 用 ref 透传可变选项，避免重挂监听器
  const closeEnabledRef = useRef(enableCloseWindow);
  closeEnabledRef.current = enableCloseWindow;

  useEffect(() => {
    if (!enabled) return undefined;

    // macOS 上主修饰键是 ⌘（Meta），长按/切换器会话围绕 Meta+Alt 展开；
    // 原 Ctrl 通道作为兜底同样接受（与 matchWorkbenchShortcut 的双通道一致）。
    const isMac = isMacShortcutPlatform();

    // ---- 长按 Ctrl+Alt（macOS: ⌘⌥ / ⌃⌥）→ 速查表临时显示（松开即收） ----
    let holdTimer: number | null = null;

    const cancelHold = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const scheduleHold = () => {
      if (holdTimer !== null) return;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        const overlay = useWorkbenchOverlay.getState();
        if (overlay.switcherOpen || overlay.cheatsheetOpen) return;
        closeAppsPanel();
        overlay.openCheatsheet({ sticky: false });
      }, CHEATSHEET_HOLD_MS);
    };

    const releaseTransientCheatsheet = () => {
      const overlay = useWorkbenchOverlay.getState();
      if (overlay.cheatsheetOpen && !overlay.cheatsheetSticky) overlay.closeCheatsheet();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const isModifierKey =
        e.key === 'Control' || e.key === 'Alt' || (isMac && e.key === 'Meta');

      // Esc 关闭速查表（overlay 级操作，不受输入框 guard 限制）
      if (e.key === 'Escape' && useWorkbenchOverlay.getState().cheatsheetOpen) {
        e.preventDefault();
        cancelHold();
        useWorkbenchOverlay.getState().closeCheatsheet();
        return;
      }
      // Esc 取消切换器会话（不聚焦），不受输入框 guard 限制（Ctrl 按住期间）
      if (e.key === 'Escape' && useWorkbenchOverlay.getState().switcherOpen) {
        e.preventDefault();
        useWorkbenchOverlay.getState().closeSwitcher();
        return;
      }

      // 任意非修饰键按下都取消长按会话（正在输入组合快捷键，而非"长按"）
      if (!isModifierKey) cancelHold();

      if (isShortcutGuardedEvent(e)) {
        cancelHold();
        return;
      }

      // 纯 主修饰+Alt 按住（无 Shift、无字符键）→ 进入长按计时
      // 非 macOS：Ctrl+Alt（Meta 参与则不算）；macOS：⌘⌥ 或兜底通道 ⌃⌥
      const primaryHeld = isMac ? e.metaKey || e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (
        isModifierKey &&
        primaryHeld &&
        e.altKey &&
        !e.shiftKey &&
        !useWorkbenchOverlay.getState().switcherOpen
      ) {
        scheduleHold();
      }

      const def = matchWorkbenchShortcut(e);
      if (!def) return;
      if (def.id === 'close-window' && !closeEnabledRef.current) return;
      // Let tabbed apps handle Ctrl+W consistently regardless of whether focus
      // is in their editor, tree, or tab strip. Do not reserve close-all.
      if (def.id === 'close-window' && focusedAppHandlesCloseShortcut()) return;
      // Ctrl+Tab 让位协议（AppDefinition.handlesTabCycleShortcut）：切换器
      // 会话未开启且焦点应用声明内部标签循环 → 壳层让位（不 preventDefault，
      // 应用自持监听器消费）。会话已开启则壳层保持所有权直至松开 Ctrl —— 此时
      // 继续走 preventDefault 分支，应用侧凭 defaultPrevented 跳过。
      if (
        (def.id === 'cycle-next' || def.id === 'cycle-prev') &&
        !useWorkbenchOverlay.getState().switcherOpen &&
        focusedAppHandlesTabCycleShortcut()
      ) {
        return;
      }
      cancelHold();
      if (e.repeat && def.id !== 'cycle-next' && def.id !== 'cycle-prev') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      runShortcut(def.id);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Alt' || (isMac && e.key === 'Meta')) {
        cancelHold();
        releaseTransientCheatsheet();
      }
      // 松开主修饰键（Ctrl；macOS 上 ⌘/Ctrl 双通道）→ 提交切换器选中窗口
      if (e.key === 'Control' || (isMac && e.key === 'Meta')) commitSwitcher();
    };

    const onBlur = () => {
      // 窗口失焦收不到 keyup，取消会话避免悬挂
      cancelHold();
      releaseTransientCheatsheet();
      useWorkbenchOverlay.getState().closeSwitcher();
    };

    // ---- macOS 原生菜单 File ▸ Close Window（⌘W）接管 ----
    // 原生 key equivalent 会在 WKWebView 收到 keydown 之前吃掉 ⌘W，
    // menu.rs 已把该菜单项改为经 menu://close-window 事件路由回前端
    // （menuEventBridge 派发同名 cancelable CustomEvent）。
    const onMenuCloseWindow = (e: Event) => {
      // workbench 桌面激活期间必须接管：关闭原生主窗在 macOS 上等价于退出
      // 应用。即使无可关窗口 / 关窗快捷键被设置禁用，也吞掉事件——对齐
      // Finder 无窗口时 ⌘W 无操作的惯例，避免连按 ⌘W 误退出。
      e.preventDefault();
      // 合成一次与 ⌘W 语义一致的 keydown 复用键盘管线：close-window 设置项、
      // tabbed 应用的 handlesCloseShortcut（notes/files 自持监听器关内部
      // 标签/窗口）与 requestCloseAnimated 走完全相同的分支。
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'w',
          code: 'KeyW',
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener(MENU_CLOSE_WINDOW_EVENT, onMenuCloseWindow);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(MENU_CLOSE_WINDOW_EVENT, onMenuCloseWindow);
      cancelHold();
      useWorkbenchOverlay.getState().closeSwitcher();
      useWorkbenchOverlay.getState().closeCheatsheet();
    };
  }, [enabled]);
}
