import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as icons from '@phosphor-icons/react';
import type { SettingsSidebarProps } from '@/features/settings/components/SettingsSidebar';
import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from './index';
import golden from './__golden__/settings.json';
import sidebarGolden from './__golden__/sidebar.json';

const state = vi.hoisted(() => ({ mobile: false, props: null as SettingsSidebarProps | null }));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => state.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/settings/components/SettingsSidebar', () => ({
  SettingsSidebar: (props: SettingsSidebarProps) => { state.props = props; return null; },
}));

describe('slot-backed desktop sidebar equals fixed pre-change forwarding evidence', () => {
  it('matches all 32 original input/output and callback cases without changing golden', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const iconNames = new Map(Object.entries(icons).map(([name, icon]) => [icon, name]));
    for (const [name, icon] of Object.entries(icons)) if (!name.endsWith('Icon')) iconNames.set(icon, name);
    try {
      for (const expected of sidebarGolden.cases) {
        const { input } = expected;
        state.mobile = input.isMobile;
        useSettingsShellStore.setState({ activeTab: 'apis' });
        let backCalls = 0;
        const externalOpen: boolean[] = [];
        const view = render(<UiKernelProvider kernel={kernel}>
          <SettingsShellSidebar isSmallScreen={input.isSmallScreen} globalLeftPanelCollapsed={input.globalLeftPanelCollapsed}
            {...(input.externalSidebarControl ? { setSidebarOpen: (open: boolean) => externalOpen.push(open) } : {})}
            {...(input.withBack ? { onBack: () => { backCalls++; } } : {})} />
        </UiKernelProvider>);
        const snapshot = () => {
          const forwarded = state.props!;
          const navigation = JSON.parse(JSON.stringify({ sidebarNavItems: forwarded.sidebarNavItems,
            sidebarCategories: forwarded.sidebarCategories, settingsSearchIndex: forwarded.settingsSearchIndex },
          (key, value) => key === 'icon' ? iconNames.get(value) : value));
          const originalNavigation = golden.navigation[input.isMobile ? 'mobile' : 'desktop'];
          for (const key of Object.keys(navigation)) expect(navigation[key]).toEqual(originalNavigation[key]);
          return {
            isSmallScreen: forwarded.isSmallScreen, globalLeftPanelCollapsed: forwarded.globalLeftPanelCollapsed,
            desktopMode: forwarded.desktopMode, sidebarSearchQuery: forwarded.sidebarSearchQuery,
            sidebarSearchFocused: forwarded.sidebarSearchFocused, activeTab: forwarded.activeTab,
            hasBack: typeof forwarded.onBack === 'function', navigationRef: `settings.json#/navigation/${input.isMobile ? 'mobile' : 'desktop'}`,
          };
        };
        const initial = snapshot();
        act(() => {
          state.props!.setSidebarSearchQuery(' OCR ');
          state.props!.setSidebarSearchFocused(true);
          state.props!.setActiveTab('document-processing');
          state.props!.setSidebarOpen(true);
          state.props!.onBack?.();
        });
        expect({ input, initial, afterActions: snapshot(), effects: { externalOpen, backCalls } }).toEqual(expected);
        view.unmount();
      }
    } finally {
      await kernel.dispose();
    }
  });
});
