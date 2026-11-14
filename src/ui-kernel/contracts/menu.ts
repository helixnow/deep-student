import type { ReactNode } from 'react';

/**
 * Application menus (FE-B9): `app.menu` holds the rows of the workbench's menus: the menu bar menus, a Dock item's
 * right-click menu and the desktop's right-click menu.
 *
 * A contribution names the menu it belongs to and returns that menu's rows for the current context each time the
 * menu renders. Rows are data; the host renders them with its own item component, runs `run` and then closes the
 * menu unless `closeOnRun` is false. The workbench menus (ids `workbench.*`) and their context:
 * - `workbench.brand`: the 「学习桌面」 menu; the desktop name header and the inline rename form stay in the host.
 * - `workbench.app`: the focused app menu; `focusedTypeId` is null when no window has focus.
 * - `workbench.window`: the window menu; `windows` lists every window in menu order.
 * - `workbench.dock`: a Dock item's right-click menu; `windows` lists that app's windows, oldest first.
 * - `workbench.desktop`: the desktop's right-click menu; the desktop's own actions (layout, wallpaper, material,
 *   widgets) are on the context.
 * - `workbench.desktopShortcut`: a desktop shortcut icon's right-click menu; the icon's own actions (open, rename,
 *   remove) are on the context.
 * Workbench contexts carry `workbench`, the menu bar's actions, so rows never reach into the workbench themselves.
 * A menu rendered outside the workbench (an id without the `workbench.` prefix) gets only its own context and `t`:
 * - `finder.desktop`: the resource library desktop view's blank-area menu; the current root folder line under the
 *   rows stays in the host.
 * - `finder.desktopShortcut`: a shortcut card's right-click menu in that view (the workbench desktop's shortcuts).
 * - `finder.tab`: a tab's right-click menu in the resource library tab bar.
 *
 * Owned by `dstu.ui.menu` (ui-plugins/official/menu); a community contribution that throws (building its rows or
 * running one) is skipped and reported, the rest of the menu still renders.
 */

/**
 * Translator of the host that renders the menu (the `workbench` namespace for workbench menus); `defaultValue` is
 * returned when the key is missing.
 */
export type AppMenuTranslate = (key: string, defaultValue?: string) => string;

export type AppMenuDisplayMode = 'tiled-left' | 'tiled-right' | 'maximized';

/** The workbench actions the menu bar offers to its rows. Closing goes through the unsaved-changes guard. */
export interface AppMenuWorkbench {
  launchApp(typeId: string): void;
  openAppsPanel(): void;
  openCheatsheet(): void;
  /** Platform-formatted binding of the cheatsheet shortcut, when one is defined. */
  cheatsheetShortcut: string | undefined;
  closeWindow(windowId: string): void;
  /** Closes every window of the given window's app. */
  closeAppWindows(windowId: string): void;
  focusWindow(windowId: string): void;
  setDisplayMode(windowId: string, mode: AppMenuDisplayMode): void;
  /** Launches the app with the given reason (`launchApp` launches with `'api'`). */
  launchAppFrom(typeId: string, reason: AppMenuLaunchReason): void;
  /** Pins the app to the Dock, or unpins it when it is pinned. */
  toggleDockPinned(typeId: string): void;
  /** Closes every window of the app, one after the other, each through the unsaved-changes guard. */
  closeWindowsOfApp(typeId: string): void;
}

/** What asked for a launch (the workbench's launch reason). */
export type AppMenuLaunchReason = 'dock' | 'api' | 'shortcut' | 'files' | 'command';

/** A window in a Dock item's menu. */
export interface AppMenuDockWindow {
  id: string;
  /** Window title, else the app name; no suffix (see `minimized`). */
  label: string;
  minimized: boolean;
}

