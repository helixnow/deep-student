/**
 * Host side of `app.menu` shared by the menu bar, the Dock item menu and the desktop right-click menu: the workbench
 * actions every context carries (`context.workbench`), the `workbench`-namespace translator, and the rows of a menu —
 * from the slot when a UI kernel is installed, otherwise from the official rows the caller passes in.
 */
import { useTranslation } from 'react-i18next';
import type { AppMenuContexts, AppMenuContribution, AppMenuId, AppMenuTranslate, AppMenuWorkbench, SlotEntry } from '@/ui-sdk';
import { useOptionalSlot } from '@/ui-sdk';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { resolveAppMenuRows, type ResolvedAppMenuRow } from '@/ui-plugins/official/menu/appMenu';
import { useWindowStore } from '../core/windowStore';
import { workbenchBus } from '../core/workbenchBus';
import { WORKBENCH_SHORTCUT_DEFINITIONS, formatShortcutBinding, useWorkbenchOverlay } from '../core/shortcuts';
import { requestCloseAnimated, requestCloseAppWindowsAnimated } from '../hooks/useWindowLifecycleAnim';
import { openAppsPanel } from './appsPanelStore';
import { toggleDockPinned } from './DockPinnedStore';

// 关窗一律走 requestCloseAnimated：canClose（未保存确认）+ 退场动画统一，菜单不得绕过 guard 直接 store.closeWindow
const appMenuWorkbench: Omit<AppMenuWorkbench, 'cheatsheetShortcut'> = {
  launchApp: (typeId) => { workbenchBus.launch({ typeId, reason: 'api' }); },
  openAppsPanel: () => openAppsPanel(),
  openCheatsheet: () => useWorkbenchOverlay.getState().openCheatsheet({ sticky: true }),
  closeWindow: (windowId) => { void requestCloseAnimated(windowId); },
  closeAppWindows: (windowId) => { void requestCloseAppWindowsAnimated(windowId); },
  focusWindow: (windowId) => useWindowStore.getState().focusWindow(windowId),
  setDisplayMode: (windowId, mode) => useWindowStore.getState().setDisplayMode(windowId, mode),
  launchAppFrom: (typeId, reason) => { workbenchBus.launch({ typeId, reason }); },
  toggleDockPinned: (typeId) => toggleDockPinned(typeId),
  closeWindowsOfApp: (typeId) => {
    const current = Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === typeId);
    void (async () => {
      for (const win of current) {
        await requestCloseAnimated(win.id);
      }
    })();
  },
};

/** 速查表键位提示（平台相关，渲染时求值而非模块初始化时） */
function cheatsheetShortcutHint(): string | undefined {
  const definition = WORKBENCH_SHORTCUT_DEFINITIONS.find((item) => item.id === 'cheatsheet');
  return definition ? formatShortcutBinding(definition.binding) : undefined;
}

/** `workbench` 命名空间的翻译（带默认值时透传） */
export function useAppMenuTranslate(): AppMenuTranslate {
  const { t } = useTranslation('workbench');
  return (key, defaultValue) => (defaultValue === undefined ? t(key) : t(key, defaultValue));
}

/**
 * 某个菜单的行：有 UI 内核时取 `app.menu`（社区行出错计入其插件），否则取 `official`。
 * `context` 为 null（菜单未渲染）时不生成行。
 */
export function useAppMenuRows<M extends AppMenuId>(
  menu: M,
  context: AppMenuContexts[M] | null,
  official: readonly SlotEntry<AppMenuContribution>[],
): ResolvedAppMenuRow[] {
  const t = useAppMenuTranslate();
  const kernel = useOptionalUiKernel();
  const entries = useOptionalSlot('app.menu') ?? official;
  if (!context) return [];
  const workbench: AppMenuWorkbench = { ...appMenuWorkbench, cheatsheetShortcut: cheatsheetShortcutHint() };
  return resolveAppMenuRows(entries, menu, { ...context, t, workbench }, (entry, phase, error) => {
    if (kernel) kernel.errors.report({ pluginId: entry.owner, origin: entry.origin, phase, error, slot: 'app.menu', entryId: entry.id });
    else console.error(`[app.menu] "${entry.id}" failed`, error);
  });
}
