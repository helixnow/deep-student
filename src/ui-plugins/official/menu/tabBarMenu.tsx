/**
 * Official rows of a resource library tab's right-click menu (`app.menu`, `finder.tab`); the tab bar renders them and
 * supplies the tab's state and actions. Loaded with the tab bar; the rows are announced to `dstu.ui.menu` on import.
 */
import React from 'react';
import { PushPin, PushPinSlash, SidebarSimple } from '@phosphor-icons/react';
import type { SlotEntry } from '@/ui-sdk';
import { appMenuContributions, type AppMenuContribution, type AppMenuContributionFor, type AppMenuRow } from './appMenu';

function official(id: string, order: number, items: AppMenuContributionFor<'finder.tab'>['items']): SlotEntry<AppMenuContribution> {
  return { id, order, owner: 'dstu.ui.menu', origin: 'builtin', value: { menu: 'finder.tab', items } };
}

const closeIcon = (
  <svg width="12" height="12" viewBox="0 0 10 10" fill="none">
    <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

// RUST-FIX(RF-W18-finder-menu-contributions): existing tab actions become ordered contributions.
export const officialTabBarMenuEntries: readonly SlotEntry<AppMenuContribution>[] = [
  // 没有分屏的宿主（小屏）不给分屏动作，行也不出现
  official('tab:split', 10, ({ t, splitRight, canSplit, openSplitView, closeSplitView }): AppMenuRow[] => {
    if (splitRight) {
      return closeSplitView
        ? [{ id: 'close-split', icon: <SidebarSimple size={14} />, label: t('learningHub:splitView.close'), run: closeSplitView }]
        : [];
    }
    return openSplitView
      ? [{ id: 'open-right', icon: <SidebarSimple size={14} />, label: t('learningHub:splitView.openRight'), disabled: !canSplit, run: openSplitView }]
      : [];
  }),
  official('tab:pin', 20, ({ t, pinned, togglePin }) => (togglePin ? [{
    id: 'pin',
    icon: pinned ? <PushPinSlash size={14} /> : <PushPin size={14} />,
    label: pinned ? t('learningHub:tabBar.unpin') : t('learningHub:tabBar.pin'),
    run: togglePin,
  }] : [])),
  official('tab:close', 30, ({ t, hasClosableToRight, close, closeOthers, closeRight }) => [
    { kind: 'separator', id: 'close-separator' },
    { id: 'close', icon: closeIcon, label: t('common:actions.close'), run: close },
    ...(closeOthers ? [{ id: 'close-others', label: t('learningHub:tabBar.closeOthers'), run: closeOthers }] : []),
    ...(closeRight ? [{ id: 'close-right', label: t('learningHub:tabBar.closeRight'), disabled: !hasClosableToRight, run: closeRight }] : []),
  ]),
];

for (const entry of officialTabBarMenuEntries) appMenuContributions.announce(entry);