export interface AppMenuDock {
  typeId: string;
  /** The app's name; the type id when the app has no definition. */
  appLabel: string;
  /** Undefined when the app has no definition. */
  instanceMode: 'single' | 'multi' | undefined;
  /** The app's windows, oldest first. */
  windows: readonly AppMenuDockWindow[];
  /** The front-most window of the workbench (any app), or null. */
  foregroundWindowId: string | null;
  pinned: boolean;
}

export type AppMenuMaterialTier = 'auto' | 'full' | 'reduced' | 'minimal';

export interface AppMenuWallpaper {
  kind: 'theme' | 'image';
  /** Preset id for `theme`. */
  value: string;
}

export interface AppMenuWallpaperPreset {
  id: string;
  /** Translation key of the preset's name. */
  nameKey: string;
}

export interface AppMenuDesktop {
  /** Some window is open, minimized ones included. */
  hasWindows: boolean;
  /** Some window is open and not minimized. */
  hasVisibleWindows: boolean;
  wallpaper: AppMenuWallpaper;
  /** Every wallpaper preset, in display order. */
  wallpaperPresets: readonly AppMenuWallpaperPreset[];
  /** Saved material tier, read when the menu opens. */
  materialTier: AppMenuMaterialTier;
  /** Whether the desktop widgets show, read when the menu opens. */
  widgetsVisible: boolean;
  /** Platform-formatted bindings of the show-desktop and expose shortcuts, when defined. */
  showDesktopShortcut: string | undefined;
  exposeShortcut: string | undefined;
  /** Closes the menu right away (for rows with `closeOnRun: false` that close before they act). */
  closeMenu(): void;
  /** Minimizes every visible window, or restores the ones it last minimized. */
  toggleShowDesktop(): void;
  /** Turns the visible windows floating and cascades them. */
  arrangeWindows(): void;
  /** Tiles the visible windows, most recently focused first. */
  tileAllWindows(): void;
  toggleExpose(): void;
  /** Shows the empty-desktop tour again. */
  replayTour(): void;
  openWallpaperManager(): void;
  /** Saves a preset as the wallpaper. */
  setWallpaperPreset(presetId: string): void;
  /** Saves the material tier; the performance profile becomes custom. */
  setMaterialTier(tier: AppMenuMaterialTier): void;
  /** Saves whether the desktop widgets show. */
  setWidgetsVisible(visible: boolean): void;
}

/** A shortcut icon on the desktop: a resource, folder, quick-access entry or learning app. */
export interface AppMenuDesktopShortcut {
  shortcutId: string;
  shortcutType: 'app' | 'resource' | 'folder' | 'quickAccess';
  /** The name the icon shows; preset shortcuts that were never renamed follow the interface language. */
  name: string;
  /** What the shortcut points at; only the fields of its type are set. */
  target: {
    resourceId?: string;
    resourceType?: string;
    folderId?: string;
    quickAccessType?: string;
    appType?: string;
  };
  /** Closes the menu right away (for rows with `closeOnRun: false` that close before they act). */
  closeMenu(): void;
  /** Opens the shortcut, as double-clicking the icon does. */
  open(): void;
  /** Turns the icon's label into the rename field. */
  beginRename(): void;
  /** Removes the shortcut from the desktop (the resource library's desktop view shows the same shortcuts). */
  remove(): void;
}

export interface AppMenuWindow {
  id: string;
  /** Window title, else the app name; minimized windows carry the 「已最小化」 suffix. */
  label: string;
  minimized: boolean;
}

/** Where the resource library desktop view creates resources. */
export interface AppMenuFinderDesktopRoot {
  /** Null for the library root. */
  folderId: string | null;
  folderName: string | null;
  folderPath: string | null;
}

export interface AppMenuFinderDesktop {
  desktopRoot: AppMenuFinderDesktopRoot;
  /** Opens the add-shortcut dialog. */
  addShortcut(): void;
  /** Opens the folder picker that sets the desktop root. */
  chooseRootFolder(): void;
}

