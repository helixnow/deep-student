/**
 * Host side of `app.menu` for the resource library's menus (`finder.*`: the desktop view's blank area and shortcut
 * cards, the tab bar's tabs): the rows of a menu — from the slot when a UI kernel is installed, otherwise from the
 * official rows the caller passes in — with the `learningHub` translator. These menus have no submenus.
 * The workbench menus' host is workbench/components/appMenuHost.ts.
 */
import { useTranslation } from 'react-i18next';
import type { AppMenuContext, AppMenuContexts, AppMenuContribution, AppMenuTranslate, SlotEntry } from '@/ui-sdk';
import { useOptionalSlot } from '@/ui-sdk';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { inlineAppMenuSubmenus, resolveAppMenuRows, type ResolvedAppMenuRow } from '@/ui-plugins/official/menu/appMenu';

export type FinderMenuId = 'finder.desktop' | 'finder.desktopShortcut' | 'finder.tab';

/** 某个资源库菜单的行：有 UI 内核时取 `app.menu`（社区行出错计入其插件），否则取 `official` */
// RUST-FIX(RF-W18-finder-menu-contributions): finder-specific host context and plugin error attribution.
export function useFinderMenuRows<M extends FinderMenuId>(
  menu: M,
  context: AppMenuContexts[M],
  official: readonly SlotEntry<AppMenuContribution>[],
): ResolvedAppMenuRow[] {
  const { t: translate } = useTranslation(['learningHub', 'common']);
  const kernel = useOptionalUiKernel();
  const entries = useOptionalSlot('app.menu') ?? official;
  const t: AppMenuTranslate = (key, defaultValue) => (defaultValue === undefined ? translate(key) : translate(key, defaultValue));
  return inlineAppMenuSubmenus(resolveAppMenuRows(entries, menu, { ...context, t } as AppMenuContext<M>, (entry, phase, error) => {
    if (kernel) kernel.errors.report({ pluginId: entry.owner, origin: entry.origin, phase, error, slot: 'app.menu', entryId: entry.id });
    else console.error(`[app.menu] "${entry.id}" failed`, error);
  }));
}
