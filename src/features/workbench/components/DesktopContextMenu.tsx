/**
 * DesktopContextMenu（O13）— 桌面空白区右键菜单 + 桌面手势
 * ---------------------------------------------------------------------------
 * 本文件集中承载 O13 的全部新增逻辑，WorkbenchDesktop（总装文件）只做薄接线：
 *
 * - `DesktopContextMenu`：桌面右键菜单（新建对话 / 资源库 / 整理窗口 / 平铺全部 /
 *   显示桌面 / 窗口俯瞰 / 壁纸预设 / 视觉材质 / 桌面设置），
 *   行来自 `app.menu` 的 `workbench.desktop`（无 UI 内核时用同一张官方表，见
 *   ui-plugins/official/menu/desktopMenu.tsx），本文件提供菜单动作并渲染，
 *   自绘玻璃面板（不用 Radix，避免把总装根节点包进 Trigger），
 *   键盘可达（↑↓ 移动、→ 进子菜单、← 退出、Enter 触发、Esc 关闭）；
 * - `useDesktopGestures`：桌面空白区 contextmenu / 双击 show desktop 手势
 *   （target === currentTarget 判空白；show desktop 走 hooks/showDesktop 共享 stash）；
 * 全部窗口操作走 windowStore / workbenchBus / useWorkbenchOverlay 现有 API，
 * 不新增 store 字段；设置持久化复用 P10 的 save_setting + 'workbench:settings-changed'
 * 事件契约（非 Tauri 环境回退 localStorage，与 WorkbenchDesktop.readSetting 对称）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { AppMenuDesktop } from '@/ui-sdk';
import { officialDesktopMenuEntries } from '@/ui-plugins/official/menu/desktopMenu';
import { inlineAppMenuSubmenus } from '@/ui-plugins/official/menu/appMenu';
import { useWindowStore } from '../core/windowStore';
import type { DisplayMode } from '../core/types';
import { getSortedWindows } from '../core/windowListCache';
import {
  WORKBENCH_SHORTCUT_DEFINITIONS,
  formatShortcutBinding,
  useWorkbenchOverlay,
} from '../core/shortcuts';
import { setMaterialTier, type MaterialTierSetting } from '../core/materialTier';
import { useLiquidGlassLens, WallpaperReplica } from '../core/liquidGlassLens';
import { toggleShowDesktop as toggleShowDesktopShared } from '../hooks/showDesktop';
import { WALLPAPER_PRESETS, type WallpaperConfig } from './WallpaperLayer';
import { OPEN_WALLPAPER_MANAGER_EVENT } from './WallpaperManagerDialog';
import { logWallpaperDiag } from '../core/wallpaperDiagnostics';
import { replayEmptyDesktopTour } from './EmptyDesktop';
import { useAppMenuRows } from './appMenuHost';
import { ActionItem, DeskMenuRow } from './DeskMenuItems';
import './DesktopContextMenu.css';

// ---------------------------------------------------------------------------
// 设置读写（key 契约与 P10 设置页 / WorkbenchDesktop 一致）
// ---------------------------------------------------------------------------

const WALLPAPER_SETTING_KEY = 'desktop.workbenchWallpaper';
const MATERIAL_TIER_SETTING_KEY = 'desktop.workbenchMaterialTier';
/** 桌面组件（日程小组件等）显隐；缺省 = 显示，只有显式 'false' 才隐藏 */
export const DESKTOP_WIDGETS_SETTING_KEY = 'desktop.workbenchDesktopWidgets';

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

async function readWorkbenchSetting(key: string): Promise<string | null> {
  try {
    if (!isTauriRuntime()) {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    return await invoke<string | null>('get_setting', { key });
  } catch {
    return null;
  }
}

/**
 * 持久化 + 派发 'workbench:settings-changed'。
 * 桌面（WorkbenchDesktop）与设置页共用该事件热更新，菜单不直接改桌面 state。
 */
async function persistWorkbenchSetting(key: string, raw: string, parsed: unknown): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await invoke('save_setting', { key, value: raw });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, raw);
    }
  } catch {
    // 落盘失败仍派发热更新（本次会话内生效）
  }
  try {
    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', { detail: { key, value: parsed } }),
    );
  } catch {
    // noop
  }
}

