/**
 * Official rows of a desktop shortcut icon's right-click menu (`app.menu`, `workbench.desktopShortcut`); the icon layer
 * renders them and supplies the shortcut's actions. Loaded with the icon layer; the rows are announced to
 * `dstu.ui.menu` on import.
 */
import React from 'react';
import { ArrowSquareOut, PencilSimple, Trash } from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
import { appMenuContributions, type AppMenuContribution, type AppMenuContributionFor } from './appMenu';

function official(id: string, order: number, items: AppMenuContributionFor<'workbench.desktopShortcut'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'workbench.desktopShortcut', items } };
}

// 原菜单每一行都先关菜单再执行
export const officialDesktopShortcutMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  official('desktopShortcut:open', 10, ({ t, closeMenu, open }) => [
    {
      id: 'open', icon: <ArrowSquareOut size={15} weight="duotone" />, label: t('learningHub:desktop.open'), closeOnRun: false,
      run: () => { closeMenu(); open(); },
    },
  ]),
  official('desktopShortcut:manage', 20, ({ t, closeMenu, beginRename, remove }) => [
    { kind: 'separator', id: 'manage-separator' },
    {
      id: 'rename', icon: <PencilSimple size={15} weight="duotone" />, label: t('learningHub:desktop.rename'), closeOnRun: false,
      run: () => { closeMenu(); beginRename(); },
    },
    {
      id: 'remove', icon: <Trash size={15} weight="duotone" />, label: t('learningHub:desktop.remove'), danger: true, closeOnRun: false,
      run: () => { closeMenu(); remove(); },
    },
  ]),
];

for (const entry of officialDesktopShortcutMenuEntries) appMenuContributions.announce(entry);