export interface AppMenuFinderDesktopShortcut extends Pick<AppMenuDesktopShortcut, 'shortcutId' | 'shortcutType' | 'name' | 'target' | 'beginRename' | 'remove'> {
  /** Opens the shortcut, as clicking the card does. */
  open(): void;
}

export interface AppMenuFinderTab {
  tabId: string;
  /** The resource the tab shows. */
  resourceType: string;
  resourceId: string;
  title: string;
  dstuPath: string;
  active: boolean;
  pinned: boolean;
  /** The tab is shown on the right of the split view. */
  splitRight: boolean;
  /** More than one tab is open, so this one can open on the right. */
  canSplit: boolean;
  /** Some tab to its right is not pinned (what closing the tabs to the right closes). */
  hasClosableToRight: boolean;
  close(): void;
  /** The actions below are undefined where the host does not offer them (no split view on small screens). */
  openSplitView?: () => void;
  closeSplitView?: () => void;
  togglePin?: () => void;
  closeOthers?: () => void;
  closeRight?: () => void;
}

export interface AppMenuContexts {
  'workbench.brand': { beginRename(): void };
  'workbench.app': { focusedWindowId: string | null; focusedTypeId: string | null };
  'workbench.window': { focusedWindowId: string | null; windows: readonly AppMenuWindow[] };
  'workbench.dock': AppMenuDock;
  'workbench.desktop': AppMenuDesktop;
  'workbench.desktopShortcut': AppMenuDesktopShortcut;
  'finder.desktop': AppMenuFinderDesktop;
  'finder.desktopShortcut': AppMenuFinderDesktopShortcut;
  'finder.tab': AppMenuFinderTab;
}

export type AppMenuId = keyof AppMenuContexts;

/**
 * What the host adds to each menu's context. A mapped type rather than a conditional one, so a host generic over the
 * menu id still type-checks when it passes `{ ...context, t, workbench }`.
 */
type AppMenuHostFields = {
  [M in AppMenuId]: M extends `workbench.${string}` ? { t: AppMenuTranslate; workbench: AppMenuWorkbench } : { t: AppMenuTranslate };
};

/**
 * What a menu's rows receive: the menu's own context and `t`. A workbench menu (id `workbench.*`) also carries
 * `workbench`, the menu bar's actions; a menu rendered outside the workbench does not, and its rows act only through
 * its own context.
 */
export type AppMenuContext<M extends AppMenuId> = AppMenuContexts[M] & AppMenuHostFields[M];

export interface AppMenuSeparator {
  kind: 'separator';
  id: string;
  /** Title of the group of rows after the separator; only the Dock menu, which groups its rows, shows it. */
  label?: string;
}

export interface AppMenuItem {
  kind?: 'item';
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  /** Renders a checkbox item; leave undefined for a plain item. */
  checked?: boolean;
  danger?: boolean;
  testId?: string;
  run?: () => void;
  /** Defaults to true. */
  closeOnRun?: boolean;
  /** Short text after the label: a tag in the Dock menu, ` · suffix` in the others. */
  suffix?: string;
  /** Renders a radio item; `checked` marks the selected one. */
  radio?: boolean;
  /**
   * Rows of a submenu, labelled with this item's label: the item opens it (hover, click, →) instead of running. Only
   * the desktop menu has submenus, one level deep; the other menus, and a submenu, show these rows in the item's place.
   */
  submenu?: readonly AppMenuRow[];
}

export type AppMenuRow = AppMenuSeparator | AppMenuItem;

export type AppMenuContributionFor<M extends AppMenuId> = {
  menu: M;
  items(context: AppMenuContext<M>): readonly AppMenuRow[];
};

export type AppMenuContribution = { [M in AppMenuId]: AppMenuContributionFor<M> }[AppMenuId];

declare module '../slot-map' {
  interface SlotMap {
    'app.menu': AppMenuContribution;
  }
}
