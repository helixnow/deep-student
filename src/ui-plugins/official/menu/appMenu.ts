/**
 * Application menus (FE-B9); the value types and SlotMap entry are the kernel contract `@/ui-kernel/contracts/menu`,
 * exported by the SDK.
 *
 * The official rows (workbenchMenus.tsx for the menu bar, dockMenu.tsx, desktopMenu.tsx, desktopShortcutMenu.tsx; for the
 * resource library finderDesktopMenu.tsx and tabBarMenu.tsx) load with their menus (not at startup) and announce
 * themselves to `appMenuContributions`; `dstu.ui.menu` declares the slot and contributes what is announced. Without a
 * UI kernel each menu uses the same official rows directly.
 */
import type {
  AppMenuContext, AppMenuContribution, AppMenuContributionFor, AppMenuId, AppMenuItem, AppMenuRow, AppMenuSeparator, SlotDefinition, SlotEntry,
} from '@/ui-sdk';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

export type {
  AppMenuContext,
  AppMenuContexts,
  AppMenuContribution,
  AppMenuContributionFor,
  AppMenuDesktop,
  AppMenuDesktopShortcut,
  AppMenuDisplayMode,
  AppMenuDock,
  AppMenuId,
  AppMenuItem,
  AppMenuMaterialTier,
  AppMenuRow,
  AppMenuSeparator,
  AppMenuTranslate,
  AppMenuWindow,
  AppMenuWorkbench,
} from '@/ui-sdk';

export const APP_MENU_SLOT: SlotDefinition = {
  name: 'app.menu',
  cardinality: 'list',
  description: '应用菜单（工作台菜单栏品牌 / 聚焦应用 / 窗口菜单、Dock 项右键菜单、桌面右键菜单）：按 order 生成各菜单的行',
};

export const appMenuContributions = createLazyContributionPoint<SlotEntry<AppMenuContribution>>('app.menu');

export type AppMenuError = (entry: SlotEntry<AppMenuContribution>, phase: 'render' | 'report', error: unknown) => void;

export type ResolvedAppMenuItem = Omit<AppMenuItem, 'submenu'> & { key: string; submenu?: readonly ResolvedAppMenuRow[] };

/** One rendered row; `key` is unique across contributions, submenu rows included. */
export type ResolvedAppMenuRow = (AppMenuSeparator & { key: string }) | ResolvedAppMenuItem;

/** The rows of `menu`, in slot order. A community `run` that throws, in a submenu too, is only reported. */
export function resolveAppMenuRows<M extends AppMenuId>(
  entries: readonly SlotEntry<AppMenuContribution>[],
  menu: M,
  context: AppMenuContext<M>,
  onError: AppMenuError,
): ResolvedAppMenuRow[] {
  const rows: ResolvedAppMenuRow[] = [];
  const seen = new Map<string, number>();
  const uniqueKey = (base: string) => {
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}#${count}` : base;
  };
  for (const entry of entries) {
    if (entry.value.menu !== menu) continue;
    const contribution = entry.value as AppMenuContributionFor<M>;
    const builtin = entry.origin === 'builtin';
    let items: readonly AppMenuRow[];
    if (builtin) items = contribution.items(context);
    else {
      try {
        items = contribution.items(context);
      } catch (error) {
        onError(entry, 'render', error);
        continue;
      }
    }
    const resolve = (row: AppMenuRow, parent: string): ResolvedAppMenuRow => {
      const key = uniqueKey(`${parent}:${row.kind ?? 'item'}:${row.id}`);
      if (row.kind === 'separator') return { ...row, key };
      const { run, submenu, ...item } = row;
      const resolved: ResolvedAppMenuItem = { ...item, key };
      if (run) {
        resolved.run = builtin ? run : () => {
          try {
            run();
          } catch (error) {
            onError(entry, 'report', error);
          }
        };
      }
      if (submenu) resolved.submenu = submenu.map((child) => resolve(child, key));
      return resolved;
    };
    for (const row of items) rows.push(resolve(row, `${entry.owner}:${entry.id}`));
  }
  return rows;
}

/** For menus without submenus: every submenu item replaced by its rows. */
export function inlineAppMenuSubmenus(rows: readonly ResolvedAppMenuRow[]): ResolvedAppMenuRow[] {
  return rows.flatMap((row) => (row.kind !== 'separator' && row.submenu ? inlineAppMenuSubmenus(row.submenu) : [row]));
}
