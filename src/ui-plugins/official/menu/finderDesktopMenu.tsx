/**
 * Official rows of the resource library desktop view's right-click menus (`app.menu`): `finder.desktop` for the blank
 * area, `finder.desktopShortcut` for a shortcut card. The view renders them and supplies the actions. Loaded with the
 * view; the rows are announced to `dstu.ui.menu` on import.
 */
import React from 'react';
import { ArrowSquareOut, Gear, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
import { appMenuContributions, type AppMenuContribution, type AppMenuContributionFor } from './appMenu';

function blankArea(id: string, order: number, items: AppMenuContributionFor<'finder.desktop'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'finder.desktop', items } };
}

function shortcut(id: string, order: number, items: AppMenuContributionFor<'finder.desktopShortcut'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'finder.desktopShortcut', items } };
}

// RUST-FIX(RF-W18-finder-menu-contributions): load with the view, not the startup closure.
export const officialFinderDesktopMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  blankArea('finderDesktop:add', 10, ({ t, addShortcut }) => [
    { id: 'add-shortcut', icon: <Plus size={15} weight="duotone" />, label: t('learningHub:desktop.addShortcut'), run: addShortcut },
  ]),
  blankArea('finderDesktop:root', 20, ({ t, chooseRootFolder }) => [
    { kind: 'separator', id: 'root-separator' },
    { id: 'set-root', icon: <Gear size={15} weight="duotone" />, label: t('learningHub:desktop.setRootFolder'), run: chooseRootFolder },
  ]),
  shortcut('finderDesktopShortcut:open', 10, ({ t, open }) => [
    { id: 'open', icon: <ArrowSquareOut size={15} weight="duotone" />, label: t('learningHub:desktop.open'), run: open },
  ]),
  shortcut('finderDesktopShortcut:rename', 20, ({ t, beginRename }) => [
    { kind: 'separator', id: 'rename-separator' },
    { id: 'rename', icon: <PencilSimple size={15} weight="duotone" />, label: t('learningHub:desktop.rename'), run: beginRename },
  ]),
  shortcut('finderDesktopShortcut:remove', 30, ({ t, remove }) => [
    { kind: 'separator', id: 'remove-separator' },
    { id: 'remove', icon: <Trash size={15} weight="duotone" />, label: t('learningHub:desktop.remove'), danger: true, run: remove },
  ]),
];

for (const entry of officialFinderDesktopMenuEntries) appMenuContributions.announce(entry);
