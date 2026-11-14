// @vitest-environment node
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import type { ShellNavItem, ShellView } from '@/ui-kernel/contracts/shell';
import * as icons from '@/components/icons/StudySidebarIcons';
import { Database } from '@phosphor-icons/react';
import shellPlugin, { officialShellViewIds } from '../index';
import { consumerEvidence } from './consumerEvidence';

it('matches the complete pre-refactor shell inventory and condition matrix', async () => {
  const kernel = new UiKernel();
  await kernel.install(shellPlugin, { origin: 'builtin' });
  const views = kernel.slots.list<ShellView>('views').map(entry => entry.value);
  const nav = kernel.slots.list<ShellNavItem>('nav').map(entry => entry.value);
  const entries = kernel.slots.list<ShellView>('views');
  const consumers = consumerEvidence(undefined, officialShellViewIds);
  const golden = JSON.parse(fs.readFileSync('src/ui-plugins/official/shell/__golden__/shell.json', 'utf8'));
  const iconNames = { ...icons, Database };
  const iconName = (icon: unknown) => Object.entries(iconNames).find(([, value]) => value === icon)?.[0];
  const navigation = [false, true].map(uiLabEnabled => ({
    uiLabEnabled,
    items: nav.filter(item => item.desktop && (!item.visible || item.visible({ dev: true, uiLabEnabled }))).map(item => ({
      id: item.id, label: { key: item.labelKey, fallback: item.fallback ?? null }, icon: iconName(item.icon),
    })),
  }));
  const actual = {
    views: views.map(view => ({
      id: view.id, content: view.contentKey, extraClass: view.extraClass ?? null,
      gate: !view.visible ? 'always' : view.visible({ dev: false, uiLabEnabled: true }) ? 'uiLabEnabled' : 'import.meta.env.DEV',
    })),
    navigation,
    mobileItems: nav.filter(item => item.mobile?.placement === 'launcher').map(item => ({
      id: item.id, icon: iconName(item.mobile?.icon ?? item.icon), label: item.mobile?.label, ariaLabel: item.mobile?.ariaLabel,
    })),
    desktop: [false, true].flatMap(uiLabEnabled => ['full', 'chat'].map(navigationScope => ({
      uiLabEnabled, navigationScope,
      ids: nav.filter(item => (!item.visible || item.visible({ dev: true, uiLabEnabled })) &&
        (navigationScope === 'chat' ? item.desktop?.chatScope : item.desktop?.placement === 'primary')).map(item => item.id),
    }))),
    shell: views.map(view => ({
      id: view.id, titleKey: view.titleKey, sidebarKind: view.shell?.sidebarKind ?? 'main',
      pageBackButton: view.shell?.pageBackButton ?? false,
      sidebarOwnsBackNavigation: view.shell?.sidebarOwnsBackNavigation ?? false,
      sidebarToggle: [false, true].map(collapsed => !view.shell?.hideExpandedSidebarToggle || collapsed),
      headerNav: [false, true].map(collapsed => !view.shell?.sidebarOwnsBackNavigation || collapsed),
      mobileBackToHome: view.shell?.mobileBackToHome ?? true,
    })),
    header: views.map(view => ({
      ...consumers.header(view.id, entries),
      cardsHubTabs: view.shell?.cardsHubTabs ?? false, contentClass: view.shell?.contentClass ?? null,
    })),
    environments: golden.environments.map(({ dev, uiLabEnabled, isSmallScreen, workbenchActive, demo }) =>
      consumers.environment({ dev, uiLabEnabled, isSmallScreen, workbenchActive, demo }, entries, views.map(view => view.contentKey!))),
    navigationTransitions: golden.navigationTransitions.map(({ dev, demo, transitions }) =>
      consumers.navigation(dev, demo, entries, transitions.map(({ input }) => input))),
  };
  try {
    expect(actual).toEqual(golden);
    expect(kernel.slots.list('views').map(entry => entry.order)).toEqual(views.map((_, index) => (index + 1) * 10));
    expect(kernel.slots.list('nav').map(entry => entry.order)).toEqual(nav.map((_, index) => (index + 1) * 10));
  } finally {
    await kernel.dispose();
  }
}, 20_000);
