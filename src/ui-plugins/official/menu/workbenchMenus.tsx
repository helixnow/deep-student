/**
 * Official rows of the workbench menu bar menus (`app.menu`); the menu bar renders them and supplies the workbench
 * actions they run (`context.workbench`). Loaded with the menu bar; the rows are announced to `dstu.ui.menu` on import.
 */
import React from 'react';
import {
  AppWindow,
  CornersOut,
  GearSix,
  Keyboard,
  PencilSimple,
  Plus,
  SignOut,
  SquareHalf,
  SquaresFour,
  X,
  XSquare,
} from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
// 学习桌面开关的唯一写通道（停用预检、handoff 都在设置功能里）
import { workbenchMode } from '@/ui-plugins/official/settings/api';
import {
  appMenuContributions,
  type AppMenuContribution,
  type AppMenuContributionFor,
  type AppMenuDisplayMode,
  type AppMenuId,
  type AppMenuRow,
} from './appMenu';

function official<M extends AppMenuId>(id: string, order: number, menu: M, items: AppMenuContributionFor<M>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu, items } as unknown as AppMenuContribution };
}

const separator = (id: string): AppMenuRow => ({ kind: 'separator', id });

export const officialAppMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  official('brand:desktop', 10, 'workbench.brand', ({ t, beginRename }) => [
    { id: 'rename', icon: <PencilSimple size={15} weight="duotone" />, label: t('menubar.desktopRename'), testId: 'wb-menubar-brand-rename', run: beginRename, closeOnRun: false },
  ]),
  official('brand:system', 20, 'workbench.brand', ({ t, workbench }) => [
    separator('system-separator'),
    { id: 'apps', icon: <SquaresFour size={15} weight="duotone" />, label: t('workbench:appsPanel.title'), testId: 'wb-menubar-brand-apps', run: () => workbench.openAppsPanel() },
    // 速查表的常驻可发现入口（`?` 快捷键之外的第二条路径）
    {
      id: 'shortcuts', icon: <Keyboard size={15} weight="duotone" />, label: t('workbench:desktopMenu.shortcuts'), shortcut: workbench.cheatsheetShortcut,
      testId: 'wb-menubar-brand-shortcuts', run: () => workbench.openCheatsheet(),
    },
    { id: 'settings', icon: <GearSix size={15} weight="duotone" />, label: t('menubar.brandSettings'), testId: 'wb-menubar-brand-settings', run: () => workbench.launchApp('settings') },
  ]),
  official('brand:exit', 30, 'workbench.brand', ({ t }) => [
    separator('exit-separator'),
    {
      id: 'exit', icon: <SignOut size={15} weight="duotone" />, label: t('menubar.brandExit'), testId: 'wb-menubar-brand-exit',
      // 失败由 helper 统一通知；成功后 App 监听 workbench:mode-changed 切回 legacy 壳
      run: () => { void workbenchMode.setEnabled(false); },
    },
  ]),
  official('app:windows', 10, 'workbench.app', ({ t, workbench, focusedTypeId, focusedWindowId }) => (focusedTypeId ? [
    { id: 'new-window', icon: <Plus size={15} weight="bold" />, label: t('dock.newWindow'), testId: 'wb-menubar-app-new-window', run: () => workbench.launchApp(focusedTypeId) },
    separator('close-separator'),
    {
      id: 'close-window', icon: <X size={15} weight="bold" />, label: t('dock.closeWindow'), testId: 'wb-menubar-app-close-window',
      run: () => { if (focusedWindowId) workbench.closeWindow(focusedWindowId); },
    },
    {
      id: 'close-all', icon: <XSquare size={15} weight="duotone" />, label: t('dock.closeAll'), testId: 'wb-menubar-app-close-all',
      run: () => { if (focusedWindowId) workbench.closeAppWindows(focusedWindowId); },
    },
  ] : [
    { id: 'all-apps', icon: <SquaresFour size={15} weight="duotone" />, label: t('menubar.allApps'), testId: 'wb-menubar-app-all-apps', run: () => workbench.openAppsPanel() },
  ])),
  official('window:list', 10, 'workbench.window', ({ t, workbench, windows, focusedWindowId }) => {
    if (windows.length === 0) {
      return [{ id: 'empty', icon: <AppWindow size={15} weight="duotone" />, label: t('expose.empty'), testId: 'wb-menubar-window-empty', disabled: true }];
    }
    return windows.map((win) => ({
      id: `window:${win.id}`,
      icon: <AppWindow size={15} weight="duotone" />,
      label: win.label,
      checked: win.id === focusedWindowId && !win.minimized,
      testId: `wb-menubar-window-item-${win.id}`,
      run: () => workbench.focusWindow(win.id),
    }));
  }),
  official('window:tile', 20, 'workbench.window', ({ t, workbench, focusedWindowId }) => {
    const tile = (mode: AppMenuDisplayMode) => () => {
      if (!focusedWindowId) return;
      workbench.setDisplayMode(focusedWindowId, mode);
    };
    return [
      separator('tile-separator'),
      { id: 'tile-left', icon: <SquareHalf size={15} weight="duotone" />, label: t('tile.left'), disabled: !focusedWindowId, testId: 'wb-menubar-window-tile-left', run: tile('tiled-left') },
      {
        id: 'tile-right', icon: <SquareHalf size={15} weight="duotone" style={{ transform: 'scaleX(-1)' }} />, label: t('tile.right'),
        disabled: !focusedWindowId, testId: 'wb-menubar-window-tile-right', run: tile('tiled-right'),
      },
      { id: 'maximize', icon: <CornersOut size={15} weight="duotone" />, label: t('window.maximize'), disabled: !focusedWindowId, testId: 'wb-menubar-window-maximize', run: tile('maximized') },
    ];
  }),
];

for (const entry of officialAppMenuEntries) appMenuContributions.announce(entry);
