/**
 * Official rows of the desktop's right-click menu (`app.menu`, `workbench.desktop`); the desktop renders them, with the
 * wallpaper and material submenus, and supplies its actions on the context. Loaded with the desktop; the rows are
 * announced to `dstu.ui.menu` on import.
 */
import React from 'react';
import {
  CalendarBlank,
  ChatCircleDots,
  CirclesFour,
  Compass,
  Desktop,
  Drop,
  FolderOpen,
  GearSix,
  GridFour,
  Image,
  Keyboard,
  SquaresFour,
  Stack,
} from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
import {
  appMenuContributions,
  type AppMenuContext,
  type AppMenuContribution,
  type AppMenuContributionFor,
  type AppMenuMaterialTier,
  type AppMenuRow,
} from './appMenu';

/** Wallpaper presets the submenu lists; the full list is in the wallpaper manager. */
const MENU_WALLPAPER_PRESET_COUNT = 5;

function official(id: string, order: number, items: AppMenuContributionFor<'workbench.desktop'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'workbench.desktop', items } };
}

const separator = (id: string): AppMenuRow => ({ kind: 'separator', id });

function wallpaperRows(c: AppMenuContext<'workbench.desktop'>): AppMenuRow[] {
  const { t, wallpaper } = c;
  // 当前选中项若在截断区之外，追加显示以免丢失选中态
  const presets = c.wallpaperPresets.slice(0, MENU_WALLPAPER_PRESET_COUNT);
  if (wallpaper.kind === 'theme' && !presets.some((preset) => preset.id === wallpaper.value)) {
    const current = c.wallpaperPresets.find((preset) => preset.id === wallpaper.value);
    if (current) presets.push(current);
  }
  const openManager = () => {
    c.closeMenu();
    c.openWallpaperManager();
  };
  return [
    // 自定义图片壁纸：显示为选中态项，点击进壁纸管理面板更换
    ...(wallpaper.kind === 'image' ? [{
      id: '__custom-image__', radio: true, label: t('workbench:desktopMenu.customWallpaper', '自定义图片'), checked: true, closeOnRun: false, run: openManager,
    }] : []),
    ...presets.map((preset): AppMenuRow => ({
      id: preset.id,
      radio: true,
      label: t(preset.nameKey, preset.id),
      checked: wallpaper.kind === 'theme' && wallpaper.value === preset.id,
      run: () => c.setWallpaperPreset(preset.id),
    })),
    separator('manage-separator'),
    {
      id: 'manage', icon: <Image size={15} weight="duotone" />, label: t('workbench:desktopMenu.manageWallpaper', '管理壁纸…'),
      testId: 'wb-desk-menu-manage-wallpaper', closeOnRun: false, run: openManager,
    },
  ];
}

function materialTierRows(c: AppMenuContext<'workbench.desktop'>): AppMenuRow[] {
  const tiers: Array<[AppMenuMaterialTier, string]> = [
    ['auto', c.t('workbench:settings.materialTier.auto')],
    ['full', c.t('workbench:settings.materialTier.full')],
    ['reduced', c.t('workbench:settings.materialTier.reduced')],
    ['minimal', c.t('workbench:settings.materialTier.minimal')],
  ];
  return tiers.map(([tier, label]) => ({ id: tier, radio: true, label, checked: c.materialTier === tier, run: () => c.setMaterialTier(tier) }));
}

export const officialDesktopMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  official('desktop:launch', 10, ({ t, workbench }) => [
    { id: 'new-chat', icon: <ChatCircleDots size={15} weight="duotone" />, label: t('workbench:desktopMenu.newChat'), run: () => workbench.launchAppFrom('chat', 'command') },
    { id: 'open-files', icon: <FolderOpen size={15} weight="duotone" />, label: t('workbench:desktopMenu.openFiles'), run: () => workbench.launchAppFrom('files', 'command') },
    { id: 'all-apps', icon: <CirclesFour size={15} weight="duotone" />, label: t('workbench:desktopMenu.allApps'), run: () => workbench.openAppsPanel() },
  ]),
  official('desktop:layout', 20, (c) => [
    separator('layout-separator'),
    {
      id: 'arrange', icon: <Stack size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.arrange'), disabled: !c.hasVisibleWindows,
      run: () => c.arrangeWindows(),
    },
    {
      id: 'tile-all', icon: <GridFour size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.tileAll'), disabled: !c.hasVisibleWindows,
      run: () => c.tileAllWindows(),
    },
    {
      id: 'show-desktop',
      icon: <Desktop size={15} weight="duotone" />,
      label: c.hasVisibleWindows ? c.t('workbench:desktopMenu.showDesktop') : c.t('workbench:desktopMenu.restoreWindows'),
      shortcut: c.showDesktopShortcut,
      disabled: !c.hasWindows,
      run: () => c.toggleShowDesktop(),
    },
    {
      id: 'expose', icon: <SquaresFour size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.expose'), shortcut: c.exposeShortcut,
      disabled: !c.hasWindows, run: () => c.toggleExpose(),
    },
  ]),
  official('desktop:appearance', 30, (c) => [
    separator('appearance-separator'),
    { id: 'wallpaper', icon: <Image size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.wallpaper'), submenu: wallpaperRows(c) },
    { id: 'tier', icon: <Drop size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.materialTier'), submenu: materialTierRows(c) },
    {
      id: 'widgets', icon: <CalendarBlank size={15} weight="duotone" />, label: c.t('workbench:desktopMenu.showWidgets'), checked: c.widgetsVisible,
      testId: 'wb-desk-menu-widgets', run: () => c.setWidgetsVisible(!c.widgetsVisible),
    },
  ]),
  official('desktop:help', 40, ({ t, workbench, closeMenu, replayTour }) => [
    separator('help-separator'),
    {
      id: 'shortcuts', icon: <Keyboard size={15} weight="duotone" />, label: t('workbench:desktopMenu.shortcuts'), shortcut: workbench.cheatsheetShortcut,
      testId: 'wb-desk-menu-shortcuts', closeOnRun: false, run: () => { closeMenu(); workbench.openCheatsheet(); },
    },
    {
      id: 'replay-tour', icon: <Compass size={15} weight="duotone" />, label: t('workbench:desktopMenu.replayTour'), testId: 'wb-desk-menu-replay-tour',
      closeOnRun: false, run: () => { closeMenu(); replayTour(); },
    },
    { id: 'settings', icon: <GearSix size={15} weight="duotone" />, label: t('workbench:desktopMenu.settings'), run: () => workbench.launchAppFrom('settings', 'command') },
  ]),
];

for (const entry of officialDesktopMenuEntries) appMenuContributions.announce(entry);
