/**
 * Official rows of a Dock item's right-click menu (`app.menu`, `workbench.dock`); the Dock renders them and supplies
 * the app's state. Loaded with the Dock; the rows are announced to `dstu.ui.menu` on import.
 */
import React from 'react';
import { Plus, PushPin, PushPinSlash, SquaresFour, XCircle } from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
import { appMenuContributions, type AppMenuContribution, type AppMenuContributionFor, type AppMenuRow } from './appMenu';

function official(id: string, order: number, items: AppMenuContributionFor<'workbench.dock'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'workbench.dock', items } };
}

export const officialDockMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  official('dock:open', 10, ({ t, workbench, typeId, instanceMode, windows }) => {
    const multi = instanceMode === 'multi';
    return [{
      id: 'open',
      icon: <Plus size={16} weight="bold" />,
      // single：始终「打开」（已运行则禁用）；multi 有实例时「新建窗口」
      label: multi && windows.length > 0 ? t('workbench:dock.newWindow') : t('workbench:dock.open'),
      disabled: !(multi || windows.length === 0),
      run: () => workbench.launchAppFrom(typeId, 'dock'),
    }];
  }),
  official('dock:windows', 20, ({ t, workbench, windows, foregroundWindowId }) => (windows.length === 0 ? [] : [
    { kind: 'separator', id: 'windows-separator', label: t('workbench:dock.windows') },
    ...windows.map((win): AppMenuRow => ({
      id: `window:${win.id}`,
      icon: <SquaresFour size={16} />,
      label: win.label,
      checked: win.id === foregroundWindowId && !win.minimized,
      ...(win.minimized ? { suffix: t('workbench:dock.minimized') } : {}),
      run: () => workbench.focusWindow(win.id),
    })),
  ])),
  official('dock:pin', 30, ({ t, workbench, typeId, pinned, windows }) => [
    { kind: 'separator', id: 'pin-separator' },
    {
      id: 'pin',
      icon: pinned ? <PushPinSlash size={16} /> : <PushPin size={16} />,
      label: pinned ? t('workbench:dock.unpin') : t('workbench:dock.pin'),
      run: () => workbench.toggleDockPinned(typeId),
    },
    ...(windows.length > 0 ? [{
      id: 'close-all', icon: <XCircle size={16} />, label: t('workbench:dock.closeAll'), danger: true, run: () => workbench.closeWindowsOfApp(typeId),
    }] : []),
  ]),
];

for (const entry of officialDockMenuEntries) appMenuContributions.announce(entry);