// ---------------------------------------------------------------------------
// 桌面窗口批量操作（全部走 store 现有 action）
// ---------------------------------------------------------------------------

const ARRANGE_ORIGIN = 48;
const ARRANGE_STEP = 28;

/** 整理窗口：全部非最小化窗口恢复 floating 并按 z 序重新级联（尺寸不变，越界回卷） */
export function arrangeDesktopWindows(): void {
  const store = useWindowStore.getState();
  const wins = Object.values(store.windows)
    .filter((w) => !w.minimized)
    .sort((a, b) => a.zIndex - b.zIndex);
  if (wins.length === 0) return;
  const { desktopSize } = store;
  let slot = 0;
  for (const win of wins) {
    if (win.displayMode !== 'floating') {
      store.setDisplayMode(win.id, 'floating');
    }
    const fresh = useWindowStore.getState().windows[win.id];
    if (!fresh) continue;
    const f = fresh.frame;
    let x = ARRANGE_ORIGIN + slot * ARRANGE_STEP;
    let y = ARRANGE_ORIGIN + slot * ARRANGE_STEP;
    if (slot > 0 && (x + f.w > desktopSize.w || y + f.h > desktopSize.h)) {
      slot = 0;
      x = ARRANGE_ORIGIN;
      y = ARRANGE_ORIGIN;
    }
    slot += 1;
    x = Math.max(0, Math.min(x, Math.max(0, desktopSize.w - f.w)));
    y = Math.max(0, Math.min(y, Math.max(0, desktopSize.h - f.h)));
    store.moveWindow(win.id, { ...f, x, y });
  }
}

/**
 * 平铺全部：按最近聚焦排序落位——1 窗最大化；2 窗左右分屏；
 * 3 窗左半 + 右上/右下；≥4 窗前四个进四分屏，其余保持原状（留在平铺层后面）。
 */
export function tileAllDesktopWindows(): void {
  const store = useWindowStore.getState();
  const wins = Object.values(store.windows)
    .filter((w) => !w.minimized)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  if (wins.length === 0) return;

  const entries: Array<{ id: string; mode: DisplayMode }> = [];
  if (wins.length === 1) {
    entries.push({ id: wins[0].id, mode: 'maximized' });
  } else if (wins.length === 2) {
    entries.push({ id: wins[0].id, mode: 'tiled-left' }, { id: wins[1].id, mode: 'tiled-right' });
  } else if (wins.length === 3) {
    entries.push(
      { id: wins[0].id, mode: 'tiled-left' },
      { id: wins[1].id, mode: 'tiled-tr' },
      { id: wins[2].id, mode: 'tiled-br' },
    );
  } else {
    const quads = ['tiled-tl', 'tiled-tr', 'tiled-bl', 'tiled-br'] as const;
    wins.slice(0, quads.length).forEach((w, i) => entries.push({ id: w.id, mode: quads[i] }));
  }

  if (typeof store.batchSetDisplayModes === 'function') {
    store.batchSetDisplayModes(entries);
  } else {
    for (const e of entries) store.setDisplayMode(e.id, e.mode);
  }
}

// ---------------------------------------------------------------------------
// 桌面手势：空白区右键（开菜单）+ 双击（show desktop 往返）
// ---------------------------------------------------------------------------

export interface DesktopMenuAnchor {
  /** 相对桌面根节点的坐标 */
  x: number;
  y: number;
}

