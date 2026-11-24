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
 * 菜单行来自 `app.menu`（官方行见 ui-plugins/official/menu/workbenchMenus.tsx，渲染见 MenuBarRows.tsx）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SquaresFour } from '@phosphor-icons/react';
import { appRegistry } from '../core/appRegistry';
import { useWindowStore } from '../core/windowStore';
import {
  formatShortcutBinding,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_DEFINITIONS,
} from '../core/shortcuts';
import { useAppsPanelOpen } from './appsPanelStore';
import { ActionItem } from './DeskMenuItems';
import { StatusBarMenu } from './StatusBarMenu';
import { MenuBarRows, menuBarWindows, useAppMenuRows, useMenuBarTranslate } from './MenuBarRows';

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

/** 窗口菜单内容（app.menu 的 workbench.window 行）：仅菜单打开期间挂载，windows 全量订阅不落在常驻顶栏上 */
const WindowMenuItems: React.FC<{
  focusedWindowId: string | null;
  onDone: () => void;
}> = ({ focusedWindowId, onDone }) => {
  const windows = useWindowStore((s) => s.windows);
  const t = useMenuBarTranslate();
  const { t: tw } = useTranslation('workbench');
  const rows = useAppMenuRows('workbench.window', { focusedWindowId, windows: menuBarWindows(windows, t) });
  const exposeDef = WORKBENCH_SHORTCUT_DEFINITIONS.find((d) => d.id === 'expose');
  return (
    <>
      <MenuBarRows rows={rows} onDone={onDone} />
      <div className="wb-desk-menu-sep" role="separator" />
      <ActionItem
        icon={<SquaresFour size={15} weight="duotone" />}
        label={tw('menubar.windowExpose', { defaultValue: '多窗俯瞰' })}
        shortcut={exposeDef ? formatShortcutBinding(exposeDef.binding) : undefined}
        testId="wb-menubar-window-expose"
        onClick={() => {
          useWorkbenchOverlay.getState().toggleExpose();
          onDone();
        }}
      />
    </>
  );
};

export interface StatusBarAppMenusProps {
  /** 任一菜单开合变化时上报（autohide 打开期间保持展开用） */
  onOpenChange?: (open: boolean) => void;
  /** 受控模式：当前顶栏激活的菜单 id（覆盖品牌/应用/窗口/控制中心/时钟） */
  activeMenuId?: 'brand' | 'app' | 'window' | 'control-center' | 'clock' | null;
  /** 受控模式：点击切换对应菜单 */
  onToggleMenu?: (id: 'app' | 'window') => void;
  /** 受控模式：顶栏已有菜单展开时指针划入相邻触发器 0ms 即时切换 */
  onHoverMenu?: (id: 'app' | 'window') => void;
  /** 受控模式：关闭菜单 */
  onCloseMenu?: () => void;
}

export const StatusBarAppMenus: React.FC<StatusBarAppMenusProps> = ({
  onOpenChange,
  activeMenuId,
  onToggleMenu,
  onHoverMenu,
  onCloseMenu,
}) => {
  const { t } = useTranslation('workbench');
  const isControlled = activeMenuId !== undefined;
  const [internalOpenMenu, setInternalOpenMenu] = useState<OpenMenu>(null);
  const openMenu: OpenMenu = isControlled
    ? activeMenuId === 'app' || activeMenuId === 'window'
      ? activeMenuId
      : null
    : internalOpenMenu;
  const appButtonRef = useRef<HTMLButtonElement | null>(null);
  const windowButtonRef = useRef<HTMLButtonElement | null>(null);
  const { windowId: focusedWindowId, typeId: focusedTypeId } = useFocusedApp();
  const exposeOpen = useWorkbenchOverlay((s) => s.exposeOpen);
  const appsPanelOpen = useAppsPanelOpen();

  useEffect(() => {
    onOpenChange?.(openMenu !== null);
  }, [openMenu, onOpenChange]);

  useEffect(() => {
    // Exposé 或统一搜索面板（⌘K）打开时收起菜单（与学习中心 / 品牌菜单同语义）
    if (!isControlled && (exposeOpen || appsPanelOpen)) {
      setInternalOpenMenu(null);
    }
  }, [isControlled, exposeOpen, appsPanelOpen]);

  const closeMenus = useCallback(() => {
    if (isControlled) {
      onCloseMenu?.();
    } else {
      setInternalOpenMenu(null);
    }
  }, [isControlled, onCloseMenu]);

  const handleToggle = useCallback(
    (menu: 'app' | 'window') => {
      if (isControlled) {
        onToggleMenu?.(menu);
      } else {
        setInternalOpenMenu((m) => (m === menu ? null : menu));
      }
    },
    [isControlled, onToggleMenu],
  );

  const handleHover = useCallback(
    (menu: 'app' | 'window') => {
      if (isControlled) {
        onHoverMenu?.(menu);
      } else {
        setInternalOpenMenu((m) => (m !== null && m !== menu ? menu : m));
      }
    },
    [isControlled, onHoverMenu],
  );

  const instantExit = isControlled ? activeMenuId !== null : internalOpenMenu !== null;
  const focusedDef = focusedTypeId ? appRegistry.get(focusedTypeId) : undefined;
  const appName = focusedTypeId
    ? focusedDef
      ? t(focusedDef.nameKey, focusedTypeId)
      : focusedTypeId
    : t('menubar.appName');

  const appRows = useAppMenuRows('workbench.app', { focusedWindowId, focusedTypeId });

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
        onClick={() => handleToggle('app')}
        onPointerEnter={() => handleHover('app')}
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
        onClick={() => handleToggle('window')}
        onPointerEnter={() => handleHover('window')}
      >
        {t('menubar.windowMenu')}
      </button>

      <StatusBarMenu
        open={openMenu === 'app'}
        anchorRef={appButtonRef}
        label={t('menubar.appMenu', { name: appName })}
        onClose={closeMenus}
        hideBackdrop={isControlled}
        instantExit={instantExit}
        testId="wb-menubar-appmenu-panel"
      >
        <MenuBarRows rows={appRows} onDone={closeMenus} />
      </StatusBarMenu>

      <StatusBarMenu
        open={openMenu === 'window'}
        anchorRef={windowButtonRef}
        label={t('menubar.windowMenu')}
        onClose={closeMenus}
        hideBackdrop={isControlled}
        instantExit={instantExit}
        testId="wb-menubar-windowmenu-panel"
      >
        <WindowMenuItems focusedWindowId={focusedWindowId} onDone={closeMenus} />
      </StatusBarMenu>
    </>
  );
};

export default StatusBarAppMenus;
