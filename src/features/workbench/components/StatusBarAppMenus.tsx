/**
 * StatusBarAppMenus — 菜单栏「聚焦应用」菜单 + 「窗口」菜单（macOS 心智模型）
 *
 * - 聚焦应用菜单：品牌 logo 右侧加粗显示当前焦点窗口所属应用名
 *   （无焦点窗口时显示默认名「学习桌面」）；下拉提供基于 windowStore /
 *   workbenchBus 已有能力的应用命令（新建窗口 / 关闭窗口 / 关闭全部窗口；
 *   无焦点应用时退化为「全部应用…」入口）。
 * - 窗口菜单：对齐 macOS Window menu——列出全部窗口（点击聚焦/恢复）
 *   与常用平铺命令（左半屏 / 右半屏 / 最大化，调 windowStore 冻结 API）。
 *
 * 弹层壳复用 StatusBarMenu（与品牌菜单同款玻璃面板与键盘语义）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  CornersOut,
  Plus,
  SquareHalf,
  SquaresFour,
  X,
  XSquare,
} from '@phosphor-icons/react';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import { getSortedWindows } from '../core/windowListCache';
import { workbenchBus } from '../core/workbenchBus';
import { useWorkbenchOverlay } from '../core/shortcuts';
import {
  requestCloseAnimated,
  requestCloseAppWindowsAnimated,
} from '../hooks/useWindowLifecycleAnim';
import { openAppsPanel } from './appsPanelStore';
import { ActionItem } from './DesktopContextMenu';
import { StatusBarMenu } from './StatusBarMenu';

type OpenMenu = 'app' | 'window' | null;

/** 焦点窗口所属应用名（无注册定义时回退 typeId） */
function useFocusedApp(): { windowId: string | null; typeId: string | null } {
  const windowId = useWindowStore((s) => s.focusStack[s.focusStack.length - 1] ?? null);
  const typeId = useWindowStore((s) => {
    const id = s.focusStack[s.focusStack.length - 1];
    return id ? s.windows[id]?.typeId ?? null : null;
  });
  return { windowId, typeId };
}

/** 窗口菜单内容：仅菜单打开期间挂载，windows 全量订阅不落在常驻顶栏上 */
const WindowMenuItems: React.FC<{
  focusedWindowId: string | null;
  onDone: () => void;
}> = ({ focusedWindowId, onDone }) => {
  const { t } = useTranslation('workbench');
  const windows = useWindowStore((s) => s.windows);
  const ordered = getSortedWindows(windows);

  const run = (fn: () => void) => () => {
    fn();
    onDone();
  };

  const windowLabel = (id: string): string => {
    const win = windows[id];
    if (!win) return t('expose.untitled');
    const def = appRegistry.get(win.typeId);
    const base = win.title || (def ? t(def.nameKey, win.typeId) : win.typeId);
    return win.minimized ? `${base} · ${t('dock.minimized')}` : base;
  };

  const tile = (mode: 'tiled-left' | 'tiled-right' | 'maximized') => {
    if (!focusedWindowId) return;
    useWindowStore.getState().setDisplayMode(focusedWindowId, mode);
  };

  return (
    <>
      {ordered.length === 0 ? (
        <ActionItem
          icon={<AppWindow size={15} weight="duotone" />}
          label={t('expose.empty')}
          testId="wb-menubar-window-empty"
          disabled
        />
      ) : (
        ordered.map((win) => (
          <ActionItem
            key={win.id}
            icon={<AppWindow size={15} weight="duotone" />}
            label={windowLabel(win.id)}
            checked={win.id === focusedWindowId && !win.minimized}
            testId={`wb-menubar-window-item-${win.id}`}
            onClick={run(() => useWindowStore.getState().focusWindow(win.id))}
          />
        ))
      )}
      <div className="wb-desk-menu-sep" role="separator" />
      <ActionItem
        icon={<SquareHalf size={15} weight="duotone" />}
        label={t('tile.left')}
        disabled={!focusedWindowId}
        testId="wb-menubar-window-tile-left"
        onClick={run(() => tile('tiled-left'))}
      />
      <ActionItem
        icon={<SquareHalf size={15} weight="duotone" style={{ transform: 'scaleX(-1)' }} />}
        label={t('tile.right')}
        disabled={!focusedWindowId}
        testId="wb-menubar-window-tile-right"
        onClick={run(() => tile('tiled-right'))}
      />
      <ActionItem
        icon={<CornersOut size={15} weight="duotone" />}
        label={t('window.maximize')}
        disabled={!focusedWindowId}
        testId="wb-menubar-window-maximize"
        onClick={run(() => tile('maximized'))}
      />
    </>
  );
};