export interface DesktopGestures {
  menuAnchor: DesktopMenuAnchor | null;
  closeMenu: () => void;
  /** show desktop 往返：有可见窗 → 全部最小化；否则恢复上次批量最小化的窗口 */
  toggleShowDesktop: () => void;
  onDesktopContextMenu: React.MouseEventHandler<HTMLElement>;
  onDesktopKeyDown: React.KeyboardEventHandler<HTMLElement>;
  onDesktopDoubleClick: React.MouseEventHandler<HTMLElement>;
}

export function useDesktopGestures(
  rootRef: React.RefObject<HTMLElement | null>,
): DesktopGestures {
  const [menuAnchor, setMenuAnchor] = useState<DesktopMenuAnchor | null>(null);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  const toggleShowDesktop = useCallback(() => {
    toggleShowDesktopShared();
  }, []);

  const onDesktopContextMenu = useCallback<React.MouseEventHandler<HTMLElement>>(
    (e) => {
      // 只处理真正落在桌面空白处的事件（窗口/Dock 等自带 pointer-events 的元素 target ≠ root）
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      const rect = rootRef.current?.getBoundingClientRect();
      setMenuAnchor({
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
      });
    },
    [rootRef],
  );

  const onDesktopDoubleClick = useCallback<React.MouseEventHandler<HTMLElement>>(
    (e) => {
      if (e.target !== e.currentTarget) return;
      toggleShowDesktop();
    },
    [toggleShowDesktop],
  );

  const onDesktopKeyDown = useCallback<React.KeyboardEventHandler<HTMLElement>>(
    (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      e.stopPropagation();
      // 键盘打开：落在工作区中心（此前 Math.min(32, …) 把锚点错钳到左上角）
      const rect = rootRef.current?.getBoundingClientRect();
      setMenuAnchor({
        x: Math.max(0, (rect?.width ?? 0) / 2),
        y: Math.max(0, (rect?.height ?? 0) / 2),
      });
    },
    [rootRef],
  );

  return {
    menuAnchor,
    closeMenu,
    toggleShowDesktop,
    onDesktopContextMenu,
    onDesktopKeyDown,
    onDesktopDoubleClick,
  };
}

// ---------------------------------------------------------------------------
// 菜单渲染
// ---------------------------------------------------------------------------

const MENU_FALLBACK_W = 240;
const MENU_FALLBACK_H = 320;
const MENU_EDGE_PAD = 8;
/** 子菜单展开侧判定用的近似宽度 */
const SUBMENU_APPROX_W = 190;
/** 离场编排：wb-kf-window-close(90ms) 播完再卸载 + 余量 */
const DESK_MENU_EXIT_MS = 180;

interface SubmenuPosition {
  left: number;
  top: number;
}

/** 按 id 查全局快捷键的展示文案（无绑定时返回 undefined，菜单不渲染提示槽） */
function shortcutHintFor(id: string): string | undefined {
  const def = WORKBENCH_SHORTCUT_DEFINITIONS.find((d) => d.id === id);
  return def ? formatShortcutBinding(def.binding) : undefined;
}

export interface DesktopContextMenuProps {
  /** null = 关闭；坐标相对桌面根节点 */
  anchor: DesktopMenuAnchor | null;
  wallpaper: WallpaperConfig;
  onClose: () => void;
  onShowDesktop: () => void;
}

