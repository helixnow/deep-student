import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';

import { PluginManagerController } from '../controller';
import { createPluginManagerSection, PLUGIN_MANAGER_SECTION_ID } from '../mount';
import { FakePluginManagerAdapter, managedPlugin } from './fixtures';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

describe('createPluginManagerSection', () => {
  it('describes an integrations settings section without registering anything itself', () => {
    const controller = new PluginManagerController(new FakePluginManagerAdapter([]));

    const section = createPluginManagerSection({ controller, order: 46, navigationOrder: 200 });

    expect(section.id).toBe(PLUGIN_MANAGER_SECTION_ID);
    expect(section.group).toBe('integrations');
    expect(section.order).toBe(46);
    expect(section.titleKey).toBe('plugin_manager:title');
    expect(section.navigation).toMatchObject({ order: 200, legacyGroup: 2 });
    expect(section.navigation?.mobileAccent).toBe('var(--settings-nav-accent-teal)');
    expect(section.navigation?.category).toMatchObject({ id: 'integrations' });
    expect(section.visible?.({ isMobile: true })).toBe(true);
    expect(section.searchDetails?.[0]?.keywords).toContain('插件');
  });

  it('lazily renders the panel with the given controller and error budget slot', async () => {
    const adapter = new FakePluginManagerAdapter([managedPlugin({ id: 'dstu.ui.chat' })]);
    const controller = new PluginManagerController(adapter);
    const section = createPluginManagerSection({ controller });
    const Component = section.component;

    render(
      <Suspense fallback={<p>loading</p>}>
        <Component getProps={{} as unknown as SettingsSectionRenderProps['getProps']} />
      </Suspense>,
    );

    // The cold lazy import can exceed Testing Library's 1s default under full-suite load.
    expect(await screen.findByTestId('plugin-manager', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText('dstu.ui.chat')).toBeInTheDocument();
  }, 15_000);
});
