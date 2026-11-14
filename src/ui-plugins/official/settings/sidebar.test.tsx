import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';
import { SettingsShellSidebar } from '@/features/settings/components/SettingsShellSidebar';
import { SettingsMobileNavigation } from '@/features/settings/components/SettingsMobileNavigation';
import { UiKernelProvider, useSlot } from '@/ui-kernel/react';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { defineUiPlugin, UiKernel } from '@/ui-kernel/kernel';
import type { SettingsSection } from '@/ui-kernel/contracts/settings';
import settingsPlugin from './index';
import { settingsIcon } from './isolation';
import { settingsNavigation } from './navigation';
import golden from './__golden__/settings.json';

const state = vi.hoisted(() => ({ mobile: false, reveal: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => state.mobile }));
vi.mock('@/features/settings/components/settingsSearchReveal', () => ({ revealSettingsSection: state.reveal }));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('real desktop settings shell sidebar consumes settings.sections', () => {
  beforeEach(() => {
    state.mobile = false;
    state.reveal.mockClear();
    useSettingsShellStore.setState({ activeTab: 'apis' });
  });

  it.each([false, true])('preserves golden categories, default tabs, search and About (mobile platform=%s)', async (mobile) => {
    state.mobile = mobile;
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const view = render(<UiKernelProvider kernel={kernel}>
      <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
    </UiKernelProvider>);
    const { t } = useTranslation(['settings', 'common', 'data', 'workbench']);
    const expected = golden.navigation[mobile ? 'mobile' : 'desktop'];
    const categoryList = view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    expect(within(categoryList).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(expected.sidebarCategories.map((category) => t(category.label)));
    for (const category of expected.sidebarCategories) {
      fireEvent.click(within(categoryList).getByRole('button', { name: t(category.label) }));
      expect(useSettingsShellStore.getState().activeTab).toBe(category.items[0]!.value);
    }
    fireEvent.click(screen.getByRole('button', { name: t('settings:tabs.about') }));
    expect(useSettingsShellStore.getState().activeTab).toBe('about');

    const input = screen.getByRole('combobox', { name: t('settings:sidebar.search_placeholder') });
    fireEvent.change(input, { target: { value: 'ocr' } });
    const result = screen.getByRole('option', {
      name: `${t('settings:ocr.title')} ${t('settings:categories.workflow')} / ${t('settings:tabs.document_processing')}`,
    });
    fireEvent.click(within(result).getByRole('button'));
    expect(useSettingsShellStore.getState().activeTab).toBe('document-processing');
    expect(state.reveal).toHaveBeenCalledExactlyOnceWith(t('settings:ocr.title'));
    expect(input).toHaveValue('');
    view.unmount();
    await kernel.dispose();
  });

  it('shows a new slot contribution in desktop navigation and search, and removes it on unload', async () => {
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const view = render(<UiKernelProvider kernel={kernel}>
      <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
    </UiKernelProvider>);
    const section: SettingsSection = {
      id: 'community.settings', group: 'community', order: 180,
      titleKey: 'community:setting', component: () => null,
      navigation: {
        order: 190, legacyGroup: 5, icon: () => null,
        mobileDescriptionKey: 'community:description', mobileAccent: 'var(--settings-nav-accent-blue)',
        category: { id: 'community', titleKey: 'community:category', icon: () => null, order: 70 },
        categoryOrder: 10,
      },
      searchDetails: [{ order: 460, label: 'Community control', keywords: ['unique-community-control'] }],
    };
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'community.settings' },
      apply: (ctx) => ctx.ui.settings.register(section) }), { origin: 'community' }));
    const categories = view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    expect(within(categories).getAllByRole('button')).toHaveLength(7);
    fireEvent.click(within(categories).getByRole('button', { name: 'community:category' }));
    expect(useSettingsShellStore.getState().activeTab).toBe(section.id);
    const { t } = useTranslation(['settings']);
    const input = screen.getByRole('combobox', { name: t('settings:sidebar.search_placeholder') });
    fireEvent.change(input, { target: { value: 'unique-community-control' } });
    expect(screen.getByRole('option', { name: 'Community control community:category / community:setting' })).toBeInTheDocument();
    await act(async () => { await kernel.unload('community.settings'); });
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'community:category' })).toBeNull();
    expect(view.container.querySelector('[data-settings-about-footer]')).not.toBeNull();
    view.unmount();
    await kernel.dispose();
  });

  it('isolates throwing community nav/category icons, including a same-id official override, and keeps builtin errors', async () => {
    // Resolve the real shared boundary first so the test does not measure Vitest cold-transform latency.
    await import('@/components/ErrorBoundary');
    const crash = (where: string) => () => { throw new Error(`${where} icon failure`); };
    const section = (id: string, category: string): SettingsSection => ({
      id, group: 'community', order: 180, titleKey: `community:${id}`, component: () => null,
      navigation: {
        order: 190, legacyGroup: 5, icon: crash(`${id} nav`),
        mobileDescriptionKey: 'community:description', mobileAccent: 'var(--settings-nav-accent-blue)',
        category: { id: category, titleKey: `community:${category}`, icon: crash(`${category} category`), order: 70 },
        categoryOrder: 10,
      },
    });
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const view = render(<UiKernelProvider kernel={kernel}>
      <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
    </UiKernelProvider>);
    const categories = () => view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'community.icons' },
      apply: (ctx) => ctx.ui.settings.register(section('crashing', 'crashing-category')) }), { origin: 'community' }));
    await waitFor(() => expect(within(categories()).getAllByRole('button')).toHaveLength(7));
    fireEvent.click(within(categories()).getByRole('button', { name: 'community:crashing-category' }));
    expect(useSettingsShellStore.getState().activeTab).toBe('crashing');
    const { t } = useTranslation(['settings']);
    fireEvent.click(within(categories()).getByRole('button', { name: t(golden.navigation.desktop.sidebarCategories[0]!.label) }));
    expect(useSettingsShellStore.getState().activeTab).toBe(golden.navigation.desktop.sidebarCategories[0]!.items[0]!.value);

    // Same plugin id as the official plugin, installed without origin: provenance is community, so it is isolated too.
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.settings' },
      apply: (ctx) => ctx.ui.settings.register(section('override', 'override-category')) })));
    expect(kernel.slots.get<SettingsSection>('settings.sections', 'override')?.origin).toBe('community');
    await waitFor(() => expect(within(categories()).getAllByRole('button')).toHaveLength(2));
    fireEvent.click(within(categories()).getByRole('button', { name: 'community:override-category' }));
    expect(useSettingsShellStore.getState().activeTab).toBe('override');
    fireEvent.click(within(categories()).getByRole('button', { name: 'community:crashing-category' }));
    expect(useSettingsShellStore.getState().activeTab).toBe('crashing');
    await act(async () => { await kernel.unload('community.icons'); });
    expect(within(categories()).queryByRole('button', { name: 'community:crashing-category' })).toBeNull();
    expect(within(categories()).getByRole('button', { name: 'community:override-category' })).toBeInTheDocument();
    view.unmount();
    await kernel.dispose();

    const builtinKernel = new UiKernel();
    await builtinKernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.settings' },
      apply: (ctx) => ctx.ui.settings.register(section('builtin', 'builtin-category')) }), { origin: 'builtin' });
    const builtin = builtinKernel.slots.get<SettingsSection>('settings.sections', 'builtin')!;
    expect(settingsIcon(builtin.value.navigation!.icon, builtin)).toBe(builtin.value.navigation!.icon);
    const propagated = vi.fn();
    class HostBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error: Error) { propagated(error); }
      render() { return this.state.failed ? <p>outer host failure</p> : this.props.children; }
    }
    const builtinView = render(<HostBoundary><UiKernelProvider kernel={builtinKernel}>
      <SettingsShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />
    </UiKernelProvider></HostBoundary>);
    expect(propagated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'builtin-category category icon failure' }));
    expect(screen.getByText('outer host failure')).toBeInTheDocument();
    builtinView.unmount();
    await builtinKernel.dispose();
  });

  it('isolates a throwing community category icon in the mobile navigation Settings renders', async () => {
    await import('@/components/ErrorBoundary');
    state.mobile = true;
    const kernel = new UiKernel();
    await kernel.install(settingsPlugin, { origin: 'builtin' });
    const opened = vi.fn();
    function MobileConsumer() {
      const entries = useSlot<SettingsSection>('settings.sections');
      const { t } = useTranslation(['settings', 'common', 'data', 'workbench']);
      const navigation = settingsNavigation(entries, t, { isMobile: true });
      return <SettingsMobileNavigation categories={navigation.sidebarCategories} items={navigation.sidebarNavItems}
        searchIndex={navigation.settingsSearchIndex} query="" onQueryChange={() => {}} onOpenTab={opened} />;
    }
    const view = render(<UiKernelProvider kernel={kernel}><MobileConsumer /></UiKernelProvider>);
    await act(async () => kernel.install(defineUiPlugin({ meta: { id: 'community.mobile' },
      apply: (ctx) => ctx.ui.settings.register({
        id: 'mobile-crash', group: 'community', order: 180, titleKey: 'community:mobile', component: () => null,
        navigation: { order: 190, legacyGroup: 5, icon: () => { throw new Error('mobile nav icon failure'); },
          mobileDescriptionKey: 'community:description', mobileAccent: 'var(--settings-nav-accent-blue)',
          category: { id: 'mobile-category', titleKey: 'community:mobile-category', order: 70,
            icon: () => { throw new Error('mobile category icon failure'); } },
          categoryOrder: 10 },
      }) }), { origin: 'community' }));
    const categories = () => view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    await waitFor(() => expect(within(categories()).getAllByRole('button')).toHaveLength(7));
    fireEvent.click(within(categories()).getByRole('button', { name: 'community:mobile-category' }));
    expect(opened).toHaveBeenLastCalledWith('mobile-crash');
    const { t } = useTranslation(['settings']);
    const first = golden.navigation.mobile.sidebarCategories[0]!;
    fireEvent.click(within(categories()).getByRole('button', { name: t(first.label) }));
    expect(opened).toHaveBeenLastCalledWith(first.items[0]!.value);
    await act(async () => { await kernel.unload('community.mobile'); });
    expect(within(categories()).getAllByRole('button')).toHaveLength(6);
    view.unmount();
    await kernel.dispose();
  });
});
