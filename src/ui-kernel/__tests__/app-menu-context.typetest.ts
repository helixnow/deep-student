/**
 * `AppMenuContext` 的编译期断言（`app-menu-context.types.test.ts` 检查）。这里为测试登记了一个工作台以外的菜单
 * `typetest.board`，所以文件放在 `__tests__` 下：应用的 tsconfig 与 owned-typecheck 都不收它，这个菜单 id 不会漏进真实的
 * `AppMenuContexts`。
 */
import {
  contribution, type AppMenuContext, type AppMenuContexts, type AppMenuContributionFor, type AppMenuId, type AppMenuRow,
  type AppMenuTranslate, type AppMenuWorkbench,
  type AppMenuFinderDesktop, type AppMenuFinderDesktopRoot, type AppMenuFinderDesktopShortcut, type AppMenuFinderTab,
} from '../../ui-sdk';

declare module '../contracts/menu' {
  interface AppMenuContexts {
    'typetest.board': { boardId: string; closeMenu(): void };
  }
}

declare const t: AppMenuTranslate;
declare const workbench: AppMenuWorkbench;

// A menu outside the workbench: rows use its own context and `t`; the host builds the context without `workbench`.
const boardRows = (c: AppMenuContext<'typetest.board'>): AppMenuRow[] => [{ id: 'close', label: c.t('close'), run: () => c.closeMenu() }];
export const boardContext: AppMenuContext<'typetest.board'> = { boardId: 'b1', closeMenu() {}, t };

// Workbench menus keep `workbench`, on the rows' side and on the host's side.
export const appContext: AppMenuContext<'workbench.app'> = { focusedWindowId: null, focusedTypeId: null, t, workbench };
// @ts-expect-error [workbench-context-needs-workbench]
export const appContextWithoutWorkbench: AppMenuContext<'workbench.app'> = { focusedWindowId: null, focusedTypeId: null, t };

export const menus = [
  contribution('app.menu', { id: 'typetest/board', value: { menu: 'typetest.board', items: boardRows } }),
  contribution('app.menu', { id: 'typetest/app', value: { menu: 'workbench.app', items: (c) => [{ id: 'apps', label: c.t('apps'), run: () => c.workbench.openAppsPanel() }] } }),
  // @ts-expect-error [board-has-no-workbench]
  contribution('app.menu', { id: 'typetest/board-apps', value: { menu: 'typetest.board', items: (c) => [{ id: 'apps', label: 'apps', run: () => c.workbench.openAppsPanel() }] } }),
];

// A host that renders any menu (the workbench's `useAppMenuRows`) passes `workbench`; leaving it out fails for a
// generic menu, since that menu may be a workbench one.
export function hostRows<M extends AppMenuId>(menu: AppMenuContributionFor<M>, context: AppMenuContexts[M]): readonly AppMenuRow[] {
  const rows = menu.items({ ...context, t, workbench });
  // @ts-expect-error [generic-host-needs-workbench]
  void menu.items({ ...context, t });
  return rows;
}

// Handoff 41: the three real finder menus need only their own actions and the host translator.
const desktopRoot: AppMenuFinderDesktopRoot = { folderId: null, folderName: null, folderPath: null };
const desktop: AppMenuFinderDesktop = { desktopRoot, addShortcut() {}, chooseRootFolder() {} };
const shortcut: AppMenuFinderDesktopShortcut = {
  shortcutId: 'note-1', shortcutType: 'resource', name: 'Note', target: { resourceId: 'note-1', resourceType: 'note' },
  open() {}, beginRename() {}, remove() {},
};
const tab: AppMenuFinderTab = {
  tabId: 'tab-1', resourceType: 'note', resourceId: 'note-1', title: 'Note', dstuPath: '/notes/note-1',
  active: true, pinned: false, splitRight: false, canSplit: false, hasClosableToRight: false, close() {},
};
export const finderContexts: {
  [M in 'finder.desktop' | 'finder.desktopShortcut' | 'finder.tab']: AppMenuContext<M>;
} = {
  'finder.desktop': { ...desktop, t },
  'finder.desktopShortcut': { ...shortcut, t },
  'finder.tab': { ...tab, t },
};
export const finderMenus = [
  contribution('app.menu', { id: 'finder/desktop', value: { menu: 'finder.desktop', items: (c) => [
    { id: 'add', label: c.t(c.desktopRoot.folderName ?? 'root'), run: () => c.addShortcut() },
    { id: 'choose', label: c.t('choose'), run: () => c.chooseRootFolder() },
  ] } }),
  contribution('app.menu', { id: 'finder/shortcut', value: { menu: 'finder.desktopShortcut', items: (c) => [
    { id: c.shortcutId, label: c.t(c.name), run: () => { c.open(); c.beginRename(); c.remove(); } },
  ] } }),
  contribution('app.menu', { id: 'finder/tab', value: { menu: 'finder.tab', items: (c) => [
    { id: c.tabId, label: c.t(c.title), disabled: !c.canSplit, checked: c.pinned, run: () => {
      c.openSplitView?.(); c.closeSplitView?.(); c.togglePin?.(); c.closeOthers?.(); c.closeRight?.(); c.close();
    } },
  ] } }),
];
// @ts-expect-error [finder-desktop-no-workbench]
finderContexts['finder.desktop'].workbench.openAppsPanel();
// @ts-expect-error [finder-shortcut-no-workbench]
finderContexts['finder.desktopShortcut'].workbench.openAppsPanel();
// @ts-expect-error [finder-tab-no-workbench]
finderContexts['finder.tab'].workbench.openAppsPanel();
// @ts-expect-error [finder-context-mismatch]
export const wrongFinderContext: AppMenuContext<'finder.desktop'> = { ...tab, t };