export interface StatusBarAppMenusProps {
  /** 任一菜单开合变化时上报（autohide 打开期间保持展开用） */
  onOpenChange?: (open: boolean) => void;
}

export const StatusBarAppMenus: React.FC<StatusBarAppMenusProps> = ({ onOpenChange }) => {
  const { t } = useTranslation('workbench');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const appButtonRef = useRef<HTMLButtonElement | null>(null);
  const windowButtonRef = useRef<HTMLButtonElement | null>(null);
  const { windowId: focusedWindowId, typeId: focusedTypeId } = useFocusedApp();
  const exposeOpen = useWorkbenchOverlay((s) => s.exposeOpen);

  useEffect(() => {
    onOpenChange?.(openMenu !== null);
  }, [openMenu, onOpenChange]);

  useEffect(() => {
    // Exposé 打开时收起菜单（与学习中心 / 品牌菜单同语义）
    if (exposeOpen) setOpenMenu(null);
  }, [exposeOpen]);

  const closeMenus = useCallback(() => setOpenMenu(null), []);
  const runAndClose = useCallback(
    (action: () => void) => () => {
      action();
      setOpenMenu(null);
    },
    [],
  );

  const focusedDef = focusedTypeId ? appRegistry.get(focusedTypeId) : undefined;
  const appName = focusedTypeId
    ? focusedDef
      ? t(focusedDef.nameKey, focusedTypeId)
      : focusedTypeId
    : t('menubar.appName');

  // 关窗一律走 requestCloseAnimated：canClose（未保存确认）+ 退场动画统一，
  // 菜单栏不得绕过 guard 直接 store.closeWindow
  const closeAllOfApp = () => {
    if (!focusedWindowId) return;
    void requestCloseAppWindowsAnimated(focusedWindowId);
  };

  return (
    <>
      <button
        ref={appButtonRef}
        type="button"
        className="wb-menubar-item wb-menubar-appmenu"
        data-testid="wb-menubar-appmenu"
        aria-label={t('menubar.appMenu', { name: appName })}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'app'}
        title={appName}
        onClick={() => setOpenMenu((m) => (m === 'app' ? null : 'app'))}
      >
        <span className="wb-menubar-appmenu-label">{appName}</span>
      </button>
      <button
        ref={windowButtonRef}
        type="button"
        className="wb-menubar-item wb-menubar-windowmenu"
        data-testid="wb-menubar-windowmenu"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'window'}
        title={t('menubar.windowMenu')}
        onClick={() => setOpenMenu((m) => (m === 'window' ? null : 'window'))}
      >
        {t('menubar.windowMenu')}
      </button>

      <StatusBarMenu
        open={openMenu === 'app'}
        anchorRef={appButtonRef}
        label={t('menubar.appMenu', { name: appName })}
        onClose={closeMenus}
        testId="wb-menubar-appmenu-panel"
      >
        {focusedTypeId ? (
          <>
            <ActionItem
              icon={<Plus size={15} weight="bold" />}
              label={t('dock.newWindow')}
              testId="wb-menubar-app-new-window"
              onClick={runAndClose(() =>
                workbenchBus.launch({ typeId: focusedTypeId, reason: 'api' }),
              )}
            />
            <div className="wb-desk-menu-sep" role="separator" />
            <ActionItem
              icon={<X size={15} weight="bold" />}
              label={t('dock.closeWindow')}
              testId="wb-menubar-app-close-window"
              onClick={runAndClose(() => {
                if (focusedWindowId) void requestCloseAnimated(focusedWindowId);
              })}
            />
            <ActionItem
              icon={<XSquare size={15} weight="duotone" />}
              label={t('dock.closeAll')}
              testId="wb-menubar-app-close-all"
              onClick={runAndClose(closeAllOfApp)}
            />
          </>
        ) : (
          <ActionItem
            icon={<SquaresFour size={15} weight="duotone" />}
            label={t('menubar.allApps')}
            testId="wb-menubar-app-all-apps"
            onClick={runAndClose(() => openAppsPanel())}
          />
        )}
      </StatusBarMenu>

      <StatusBarMenu
        open={openMenu === 'window'}
        anchorRef={windowButtonRef}
        label={t('menubar.windowMenu')}
        onClose={closeMenus}
        testId="wb-menubar-windowmenu-panel"
      >
        <WindowMenuItems focusedWindowId={focusedWindowId} onDone={closeMenus} />
      </StatusBarMenu>
    </>
  );
};

export default StatusBarAppMenus;
