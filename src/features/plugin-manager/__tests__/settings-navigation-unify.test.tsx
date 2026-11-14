import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import type { SettingsSection } from '@/ui-kernel/contracts/settings';
import settingsPlugin from '@/ui-plugins/official/settings';
import { settingsNavigation } from '@/ui-plugins/official/settings/navigation';

import { PluginManagerController } from '../controller';
import { FakePluginManagerAdapter } from './fixtures';
import { createPluginManagerSection, PLUGIN_MANAGER_SECTION_ID } from '../mount';

const t = ((key: string) => key) as unknown as TFunction;
const navigation = (kernel: UiKernel) =>
  settingsNavigation(kernel.slots.list<SettingsSection>('settings.sections'), t, { isMobile: false });

describe('settings navigation unifies the legacy plugins tab', () => {
  it('keeps 插件 when only dstu.ui.settings is installed (golden shape)', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    try {
      expect(navigation(kernel).sidebarNavItems.map((item) => item.value)).toContain('plugins');
    } finally {
      await kernel.dispose();
    }
  });

  it('hides the redundant plugins entry once plugin-manager is mounted', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    try {
      const section = createPluginManagerSection({
        controller: new PluginManagerController(new FakePluginManagerAdapter([])),
      });
      await kernel.install(defineUiPlugin({
        meta: { id: 'plugin-manager.fixture' },
        apply: (ctx) => ctx.ui.settings.register(section),
      }));

      const unified = navigation(kernel);
      const tabs = unified.sidebarNavItems.map((item) => item.value);
      expect(tabs).toContain(PLUGIN_MANAGER_SECTION_ID);
      expect(tabs).not.toContain('plugins');
      // The unified entry keeps the integrations category ordering.
      const integrations = unified.sidebarCategories.find((category) => category.value === 'integrations');
      expect(integrations?.items.map((item) => item.value)).toEqual(
        expect.arrayContaining(['mcp', PLUGIN_MANAGER_SECTION_ID]),
      );
      expect(integrations?.items.map((item) => item.value)).not.toContain('plugins');
      // No dangling search hit that would route to the removed tab.
      expect(unified.settingsSearchIndex.filter((entry) => entry.tab === 'plugins')).toEqual([]);
    } finally {
      await kernel.dispose();
    }
  });
});