const DesktopContextMenuComponent: React.FC<DesktopContextMenuProps> = ({
  anchor,
  wallpaper,
  onClose,
  onShowDesktop,
}) => {
  const { t } = useTranslation();
  const desktopSize = useWindowStore((s) => s.desktopSize);
  const hasWindows = useWindowStore((s) => getSortedWindows(s.windows).length > 0);
  const hasVisibleWindows = useWindowStore((s) =>
    getSortedWindows(s.windows).some((w) => !w.minimized),
  );

  const panelRef = useRef<HTMLDivElement | null>(null);
  const subPanelRef = useRef<HTMLDivElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  /** 展开的子菜单：父项行的 key */
  const [openSub, setOpenSub] = useState<string | null>(null);
  /** 子菜单父项的包裹层（按行 key），定位与键盘回焦用 */
  const subParentRefs = useRef(new Map<string, HTMLElement>());
  const [submenuPosition, setSubmenuPosition] = useState<SubmenuPosition | null>(null);
  const [tierSetting, setTierSetting] = useState<MaterialTierSetting>('auto');
  const [widgetsVisible, setWidgetsVisible] = useState(true);
  const open = anchor !== null;
  useLiquidGlassLens(panelRef, open);
  useLiquidGlassLens(subPanelRef, open && openSub !== null);

  // ---- 离场编排：anchor 置空后保留面板播 wb-kf-window-close，播完再卸载 ----
  const [renderedAnchor, setRenderedAnchor] = useState<DesktopMenuAnchor | null>(anchor);
  const [closing, setClosing] = useState(false);
  const renderedAnchorRef = useRef(renderedAnchor);
  const exitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    renderedAnchorRef.current = renderedAnchor;
  }, [renderedAnchor]);
  useEffect(() => {
    if (anchor) {
      // 打开/重开：取消进行中的离场，面板保持挂载复播入场动画
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRenderedAnchor(anchor);
      setClosing(false);
      return;
    }
    // renderedAnchor 走 ref 镜像、不列入依赖：closing 置位不应重触发本 effect
    if (!renderedAnchorRef.current) return;
    setClosing(true);
    // 主面板淡出时子菜单同步卸载（此前子菜单 portal 会在 body 上多挂 ~180ms）
    setOpenSub(null);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setRenderedAnchor(null);
      setClosing(false);
    }, DESK_MENU_EXIT_MS);
  }, [anchor]);

  // 卸载兜底：清掉进行中的离场计时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    },
    [],
  );

  const subOpensLeft = pos.left + (panelRef.current?.offsetWidth || MENU_FALLBACK_W) + SUBMENU_APPROX_W >
    desktopSize.w - MENU_EDGE_PAD;
  const subClassName = `wb-desk-menu wb-glass-lens wb-desk-menu-sub${subOpensLeft ? ' wb-desk-menu-sub--left' : ''}`;

  // ---- 开合副作用：定位钳制 / 焦点管理 / 全局兜底监听 ----

  useLayoutEffect(() => {
    if (!anchor) return;
    setOpenSub(null);
    const el = panelRef.current;
    const w = el?.offsetWidth || MENU_FALLBACK_W;
    const h = el?.offsetHeight || MENU_FALLBACK_H;
    setPos({
      left: Math.max(MENU_EDGE_PAD, Math.min(anchor.x, desktopSize.w - w - MENU_EDGE_PAD)),
      top: Math.max(MENU_EDGE_PAD, Math.min(anchor.y, desktopSize.h - h - MENU_EDGE_PAD)),
    });
  }, [anchor, desktopSize]);

  useEffect(() => {
    if (!open) return undefined;
    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // 焦点逃逸（hover 子菜单开合等）时的兜底关闭通道
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onWindowBlur = () => onClose();
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, onClose]);

  // 打开时回读材质档 / 桌面组件设置（仅菜单展示选中态用）
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void readWorkbenchSetting(MATERIAL_TIER_SETTING_KEY).then((raw) => {
      if (cancelled) return;
      const v = String(raw ?? '');
      setTierSetting(v === 'full' || v === 'reduced' || v === 'minimal' ? v : 'auto');
    });
    void readWorkbenchSetting(DESKTOP_WIDGETS_SETTING_KEY).then((raw) => {
      if (cancelled) return;
      setWidgetsVisible(String(raw ?? '') !== 'false');
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 键盘打开子菜单时聚焦第一项（hover 打开不抢焦点）
  const subOpenedByKeyboardRef = useRef(false);
  useEffect(() => {
    if (!open || !openSub || !subOpenedByKeyboardRef.current) return;
    subOpenedByKeyboardRef.current = false;
    subPanelRef.current
      ?.querySelector<HTMLButtonElement>('button[data-wb-desk-item]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open, openSub]);

  useLayoutEffect(() => {
    if (!openSub) {
      setSubmenuPosition(null);
      return;
    }

    const parentItem = subParentRefs.current.get(openSub)?.querySelector<HTMLElement>('[data-wb-desk-sub]');
    const submenu = subPanelRef.current;
    if (!parentItem || !submenu) return;

    const parentRect = parentItem.getBoundingClientRect();
    const submenuRect = submenu.getBoundingClientRect();
    const left = subOpensLeft
      ? parentRect.left - submenuRect.width - 2
      : parentRect.right + 2;
    const maxTop = Math.max(MENU_EDGE_PAD, window.innerHeight - submenuRect.height - MENU_EDGE_PAD);

    setSubmenuPosition({
      left: Math.max(MENU_EDGE_PAD, Math.min(left, window.innerWidth - submenuRect.width - MENU_EDGE_PAD)),
      top: Math.max(MENU_EDGE_PAD, Math.min(parentRect.top - 6, maxTop)),
    });
  }, [desktopSize, openSub, pos, subOpensLeft]);

  // ---- 动作（菜单行来自 app.menu 的 workbench.desktop；行执行后关闭菜单，closeOnRun: false 的行先关再执行） ----

  const desktop: AppMenuDesktop = {
    hasWindows,
    hasVisibleWindows,
    wallpaper,
    wallpaperPresets: WALLPAPER_PRESETS,
    materialTier: tierSetting,
    widgetsVisible,
    showDesktopShortcut: shortcutHintFor('show-desktop'),
    exposeShortcut: shortcutHintFor('expose'),
    closeMenu: onClose,
    toggleShowDesktop: onShowDesktop,
    arrangeWindows: arrangeDesktopWindows,
    tileAllWindows: tileAllDesktopWindows,
    toggleExpose: () => useWorkbenchOverlay.getState().toggleExpose(),
    replayTour: replayEmptyDesktopTour,
    openWallpaperManager: () => {
      try {
        window.dispatchEvent(new CustomEvent(OPEN_WALLPAPER_MANAGER_EVENT));
      } catch {
        // noop
      }
    },
    setWallpaperPreset: (presetId) => {
      const next: WallpaperConfig = { kind: 'theme', value: presetId };
      logWallpaperDiag('persist', {
        source: 'context-menu',
        key: WALLPAPER_SETTING_KEY,
        value: next,
      });
      void persistWorkbenchSetting(WALLPAPER_SETTING_KEY, JSON.stringify(next), next);
    },
    setMaterialTier: (next) => {
      setTierSetting(next);
      setMaterialTier(next);
      void persistWorkbenchSetting(MATERIAL_TIER_SETTING_KEY, next, next);
      // 桌面菜单单独改材质 → 性能档位记为自定义（与设置页一致）
      void persistWorkbenchSetting('desktop.workbenchPerformanceProfile', 'custom', 'custom');
    },
    /** 桌面组件显隐：走既有 desktop.* 设置通道，WorkbenchDesktop 经热更新事件收敛 */
    setWidgetsVisible: (next) => {
      setWidgetsVisible(next);
      void persistWorkbenchSetting(DESKTOP_WIDGETS_SETTING_KEY, String(next), next);
    },
  };
  const rows = useAppMenuRows('workbench.desktop', renderedAnchor ? desktop : null, officialDesktopMenuEntries);
  const openSubRow = openSub ? rows.find((row) => row.key === openSub) : undefined;
  const subRows = openSubRow && openSubRow.kind !== 'separator' && openSubRow.submenu
    ? inlineAppMenuSubmenus(openSubRow.submenu)
    : null;


  // ---- 键盘导航 ----

  const collectItems = (scope: HTMLElement | null, mainPanelOnly: boolean): HTMLButtonElement[] => {
    if (!scope) return [];
    return Array.from(
      scope.querySelectorAll<HTMLButtonElement>('button[data-wb-desk-item]:not(:disabled)'),
    ).filter((el) => !mainPanelOnly || !el.closest('.wb-desk-menu-sub'));
  };

  const focusSubParent = (subKey: string) => {
    subParentRefs.current.get(subKey)
      ?.querySelector<HTMLButtonElement>('button[data-wb-desk-sub]')
      ?.focus({ preventScroll: true });
  };

  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLButtonElement | null;
    const inSub = openSub !== null && Boolean(subPanelRef.current?.contains(active));
    const items = inSub
      ? collectItems(subPanelRef.current, false)
      : collectItems(panelRef.current, true);
    const idx = active ? items.indexOf(active) : -1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[(idx + 1 + items.length) % Math.max(items.length, 1)]?.focus({ preventScroll: true });
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[idx <= 0 ? items.length - 1 : idx - 1]?.focus({ preventScroll: true });
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus({ preventScroll: true });
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus({ preventScroll: true });
        break;
      case 'ArrowRight': {
        const subKey = active?.dataset.wbDeskSub !== undefined
          ? [...subParentRefs.current].find(([, wrap]) => wrap.contains(active))?.[0]
          : undefined;
        if (!inSub && subKey) {
          e.preventDefault();
          subOpenedByKeyboardRef.current = true;
          setOpenSub(subKey);
        }
        break;
      }
      case 'ArrowLeft':
        if (inSub && openSub) {
          e.preventDefault();
          const parent = openSub;
          setOpenSub(null);
          focusSubParent(parent);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (inSub && openSub) {
          const parent = openSub;
          setOpenSub(null);
          focusSubParent(parent);
        } else {
          onClose();
        }
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  if (!renderedAnchor) return null;

  return (
    <>
      {/* backdrop 在 closing 期间保留（仅拦截，不再触发关闭）：
          离场 ~90ms 内的点击不应穿透到桌面/窗口（首次点击只收起菜单语义） */}
      <div
        className="wb-desk-menu-backdrop"
        data-wb-desk-menu-backdrop
        aria-hidden="true"
        onPointerDown={closing ? undefined : onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!closing) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="wb-desk-menu wb-glass-lens"
        data-wb-desk-menu
        data-phase={closing ? 'closing' : 'open'}
        role="menu"
        aria-label={t('workbench:desktopMenu.label')}
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onPanelKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <WallpaperReplica hostRef={panelRef} enabled={open} />
        {rows.map((row) => {
          if (row.kind === 'separator' || !row.submenu) {
            return <DeskMenuRow key={row.key} row={row} onDone={onClose} onPointerEnter={() => setOpenSub(null)} />;
          }
          const subKey = row.key;
          return (
            <div
              key={subKey}
              ref={(el) => {
                if (el) subParentRefs.current.set(subKey, el);
                else subParentRefs.current.delete(subKey);
              }}
              className="wb-desk-menu-subwrap"
            >
              <ActionItem
                icon={row.icon}
                label={row.label}
                disabled={row.disabled}
                danger={row.danger}
                testId={row.testId}
                subId={row.id}
                subOpen={openSub === subKey}
                onClick={() => setOpenSub(openSub === subKey ? null : subKey)}
                onPointerEnter={() => setOpenSub(subKey)}
              />
            </div>
          );
        })}
      </div>
      {openSubRow && subRows && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={subPanelRef}
              className={subClassName}
              role="menu"
              aria-label={openSubRow.label}
              style={{
                left: submenuPosition?.left ?? 0,
                top: submenuPosition?.top ?? 0,
                visibility: submenuPosition ? 'visible' : 'hidden',
              }}
              onKeyDown={onPanelKeyDown}
            >
              <WallpaperReplica hostRef={subPanelRef} enabled={open && openSub !== null} />
              {subRows.map((row) => <DeskMenuRow key={row.key} row={row} onDone={onClose} />)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

export const DesktopContextMenu = React.memo(DesktopContextMenuComponent);
DesktopContextMenu.displayName = 'DesktopContextMenu';

export default DesktopContextMenu;
