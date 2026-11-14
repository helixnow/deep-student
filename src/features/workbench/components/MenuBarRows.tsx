/**
 * 菜单栏的 `app.menu` 行：取槽位（无 UI 内核时用官方行），补上翻译与菜单栏动作（`context.workbench`），
 * 按桌面右键菜单同款 ActionItem 渲染。官方行见 ui-plugins/official/menu/workbenchMenus.tsx。
 */
import React from 'react';
import type { AppMenuContexts, AppMenuId, AppMenuTranslate, AppMenuWindow } from '@/ui-sdk';
import { officialAppMenuEntries } from '@/ui-plugins/official/menu/workbenchMenus';
import { inlineAppMenuSubmenus, type ResolvedAppMenuRow } from '@/ui-plugins/official/menu/appMenu';
import { appRegistry } from '../core/appRegistry';
import { getSortedWindows } from '../core/windowListCache';
import type { WorkbenchWindow } from '../core/types';
import { useAppMenuRows as useHostAppMenuRows, useAppMenuTranslate } from './appMenuHost';
import { DeskMenuRow } from './DeskMenuItems';

/** 窗口菜单的窗口列表：菜单顺序；标题优先，否则应用名（无注册定义时回退 typeId），最小化带后缀 */
export function menuBarWindows(windows: Readonly<Record<string, WorkbenchWindow>>, t: AppMenuTranslate): AppMenuWindow[] {
  return getSortedWindows(windows as Record<string, WorkbenchWindow>).map((win) => {
    const def = appRegistry.get(win.typeId);
    const base = win.title || (def ? t(def.nameKey, win.typeId) : win.typeId);
    return { id: win.id, label: win.minimized ? `${base} · ${t('dock.minimized')}` : base, minimized: !!win.minimized };
  });
}

/** `workbench` 命名空间的翻译（带默认值时透传） */
export const useMenuBarTranslate = useAppMenuTranslate;

/** 某个菜单栏菜单的行：有 UI 内核时取 `app.menu`（社区行出错计入其插件），否则取官方行 */
export function useAppMenuRows<M extends AppMenuId>(menu: M, context: AppMenuContexts[M]): ResolvedAppMenuRow[] {
  return useHostAppMenuRows(menu, context, officialAppMenuEntries);
}

/** 菜单栏行（桌面右键菜单同款 ActionItem；子菜单就地展开）；`onDone` 在行执行后关闭菜单 */
export function MenuBarRows({ rows, onDone }: { rows: readonly ResolvedAppMenuRow[]; onDone: () => void }) {
  return (
    <>
      {inlineAppMenuSubmenus(rows).map((row) => <DeskMenuRow key={row.key} row={row} onDone={onDone} />)}
    </>
  );
}
